---
title: Supported Types
description: Every schema shape shorn can encode, with the spelling in each validator and the byte cost.
---

shorn supports the shapes that sit in two sets at once: what JSON Schema can describe, and what a format without type tags can encode. Everything else is on [Rejected Shapes](/schemas/rejected-shapes/).

## Primitives

| Shape | Zod | Valibot | ArkType | Bytes |
| --- | --- | --- | --- | --- |
| String | `z.string()` | `v.string()` | `"string"` | varint length + UTF-8 |
| Boolean | `z.boolean()` | `v.boolean()` | `"boolean"` | 1 |
| Signed int | `z.int()` | `v.pipe(v.number(), v.integer())` | `"number.integer"` | ZigZag varint |
| Unsigned int | `z.int().nonnegative()` | `+ v.minValue(0)` | `"number.integer >= 0"` | varint |
| Float | `z.number()` | `v.number()` | `"number"` | 8 |
| Literal | `z.literal(v)` | `v.literal(v)` | `"'M'"` | 0 |
| Null | `z.null()` | `v.null()` | `"null"` | 0 |
| Enum | `z.enum([...])` | `v.picklist([...])` | `"'M' \| 'F'"` | varint index |
| UUID | `z.uuid()` | `v.pipe(v.string(), v.uuid())` | `"string.uuid"` | 16 |
| `Date` | `z.date()` | `v.date()` | `"Date"` | 6 for any current date |
| `date-time` string | `z.iso.datetime()` | `v.pipe(v.string(), v.isoTimestamp())` | none | 6 |
| BigInt | `z.bigint()` | `v.bigint()` | `"bigint"` | 1 + one per magnitude byte |

A varint is a variable-length integer: small values take one byte, larger values take more. ZigZag is the trick that lets a varint hold negative numbers, by interleaving them with the positives (`0, -1, 1, -2, 2` become `0, 1, 2, 3, 4`). It doubles the magnitude, so a signed `int` needs an extra byte at half the value a `uint` would. Declare an integer non-negative whenever it is.

Enum members do not have to be strings. `z.enum({ Ok: 200, Missing: 404 })` writes a one-byte index instead of the eight bytes each number would otherwise cost. Members are indexed in canonical order: by value for an all-string enum, and by JSON text for anything else, because `<` cannot order mixed types consistently.

A `uuid` is stored as the 16 bytes it stands for, not the 36 characters it is written as. Bytes have no case, so shorn accepts lowercase UUIDs only. An uppercase one is refused rather than handed back as a different string than the one you gave it. RFC 4122 says to generate lowercase.

`uuid` and `date-time` are the only two string formats shorn packs. Every other format is stored as text. A `date-time` becomes the 6 bytes of the instant it names. Epoch milliseconds cannot remember how many fractional digits the string had or how its offset was written, so only the `toISOString()` spelling is accepted and every other spelling is refused. ArkType has no `format: "date-time"` spelling: its `"string.date.iso"` converts to a pattern, so it stays an ordinary string.

A `Date` is those same 6 bytes, decoded back to a `Date`. A `bigint` is a varint header holding the byte count and sign of the magnitude, followed by the magnitude itself in little-endian order, so it has no practical width limit. See [Date, BigInt, Map, Set](/schemas/rich-types/) for the spellings in each validator, the Valibot recipe, and the `x-shorn` keyword all four travel on.

## Collections

| Shape | Zod | Valibot | ArkType | Bytes |
| --- | --- | --- | --- | --- |
| Array | `z.array(T)` | `v.array(T)` | `"T[]"` | varint count + elements |
| Fixed array | `z.array(T).length(n)` | `v.pipe(v.array(T), v.length(n))` | `"T[] == n"` | elements only |
| Tuple | `z.tuple([...])` | `v.tuple([...])` | `["string", "number"]` | elements only |
| Tuple with rest | `z.tuple([...], T)` | `v.tupleWithRest([...], T)` | `["string", "...", "T[]"]` | fixed items + varint count + rest |
| Set | `z.set(T)` | `v.set(T)` | refused | varint count + elements |
| Map | `z.map(K, V)` | `v.map(K, V)` | refused | varint count + key/value pairs |

An array writes its element count on the wire. A tuple gets its count from the schema. That difference is why a tuple may contain zero-width elements and an array may not.

