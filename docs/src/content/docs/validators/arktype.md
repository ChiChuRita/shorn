---
title: ArkType
description: ArkType 2.1.28+ implements both Standard interfaces directly. Its open objects are the one thing to know about.
---

ArkType 2.1.28 and newer implements both Standard Schema and Standard JSON Schema on the type itself. Pass the type and nothing else.

```ts
import { type } from "arktype";
import { decode, encode } from "@chichurita/shorn";

const Person = type({
  name: "string",
  age: "number.integer >= 0",
  role: "'viewer' | 'editor' | 'admin'",
});

const person = { name: "Grace", age: 45, role: "admin" } as const;
const bytes = encode(Person, person); // 8 bytes
const decoded = decode(Person, bytes);
```

An equivalent Zod schema produces the same bytes and the same fingerprint. Use `"number.integer >= 0"` wherever a value cannot be negative: a signed integer uses ZigZag encoding and needs an extra byte at half the value an unsigned one would. [Supported types](/schemas/supported-types/) maps every ArkType shape to its bytes.

## Extra properties

ArkType objects are open by default. Unknown properties pass validation, and ArkType does not emit `additionalProperties: false`, so shorn checks for extras during encoding and rejects them rather than dropping data. The codec itself still builds.

| Type | `{ name: "Grace", extra: true }` |
| --- | --- |
| `type({ name: "string" })` | shorn throws `Unknown object property "extra"` |
| `type({ name: "string", "+": "delete" })` | encodes; ArkType strips `extra` |
| `type({ name: "string", "+": "reject" })` | ArkType throws `extra must be removed` |

Use `"+": "delete"` to strip extras you expect, or `"+": "reject"` to get ArkType's own validation error. Leaving the object open works too, since shorn rejects the extras itself.

The [fingerprint](/versioning/fingerprinting/) leaves out `rejectUnknown`, so equivalent ArkType and Zod schemas still agree even though they handle extra properties differently.

## Defaults

A default, `{ theme: "string = 'light'" }`, compiles to an optional field. ArkType describes the field as optional on the input side and required on the output side, and shorn takes the input side's optionality. An equivalent Zod or Valibot schema produces the same bytes and fingerprint. Encode validates first, so ArkType has filled the field and its presence bit is always set. [Zod defaults](/validators/zod/#defaults) covers what a payload without the field decodes to.

## Rich types

`Date` and `bigint` encode natively:

```ts
const Event = type({ when: "Date", id: "bigint" });
const codec = compile(Event); // 6 bytes for the Date
```

JSON Schema has no keyword for either, so shorn's conversion hook writes its own [`x-shorn`](/schemas/rich-types/#the-x-shorn-keyword) keyword for them during ArkType's conversion. An equivalent Zod schema produces the same bytes and the same fingerprint.

`Set` and `Map` are refused:

```text
ArkType's Set carries no element type, so there is nothing to encode its
members as; convert it at the edge
```

Both are keywords in ArkType, and neither says what type its members have. A format without type tags has nothing to write the members as, and encoding them as empty containers would silently drop data. Zod's `z.set(T)` and Valibot's `v.set(T)` name the element type and are supported. Any other prototype is refused too, as `RegExp cannot be represented in JSON Schema`.

ArkType has no `format: "date-time"` spelling either. `"string.date.iso"` converts to a pattern, so an ISO timestamp stays an ordinary string rather than becoming the 6 bytes `z.iso.datetime()` gets.

A morph is refused when its input and output produce different wire shapes, because shorn needs both sides to agree on the bytes. Standard Schema has no reverse operation, so shorn cannot run a morph backwards; see [Date, BigInt, Map, Set](/schemas/rich-types/). A morph whose two sides have the same wire shape compiles, and runs on encode and again on decode, so it has to return its own output unchanged when it runs a second time.

## Minimum version

2.1.28 is the minimum. Earlier versions lack Standard JSON Schema, so `encode` throws `provides validation but not structure`. On those versions, pass the `structure` argument.
