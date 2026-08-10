---
title: Compilation and Caching
description: encode and decode cache the wire plan by schema identity. compile exposes the same plan as a reusable codec object.
---

Converting a JSON Schema to a wire plan has a one-time setup cost. With a stable schema object, it happens once rather than once per call.

## The functional API caches

```ts
const bytes = encode(Person, person);
const back = decode(Person, bytes);
```

The plan is stored in a `WeakMap` keyed on the schema object's identity, so a schema going out of scope takes its plan with it.

The functional and compiled APIs use the same cached plan. Choose the form that fits your code.

## `compile` returns the same plan

```ts
const PersonWire = compile(Person);
```

Use it for a codec object to pass around, store in a map, or wrap in [`fingerprinted()`](/versioning/fingerprinting/).

There is no build step. `compile` builds the codec in memory and writes nothing to disk.

## Runtime specialization

For eligible object schemas, shorn creates specialized encode and decode functions with `new Function` when the codec is constructed. Schemas with optional fields use the interpreted path. Encoding also uses the interpreted path when it must reject unknown properties or handle a field that shadows `Object.prototype`.

Schema keys are passed as function arguments rather than inserted into generated source, so keys from external JSON Schemas are not executable code.

### Under a strict Content Security Policy

A policy without `unsafe-eval` blocks `new Function`. shorn automatically uses the interpreted path instead, with identical bytes and results.

## Identity is what gets cached

```ts
// Cached: one plan, reused.
const Person = z.object({ name: z.string() });
export const write = (p) => encode(Person, p);

// Not cached: a new schema per call, so a new plan per call.
export const write = (p) => encode(z.object({ name: z.string() }), p);
```

The second form pays the full conversion on every call. Hoist schemas to module scope.

## Valibot: two identities

The cache is keyed on the schema **and** the structure object:

```ts
// Cached.
const structure = toStandardJsonSchema(Person);
export const write = (p) => encode(Person, p, structure);

// Not cached: toStandardJsonSchema returns a fresh object each call, and is
// not free itself, so this form pays twice.
export const write = (p) => encode(Person, p, toStandardJsonSchema(Person));
```

## The `Writer` is pooled

`encode` reuses an internal `Writer` and resets it after every call, including when encoding throws:

- **`encode` returns an exact-size copy**, not a view into an oversized buffer.
- **Buffers grown past 64 KiB are released**, so one large encode does not permanently inflate the process.

## When cold setup matters

Cold setup is usually negligible in a long-lived server, but it can matter in a serverless function that handles only one request. For comparison: Avro takes 68.99 µs, Protobuf.js reflection 187.75 µs, SchemaPack 3.00 µs, msgpackr records 1.00 µs, and JSON 0.08 µs. Most of shorn's time is Zod schema construction, which an application using Zod already pays. See [Footprint](/performance/footprint/).
