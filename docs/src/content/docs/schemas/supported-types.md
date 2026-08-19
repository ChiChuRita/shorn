---
title: Supported Types
description: Every schema shape shorn can encode, with the vendor spelling and byte cost for each.
---

shorn supports the intersection of two sets: shapes JSON Schema can describe and shapes a tagless format can encode. See [Rejected Shapes](/schemas/rejected-shapes/) for the rest.

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

Declare non-negative integers when possible. ZigZag doubles the encoded magnitude, so a signed `int` needs an extra byte at lower values than a `uint`.

Enum members do not have to be strings: `z.enum({ Ok: 200, Missing: 404 })` is a one-byte index, not the eight bytes its numbers would otherwise cost. Members are indexed in canonical order — by value for an all-string enum, by JSON text for any other, since `<` is not a total order across mixed types.

A `uuid` is stored as the 16 bytes it stands for, not the 36 characters it is written as. Those bytes have no case, so shorn encodes lowercase UUIDs only and refuses an uppercase one rather than returning a different string than it was given (RFC 4122 says to generate lowercase). It is the only string format shorn packs: a `date-time` has free fractional digits and a free offset spelling, so no timestamp reproduces the string it was parsed from.

## Collections

| Shape | Zod | Valibot | ArkType | Bytes |
| --- | --- | --- | --- | --- |
| Array | `z.array(T)` | `v.array(T)` | `"T[]"` | varint count + elements |
| Fixed array | `z.array(T).length(n)` | `v.pipe(v.array(T), v.length(n))` | `"T[] == n"` | elements only |
| Tuple | `z.tuple([...])` | `v.tuple([...])` | `["string", "number"]` | elements only |
| Tuple with rest | `z.tuple([...], T)` | `v.tupleWithRest([...], T)` | `["string", "...", "T[]"]` | fixed items + varint count + rest |

An array's count is on the wire; a tuple's comes from the schema. That is why a tuple may contain zero-width elements and an array may not.

An array whose `minItems` equals its `maxItems` is the third case: the count is fixed by the schema, so it is not written and the element may be zero-width, exactly as in a tuple. The count is still checked against the remaining input before anything is allocated, since `minItems` may have arrived from a fetched JSON Schema — and when the element is zero-width there is no input to check it against, so the total number of slots such a schema can fill from nothing is capped at 1,000,000 across nesting instead. See [Hostile Input](/hostile-input/).

## Discriminated unions

`z.discriminatedUnion("kind", [...])` → a varint branch index, then that branch.

Every branch must be an object with one property that is a distinct `const` in each of them. The discriminant costs nothing on the wire — it is a literal inside its branch, and literals encode to zero bytes — so the index is the only byte added, replacing the field a self-describing format would write out in full.

Branches are ordered by discriminant, so declaration order does not reach the wire. Adding a branch shifts the indices at or after it; see [Schema Changes](/versioning/schema-evolution/).

## Type-disjoint unions

`z.union([z.string(), z.number()])` → the same varint branch index, then that branch.

A union needs no discriminant when no two branches share a JSON type, because then the type of the value already names its branch. Nothing is tried and nothing is guessed: exactly one branch can hold a given value, so the encoder reads `typeof` and writes the index.

```ts
z.union([z.string(), z.number()]);              // number is 0, string is 1
z.union([z.string(), z.array(z.string()), z.null()]);
z.union([z.literal("a"), z.literal(3)]);        // the index is the whole payload
```

The seven types are `string`, `number`, `boolean`, `null`, `array`, `object`, and — folded into `number` — `integer`. Branches are ordered by type name, so declaration order does not reach the wire here either.

