---
title: Byte Layout
description: Every wire type, byte by byte, with the rules that make the encoding canonical.
---

The format is **tagless and positional**. Payloads contain no field names, type markers, separators, or version bytes; the schema supplies their meaning. Every example below comes from the published implementation.

## Integers

Unsigned: base-128 varints, little-endian groups, high bit as continuation flag.

| Value | Bytes |
| --- | --- |
| `0` | `[0]` |
| `127` | `[127]` |
| `128` | `[128, 1]` |

Signed: **ZigZag** first, mapping `0, -1, 1, -2, 2` to `0, 1, 2, 3, 4`, then the same varint.

| Value | Bytes |
| --- | --- |
| `-1` | `[1]` |
| `63` | `[126]` |
| `64` | `[128, 1]` |

ZigZag doubles the magnitude, so a signed integer crosses every size boundary at half the value: `64` is two bytes as an `int`, one as a `uint`. Declare a non-negative lower bound wherever it is true; either spelling is read as unsigned, so `.nonnegative()` (`minimum: 0`) and `.positive()` (`exclusiveMinimum: 0`) both get the shorter encoding.

**Overlong varints are rejected.** `1` must be `[1]`, never `[129, 0]`.

**`-0` is not an integer on the wire.** Both integer encodings write it as `0` and read it back as `0`, which is what `JSON.stringify` does with it too. Encoding `-0` against an enum that lists `0` normalizes the same way, since member lookup matches `-0` to `0`. A field that has to tell `-0` from `0` needs a float — `float64` carries the sign bit — or a string.

Normalizing is the exception here, not the rule: `-0` as an [enum member or literal](/schemas/rejected-shapes/) is refused when the codec is built, because there the value *is* the schema and a member that cannot survive its own round trip has no index worth giving it.

## Floats

`z.number()` is little-endian IEEE-754 **float64**, always 8 bytes, no varint compaction.

```
1.5 -> [0, 0, 0, 0, 0, 0, 248, 63]
```

`m.float32()` (4 bytes) is available only through the low-level API. Little-endian order is part of the format and does not depend on the host.

## Booleans

One byte, `[1]` or `[0]`. Anything else is a `DecodeError`.

## Strings and bytes

A varint **byte** length, then the contents. Strings are UTF-8; `m.bytes()` is raw.

```
"ab"               -> [2, 97, 98]
Uint8Array([9, 9]) -> [2, 9, 9]
```

UTF-8 decoding is strict. Invalid sequences cause a `DecodeError` instead of being replaced with `U+FFFD`. That holds regardless of which decoder the runtime provides: on Node, string decoding goes through `Buffer.prototype.utf8Slice` because it is measurably cheaper, and because that function substitutes `U+FFFD` rather than failing, any result containing one is re-decoded strictly to get a definitive answer. A string that legitimately contains `U+FFFD` round-trips; a malformed payload throws.

**String content stays where its field is, and that is a commitment rather than an accident.** Writing every string into one contiguous region instead — as msgpackr's `bundleStrings` mode does — would let a decoder turn all of them into text in a single call, which is worth about 32% of decode on a document-shaped payload. It is deliberately not done: it would change the bytes of every existing shape, it would still not overtake `bundleStrings`, and substrings of one large region keep that whole region alive in memory for as long as any field decoded from it is retained. If it is ever offered it will be an opt-in wrapper alongside [`fingerprinted()`](/versioning/fingerprinting/), which adds a new shape rather than redefining this one.

## Literals

Zero bytes: the schema already knows the value.

```
m.literal("x") with "x" -> []
```

## Enums

The index of the value in **sorted** order, as a varint. Members are deduplicated and sorted first, so declaration order is irrelevant.

```
m.enum(["M", "F", "X"])  // sorted to ["F", "M", "X"]
"X" -> [2]
```

Members do not have to be strings. An all-string enum sorts by value; any other enum sorts by each member's JSON text, since `<` is not a total order across mixed types. Either way a member costs one byte until there are 128 of them: a numeric enum is an index, not a number.

An index past the last member is a `DecodeError`. Adding a member shifts every index at or after it; see [Wire Fingerprints](/versioning/fingerprinting/).

## Nullable

One discriminator byte, then the value if present.

```
null -> [0]
5    -> [1, 5]
```

A marker over a shape that already holds `null` — `z.any()`, `z.null()`, an enum with a `null` member, or a second `.nullable()` — is dropped when the codec is built, so no payload carries two ways to spell one `null`. The dropped marker is not in the [fingerprint](/versioning/schema-evolution/) either: two schemas that write the same bytes derive the same fingerprint.

## Arrays

A varint element count, then elements back to back. Order is never changed.

```
[1, 2, 3] -> [3, 1, 2, 3]
```

The decoder refuses a count larger than the remaining input could satisfy, before allocating. See [Hostile Input](/hostile-input/).

When the schema fixes the count (`minItems` equal to `maxItems`) the varint is omitted and the array is written like a tuple. The count is still checked against the remaining input, because a schema may have been fetched rather than written.

```
z.array(z.uint32()).length(3) with [1, 2, 3] -> [1, 2, 3]
```

## Tuples

Elements only; the length comes from the schema.

```
m.tuple([m.uint(), m.boolean()]) with [7, true] -> [7, 1]
```

Because the length is not on the wire, a tuple *may* contain zero-width elements where an array may not.

A **rest** element is the part whose count is not in the schema, so it is written as an array would be — the fixed items bare, then a varint count and the remainder:

```
z.tuple([z.string()], z.int()) with ["a", 1, 2] -> [1, 97, 2, 2, 4]
                                                   └─ "a" ┘  │  └─ 1, 2 as ZigZag
                                                             └─ two rest elements
```

