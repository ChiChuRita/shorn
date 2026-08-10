---
title: API Overview
description: The whole public surface on one page.
---

```ts
// Encode and decode
encode(schema, value, structure?): Uint8Array;
decode(schema, bytes, structure?): Output;

safeEncode(schema, value, structure?): SafeResult<Uint8Array>;
safeDecode(schema, bytes, structure?): SafeResult<Output>;

encodeAsync(schema, value, structure?): Promise<Uint8Array>;
decodeAsync(schema, bytes, structure?): Promise<Output>;

// Codecs
compile(schema, structure?): Schema<Output>;
fingerprinted(codec, options?): FingerprintedSchema<Output>;
unchecked(schemaOrCodec, structure?): Schema<Output>;

// Low-level
m.string() | m.bytes() | m.boolean() | m.uint() | m.int()
  | m.float32() | m.float64() | m.literal(v) | m.enum([...])
  | m.array(item) | m.tuple([...]) | m.object({...});

// Errors
EncodeError;
DecodeError; // .offset
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
| No validator, or you need `bytes`/`float32` | `m` |

All entry points use the same structural decode path through `Schema.decode`, so they report the same errors.

## Options

```ts
interface FingerprintOptions {
  readonly bytes?: 1 | 2 | 3 | 4; // default 3
}
```

The trailing `structure` argument is a `StandardJSONSchemaV1`, required for validators implementing Standard Schema but not Standard JSON Schema: Valibot always, Zod before 4.2, ArkType before 2.1.28.

## Types

```ts
type SafeResult<T> =
  | { success: true; data: T }
  | { success: false; error: Error };

type EncodableStandardSchema<In = unknown, Out = In> =
  StandardSchemaV1<In, Out> & StandardJSONSchemaV1<In, Out>;

type Infer<S extends Schema<unknown>> = S["_output"];
```

`Infer` reads the output type off a low-level `m` codec. For schema-backed codecs use your validator's inference (`z.infer`, `v.InferOutput`, `typeof T.infer`).

Also exported: `Schema`, `OptionalSchema`, `NullableSchema`, `FingerprintedSchema`, `Reader`, `Writer`, `ObjectOutput`, `Shape`, `FingerprintOptions`.

## The three-line version

```ts
const Person = z.object({ name: z.string(), age: z.int().nonnegative() });

export const wire = compile(Person);                 // pinned RPC
export const stored = fingerprinted(compile(Person), { bytes: 4 });
```

## Reference

[Functions](/api/functions/) · [m Builders](/api/m/) · [Errors](/api/errors/)
