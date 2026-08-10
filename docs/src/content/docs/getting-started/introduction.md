---
title: Introduction
description: shorn is compact binary serialization for Zod, Valibot, and ArkType. It reads the schema you already validate with and writes payloads without keys or type tags.
---

shorn encodes data with the schema your project already uses. It reads [Standard Schema](https://standardschema.dev/schema) for validation and [Standard JSON Schema](https://standardschema.dev/json-schema) for structure. Field names and type tags stay in the schema instead of being repeated in every payload.

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

The same value is 35 bytes of minified JSON.

## What you get

- **No shorn schema language.** No IDL, CLI, codegen, or compiler plugin.
- **Canonical bytes.** Equivalent Zod, Valibot, and ArkType schemas encode identically.
- **Validation both ways.** Your library runs on encode and again on decode.
- **Small, tree-shakeable runtime.** Optional helpers add code only when imported.
- MIT licensed.

## What you do not get

shorn is an experimental alpha with important limits:

- **No schema evolution.** Only the matching wire shape can decode a payload. [`fingerprinted()`](/versioning/fingerprinting/) detects most mismatches; nothing resolves them.
- **No streaming**, random access, or zero-copy views.
- **No cross-language decoder.** TypeScript and JavaScript only.
- **No universal performance guarantee.** Results depend on schema, data, runtime, and compression. See [Throughput](/performance/throughput/) and benchmark your workload.
- **Not confidential.** Encrypt the bytes when secrecy matters.

## Where next

| To | Read |
| --- | --- |
| Understand the pitch | [Why shorn?](/getting-started/why-shorn/) |
| Get running | [Installation](/getting-started/installation/), [Quick Start](/getting-started/quick-start/) |
| Send, store, or queue bytes | [Using Payloads](/getting-started/using-payloads/) |
| Know what encodes | [Supported Types](/schemas/supported-types/) |
| Version stored data | [Wire Fingerprints](/versioning/fingerprinting/) |
| See the bytes | [Byte Layout](/wire-format/layout/) |
