---
title: Functions
description: Signatures and behavior for encode, decode, the safe and async variants, compile, unchecked, valibotOverride, and fingerprinted.
---

Each function has two overloads. One takes a schema that implements both Standard interfaces. The other takes a Standard Schema plus a `structure` that describes the same shape.

`structure` is either a **Standard JSON Schema implementation** (`toStandardJsonSchema(schema)` for Valibot) or a plain **JSON Schema document**, typed as `JsonSchemaDocument`. One document describes one shape, so it serves as both the input and the output side. That is why a schema with a default or a transform needs the two-method form instead. A plain object counts as a document when it has `$schema`, `$ref`, `type`, `anyOf`, `oneOf`, `const`, `enum`, `properties` or `x-shorn`. Anything else is refused, so a validator passed twice by mistake does not read as an empty schema and appear to work.

```ts
const structure = {
  type: "object",
  properties: { when: { "x-shorn": "date" }, name: { type: "string" } },
  required: ["when", "name"],
};

const codec = compile(schema, structure); // cached by the identity of both objects
```

`x-shorn` is shorn's own keyword for the four types JSON Schema cannot describe. See [Date, BigInt, Map, Set](/schemas/rich-types/#the-x-shorn-keyword).

## `encode`

```ts
encode<S extends EncodableStandardSchema>(schema: S, value: InferOutput<S>): Uint8Array;
encode<S extends StandardSchemaV1>(schema: S, value: InferOutput<S>, structure: StandardJSONSchemaV1 | JsonSchemaDocument): Uint8Array;
```

Validates, then writes bytes. Throws `EncodeError` if validation fails or the schema cannot be encoded.

The returned `Uint8Array` is an **exact-size copy**, not a view into a reused buffer, so you can keep it as long as you like. The wire plan is cached per schema object.

## `decode`

```ts
decode<S extends EncodableStandardSchema>(schema: S, bytes: Uint8Array): InferOutput<S>;
decode<S extends StandardSchemaV1>(schema: S, bytes: Uint8Array, structure: StandardJSONSchemaV1 | JsonSchemaDocument): InferOutput<S>;
```

Reads the structure, then validates. Throws `DecodeError` for malformed bytes **and** for a validation failure on the way out.

Bytes left over after a complete value are an error. Input that is not a `Uint8Array` produces a `DecodeError` rather than a raw `TypeError`. An array from another realm, such as `node:vm`, an iframe, or jsdom, is accepted through a tag check when `instanceof` fails.

## `encodeInto`

```ts
encodeInto<T>(codec: Schema<T>, value: T, target: Uint8Array, offset?: number): number;
```

Encodes into a buffer you own and returns the offset just past the last byte written, so consecutive calls pack a frame:

```ts
const frame = new Uint8Array(65_536);
let end = 0;
for (const event of events) end = encodeInto(codec, event, frame, end);
socket.send(frame.subarray(0, end));
```

The bytes are exactly what `codec.encode(value)` would return. What you save is the output array and the copy into the frame that would follow it, which together are about half the cost of a small encode: on the Person fixture, 48 ns down to 23 ns, and a 100-message frame in 40% of the time. For a message you hand straight to `send()`, `encode()` is simpler and no slower.

Takes any codec: from `compile()`, `fingerprinted()`, `unchecked()`, or `m`. Throws `EncodeError` when the value does not fit, when `offset` is outside `target`, or when `target` is not a `Uint8Array`, and names the failing field just as `encode()` does. After a too-small target, the bytes from `offset` onward are unspecified. Decoding needs no counterpart: `decode()` takes any `Uint8Array` view, so hand it `frame.subarray(start, end)`.

## `safeEncode` / `safeDecode`

```ts
safeEncode(schema, value, structure?): SafeResult<Uint8Array>;
safeDecode(schema, bytes, structure?): SafeResult<InferOutput<S>>;

type SafeResult<T> = { success: true; data: T } | { success: false; error: Error };
```

Same behavior, without throwing. Anything thrown that is not an `Error` is wrapped, so `result.error` is always an `Error`.

## `encodeAsync` / `decodeAsync`

