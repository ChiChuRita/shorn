---
title: Introduction
description: shorn is compact binary serialization for Zod, Valibot, and ArkType. It reads the schema you already validate with and writes payloads without keys or type tags.
---

shorn encodes data with the schema your project already uses. It reads [Standard Schema](https://standardschema.dev/schema) for validation and [Standard JSON Schema](https://standardschema.dev/json-schema) for structure, so there is no IDL, no code generation, and no second definition to keep in sync.

```ts
import { z } from "zod";
import { decode, encode } from "shorn";

const Person = z.object({
  name: z.string(),
  age: z.int().nonnegative(),
  sex: z.enum(["M", "F", "X"]),
});

const bytes = encode(Person, { name: "Grace", age: 45, sex: "F" }); // 8 bytes
const decoded = decode(Person, bytes);
```

The same value is 35 bytes of minified JSON. Field names and type tags stay in the schema instead of being repeated in every payload.

Equivalent Zod, Valibot, and ArkType schemas encode identically. Your validator runs on encode and again on decode. The runtime is small and tree-shakes per feature, so optional helpers cost nothing until imported. MIT licensed.

## Good fit

Both endpoints are TypeScript or JavaScript, the application already validates its data, both ends can share one wire shape, and payload size or serialization cost matters. If any of those is false, [Comparisons](/comparisons/) covers what to reach for instead.

## Limits

shorn is an experimental alpha, and some of these limits are permanent rather than unfinished:

- **No schema evolution.** Only the matching wire shape can decode a payload. [`fingerprinted()`](/versioning/fingerprinting/) detects most mismatches; nothing resolves them.
- **No streaming**, random access, or zero-copy views.
- **No cross-language decoder.** TypeScript and JavaScript only.
- **No universal performance guarantee.** Results depend on schema, data, runtime, and compression. See [Throughput](/performance/throughput/) and benchmark your workload.
- **Rich values need an explicit wire form.** `Date`, `bigint`, `Map`, and `Set` are [converted at the edge](/schemas/rich-types/).
- **Not confidential.** Encrypt the bytes when secrecy matters.

Next: [Installation](/getting-started/installation/), then [Quick Start](/getting-started/quick-start/).
