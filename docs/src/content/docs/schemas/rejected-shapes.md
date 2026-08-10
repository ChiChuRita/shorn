---
title: Rejected Shapes
description: Every shape shorn refuses, the error it throws, and what to do instead.
---

shorn refuses schemas it cannot encode exactly. Unless noted, each refusal is an `EncodeError` thrown when the codec is built: during `compile()` or the first `encode()`, not on a later payload.

## Summary

| Shape | Refused at | Instead |
| --- | --- | --- |
| Undiscriminated union | build | a `const` discriminant in every branch |
| Recursive schema | build | flatten, or nest as `m.bytes()` |
| Input ≠ output wire shape | build | make both sides agree |
| `Date`, `bigint`, `Map`, `Set` | vendor, before shorn | convert at the edge |
| Transform | vendor, before shorn | `z.codec()` outside the codec |
| Empty enum | build | — |
| `NaN`, `Infinity` or `-0` enum member | build | a finite number, or a string |
| Array of zero-width element | build | encode a count instead |
| A second null or presence marker | build | drop the redundant wrapper |
| No Standard JSON Schema | build | pass `structure` |
| Async schema on a sync entry point | encode | `encodeAsync` / `decodeAsync` |
| Unknown property | encode | close the object, or strip first |
| Uppercase UUID | encode | lowercase it, as RFC 4122 asks |

## General unions

> Only nullable and discriminated JSON Schema unions are currently supported

A **discriminated** union is supported: one property that is a distinct `const` in every branch tells the decoder which branch to read, and the index costs one byte. See [Supported Types](/schemas/supported-types/#discriminated-unions).

A union without one is refused. Picking a branch would mean trying each in turn and keeping the first that fits, and where two branches both fit, the wrong choice decodes silently into a valid-looking value. Give the branches a discriminant, or give each variant its own codec and select it by [fingerprint](/versioning/schema-evolution/).

Extra properties are a separate question from open objects, which are now [supported](/schemas/supported-types/). When a validator omits `additionalProperties` entirely — ArkType, and some Valibot object schemas — the object is closed with no tail to hold extras, so the codec builds and encoding an extra property throws `Unknown object property "x"`.

## Recursive schemas

> Recursive schemas ($ref) are not supported; flatten to a fixed depth or nest the recursive part as bytes

A `$ref` back to the root has no bounded wire shape. Without one, shorn cannot compute the `_minWidth` used to limit allocation during decoding. Flatten the schema to a fixed depth, or encode the nested part separately and store it in an `m.bytes()` field.

## Intersections and never

> Unsupported JSON Schema combinator allOf

An intersection (`allOf`) would need the merged shape, which the vendor has not computed, and `z.never()` (`not`) admits no value to encode. Merge the intersection yourself into one object schema.

## Different input and output shapes

> Schemas with different input and output wire shapes require a bidirectional codec and are not yet supported

shorn converts and compares both `jsonSchema.input()` and `.output()`. It refuses a default or widening refinement when the two wire shapes differ because it cannot reverse that change during encoding. With `z.codec()`, JSON Schema conversion usually throws before this check.

## Rich types

> \<the vendor's message\> — shorn encodes the wire shape; convert rich types at the edge

`z.date()`, `z.bigint()`, `z.map()`, `z.set()`, `v.date()`, ArkType `Date`. The wall is JSON Schema's, not any vendor's: all three throw before shorn is involved, and shorn keeps their reason and appends the remedy. See [Date, BigInt, Map, Set](/schemas/rich-types/).

## Transforms

A one-way transform has no reverse direction in Standard Schema, so shorn cannot undo it on decode. Use `z.codec()` for a declarative bidirectional pair, applied outside the codec.

## Empty enums

> Empty enums are unsupported

No valid value means no index to write.

## Enum members with no JSON text of their own

> Enum member NaN has no JSON text of its own

An enum whose members are not all strings indexes them in the order of their JSON
text, because `<` is not a total order across mixed types. Four numbers do not
survive that trip: `NaN`, `Infinity` and `-Infinity` all write as `null`, so they
would share an index with each other and with a real `null` member; `-0` writes as
`0` and reads back as `0`, so the member that returns is not the member that was
declared. Either way a member would be unencodable or two indexes would decode to
one value, so all four are refused rather than reordered. JSON Schema cannot
express any of them either.

The same four as a **single literal** are not caught, because the vendor's JSON
Schema has already lost them by the time shorn reads it: `z.literal(NaN)` and both
infinities arrive as `{ type: "number", const: null }`, and `z.literal(-0)` arrives
as `{ const: 0 }`. The first three produce a codec that refuses every value it is
given (*"Expected literal null"*) and decodes to `null`; `-0` round-trips to `0`.
Do not use a non-finite number or `-0` as a literal.

## Arrays of zero-width elements

```ts
z.array(z.literal("x"));  // literal encodes to 0 bytes
z.array(z.tuple([]));
z.array(z.object({}));
```

An array element must be able to use at least one byte. Otherwise, a tiny payload could declare a million elements without providing any element data, and the decoder could not bound the allocation. A **tuple** may contain zero-width elements because its length comes from the schema. See [Hostile Input](/hostile-input/).

If you need a count of a constant, encode the count: `z.int().nonnegative()`.

## Stacked null or presence markers

> This schema already decodes to null; wrapping it in nullable() would give null two encodings

> This schema already decodes to undefined; wrapping it in optional() would give undefined two encodings

```ts
m.literal(null).nullable();                  // null is already the only value
m.string().optional().nullable().optional(); // undefined would have two spellings
compile(z.string().nullable()).nullable();   // the flag survives compile()
```

Two markers for the same value would make `[0]` and `[1, 0]` decode alike, so distinct payloads would produce the same value and decoding would no longer be injective. Repeating one wrapper (`x.optional().optional()`) is not an error: it collapses and returns the identical object, because `T | undefined | undefined` is exactly `T | undefined`. Only a genuinely duplicated marker throws.

Drop the redundant wrapper. Mixing the two once is supported and meaningful: `m.string().optional().nullable()` tells absent apart from null.

## Missing structural interface

> Standard Schema provides validation but not structure; pass a Standard JSON Schema implementation as the second argument

Valibot always needs this option, as do Zod versions before 4.2 and ArkType versions before 2.1.28. Pass the `structure` argument; see [Valibot](/validators/valibot/).

## Uppercase UUIDs

> Expected a lowercase UUID, received X

A `format: "uuid"` string is stored as its 16 bytes, and 16 bytes have no case. A validator accepts either spelling (RFC 4122 says to generate lowercase and accept both), so this is refused at encode rather than at build, and only for the values that would not survive the round trip. Lowercase the value at the edge; `String.prototype.toLowerCase` is exact for hexadecimal.

The same reasoning is why no other string format is packed. A `date-time` has free fractional digits and a free offset spelling, so a timestamp cannot reproduce the string it was parsed from, and it stays a string.

## Async validation on a sync entry point

> This Standard Schema validates asynchronously; use encodeAsync/decodeAsync, which accept either this schema or a codec built from it.

Pass the same codec to `encodeAsync`/`decodeAsync`; `fingerprinted()` codecs are accepted too. See [Validation](/core-concepts/validation/).