A **Set** writes exactly what an array of the same elements writes, and a **Map** exactly what an array of `[key, value]` tuples writes, both in iteration order. What differs is what they decode to and their [fingerprint](/versioning/fingerprinting/), so a payload written as one is never read back as the other. Neither has a fixed-count form, so neither may hold a zero-width element. The decoder refuses a duplicate element or key instead of silently merging it. ArkType's `Set` and `Map` keywords carry no element type and are [refused](/schemas/rejected-shapes/#arktypes-set-and-map).

An array whose `minItems` equals its `maxItems` is a third case. The schema fixes the count, so the count is not written and the element may be zero-width, just as in a tuple. The count is still checked against the remaining input before anything is allocated, because `minItems` may have come from a fetched JSON Schema. When the element is zero-width there is no input to check against, so instead the total number of slots such a schema can fill from nothing is capped at 1,000,000 across all nesting. See [Hostile Input](/hostile-input/).

## Discriminated unions

`z.discriminatedUnion("kind", [...])` → a varint branch index, then that branch.

Every branch must be an object with one property that is a distinct `const` in each branch. That property, the discriminant, costs nothing on the wire: it is a literal inside its branch, and literals encode to zero bytes. So the index is the only byte added, and it replaces the field a self-describing format would write out in full.

Branches are ordered by discriminant value, so declaration order does not reach the wire. Adding a branch shifts the indices of the branches that sort after it. See [Schema Changes](/versioning/schema-evolution/).

## Type-disjoint unions

`z.union([z.string(), z.number()])` → the same varint branch index, then that branch.

A union needs no discriminant when no two branches share a JSON type, because then the type of the value already tells you which branch it belongs to. Nothing is tried and nothing is guessed. Exactly one branch can hold a given value, so the encoder reads `typeof` and writes the index.

```ts
z.union([z.string(), z.number()]);              // number is 0, string is 1
z.union([z.string(), z.array(z.string()), z.null()]);
z.union([z.literal("a"), z.literal(3)]);        // the index is the whole payload
```

The seven JSON types are `string`, `number`, `boolean`, `null`, `array`, `object`, and `integer`, which folds into `number`. Branches are ordered by type name, so again declaration order does not reach the wire.

