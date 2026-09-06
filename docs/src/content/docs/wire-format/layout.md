---
title: Byte Layout
description: Every wire type, byte by byte, with the rules that make the encoding canonical.
---

The format is **tagless and positional**. A payload contains no field names, type markers, separators, or version bytes. The schema supplies the meaning of every byte. Every example below comes from the published implementation. For why this leaves so little to write, see [Where the bytes go](/core-concepts/how-it-works/#where-the-bytes-go).

## Integers

Unsigned integers are base-128 varints: seven bits of value per byte, least significant group first, with the high bit of each byte saying whether another byte follows.

| Value | Bytes |
| --- | --- |
| `0` | `[0]` |
| `127` | `[127]` |
| `128` | `[128, 1]` |

Signed integers are **ZigZag** encoded first, which maps `0, -1, 1, -2, 2` to `0, 1, 2, 3, 4`, and then written as the same varint.

| Value | Bytes |
| --- | --- |
| `-1` | `[1]` |
| `63` | `[126]` |
| `64` | `[128, 1]` |

ZigZag doubles the magnitude, so a signed integer crosses every size boundary at half the value: `64` is two bytes as an `int` and one as a `uint`. Declare a non-negative lower bound wherever it is true. Either spelling is read as unsigned, so `.nonnegative()` (`minimum: 0`) and `.positive()` (`exclusiveMinimum: 0`) both get the shorter encoding.

**Overlong varints are rejected.** `1` must be `[1]`, never `[129, 0]`.

**`-0` is not an integer on the wire.** Both integer encodings write it as `0` and read it back as `0`, exactly as `JSON.stringify` does. A field that has to tell `-0` from `0` needs a float, since `float64` carries the sign bit, or a string. As an [enum member or literal](/schemas/rejected-shapes/), `-0` is refused when the codec is built rather than normalized, because there the value *is* the schema.

## Floats

`z.number()` is little-endian IEEE-754 **float64**, always 8 bytes, with no varint compaction.

```
1.5 -> [0, 0, 0, 0, 0, 0, 248, 63]
```

`m.float32()` (4 bytes) is available only through the low-level API. Little-endian order is part of the format and does not depend on the host machine.

## Dates

A `Date` is its epoch milliseconds as a ZigZag varint, exactly what an `int` writes. That is six bytes for any date this century, fewer near 1970, and exact, since a `Date` holds nothing finer than a millisecond.

```
new Date("2026-09-03T12:00:00.000Z") -> [128, 136, 159, 242, 140, 104]
```

An **Invalid Date** is refused at encode: its time value is `NaN`, which no integer holds. On the way back, a millisecond count outside ±8.64e15 names no `Date` at all, since that is where the spec's TimeClip puts the end of the range, so the decoder refuses it rather than returning an Invalid Date.

A **`format: "date-time"` string** takes the same six bytes and decodes back to text, the `toISOString()` spelling of that instant. Only that spelling encodes. Epoch milliseconds cannot remember a fractional-digit count or an offset, so anything else is refused rather than normalized, exactly as an uppercase UUID is. See [Rejected Shapes](/schemas/rejected-shapes/#non-canonical-date-time-strings).

## BigInts

A varint header, then the magnitude in little-endian order with no leading zero byte. The header is the magnitude's **byte count doubled, plus 1 when the value is negative**, so the low bit is the sign and the rest is the width. Zero is the single header byte `[0]`.

| Value | Bytes |
| --- | --- |
| `0n` | `[0]` |
| `1n` | `[2, 1]` |
| `-1n` | `[3, 1]` |
| `255n` | `[2, 255]` |
| `256n` | `[4, 0, 1]` |
| `-256n` | `[5, 0, 1]` |
| `2n ** 64n` | `[18, 0, 0, 0, 0, 0, 0, 0, 0, 1]` |

The header stays one byte up to a 63-byte magnitude, and the magnitude itself may reach 64 MiB, the same ceiling a string or a byte array has. This is not the varint path: that reader stops at ten bytes, and the cap is a hostile-input defense worth keeping.

Canonical on both sides. A header of `1` would be negative zero, and a zero high byte would be a padded magnitude. Either would give one value two encodings, so both are refused on decode as `Non-canonical bigint`.

## Sets

A varint element count, then the elements in **iteration order**. Byte-identical to an array of the same elements.

```
m.set(m.string()) with new Set(["a", "b"]) -> [2, 1, 97, 1, 98]
```

A Set and an array therefore cost the same and write the same payload. What separates them is what they decode to, and their [fingerprint](/versioning/fingerprinting/): the signature token is `{ set: T }` rather than `{ array: T }`, on purpose, so a payload written as one is never read back as the other.

A **duplicate element** is refused on decode. `new Set` would merge the pair, and the value would then re-encode to one element for a payload that declared two, breaking the one-value-one-encoding rule every other shape keeps. Only a primitive can trip this, since every decoded object is a fresh reference.

There is no fixed-count form, so the element must occupy at least one byte, and the count is checked against the remaining input before anything is allocated, exactly as an array's is.

## Maps

A varint entry count, then each key followed by its value, in iteration order. Byte-identical to an array of `[key, value]` tuples. Keys may be any schema, since a Map's key may be anything.

```ts
m.map(m.string(), m.uint())

new Map([["x", 1], ["y", 300]]) -> [2, 1, 120, 1, 1, 121, 172, 2]
                                    │  └───────┘  └────────────┘
                                    │  "x" -> 1   "y" -> 300
                                    └─ two entries
```

Unlike a record, a Map does not sort its keys or refuse an order. Its keys are not restricted to strings, so there is no single order to canonicalize to. A **duplicate key** is refused on decode for the Set's reason. An entry must occupy at least one byte, counting key and value together.

## Booleans

One byte, `[1]` or `[0]`. Anything else is a `DecodeError`.

## Strings and bytes

A varint **byte** length, then the contents. Strings are UTF-8. `m.bytes()` is raw.

```
"ab"               -> [2, 97, 98]
Uint8Array([9, 9]) -> [2, 9, 9]
```

UTF-8 decoding is strict: an invalid sequence is a `DecodeError`, not a `U+FFFD` replacement character. On Node the faster `Buffer.prototype.utf8Slice` substitutes instead of failing, so any result containing `U+FFFD` is decoded a second time strictly for a definitive answer. A string that legitimately contains `U+FFFD` round-trips. A malformed payload throws.

**String content stays where its field is.** Writing every string into one contiguous region, as msgpackr's `bundleStrings` does, would buy about 32% of decode on document-shaped payloads. But it would change the bytes of every existing shape, still not overtake `bundleStrings`, and keep the whole region alive in memory for as long as any field decoded from it. If it is ever offered it will be an opt-in wrapper alongside [`fingerprinted()`](/versioning/fingerprinting/).

## Literals

Zero bytes. The schema already knows the value.

```
m.literal("x") with "x" -> []
```

## Enums

The index of the value in **sorted** order, as a varint. Members are deduplicated and sorted first, so declaration order does not matter.

```
m.enum(["M", "F", "X"])  // sorted to ["F", "M", "X"]
"X" -> [2]
```

Members do not have to be strings. An all-string enum sorts by value. Any other enum sorts by each member's JSON text, because `<` cannot order mixed types consistently. Either way a member costs one byte until there are 128 of them: a numeric enum is an index, not a number.

An index past the last member is a `DecodeError`. Adding a member shifts every index at or after it; see [Wire Fingerprints](/versioning/fingerprinting/).

## Nullable

One marker byte, then the value if there is one.

```
null -> [0]
5    -> [1, 5]
```

A marker over a shape that already holds `null` (`z.any()`, `z.null()`, an enum with a `null` member, or a second `.nullable()`) is dropped when the codec is built, so no payload carries two ways to spell one `null`. The dropped marker is not in the [fingerprint](/versioning/schema-evolution/) either, so a redundant wrapper changes neither the bytes nor the identifier.

## Arrays

A varint element count, then the elements back to back. Order is never changed.

```
[1, 2, 3] -> [3, 1, 2, 3]
```

The decoder refuses a count larger than the remaining input could satisfy, before allocating. See [Hostile Input](/hostile-input/).

When the schema fixes the count (`minItems` equal to `maxItems`), the varint is left out and the array is written like a tuple. The count is still checked against the remaining input, because a schema may have been fetched rather than written by hand.

```
z.array(z.uint32()).length(3) with [1, 2, 3] -> [1, 2, 3]
```

## Tuples

Elements only. The length comes from the schema.

```
m.tuple([m.uint(), m.boolean()]) with [7, true] -> [7, 1]
```

Because the length is not on the wire, a tuple *may* contain zero-width elements where an array may not.

A **rest** element is the part whose count is not in the schema, so it is written the way an array would be: the fixed items bare, then a varint count and the remainder.

```
z.tuple([z.string()], z.int()) with ["a", 1, 2] -> [1, 97, 2, 2, 4]
                                                   └─ "a" ┘  │  └─ 1, 2 as ZigZag
                                                             └─ two rest elements
```

## Objects

1. A **presence bitmap** for the optional fields, `ceil(n / 8)` bytes. Left out entirely when there are none.
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

Field order is the rank of the field name in ascending UTF-16 code unit order. The encoder applies it. It is never declared.

**The bitmap width is fixed by the schema.** A ninth optional field adds a byte, so earlier payloads need their original codec. See [Schema Changes](/versioning/schema-evolution/).

## Records (keys the schema does not name)

A varint entry count, then each key as a string followed by its value.

```ts
z.record(z.string(), z.int())

{ b: 2, a: 1 } -> [2, 1, 97, 2, 1, 98, 4]
                  │  └───────┘  └───────┘
                  │  a: 1        b: 2      (ZigZag: 1 -> 2, 2 -> 4)
                  └─ two entries
```

Keys are the one thing here that costs what it does in JSON, because they are data rather than schema. They are written in ascending UTF-16 code unit order, and the decoder **refuses** a payload whose keys arrive in any other order, which also rules out a repeated key. Sorting on the way in instead would let two payloads decode to the same record.

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

The index is the only byte added, and it usually replaces one. The discriminant is a literal inside its branch, and a literal writes nothing. A tagged format pays for both the tag and the field. shorn pays for neither, only the index.

Branches are ordered by their discriminant value, so reordering the schema does not move the wire. An index past the last branch is a `DecodeError`. Adding a branch shifts every index at or after it, exactly as adding an enum member does.

## Type-disjoint unions

The same varint index, used when the branches carry no discriminant but no two of them share a JSON type.

```ts
z.union([z.string(), z.number()])

"hi" -> [1, 2, 104, 105]
        │  └─ the string: length 2, then "hi"
        └─ branch index; `string` sorts after `number`
42   -> [0, 0, 0, 0, 0, 0, 0, 69, 64]
```

Branches are ordered by **type name** (`array`, `boolean`, `null`, `number`, `object`, `string`), so declaration order does not reach the wire, exactly as with a discriminant. The decoder cannot tell the two union forms apart and does not need to. Both read an index and then the branch.

`integer` is not a name on that list. It folds into `number`, because nothing about a value says which of the two it was declared as. A union that would need to tell them apart is refused rather than given an index it cannot assign.

## Recursive schemas

Nothing of their own. A cycle lives in the schema, so each level writes what its shapes write:

```ts
const Node = z.object({ value: z.string(), get children() { return z.array(Node); } });

{ value: "a", children: [] }                               -> [1, 97, 0]
                                                               │      └─ no children
                                                               └─ "a"
{ value: "a", children: [{ value: "b", children: [] }] }   -> [1, 97, 1, 1, 98, 0]
                                                                       └─ one child, inline
```

The recursion is bounded by whatever lets it stop: an empty array here, a `null` back edge in a linked list. Depth is capped at 256 levels on both sides, since a recursive schema takes its nesting from the payload rather than from the schema; see [Hostile Input](/hostile-input/).

A `$ref` reached twice but never through itself is not a cycle. It is inlined, so a shared definition writes and fingerprints exactly as it would written out in full. The exception is a copy of a *recursive* definition, which is folded back onto that definition instead. Same bytes either way. The fold is what keeps one recursive type on one fingerprint across validators that spell it differently.

## Open objects

Declared fields first, exactly as a closed object writes them, then everything else as a record.

```ts
z.looseObject({ a: z.string() })

{ a: "x" }            -> [1, 120, 0]
{ a: "x", n: 5 }      -> [1, 120, 1, 1, 110, 3, 10]
                                  └─ one extra: key "n", then a dynamic 5
```

An object with nothing extra still pays the one-byte count. That is what an open object costs over a closed one. Extras are ordered, and refused out of order, like any record. A key repeating a declared field is refused too, since it would overwrite the field decoded a moment earlier and let two payloads decode alike.

`z.object().catchall(T)` is the same layout with `T` in place of the dynamic value, so the extras' values carry no tag and only their keys are on the wire.

## Dynamic values

Where a schema declines to describe a value (`z.any()`, `z.unknown()`, an empty JSON Schema node), the payload describes itself, with one tag byte followed by the value.

| Tag | Value | Payload |
| --- | --- | --- |
| 0 | `null` | none |
| 1 | `false` | none |
| 2 | `true` | none |
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

One value still has exactly one encoding. An integer always takes tag 3, and a tag 4 payload holding an integer is refused rather than accepted as a second spelling. Objects under a dynamic value follow the record rules above, key order included.

A dynamic value holds `null`, a boolean, a number, a string, an array, or a plain object. A `Date`, `Map`, or class instance is refused rather than written as the empty object it looks like. Nesting is capped at 64 levels on both sides, since this is the one place where the *payload* chooses the depth.

A schema with no dynamic value in it writes no tag and pays nothing for this.

## Decoder limits

| Limit | Value |
| --- | --- |
| Collection elements | 1,000,000 |
| String / byte-array / BigInt magnitude length | 64 MiB |
| Dynamic value nesting | 64 levels |
| `Date` milliseconds | ±8.64e15 |
| Trailing bytes | rejected |
| Non-canonical varint | rejected |
| Non-canonical BigInt | rejected |
| Non-canonical dynamic number | rejected |
| Record keys out of order | rejected |
| Duplicate `Set` element | rejected |
| Duplicate `Map` key | rejected |
| Unsafe numeric varint | rejected |

## What is not in the payload

No schema identifier, version byte, length prefix on the whole value, or type tags. The format version is hashed into the [fingerprint](/versioning/fingerprinting/) instead of spent as a wire byte.

Two things reach the wire only where the schema declined to supply them: a record's keys, and a dynamic value's type tag. A schema that names everything it holds writes nothing but values.

Bare payloads are compact, but they are neither self-describing nor confidential. **Encrypt them when secrecy is required.**
