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

**This is a JSON Schema limitation, not a validator-specific one.** shorn gets structure through Standard JSON Schema, so it cannot encode values that JSON Schema cannot describe. shorn preserves the validator's error and adds guidance for converting the value.

## The pattern

**shorn encodes a wire-friendly shape. Convert rich values at the application boundary.** In Zod, `z.codec()` can define both conversions:

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

Valibot and ArkType transforms do not expose a reverse direction through Standard Schema, so write both conversions explicitly. Use a `Wire` schema for shorn and convert outside it.

## Why separate conversion is required

- **Standard Schema v1 exposes only `validate` and `jsonSchema`.** It has no reverse operation. `z.encode` is specific to Zod, and calling it would require validator-specific code.
- **For a Zod codec, `jsonSchema.output()` throws.** `input()` returns the wire shape, while the output is the rich type. shorn needs both sides to agree.
- **shorn calls the schema's validation direction during both encode and decode.** Supplying `structure` does not make a bidirectional codec work: rich values fail validation as wire values, while wire values are transformed into rich values that the wire codec cannot encode.

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

An epoch integer is about 20 bytes smaller than an ISO-8601 string. You can choose it in your own codec, but shorn will not convert automatically because a round trip could change the original string representation.

The [fingerprint](/versioning/fingerprinting/) identifies only the wire shape. Changing conversion functions without changing that shape does not change the fingerprint.

## Values with no sensible wire form

Values such as `RegExp`, `URL`, class instances, and functions need an explicit wire representation. Store only the data you need, such as a URL string or a regular expression's source and flags, and convert at the application boundary.