Two branches that share a type stay [refused](/schemas/rejected-shapes/#overlapping-unions). Nothing about `5` says whether it was declared as `z.int()` or `z.number()`, and choosing between two object branches without a `const` would mean trying each one in turn.

## Recursive schemas

`z.lazy(() => Node)`, or a self-referencing getter → the same shapes, with the cycle read again at each level.

```ts
const Node = z.object({
  value: z.string(),
  get children() {
    return z.array(Node);
  },
});
```

A recursive schema adds nothing to the wire. The cycle lives in the schema, so a tree costs exactly what its levels would cost written out by hand: the array count at each level, and the fields of each node.

Recursion needs a way to stop, and that exit is what keeps the payload finite: a nullable back edge, an optional field, or an array that can be empty. A cycle without one, such as `{ next: Node }` with no `null` and no `?`, describes no finite value, and reports a depth error the first time it is used. Nesting is capped at **256 levels** on both sides, because here the depth comes from the payload rather than the schema. A linked list longer than that wants an array. Recursion is for trees.

A definition that is reached twice but never through itself is not recursive. It is inlined, and encodes and fingerprints exactly as it would written out in full.

The cycle has to pass through an array or an object. A recursive type reached through a `Set` or `Map` element is [refused](/schemas/rejected-shapes/#recursion-through-a-set-or-map), because that element is converted as a document of its own, and a reference inside it would resolve against the wrong document.

A nullable marker over a recursive definition that already admits `null` is dropped rather than doubled, the same rule every non-recursive shape follows. Whether a cycle admits `null` cannot be answered while it is still being built, so before 0.3.0 the marker was added and then refused, and `T | null` where `T` was itself a recursive `T | null` did not compile at all.

Recursion works with both union forms, which is what a general JSON value needs:

```ts
const Json = z.union([
  z.string(), z.number(), z.boolean(), z.null(),
  z.array(z.lazy(() => Json)),
  z.record(z.string(), z.lazy(() => Json)),
]);
```

Six branches, no two sharing a type, two of them recursive. A branch that *is* the whole definition works too. Its type is read at the far end of the `$ref`.

## Records, open objects, and dynamic values

| Shape | Zod | Bytes |
| --- | --- | --- |
| Record | `z.record(z.string(), T)` | varint count + key/value pairs |
| Open object | `z.looseObject({...})`, `.catchall(T)` | declared fields + a record of the rest |
| Dynamic | `z.any()`, `z.unknown()` | 1 tag byte + the value |

These are the shapes whose contents the schema does not know in advance, so they are the only ones that write something a closed schema never does. A record writes its keys. A dynamic value writes a one-byte type tag. You pay for both only where you use them.

```ts
z.object({ id: z.uuid(), attributes: z.record(z.string(), z.string()) });
z.object({ id: z.uuid(), payload: z.any() });
```

A record's keys go on the wire in ascending UTF-16 code unit order, and the decoder refuses any other order, which also rules out a repeated key. A dynamic value can hold `null`, a boolean, a number, a string, an array, or a plain object, nested up to 64 levels. A `Date` or a `Map` under `z.any()` is refused rather than written as the empty object it looks like. See [Byte Layout](/wire-format/layout/#dynamic-values) for the tag table.

An **open object** combines the two. The declared fields are written bare in their positional slots, then everything else follows as a record. `z.looseObject` leaves the type of the extras open, so their values carry a tag. `.catchall(T)` declares the type, so only their keys are on the wire. An open object costs one byte even when it has no extras. A closed object costs nothing. A key in the tail that repeats a declared field is refused on decode, because it would overwrite a field decoded a moment earlier.

## Objects

| Shape | Zod | Valibot | ArkType |
| --- | --- | --- | --- |
| Closed | `z.object({...})` | `v.object({...})` | `type({...})` |
| Strict | `z.strictObject({...})` | `v.strictObject({...})` | `"+": "reject"` |
| Optional field | `z.optional(T)` | `v.optional(T)` | `"key?": "string"` |

An object writes a presence bitmap for its optional fields, `ceil(n / 8)` bytes, left out entirely when there are none. Then come the values in canonical key order. Field names are never written. The validator and shorn may handle extra properties differently; see [Zod](/validators/zod/), [Valibot](/validators/valibot/), and [ArkType](/validators/arktype/).

## Nullable and nesting

`z.nullable(T)` · `v.nullable(T)` · `"T | null"` → one marker byte, then the value if there is one. Both JSON Schema spellings work: an `anyOf` with two branches where one is `null`, and a `type` array with two entries where one is `"null"`. A two-branch nullable is the cheapest union there is: one byte and no index.

Objects, arrays, and tuples nest with no per-level header. A nested object encodes as nothing more than its fields. Nesting fixed by the schema has no limit of its own, though at about 1,400 levels through `compile()`, or 1,600 through `m`, JavaScript throws a `RangeError` while the codec is being built. Reaching that takes a hostile *schema*, not merely hostile bytes. Nesting chosen by the *payload* is capped: 256 levels for a recursive schema, 64 for a dynamic value.

## Refinements are validated, not encoded

`.min()`, `.max()`, `.regex()`, `.email()`, and `.refine()` run during encode and decode, but they do not change the wire format. Adding `.max(300)` does not change the [fingerprint](/versioning/fingerprinting/).

Four refinements are exceptions, because each one removes something the payload would otherwise have to carry. All four change both the bytes and the fingerprint:

| Refinement | JSON Schema | Effect |
| --- | --- | --- |
| `.nonnegative()` on an integer | `minimum >= 0` | unsigned varint instead of ZigZag |
| `.length(n)` on an array | `minItems === maxItems` | the count is dropped |
| `.uuid()` on a string | `format: "uuid"` | 16 bytes instead of 36 characters |
| `z.iso.datetime()` on a string | `format: "date-time"` | 6 bytes instead of about 25 characters |

## Low-level extras

These have no JSON Schema form, so no validator can select them. They are reachable only through the [`m` API](/api/m/):

| Shape | Builder | Bytes |
| --- | --- | --- |
| Raw bytes | `m.bytes()` | varint length + contents |
| 32-bit float | `m.float32()` | 4 |

`m.date()`, `m.bigint()`, `m.set()` and `m.map()` are not on this list. They travel on shorn's own `x-shorn` keyword, so a validator does select them. See [Date, BigInt, Map, Set](/schemas/rich-types/). There is no `m` builder for a `date-time` string, which `compile()` reaches through the format alone.