## Objects

1. A **presence bitmap** for the optional fields, `ceil(n / 8)` bytes. Omitted entirely when there are none.
2. The field values in canonical key order, skipping absent optionals.

A field's bit is its rank **among the optional fields**, low bit first.

```ts
m.object({ a: m.uint().optional(), b: m.uint() })

{ a: 1, b: 2 } -> [1, 1, 2]   // bitmap 1, then a, then b
{ b: 2 }       -> [0, 2]      // bitmap 0, a skipped
```

Nine optional fields make the bitmap two bytes:

```
9 optional, all absent           -> [0, 0]
9 optional, all present, each 1  -> [255, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
```

Field order is the field name's rank in ascending UTF-16 code-unit order, applied by the encoder, never declared.

**The bitmap width is fixed by the schema.** A ninth optional field adds a byte, so earlier payloads require their original codec. See [Schema Changes](/versioning/schema-evolution/).

## Records (keys the schema does not name)

A varint entry count, then each key as a string followed by its value.

```ts
z.record(z.string(), z.int())

{ b: 2, a: 1 } -> [2, 1, 97, 2, 1, 98, 4]
                  │  └───────┘  └───────┘
                  │  a: 1        b: 2      (ZigZag: 1 -> 2, 2 -> 4)
                  └─ two entries
```

Keys are the one thing here that costs what it does in JSON, because they are data rather than schema. They are written in ascending UTF-16 code-unit order, and the decoder **refuses** a payload whose keys arrive in any other order, which also refuses a repeated key. Sorting on the way in instead would let two payloads decode to the same record.

## Discriminated unions

A varint branch index, then that branch's own encoding.

```ts
z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), x: z.int() }),
  z.object({ kind: z.literal("key"), code: z.string() }),
])

{ kind: "click", x: 3 } -> [0, 6]
                           │  └─ x, ZigZag
                           └─ branch index; `kind` itself writes nothing
```

The index is the only byte added, and it usually replaces one. The discriminant is a literal inside its branch, and a literal writes nothing — so a tagged format pays for both the tag and the field, and shorn pays for neither, only the index.

Branches are ordered by their discriminant, canonically, so reordering the schema does not move the wire. An index past the last branch is a `DecodeError`. Adding a branch shifts every index at or after it, exactly as adding an enum member does.

## Open objects

Declared fields first, exactly as a closed object writes them, then everything else as a record.

```ts
z.looseObject({ a: z.string() })

{ a: "x" }            -> [1, 120, 0]
{ a: "x", n: 5 }      -> [1, 120, 1, 1, 110, 3, 10]
                                  └─ one extra: key "n", then a dynamic 5
```

An object with nothing extra still pays the one-byte count, which is what an open object costs over a closed one. Extras are ordered and refused out of order like any record, and a key repeating a declared field is refused too — it would otherwise overwrite the field decoded moments earlier, so two payloads would decode alike.

`z.object().catchall(T)` is the same layout with `T` in place of the dynamic value, so the extras' values are tagless and only their keys are on the wire.

## Dynamic values

Where a schema declines to describe a value (`z.any()`, `z.unknown()`, an empty JSON Schema node) the payload describes itself, with one tag byte followed by the value.

| Tag | Value | Payload |
| --- | --- | --- |
| 0 | `null` | — |
| 1 | `false` | — |
| 2 | `true` | — |
| 3 | safe integer | ZigZag varint |
| 4 | any other number | 8 bytes |
| 5 | string | varint length + UTF-8 |
| 6 | array | varint count + values |
| 7 | object | varint count + key/value pairs, as a record |

```
null    -> [0]
true    -> [2]
5       -> [3, 10]
"hi"    -> [5, 2, 104, 105]
{ a: 1 } -> [7, 1, 1, 97, 3, 2]
```

One value still has exactly one encoding: an integer always takes tag 3, and a tag 4 payload holding an integer is refused rather than accepted as a second spelling. Objects under a dynamic value follow the record rules above, key order included.

A dynamic value holds `null`, a boolean, a number, a string, an array, or a plain object. A `Date`, `Map`, or class instance is refused rather than written as the empty object its own keys make it look like. Nesting is capped at 64 levels on both sides: this is the one place the *payload* chooses the depth, and an object that holds itself hits the same cap on the way out.

Nothing else changes. A schema with no dynamic value in it writes no tag and pays nothing for this existing.

## A whole record

```ts
encode(Person, { name: "Grace", age: 45, sex: "F" });
```

```
[45, 5, 71, 114, 97, 99, 101, 0]
 │   │  └────────────────────┘  └─ sex: index of "F" in ["F","M","X"]
 │   └─ name: length 5
 └─ age: uint varint 45          (no bitmap: nothing is optional)
```

Eight bytes. `age` comes first because `"age"` sorts before `"name"`. JSON spends 35.

## Decoder limits

| Limit | Value |
| --- | --- |
| Collection elements | 1,000,000 |
| String / byte-array length | 64 MiB |
| Dynamic value nesting | 64 levels |
| Trailing bytes | rejected |
| Non-canonical varint | rejected |
| Non-canonical dynamic number | rejected |
| Record keys out of order | rejected |
| Unsafe numeric varint | rejected |

## What is not in the payload

No schema identifier, version byte, length prefix on the whole value, or type tags. The format version is hashed into the [fingerprint](/versioning/fingerprinting/) instead of spent as a wire byte.

Two things are on the wire only where the schema declined to supply them: a record's keys, and a dynamic value's type tag. Both are paid for per use, by the shapes that asked for them, and a schema that names everything it holds still writes nothing but values.

Bare payloads are compact, but they are neither self-describing nor confidential. **Encrypt them when secrecy is required.**
