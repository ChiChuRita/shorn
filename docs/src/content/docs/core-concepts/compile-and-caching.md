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

### A cached schema is assumed not to change

The plan is derived once from what `jsonSchema.input()` and `jsonSchema.output()` returned the first time, and shorn never asks again. A schema object that reports a *different* structure later keeps the plan built from the old one, and encodes to the old shape with no error:

```ts
let type = "integer";
const mutable = { "~standard": { /* … */ jsonSchema: { output: () => ({ type }) } } };
encode(mutable, 5);   // plan built for integer
type = "string";
encode(mutable, 5);   // still the integer plan
```

This is a property of the cache, not a bug shorn can check: re-deriving the JSON Schema to compare it is the whole cost the cache exists to remove. Zod, Valibot and ArkType schemas are immutable, so it cannot arise from them — if you build a Standard Schema by hand, treat it as frozen once encoded, and construct a new object rather than mutating one.

For Valibot the cache is keyed on the schema **and** the structure object, so `toStandardJsonSchema` must be hoisted too — it returns a fresh object each call and is not free itself, so an inline call pays twice. See [Valibot](/validators/valibot/).

## Runtime specialization

For eligible object schemas, shorn creates specialized encode and decode functions with `new Function` when the codec is constructed. Optional fields are generated too: which fields arrive varies per payload, but each optional's bit in the presence bitmap is fixed by the schema, so the generated code tests a constant mask.

A schema that must reject unknown properties checks for them first, then runs the same generated encoder. The interpreted path is used instead for an open object, or when a field name collides with `Object.prototype`: cases that need `defineProperty` rather than a plain assignment.

Schema keys are passed as function arguments rather than inserted into generated source, so keys from external JSON Schemas are not executable code.

A Content Security Policy without `unsafe-eval` blocks `new Function`. shorn automatically uses the interpreted path instead, with identical bytes and results.

## The `Writer` is pooled

`encode` reuses an internal `Writer` and resets it after every call, including when encoding throws. It returns an **exact-size copy**, not a view into an oversized buffer, and buffers grown past 64 KiB are released so one large encode does not permanently inflate the process. `encodeInto` keeps a second pooled `Writer` pointed at your buffer, and lets go of any target larger than 64 KiB once the call returns, so a one-off frame is not pinned either.

## When cold setup matters

Cold setup is usually negligible in a long-lived server, but it can matter in a serverless function that handles only one request. Most of shorn's time is Zod schema construction, which an application using Zod already pays. See [Footprint](/performance/footprint/) for the measured comparison against other codecs.
