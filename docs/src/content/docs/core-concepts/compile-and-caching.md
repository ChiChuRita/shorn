---
title: Compilation and Caching
description: encode and decode cache the wire plan per schema object. compile exposes the same plan as a reusable codec.
---

Turning a JSON Schema into a wire plan has a one-time cost. As long as you reuse the same schema object, that cost is paid once, not on every call. The plan lives in a `WeakMap` keyed on the schema object, so when a schema is garbage collected its plan goes with it.

`encode` and `decode` share this cached plan with `compile`, so pick whichever form reads better in your code. `compile` gives you a codec object to pass around, store in a map, or wrap in [`fingerprinted()`](/versioning/fingerprinting/). Neither form involves a build step: `compile` works in memory and writes nothing to disk.

## The cache is keyed by object identity

```ts
// Cached: one plan, reused.
const Person = z.object({ name: z.string() });
export const write = (p) => encode(Person, p);

// Not cached: a new schema per call, so a new plan per call.
export const write = (p) => encode(z.object({ name: z.string() }), p);
```

The second form pays the full conversion on every call. Define schemas at module scope.

### A cached schema is assumed not to change

The plan is derived once, from whatever `jsonSchema.input()` and `jsonSchema.output()` returned the first time. shorn never asks again. If a schema object later reports a different structure, the old plan is still used, and values encode to the old shape with no error:

```ts
let type = "integer";
const mutable = { "~standard": { /* … */ jsonSchema: { output: () => ({ type }) } } };
encode(mutable, 5);   // plan built for integer
type = "string";
encode(mutable, 5);   // still the integer plan
```

shorn cannot detect this without re-deriving the JSON Schema on every call, which is the cost the cache exists to avoid. Zod, Valibot, and ArkType schemas are immutable, so this cannot happen with them. If you build a Standard Schema object by hand, treat it as frozen once it has been encoded, and build a new object instead of mutating it.

For Valibot the cache key is the schema **and** the structure object together. So `toStandardJsonSchema` must be hoisted too: it returns a fresh object each time and does real work itself, so an inline call pays twice. See [Valibot](/validators/valibot/).

## Generated encoders

For most object schemas, shorn generates specialized encode and decode functions with `new Function` when the codec is built. Open objects, and objects with a field named like something on `Object.prototype`, use an interpreted path instead. Schema keys are passed to the generated function as arguments, never pasted into its source, so a key from an external JSON Schema can never become executable code.

A Content Security Policy without `unsafe-eval` blocks `new Function`. shorn then uses the interpreted path automatically, with identical bytes and results.

## Buffers

`encode` reuses one internal `Writer` and returns an **exact-size copy** of the bytes, never a view into a larger reused buffer. A buffer that grew past 64 KiB is released afterwards, so one large encode does not permanently inflate the process. `encodeInto` writes into your buffer and keeps no reference to a target larger than 64 KiB once the call returns.

## When cold setup matters

Cold setup is usually negligible in a long-lived server. It can matter in a serverless function that handles a single request. Most of shorn's cold time is Zod building the schema, which an application that uses Zod pays anyway. See [Footprint](/performance/footprint/) for the measurements against other codecs.