Two branches that *do* share a type stay [refused](/schemas/rejected-shapes/#overlapping-unions): no value says whether it was declared `z.int()` or `z.number()`, and picking between two `const`-less object branches would mean trying each in turn.

## Recursive schemas

`z.lazy(() => Node)`, or a self-referential getter → the same shapes, with the cycle read again at each level.

```ts
const Node = z.object({
  value: z.string(),
  get children() {
    return z.array(Node);
  },
});
```

A recursive schema adds nothing to the wire. The cycle lives in the schema, so a tree costs exactly what its levels cost written out longhand: the array count at each level, and the fields of each node.

Recursion needs a way out, and that way out is what bounds the payload — a nullable back-edge, an optional field, or an array that can be empty. A cycle without one, such as `{ next: Node }` with no `null` and no `?`, has no finite value and reports a depth error the first time it is used. Nesting is capped at **256 levels** on both sides, since depth comes from the payload rather than the schema. A linked list longer than that wants an array; recursion is for trees.

A definition reached twice but never through itself is not recursive: it is inlined, and encodes and fingerprints exactly as it would written out in full.

A nullable marker over a recursive definition that already admits `null` is dropped rather than doubled, the same rule non-recursive shapes have always followed. Whether the cycle admits `null` cannot be answered while it is still being built, so before 0.3.0 the marker was added and then refused, and `T | null` where `T` was itself a recursive `T | null` did not compile at all.

Recursion composes with both union forms, which is what a JSON value needs:

```ts
const Json = z.union([
  z.string(), z.number(), z.boolean(), z.null(),
  z.array(z.lazy(() => Json)),
  z.record(z.string(), z.lazy(() => Json)),
]);
```

Six branches, no two sharing a type, two of them recursive. A branch that *is* the whole definition works too — its type is read at the far end of the `$ref`.

## Records, open objects, and dynamic values

| Shape | Zod | Bytes |
| --- | --- | --- |
| Record | `z.record(z.string(), T)` | varint count + key/value pairs |
| Open object | `z.looseObject({...})`, `.catchall(T)` | declared fields + a record of the rest |
| Dynamic | `z.any()`, `z.unknown()` | 1 tag byte + the value |

These are the shapes whose contents are not in the schema, so they are the only ones that write something a closed schema does not: a record writes its keys, a dynamic value writes a one-byte type tag. Both are paid for only where they are used.

```ts
z.object({ id: z.uuid(), attributes: z.record(z.string(), z.string()) });
z.object({ id: z.uuid(), payload: z.any() });
```

A record's keys go on the wire in ascending UTF-16 code-unit order, and the decoder refuses any other order, which also refuses a repeated key. A dynamic value holds `null`, a boolean, a number, a string, an array, or a plain object, and nests up to 64 levels; a `Date` or `Map` is refused rather than written as the empty object it looks like. See [Byte Layout](/wire-format/layout/#dynamic-values) for the tag table.

An **open object** is the two put together: declared keys are written bare in their tagless slots, then everything else follows as a record. `z.looseObject` leaves the extras' type open, so their values are tagged; `.catchall(T)` declares it, so only their keys are on the wire. An open object pays one byte even with no extras; a closed object pays nothing. A tail key repeating a declared field is refused on decode, since it would overwrite the field decoded moments earlier.

## Objects

| Shape | Zod | Valibot | ArkType |
| --- | --- | --- | --- |
| Closed | `z.object({...})` | `v.object({...})` | `type({...})` |
| Strict | `z.strictObject({...})` | `v.strictObject({...})` | `"+": "reject"` |
| Optional field | `z.optional(T)` | `v.optional(T)` | `"key?": "string"` |

Objects write a presence bitmap for optional fields (`ceil(n / 8)` bytes, omitted when there are none), followed by values in canonical key order. Field names are never written. The validator and shorn may handle extra properties differently; see [Zod](/validators/zod/), [Valibot](/validators/valibot/), and [ArkType](/validators/arktype/).

## Nullable and nesting

`z.nullable(T)` · `v.nullable(T)` · `"T | null"` → one discriminator byte + value. Both JSON Schema spellings work: an `anyOf` of two branches where one is `null`, and a `type` array of two entries where one is `"null"`. A two-branch nullable is the cheapest union: one byte and no index.

Objects, arrays, and tuples nest without a per-level header — a nested object encodes as only its fields. Nesting the schema fixes has no limit, though at about 1,400 levels through `compile()` — 1,600 through `m` — JavaScript throws a `RangeError` while the codec is being built; that needs a hostile *schema*, not merely hostile bytes. Nesting the *payload* chooses is capped: 256 levels for a recursive schema, 64 for a dynamic value.

## Refinements are validated, not encoded

`.min()`, `.max()`, `.regex()`, `.email()`, and `.refine()` run during encode and decode but do not change the wire format. Adding `.max(300)` does not change the [fingerprint](/versioning/fingerprinting/).

Three refinements are exceptions, because each removes something the payload would otherwise carry. All three change bytes and fingerprint:

| Refinement | JSON Schema | Effect |
| --- | --- | --- |
| `.nonnegative()` on an integer | `minimum >= 0` | unsigned varint instead of ZigZag |
| `.length(n)` on an array | `minItems === maxItems` | the count is dropped |
| `.uuid()` on a string | `format: "uuid"` | 16 bytes instead of 36 characters |

## Low-level extras

No JSON Schema form, so no validator selects them. They are reachable only via the [`m` API](/api/m/):

| Shape | Builder | Bytes |
| --- | --- | --- |
| Raw bytes | `m.bytes()` | varint length + contents |
| 32-bit float | `m.float32()` | 4 |
