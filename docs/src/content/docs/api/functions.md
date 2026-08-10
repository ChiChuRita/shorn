---
title: Functions
description: Signatures and behavior for encode, decode, the safe and async variants, compile, and fingerprinted.
---

Each function has two overloads. One accepts schemas that implement both Standard interfaces. The other accepts a Standard Schema plus its `structure` — a Standard JSON Schema for the same shape.

## `encode`

```ts
encode<S extends EncodableStandardSchema>(schema: S, value: InferOutput<S>): Uint8Array;
encode<S extends StandardSchemaV1>(schema: S, value: InferOutput<S>, structure: StandardJSONSchemaV1): Uint8Array;
```

Validates, then writes bytes. Throws `EncodeError` if validation fails or the schema cannot be encoded.

The returned `Uint8Array` is an **exact-size copy**, not a view into a reused buffer. It is safe to retain. The wire plan is cached by schema identity.

## `decode`

```ts
decode<S extends EncodableStandardSchema>(schema: S, bytes: Uint8Array): InferOutput<S>;
decode<S extends StandardSchemaV1>(schema: S, bytes: Uint8Array, structure: StandardJSONSchemaV1): InferOutput<S>;
```

Reads the structure, then validates. Throws `DecodeError` for malformed bytes **and** for validation failures on the way out.

Trailing bytes cause an error. An input that is not a `Uint8Array` produces a `DecodeError` rather than a raw `TypeError`. Cross-realm arrays from `node:vm`, an iframe, or jsdom are accepted through a tag check when `instanceof` fails.

## `safeEncode` / `safeDecode`

```ts
safeEncode(schema, value, structure?): SafeResult<Uint8Array>;
safeDecode(schema, bytes, structure?): SafeResult<InferOutput<S>>;

type SafeResult<T> = { success: true; data: T } | { success: false; error: Error };
```

Same behavior without throwing. Non-`Error` throws are wrapped, so `result.error` is always an `Error`.

## `encodeAsync` / `decodeAsync`

```ts
encodeAsync(schema, value, structure?): Promise<Uint8Array>;
decodeAsync(schema, bytes, structure?): Promise<InferOutput<S>>;
encodeAsync<T>(codec: Schema<T>, value: T): Promise<Uint8Array>;
decodeAsync<T>(codec: Schema<T>, bytes: Uint8Array): Promise<T>;
```

Use these functions for schemas with **asynchronous** refinements. Both accept either a Standard Schema or a codec built from one, including a `fingerprinted()` codec; the prefix is written and checked on the async path exactly as on the sync one. There are no safe async variants. See [Validation](/core-concepts/validation/).

Passing a codec with no validator to await (an `m` schema, or a `compile()` codec wrapped in `nullable()`/`optional()`) is refused rather than encoded synchronously:

> This codec has no validator to await; async validation needs a codec from compile(), optionally wrapped by fingerprinted()

Calling `encode`/`decode` on an async schema throws:

> This Standard Schema validates asynchronously; use encodeAsync/decodeAsync, which accept either this schema or a codec built from it.

## `compile`

```ts
compile<S extends EncodableStandardSchema>(schema: S): Schema<InferOutput<S>>;
compile<S extends StandardSchemaV1>(schema: S, structure: StandardJSONSchemaV1): Schema<InferOutput<S>>;
```

Returns the cached wire plan as a codec with `.encode()` and `.decode()`.

**No build step.** `compile` builds the codec in memory and writes nothing to disk. Repeated calls with the same schema and structure object return the **same** cached instance. Eligible object schemas specialize both encoding and decoding at runtime; a strict Content Security Policy uses the interpreted path instead. See [Compilation and Caching](/core-concepts/compile-and-caching/).

## `fingerprinted`

```ts
fingerprinted<T>(codec: Schema<T>, options?: FingerprintOptions): FingerprintedSchema<T>;
```

Prefixes payloads with a short FNV-1a digest of the schema's canonical wire signature.

```ts
const codec = fingerprinted(compile(Person), { bytes: 4 });
codec.encode(person);  // 4 + payload bytes
codec.fingerprint;     // Uint8Array, a fresh copy every read
codec.fingerprintHex;  // "7236d1", the Map key for dispatch
```

Throws `EncodeError` for a codec without a signature:

> fingerprinted() needs a codec built from a Standard JSON Schema; compile() returns one, the low-level m API does not

It also throws if `bytes` is outside 1–4. The default is 3 bytes; use 4 for persistent data. See [Wire Fingerprints](/versioning/fingerprinting/).

### `FingerprintedSchema`

| Member | Type | Notes |
| --- | --- | --- |
| `fingerprint` | `Uint8Array` | Fresh copy every read; cannot key a `Map` |
| `fingerprintHex` | `string` | Lowercase hex, immutable, the dispatch key |

`fingerprint` returns a copy so callers cannot mutate the codec's internal bytes. Otherwise, an accidental write could make the codec non-canonical while it still round-trips against itself.

## `Schema<T>`

```ts
abstract class Schema<T> {
  encode(value: T): Uint8Array;
  decode(value: Uint8Array): T;
  optional(): OptionalSchema<T>;
  nullable(): NullableSchema<T>;
  readonly signature?: string; // only on codecs built from a JSON Schema
}
```

`signature` is type-only on the base class, so users who do not import `fingerprinted()` pay no runtime cost for it. `_encode`, `_decode`, and `_minWidth` are internal and may change in a minor release. See [Low-Level m API](/wire-format/low-level-api/).
