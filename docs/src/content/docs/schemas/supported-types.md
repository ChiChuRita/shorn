---
title: Supported Types
description: Every schema shape shorn can encode, with the vendor spelling and byte cost for each.
---

shorn supports the intersection of two sets: shapes JSON Schema can describe and shapes a tagless format can encode. See [Rejected Shapes](/schemas/rejected-shapes/) for unsupported cases.

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

Declare non-negative integers when possible. ZigZag encoding doubles the encoded magnitude, so a signed `int` needs an extra byte at lower values than a `uint`.

An enum's members do not have to be strings: `z.enum({ Ok: 200, Missing: 404 })` is a one-byte index, not the eight bytes its numbers would otherwise cost. Members are indexed in canonical order: by the value for an all-string enum, by its JSON text for any other, since `<` is not a total order across mixed types.

A `uuid` format is stored as the 16 bytes it stands for rather than the 36 characters it is written as. Those bytes have no case, so shorn encodes lowercase UUIDs only and refuses an uppercase one rather than returning a different string than it was given; RFC 4122 says to generate lowercase. This is the only string format shorn packs. A `date-time` is not recoverable, because its fractional digits and offset spelling are free and no timestamp reproduces the string it was parsed from.

## Collections

| Shape | Zod | Valibot | ArkType | Bytes |
| --- | --- | --- | --- | --- |
| Array | `z.array(T)` | `v.array(T)` | `"T[]"` | varint count + elements |
| Fixed array | `z.array(T).length(n)` | `v.pipe(v.array(T), v.length(n))` | `"T[] == n"` | elements only |
| Tuple | `z.tuple([...])` | `v.tuple([...])` | `["string", "number"]` | elements only |
| Tuple with rest | `z.tuple([...], T)` | `v.tupleWithRest([...], T)` | — | fixed items + varint count + rest |

An array's count is on the wire; a tuple's comes from the schema. That is why a tuple may contain zero-width elements and an array may not.

An array whose `minItems` equals its `maxItems` is the third case: the count is fixed by the schema, so it is not written and the element may be zero-width, exactly as in a tuple. The count is still checked against the remaining input before anything is allocated; `minItems` may arrive from a JSON Schema that was fetched rather than written, so it earns no more trust than a length the payload declared for itself.

## Discriminated unions

`z.discriminatedUnion("kind", [...])` → a varint branch index, then that branch.

Every branch must be an object with one property that is a distinct `const` in each of them. That property is the discriminant, and it costs nothing on the wire: it is a literal inside its branch, and a literal encodes to zero bytes. So the index is the only byte added, and it replaces the field a self-describing format would have written out in full.

Branches are ordered by discriminant, so declaration order does not reach the wire. Adding a branch shifts the indices at or after it; see [Schema Changes](/versioning/schema-evolution/).

A union without such a property is still [refused](/schemas/rejected-shapes/#general-unions) — choosing a branch would mean guessing.

## Records, open objects, and dynamic values

| Shape | Zod | Bytes |
| --- | --- | --- |
| Record | `z.record(z.string(), T)` | varint count + key/value pairs |
| Open object | `z.looseObject({...})`, `.catchall(T)` | declared fields + a record of the rest |
| Dynamic | `z.any()`, `z.unknown()` | 1 tag byte + the value |

These are the two shapes whose contents are not in the schema, so they are the two that write something a closed schema does not: a record writes its keys, and a dynamic value writes a one-byte type tag. Both are paid for only where they are used.

A record's keys go on the wire in ascending UTF-16 code-unit order, and the decoder refuses any other order, which also refuses a repeated key. A dynamic value holds `null`, a boolean, a number, a string, an array, or a plain object, and nests up to 64 levels; a `Date` or `Map` is refused rather than written as the empty object it looks like. See [Wire Format](/wire-format/layout/#dynamic-values) for the tag table.

```ts
z.object({ id: z.uuid(), attributes: z.record(z.string(), z.string()) });
z.object({ id: z.uuid(), payload: z.any() });
```

An **open object** is the two put together: the keys the schema names are written bare, in their tagless slots, and whatever else the value holds follows as a record. `z.looseObject` leaves the extras' type open, so their values are tagged; `.catchall(T)` declares it, so only their keys are on the wire. A closed object is unchanged and pays nothing for this — an open one pays one byte when it has no extras at all.

A key in the tail that repeats a declared field is refused on decode. It would overwrite the field decoded moments earlier, so two payloads would decode to the same value.

## Objects

| Shape | Zod | Valibot | ArkType |
| --- | --- | --- | --- |
| Closed | `z.object({...})` | `v.object({...})` | `type({...})` |
| Strict | `z.strictObject({...})` | `v.strictObject({...})` | `"+": "reject"` |
| Optional field | `z.optional(T)` | `v.optional(T)` | `"key?": "string"` |

Objects write a presence bitmap for optional fields (`ceil(n / 8)` bytes, omitted when there are no optional fields), followed by values in canonical key order. Field names are never written. The validator and shorn may handle extra properties differently; see [Zod](/validators/zod/), [Valibot](/validators/valibot/), and [ArkType](/validators/arktype/).

## Nullable

`z.nullable(T)` · `v.nullable(T)` · `"T | null"` → one discriminator byte + value.

Both JSON Schema spellings work: an `anyOf` of two branches where one is `null`, and a `type` array of two entries where one is `"null"`. Nullable is the **only** union supported.

## Nesting

Objects, arrays, and tuples can be nested without adding a per-level header. A nested object is encoded as only its fields.

Recursive schemas are unsupported because a `$ref` to the root has no bounded wire shape, so shorn cannot compute `_minWidth`. There is also no depth limit for non-recursive nesting. At about 5,900 levels, JavaScript throws a `RangeError` instead of a `DecodeError`. This requires a hostile *schema*, not merely hostile bytes.

## Refinements are validated, not encoded

`.min()`, `.max()`, `.regex()`, `.email()`, and `.refine()` run during encode and decode but do not change the wire format. Adding `.max(300)`, for example, does not change the [fingerprint](/versioning/fingerprinting/).

Three refinements are exceptions, because each one removes something the payload would otherwise have to carry. All three change bytes and fingerprint:

| Refinement | JSON Schema | Effect |
| --- | --- | --- |
| `.nonnegative()` on an integer | `minimum >= 0` | unsigned varint instead of ZigZag |
| `.length(n)` on an array | `minItems === maxItems` | the count is dropped |
| `.uuid()` on a string | `format: "uuid"` | 16 bytes instead of 36 characters |

## Low-level extras

No JSON Schema form, so no validator selects them. They are reachable only via the [`m` API](/wire-format/low-level-api/):

| Shape | Builder | Bytes |
| --- | --- | --- |
| Raw bytes | `m.bytes()` | varint length + contents |
| 32-bit float | `m.float32()` | 4 |
