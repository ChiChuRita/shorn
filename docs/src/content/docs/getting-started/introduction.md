---
title: Introduction
description: shorn is compact binary serialization for Zod, Valibot, and ArkType. It reads the schema you already validate with and writes payloads without field names or type tags.
---

shorn turns the validation schema you already have into a binary format. It reads two things from that schema: [Standard Schema](https://standardschema.dev/schema) for validation, and [Standard JSON Schema](https://standardschema.dev/json-schema) for structure. Because your validator already describes every field and its type, there is no separate schema file to write, no code to generate, and no second copy of your types to keep in sync.

```ts
import { z } from "zod";
import { decode, encode } from "@chichurita/shorn";

const Person = z.object({
  name: z.string(),
  age: z.int().nonnegative(),
  sex: z.enum(["M", "F", "X"]),
});

const bytes = encode(Person, { name: "Grace", age: 45, sex: "F" }); // 8 bytes
const decoded = decode(Person, bytes);
```

As minified JSON, that value is 35 bytes. shorn writes 8, because the field names and type markers stay in the schema instead of being repeated in every payload. [Where the bytes go](/core-concepts/how-it-works/#where-the-bytes-go) walks from 35 down to 8 in three steps.

A few things hold everywhere:

- The same schema written in Zod, Valibot, or ArkType produces the same bytes.
- Your validator runs before encoding and again after decoding, so a payload never skips your rules.
- The runtime is small. Helpers you do not import cost nothing in your bundle.
- MIT licensed.

## When it fits

shorn is a good fit when all of these are true: both ends of the wire are TypeScript or JavaScript, your application already validates its data, both ends can share one schema, and payload size or serialization cost actually matters to you. If any of those is false, [Comparisons](/comparisons/) says what to use instead.

## Limits

Some of these are design decisions rather than gaps that will be filled later:

- **No schema evolution.** A payload can only be decoded by the exact wire shape that wrote it. [`fingerprinted()`](/versioning/fingerprinting/) catches most mismatches, but nothing migrates old payloads for you.
- **No streaming**, random access, or zero-copy views.
- **No cross-language decoder.** TypeScript and JavaScript only.
- **No universal speed guarantee.** Results depend on your schema, your data, the runtime, and compression. See [Throughput](/performance/throughput/) and measure your own workload.
- **Some values have no wire form.** `Date`, `bigint`, `Map`, `Set` and `date-time` strings are [supported natively](/schemas/rich-types/). `undefined`, symbols, `RegExp`, class instances and one-way transforms are not, so convert those before encoding.
- **Not confidential.** The bytes are compact, not secret. Encrypt them when secrecy matters.

Next: [Installation](/getting-started/installation/), then [Quick Start](/getting-started/quick-start/).
