---
title: Canonical Bytes
description: Every supported value has exactly one encoding, with one documented exception for low-level NaN values.
---

For any value a validator-backed schema accepts, there is exactly one valid encoding. Field order, enum order, integer spelling, and byte order are all derived from the schema. None of them is configurable.

## Field order is derived

Fields are written in the order of their names, compared as **UTF-16 code units, ascending**. That is JavaScript's default string comparison.

```ts
const Person = z.object({
  name: z.string(),             // rank 1
  age: z.int().nonnegative(),   // rank 0
  sex: z.enum(["M", "F", "X"]), // rank 2
});
```

`age` is written first even though it was declared second. [Where the bytes go](/core-concepts/how-it-works/#where-the-bytes-go) shows this byte by byte. Because the order comes from the names alone, every validator and both the high-level and low-level APIs agree on it.

The **encoder** applies the sort. The [`m` API](/api/m/) cannot override it, because field order is a rule of the wire format, not a schema option.

## Enum members are sorted too

```ts
z.enum(["M", "F", "X"]); // sorted: ["F", "M", "X"] → 0, 1, 2
```

Declaring `["X", "F", "M"]` gives identical bytes. Adding a member shifts the index of every member that sorts after it, which is why versioned payloads need a [wire fingerprint](/versioning/fingerprinting/).

## The same bytes from every validator

```ts
z.object({ name: z.string(), age: z.int().nonnegative() });
v.object({ name: v.string(), age: v.pipe(v.number(), v.integer(), v.minValue(0)) });
type({ name: "string", age: "number.integer >= 0" });
// all three: the same bytes, the same fingerprint
```

This works because the wire shape comes from JSON Schema, which all three validators produce. The signature leaves out `rejectUnknown`, the one thing validators handle differently, because it does not change the encoded bytes.

Recursive types agree too, even though validators spell them differently: one points a `$ref` at its definition, another inlines a copy and refers back from inside it. shorn folds a copy of a definition back onto the definition, so both spellings produce one signature.

## Integers have one spelling

Overlong varints are rejected. `1` must be `0x01`, never `0x81 0x00`. This keeps every encoding unique, which is what content addressing, deduplication, and byte-level equality all depend on.

## What canonical does not cover

- **Floats.** `-0` and `0` are different byte strings. Validator-backed schemas refuse `NaN`. The low-level `m.float32()` and `m.float64()` accept it, and several NaN bit patterns decode without error. Do not use low-level NaN values for content addressing.
- **String normalization.** `"é"` as one code point and as `e` plus a combining accent are two different strings, and both encode faithfully. Normalize first if you need them to be equal.
- **Decoded key order.** A decoded object has shorn's key order, not the order of your original object. It is the same *value*, so `toEqual` and `isDeepStrictEqual` pass. But `JSON.stringify(decoded) === JSON.stringify(original)` fails, because `JSON.stringify` is sensitive to key order. Compare values, not serialized strings. (Restoring declaration order was measured and rejected: it cost 6 to 15% of decode speed.)

## A round trip returns the same value

`decode(encode(x))` gives back `x` itself, not merely something equivalent. A `format: "date-time"` string is stored as epoch milliseconds, which shrinks about 25 bytes to 6. But epoch milliseconds cannot remember how many fractional digits the string had or how its offset was spelled. So only the one spelling that survives the trip is accepted, the `toISOString()` one, and every other spelling is refused rather than silently normalized. Uppercase UUIDs follow the same rule: refuse anything that would come back different. See [Date, BigInt, Map, Set](/schemas/rich-types/).
