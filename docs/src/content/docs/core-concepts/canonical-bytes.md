---
title: Canonical Bytes
description: Supported values have a deterministic encoding, with one documented exception for low-level NaN values.
---

For supported validator-backed values, a value and wire shape have one valid encoding. Key order, enum order, integer spelling, and byte order are derived rather than configurable.

## Key order is derived

Field order is the rank of the field's name in **UTF-16 code-unit ascending order**, JavaScript's default string comparison.

```ts
const Person = z.object({
  name: z.string(),             // rank 1
  age: z.int().nonnegative(),   // rank 0
  sex: z.enum(["M", "F", "X"]), // rank 2
});
```

`age` is written first even though it was declared second, as [Where the bytes go](/core-concepts/how-it-works/#where-the-bytes-go) shows byte by byte. The order is derived from field names, so validators and the high- and low-level APIs all produce the same result.

The **encoder** applies the sort. The [`m` API](/api/m/) cannot override it because canonical field order is a wire-format rule, not a schema option.

## Enum members are sorted too

```ts
z.enum(["M", "F", "X"]); // sorted: ["F", "M", "X"] → 0, 1, 2
```

Declaring `["X", "F", "M"]` produces identical bytes. Adding a member shifts every index at or after it, so versioned payloads need a [wire fingerprint](/versioning/fingerprinting/).

## Cross-vendor identity

```ts
z.object({ name: z.string(), age: z.int().nonnegative() });
v.object({ name: v.string(), age: v.pipe(v.number(), v.integer(), v.minValue(0)) });
type({ name: "string", age: "number.integer >= 0" });
// all three: the same bytes, the same fingerprint
```

This works because the wire shape comes from JSON Schema. The signature excludes `rejectUnknown`, which validators handle differently but which does not change the encoded bytes.

Recursive types hold too, though validators spell them differently: one points a `$ref` at its definition, another inlines a copy and refers back from inside it. A copy of a definition is folded onto the definition, so both spellings derive one signature.

## Integers have one spelling

Overlong varints are rejected: `1` must be `0x01`, never `0x81 0x00`. This keeps the encoding unique, which is required for content addressing, deduplication, and byte-level equality.

## What canonicality does not cover

- **Floats.** `-0` and `0` are distinct byte strings. Validator-backed schemas refuse `NaN`; low-level `m.float32()` and `m.float64()` accept it, and multiple NaN bit patterns decode successfully. Do not use low-level NaN values for content addressing.
- **String normalization.** `"é"` as one code point and as `e` plus a combining accent are different strings, both encoded faithfully. Normalize first if you need them equal.
- **Decoded key order.** The decoded object's key order is shorn's, not your original object's. It is the same *value*, so `toEqual` and `isDeepStrictEqual` pass — but `JSON.stringify(decoded) === JSON.stringify(original)` does not, since `JSON.stringify` is key-order sensitive. Compare values, not serialized strings. (Restoring declaration order was measured and rejected: it cost 6–15% of decode.)

## Round-tripping is a fixed point

`decode(encode(x))` returns `x`, not merely an equivalent value. A `format: "date-time"` string is stored as epoch milliseconds, about 25 bytes down to 6, and epoch milliseconds remember neither a fractional-digit count nor an offset spelling. So only the one spelling that survives the trip encodes, the `toISOString()` one, and every other spelling is refused rather than normalised. Same rule as an uppercase UUID: refuse what would come back different. See [Date, BigInt, Map, Set](/schemas/rich-types/).
