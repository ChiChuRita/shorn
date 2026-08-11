---
title: Compilation and Caching
description: encode and decode cache the wire plan by schema identity. compile exposes the same plan as a reusable codec object.
---

Converting a JSON Schema to a wire plan has a one-time setup cost. With a stable schema object, it happens once rather than once per call. The plan is stored in a `WeakMap` keyed on the schema object's identity, so a schema going out of scope takes its plan with it.

The functional and compiled APIs share that one cached plan, so choose whichever form fits your code. `compile` is for a codec object to pass around, store in a map, or wrap in [`fingerprinted()`](/versioning/fingerprinting/). There is no build step either way: `compile` works in memory and writes nothing to disk.

## Identity is what gets cached

```ts
// Cached: one plan, reused.
const Person = z.object({ name: z.string() });
export const write = (p) => encode(Person, p);

// Not cached: a new schema per call, so a new plan per call.
export const write = (p) => encode(z.object({ name: z.string() }), p);
```

The second form pays the full conversion on every call. Hoist schemas to module scope.

For Valibot the cache is keyed on the schema **and** the structure object, so `toStandardJsonSchema` must be hoisted too — it returns a fresh object each call and is not free itself, so an inline call pays twice. See [Valibot](/validators/valibot/).

## Runtime specialization

For eligible object schemas, shorn creates specialized encode and decode functions with `new Function` when the codec is constructed. Decoding is generated for schemas with optional fields as well: which fields arrive varies per payload, but each optional's byte and bit in the presence bitmap are fixed by the schema, so the generated function tests a constant mask. Encoding takes the interpreted path when a schema has optional fields, and also when it must reject unknown properties or handle a field that shadows `Object.prototype`; decoding does the same for a `__proto__` field, an open object, or an absent optional named after an `Object.prototype` member, each of which needs `defineProperty` rather than an assignment.

Schema keys are passed as function arguments rather than inserted into generated source, so keys from external JSON Schemas are not executable code.

A Content Security Policy without `unsafe-eval` blocks `new Function`. shorn automatically uses the interpreted path instead, with identical bytes and results.

## The `Writer` is pooled

`encode` reuses an internal `Writer` and resets it after every call, including when encoding throws. It returns an **exact-size copy**, not a view into an oversized buffer, and buffers grown past 64 KiB are released so one large encode does not permanently inflate the process.

## When cold setup matters

Cold setup is usually negligible in a long-lived server, but it can matter in a serverless function that handles only one request. Most of shorn's time is Zod schema construction, which an application using Zod already pays. See [Footprint](/performance/footprint/) for the measured comparison against other codecs.
