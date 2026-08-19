---
title: Rejected Shapes
description: Every shape shorn refuses, the error it throws, and what to do instead.
---

shorn refuses schemas it cannot encode exactly. Unless noted, each refusal is an `EncodeError` thrown when the codec is built — during `compile()` or the first `encode()`, not on a later payload.

| Shape | Refused at | Instead |
| --- | --- | --- |
| Union with two branches of one JSON type | build | a `const` discriminant in every branch |
| Input ≠ output wire shape | build | make both sides agree |
| `$ref` to another document | build | inline the definition |
| Recursion past 256 levels, or with no way out | encode and decode | a nullable back-edge, or an array |
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

## Overlapping unions

> Only nullable, discriminated and type-disjoint JSON Schema unions are currently supported

Three union forms are supported, and each one lets the encoder name a branch without trying it:

- **nullable** — two branches, one of them `null`: one discriminator byte, no index.
- **discriminated** — one property that is a distinct `const` in every branch. See [Discriminated unions](/schemas/supported-types/#discriminated-unions).
- **type-disjoint** — no two branches sharing a JSON type, so the type of the value names its branch. See [Type-disjoint unions](/schemas/supported-types/#type-disjoint-unions).

What stays refused is a union where two branches could both hold one value:

```ts
z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]);  // both objects
z.union([z.int(), z.number()]);                                      // both numbers
z.union([z.string(), z.any()]);                                      // any overlaps everything
```

Picking a branch there would mean trying each in turn and keeping the first that fits — and where two fit, the wrong choice decodes silently into a valid-looking value. Give the branches a discriminant, or give each variant its own codec and select it by [fingerprint](/versioning/schema-evolution/).

`integer` and `number` are one type at runtime, since nothing about `5` says which it was declared as. A branch with a `type` array, or with no `type` at all, is refused for the same reason: it overlaps whatever sits beside it.

Extra properties are a separate question from open objects, which are [supported](/schemas/supported-types/#records-open-objects-and-dynamic-values). When a validator omits `additionalProperties` entirely — ArkType, and some Valibot object schemas — the object is closed with no tail to hold extras, so the codec builds and encoding an extra property throws `Unknown object property "x"`.

## Recursion that cannot terminate

> Recursive value nests deeper than 256

Recursive schemas are [supported](/schemas/supported-types/#recursive-schemas). Two things about them are still refused.

A cycle needs a way out — a nullable back-edge, an optional field, or an array that may be empty. A cycle without one describes no finite value; rather than prove that at build time, shorn lets the depth counter report it the first time the schema is used.

Depth is capped at 256 levels on both sides, since a recursive schema takes its nesting from the payload and a couple of bytes per level would otherwise buy unbounded stack. Anything deeper wants an array rather than a cycle.

> Unsupported JSON Schema reference "…"; only same-document references are supported

A `$ref` is resolved against the document it appears in. Fetching a remote schema mid-build is not something a serializer should be doing.

## Intersections and never

> Unsupported JSON Schema combinator allOf

An intersection (`allOf`) would need the merged shape, which the vendor has not computed, and `z.never()` (`not`) admits no value to encode. Merge the intersection yourself into one object schema.

## Different input and output shapes

> Schemas with different input and output wire shapes require a bidirectional codec and are not yet supported

shorn converts and compares both `jsonSchema.input()` and `.output()`, and refuses a default or widening refinement when the two wire shapes differ, because it cannot reverse that change during encoding. With `z.codec()`, JSON Schema conversion usually throws before this check.

## Rich types and transforms

> \<the vendor's message\> — shorn encodes the wire shape; convert rich types at the edge

`z.date()`, `z.bigint()`, `z.map()`, `z.set()`, `v.date()`, ArkType `Date`. The wall is JSON Schema's, not any vendor's: all three throw before shorn is involved, and shorn keeps their reason and appends the remedy.

A one-way transform has no reverse direction in Standard Schema either, so shorn cannot undo it on decode. Use `z.codec()` for a declarative bidirectional pair, applied outside the codec. See [Date, BigInt, Map, Set](/schemas/rich-types/).

## Empty enums, and members with no JSON text

> Empty enums are unsupported

No valid value means no index to write.

> Enum member NaN has no JSON text of its own

An enum whose members are not all strings indexes them by their JSON text, because `<` is not a total order across mixed types. Four numbers do not survive that trip: `NaN`, `Infinity` and `-Infinity` all write as `null`, so they would share an index with each other and with a real `null` member, and `-0` writes and reads back as `0`. All four are refused rather than reordered.

Encoding `-0` against an enum that *does* list `0` is refused too, at encode time rather than at build time. A `Map` keys by SameValueZero, so `-0` used to find the `0` member, go out as that member's index and come back as `0` — the round trip broke silently. `m.literal(0).encode(-0)` has always been refused for the same reason; since 0.3.0 the enum agrees.

The same four as a **single literal** are not caught, because the vendor's JSON Schema has already lost them: `z.literal(NaN)` and both infinities arrive as `{ type: "number", const: null }`, and `z.literal(-0)` as `{ const: 0 }`. The first three build a codec that refuses every value it is given and decodes to `null`; `-0` round-trips to `0`. Do not use a non-finite number or `-0` as a literal.

## Arrays of zero-width elements

```ts
z.array(z.literal("x"));  // literal encodes to 0 bytes
z.array(z.tuple([]));
z.array(z.object({}));
```

An array element must be able to use at least one byte. Otherwise a tiny payload could declare a million elements without providing any element data, and the decoder could not bound the allocation. A **tuple** may contain zero-width elements because its length comes from the schema.

An array whose count the schema fixes may too, for the same reason — but only up to 1,000,000 slots in total, counted through nesting and through any zero-width object or tuple in between. Past that the same message refuses it: a fixed count needs no payload to satisfy, so nothing but the schema can bound it.

```ts
z.array(z.literal("x")).length(1_000_000);                     // fine: a million slots
z.array(z.array(z.literal("x")).length(1000)).length(1000);     // refused: a million and one
```

See [Hostile Input](/hostile-input/).

If you need a count of a constant, encode the count: `z.int().nonnegative()`.

## Stacked null or presence markers

> This schema already decodes to null; wrapping it in nullable() would give null two encodings

> This schema already decodes to undefined; wrapping it in optional() would give undefined two encodings

```ts
m.literal(null).nullable();                  // null is already the only value
m.string().optional().nullable().optional(); // undefined would have two spellings
compile(z.string().nullable()).nullable();   // the flag survives compile()
```

Two markers for the same value would make `[0]` and `[1, 0]` decode alike, so decoding would no longer be injective. Repeating one wrapper (`x.optional().optional()`) is not an error: it collapses and returns the identical object.

Drop the redundant wrapper. Mixing the two once is supported and meaningful: `m.string().optional().nullable()` tells absent apart from null.

A **vendor schema** that spells the same thing twice is not this error. `z.any().nullable()`, `z.null().nullable()` and `z.literal(null).nullable()` all compile, because `compile()` sees the inner shape already holds `null` and drops the wrapper. This error is about a marker you stacked yourself — on an `m` schema, or on a codec `compile()` already returned.

## Missing structural interface

> Standard Schema provides validation but not structure; pass a Standard JSON Schema implementation as the second argument

Valibot always needs this, as do Zod before 4.2 and ArkType before 2.1.28. Pass the `structure` argument; see [Valibot](/validators/valibot/).

## Uppercase UUIDs

> Expected a lowercase UUID, received X

A `format: "uuid"` string is stored as its 16 bytes, and 16 bytes have no case. Validators accept either spelling (RFC 4122 says to generate lowercase and accept both), so this is refused at encode and only for values that would not survive the round trip. Lowercase at the edge; `String.prototype.toLowerCase` is exact for hexadecimal.

No other string format is packed for the same reason. A `date-time` has free fractional digits and a free offset spelling, so it stays a string.

## Async validation on a sync entry point

> This Standard Schema validates asynchronously; use encodeAsync/decodeAsync, which accept either this schema or a codec built from it.

Pass the same codec to `encodeAsync`/`decodeAsync`; `fingerprinted()` codecs are accepted too. See [Validation](/core-concepts/validation/#async-validation).
