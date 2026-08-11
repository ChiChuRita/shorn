---
title: Date, BigInt, Map, Set
description: JSON Schema has no form for these, so every vendor refuses them before shorn sees anything. Convert at the edge.
---

| Schema | Result |
| --- | --- |
| `z.date()`, `z.bigint()`, `z.map()`, `z.set()`, `z.undefined()`, `z.nan()` | Zod: *"X cannot be represented in JSON Schema"* |
| `v.date()` | Valibot: *"The 'date' schema cannot be converted to JSON Schema"* |
| ArkType `Date`, `bigint` | `{ code: "date" }`, `{ code: "domain", domain: "bigint" }` |
| `z.string().transform(...)` | Zod: *"Transforms cannot be represented"* |

**This is a JSON Schema limitation, not a validator-specific one.** shorn gets structure through Standard JSON Schema, so it cannot encode values JSON Schema cannot describe. It preserves the validator's own error and appends guidance.

## The pattern

**shorn encodes a wire-friendly shape. Convert rich values at the application boundary.** In Zod, `z.codec()` can declare both directions:

```ts
const Rich = z.object({
  when: z.codec(z.iso.datetime(), z.date(), {
    decode: (text) => new Date(text),
    encode: (date) => date.toISOString(),
  }),
  id: z.codec(z.string(), z.bigint(), {
    decode: (text) => BigInt(text),
    encode: (big) => big.toString(),
  }),
});

const Wire = z.object({ when: z.iso.datetime(), id: z.string() });
const codec = fingerprinted(compile(Wire));

const bytes = codec.encode(z.encode(Rich, value)); // rich → wire → bytes
const back = z.decode(Rich, codec.decode(bytes));  // bytes → wire → rich
```

Valibot and ArkType transforms do not expose a reverse direction through Standard Schema, so write both conversions explicitly. Either way, use a `Wire` schema for shorn and convert outside it.

The conversion has to stay separate because Standard Schema v1 exposes only `validate` and `jsonSchema` — there is no reverse operation, and `z.encode` is Zod-specific. Supplying `structure` does not rescue a bidirectional codec either: rich values fail validation as wire values, while wire values are transformed into rich values the wire codec cannot encode. For a Zod codec, `jsonSchema.output()` throws outright, and shorn needs both sides to agree.

## Choosing a wire form

| Rich value | Wire form | Cost |
| --- | --- | --- |
| `Date` | `z.iso.datetime()` string | ~25 bytes |
| `Date`, if you own both ends | `z.int()` epoch millis | 6–7 bytes |
| `bigint` | `z.string()` | digits + 1 |
| `Map` | `z.array(z.tuple([K, V]))` | count + entries |
| `Map` with known keys | `z.object({...})` | bitmap + values |
| `Set` | `z.array(T)` | count + elements |
| `undefined` field | `z.optional(T)` | one bit |

An epoch integer is about 20 bytes smaller than an ISO-8601 string. Choose it in your own codec if you want it; shorn will not convert automatically, because a round trip could change the original string representation.

The [fingerprint](/versioning/fingerprinting/) identifies only the wire shape, so changing conversion functions without changing that shape does not change it.

Values such as `RegExp`, `URL`, class instances, and functions have no sensible wire form at all. Store only the data you need — a URL string, a regular expression's source and flags — and convert at the boundary.