```ts
encodeAsync(schema, value, structure?): Promise<Uint8Array>;
decodeAsync(schema, bytes, structure?): Promise<InferOutput<S>>;
encodeAsync<T>(codec: Schema<T>, value: T): Promise<Uint8Array>;
decodeAsync<T>(codec: Schema<T>, bytes: Uint8Array): Promise<T>;
```

For schemas with **asynchronous** refinements. Both accept either a Standard Schema or a codec built from one, including a `fingerprinted()` codec. The prefix is written and checked on the async path exactly as on the sync one. There are no safe async variants.

Calling `encode`/`decode` on an async schema throws. So does passing a codec that has no validator to await: an `m` schema, or a `compile()` codec wrapped in `nullable()`/`optional()`. See [Validation](/core-concepts/validation/#async-validation) and [Errors](/api/errors/#async).

## `compile`

```ts
compile<S extends EncodableStandardSchema>(schema: S): Schema<InferOutput<S>>;
compile<S extends StandardSchemaV1>(schema: S, structure: StandardJSONSchemaV1 | JsonSchemaDocument): Schema<InferOutput<S>>;
```

Returns the cached wire plan as a codec with `.encode()` and `.decode()`. **No build step:** it works in memory and writes nothing to disk. Calling it again with the same schema and structure objects returns the **same** cached instance. See [Compilation and Caching](/core-concepts/compile-and-caching/).

## `unchecked`

```ts
unchecked<T>(codec: Schema<T>): Schema<T>;
unchecked<S extends EncodableStandardSchema>(schema: S): Schema<InferOutput<S>>;
unchecked<S extends StandardSchemaV1>(schema: S, structure: StandardJSONSchemaV1 | JsonSchemaDocument): Schema<InferOutput<S>>;
```

The same codec with the validator removed: identical bytes on the wire, and no refinements run on either side. It is cached alongside the codec it came from, so calling it per message is a lookup, not a rebuild. It accepts a `fingerprinted()` codec and keeps the envelope, prefix check included.

Throws `EncodeError` for a codec that has no validator to remove. [Skipping Validation](/core-concepts/validation/#skipping-validation) covers when this is safe and what you give up.

## `valibotOverride`

```ts
valibotOverride<J>(
  convert: (schema: never, config: { overrideSchema: (context: ValibotOverrideContext) => J | undefined }) => J,
): (context: ValibotOverrideContext) => J | undefined;
```

Fills the `overrideSchema` slot of `@valibot/to-json-schema`, so that `v.date()`, `v.bigint()`, `v.set()` and `v.map()` convert to shorn's `x-shorn` keyword instead of throwing. The document that comes out is a valid `structure`.

```ts
import { toJsonSchema } from "@valibot/to-json-schema";
import { compile, valibotOverride } from "@chichurita/shorn";

const structure = toJsonSchema(Person, { overrideSchema: valibotOverride(toJsonSchema) });
const codec = compile(Person, structure);
```

`toStandardJsonSchema` takes no options, which is why the raw converter is used here. You pass the converter in rather than shorn importing it, for two reasons: shorn depends on no validator, and a Set inside a Set has to be converted through the same hook or the inner one would throw where the outer one did not. Zod and ArkType need none of this; shorn passes their hooks itself. See [Valibot](/validators/valibot/#rich-types).

## `fingerprinted`

```ts
fingerprinted<T>(codec: Schema<T>, options?: FingerprintOptions): FingerprintedSchema<T>;
```

Prefixes each payload with a short FNV-1a digest of the schema's canonical wire signature.

```ts
const codec = fingerprinted(compile(Person), { bytes: 4 });
codec.encode(person);  // 4 + payload bytes
codec.fingerprint;     // Uint8Array, a fresh copy every read
codec.fingerprintHex;  // "7236d1", the Map key for dispatch
```

`fingerprint` returns a copy so that a caller cannot change the codec's internal bytes. An accidental write would leave the codec non-canonical while it still round-trips against itself. Use `fingerprintHex` as a `Map` key.

Throws `EncodeError` for a codec without a signature, and for `bytes` outside 1 to 4. The default is 3 bytes. Use 4 for persistent data. See [Wire Fingerprints](/versioning/fingerprinting/).

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

`signature` exists only at the type level on the base class, so users who never import `fingerprinted()` pay no runtime cost for it. `_encode`, `_decode`, and `_minWidth` are internal and may change in a minor release. See [m Builders](/api/m/).
