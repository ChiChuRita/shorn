---
title: API Overview
description: The whole public surface on one page.
---

```ts
// Encode and decode
encode(schema, value, structure?): Uint8Array;
decode(schema, bytes, structure?): Output;
encodeInto(codec, value, target, offset?): number; // into a buffer you own

safeEncode(schema, value, structure?): SafeResult<Uint8Array>;
safeDecode(schema, bytes, structure?): SafeResult<Output>;

encodeAsync(schema, value, structure?): Promise<Uint8Array>;
decodeAsync(schema, bytes, structure?): Promise<Output>;

// Codecs
compile(schema, structure?): Schema<Output>;
fingerprinted(codec, options?): FingerprintedSchema<Output>;
unchecked(schemaOrCodec, structure?): Schema<Output>;
valibotOverride(toJsonSchema): (context) => JsonSchema | undefined; // Valibot Date, bigint, Set, Map

// Low-level
m.string() | m.bytes() | m.boolean() | m.uint() | m.int()
  | m.float32() | m.float64() | m.literal(v) | m.enum([...])
  | m.date() | m.bigint()
  | m.array(item) | m.tuple([...]) | m.object({...})
  | m.set(item) | m.map(key, value);

// Errors
EncodeError; // .path, .issues
DecodeError; // .offset, .issues
```

## Choosing an entry point

| Situation | Use |
| --- | --- |
| Ordinary code, throwing is fine | `encode` / `decode` |
| Untrusted input | `safeEncode` / `safeDecode` |
| Async refinement | `encodeAsync` / `decodeAsync` |
| A codec object to pass around | `compile` |
| **Stored, queued, version-crossing** | **`fingerprinted(compile(schema), { bytes: 4 })`** |
| Trusted producer you own, both ends | `unchecked(compile(schema))` |
| You own the output buffer: frames, batches | `encodeInto(codec, value, target, offset)` |
| Valibot with `Date`, `bigint`, `Set` or `Map` | `compile(schema, toJsonSchema(schema, { overrideSchema: valibotOverride(toJsonSchema) }))` |
| No validator, or you need `bytes`/`float32` | `m` |

Every entry point decodes through the same structural path, `Schema.decode`, so they all report the same errors.

## Options and types

```ts
interface FingerprintOptions {
  readonly bytes?: 1 | 2 | 3 | 4; // default 3
}

type SafeResult<T> =
  | { success: true; data: T }
  | { success: false; error: Error };

type EncodableStandardSchema<In = unknown, Out = In> =
  StandardSchemaV1<In, Out> & StandardJSONSchemaV1<In, Out>;

interface JsonSchemaDocument { /* a plain JSON Schema object */ }

interface ValibotOverrideContext {
  readonly valibotSchema: { readonly type: string };
}

type Infer<S extends Schema<unknown>> = S["_output"];
```

The trailing `structure` argument is either a `StandardJSONSchemaV1` implementation or a plain `JsonSchemaDocument`. It is required for validators that implement Standard Schema but not Standard JSON Schema: Valibot always, Zod before 4.2, ArkType before 2.1.28.

`Infer` reads the output type off a low-level `m` codec. For schema-backed codecs use your validator's own inference (`z.infer`, `v.InferOutput`, `typeof T.infer`).

Also exported: `Schema`, `OptionalSchema`, `NullableSchema`, `FingerprintedSchema`, `Reader`, `Writer`, `ObjectOutput`, `Shape`, `EnumValue`, `FingerprintOptions`.

## The two-line version

```ts
const Person = z.object({ name: z.string(), age: z.int().nonnegative() });

export const wire = compile(Person);                              // pinned RPC
export const stored = fingerprinted(compile(Person), { bytes: 4 }); // persisted
```
