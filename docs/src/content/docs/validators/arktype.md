---
title: ArkType
description: ArkType 2.1.28+ implements both Standard interfaces directly. Its open objects are the one thing to know about.
---

ArkType 2.1.28 and newer implements both Standard Schema and Standard JSON Schema directly. Pass the type and nothing else.

```ts
import { type } from "arktype";
import { decode, encode } from "shorn";

const Person = type({
  name: "string",
  age: "number.integer >= 0",
  sex: "'M' | 'F' | 'X'",
});

const person = { name: "Grace", age: 45, sex: "F" } as const;
const bytes = encode(Person, person); // 8 bytes
const decoded = decode(Person, bytes);
```

An equivalent Zod schema produces the same bytes and fingerprint.

## Wire mapping

| ArkType | Wire |
| --- | --- |
| `"string"` | varint length + UTF-8 |
| `"boolean"` | one byte |
| `"number.integer"` | ZigZag varint |
| `"number.integer >= 0"` | plain varint |
| `"number"` | float64, always 8 bytes |
| `"'M' \| 'F' \| 'X'"` | varint index in sorted order |
| `"'M'"` | zero bytes |
| `"string[]"` | varint count + elements |
| `["string", "number"]` | tuple: elements only |
| `{ ... }` | presence bitmap + values in canonical key order |
| `"key?": "string"` | a bit in the presence bitmap |
| `"string \| null"` | discriminator byte + value |

Use `"number.integer >= 0"` when the value cannot be negative. Signed integers use ZigZag encoding and need an extra byte at lower values.

## Extra properties

ArkType objects are open by default. Unknown properties pass through validation, and ArkType does not emit `additionalProperties: false`. shorn therefore checks for extras during encoding and rejects them instead of dropping data. The codec still builds successfully.

| Type | `{ name: "Grace", extra: true }` |
| --- | --- |
| `type({ name: "string" })` | shorn throws `Unknown object property "extra"` |
| `type({ name: "string", "+": "delete" })` | encodes; ArkType strips `extra` |
| `type({ name: "string", "+": "reject" })` | ArkType throws `extra must be removed` |

Use `"+": "delete"` to strip expected extras, or `"+": "reject"` to report ArkType's validation error. Leaving the object open also works because shorn will reject extras during encoding.

The [fingerprint](/versioning/fingerprinting/) excludes `rejectUnknown`, so equivalent ArkType and Zod schemas still agree even though they handle extra properties differently.

## Rich types

`Date` and `bigint` fail during JSON Schema conversion, before shorn receives them. ArkType reports `{ code: "date" }` and `{ code: "domain", domain: "bigint" }`. Convert rich values at the application boundary and encode a wire-friendly shape; see [Date, BigInt, Map, Set](/schemas/rich-types/). Standard Schema has no reverse operation, so shorn cannot run an ArkType morph backwards.

A morph is also refused when its input and output produce different wire shapes. shorn requires both sides to agree on the encoded bytes.

## Version note

2.1.28 is the floor. Earlier versions lack Standard JSON Schema, so `encode` throws *"provides validation but not structure"*. Pass the `structure` argument.
