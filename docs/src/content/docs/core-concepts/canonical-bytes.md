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

encode(Person, { name: "Grace", age: 45, sex: "F" });
// [45, 5, 71, 114, 97, 99, 101, 0]
//  ^age ^len "Grace"           ^sex
```

`age` is written first even though it was declared second. The order is derived from field names, so validators and the high- and low-level APIs all produce the same result.

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

## Integers have one spelling

Overlong varints are rejected: `1` must be `0x01`, never `0x81 0x00`. This keeps the encoding unique, which is required for content addressing, deduplication, and byte-level equality.

## What canonicality does not cover

- **Floats.** `-0` and `0` are distinct byte strings. Validator-backed schemas refuse `NaN`; low-level `m.float32()` and `m.float64()` accept it, and multiple NaN bit patterns decode successfully. Do not use low-level NaN values for content addressing.
- **String normalization.** `"é"` as one code point and as `e` plus a combining accent are different strings, both encoded faithfully. Normalize first if you need them equal.
- **Decoded key order.** The bytes are canonical; the decoded object's key order is shorn's, not your original object's. A decoded record is the same *value*, so `toEqual`, `isDeepStrictEqual` and any structural comparison pass — but `JSON.stringify(decoded) === JSON.stringify(original)` does not, because `JSON.stringify` is key-order sensitive. Compare values rather than serialized strings; a test suite that asserts on `JSON.stringify` output will report a difference where there is none.

  Decoding in your declaration order instead was measured and rejected: the generated decoder builds one object literal, so emitting keys in a different order than they are read requires a temporary per field, which cost 6-15% of decode. Canonical order also mirrors the wire, which is the more useful thing for a reader to see.

## Round-tripping is a fixed point

`decode(encode(x))` returns `x`, not merely an equivalent value. Converting a `format: "date-time"` string to an epoch integer could reduce it from about 25 bytes to 5, but it would not preserve the original ISO-8601 spelling. For example, `Z` could come back as `+00:00`.

That conversion preserves the instant but changes its representation. shorn therefore leaves it to the application. See [Date, BigInt, Map, Set](/schemas/rich-types/).
