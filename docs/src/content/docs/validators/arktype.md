---
title: ArkType
description: ArkType 2.1.28+ implements both Standard interfaces directly. Its open objects are the one thing to know about.
---

ArkType 2.1.28 and newer implements both Standard Schema and Standard JSON Schema directly. Pass the type and nothing else.

```ts
import { type } from "arktype";
import { decode, encode } from "@chichurita/shorn";

const Person = type({
  name: "string",
  age: "number.integer >= 0",
  sex: "'M' | 'F' | 'X'",
});

const person = { name: "Grace", age: 45, sex: "F" } as const;
const bytes = encode(Person, person); // 8 bytes
const decoded = decode(Person, bytes);
```

An equivalent Zod schema produces the same bytes and fingerprint. Use `"number.integer >= 0"` wherever the value cannot be negative: signed integers use ZigZag encoding and need an extra byte at lower values. [Supported Types](/schemas/supported-types/) maps every ArkType shape to its bytes.

## Extra properties

ArkType objects are open by default. Unknown properties pass validation, and ArkType does not emit `additionalProperties: false`, so shorn checks for extras during encoding and rejects them rather than dropping data. The codec still builds successfully.

| Type | `{ name: "Grace", extra: true }` |
| --- | --- |
| `type({ name: "string" })` | shorn throws `Unknown object property "extra"` |
| `type({ name: "string", "+": "delete" })` | encodes; ArkType strips `extra` |
| `type({ name: "string", "+": "reject" })` | ArkType throws `extra must be removed` |

Use `"+": "delete"` to strip expected extras, or `"+": "reject"` to report ArkType's own validation error. Leaving the object open works too, since shorn rejects the extras itself.

The [fingerprint](/versioning/fingerprinting/) excludes `rejectUnknown`, so equivalent ArkType and Zod schemas still agree even though they handle extra properties differently.

## Rich types

`Date` and `bigint` fail during JSON Schema conversion, before shorn receives them: ArkType reports `{ code: "date" }` and `{ code: "domain", domain: "bigint" }`. Standard Schema has no reverse operation, so shorn cannot run an ArkType morph backwards. Convert at the application boundary and encode a wire-friendly shape; see [Date, BigInt, Map, Set](/schemas/rich-types/).

A morph is also refused when its input and output produce different wire shapes, because shorn requires both sides to agree on the encoded bytes.

## Version note

2.1.28 is the floor. Earlier versions lack Standard JSON Schema, so `encode` throws *"provides validation but not structure"*. Pass the `structure` argument.
