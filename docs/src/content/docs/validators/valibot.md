---
title: Valibot
description: Valibot keeps JSON Schema conversion in a separate package, so shorn takes the converted structure as an option.
---

Valibot implements Standard Schema but provides JSON Schema conversion in a separate, tree-shakeable package. Pass the output of its official converter to shorn.

```ts
import * as v from "valibot";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { decode, encode } from "shorn";

const Person = v.object({
  name: v.string(),
  age: v.pipe(v.number(), v.integer(), v.minValue(0)),
  sex: v.picklist(["M", "F", "X"]),
});

const structure = toStandardJsonSchema(Person);

const person = { name: "Grace", age: 45, sex: "F" } as const;
const bytes = encode(Person, person, structure); // 8 bytes
const decoded = decode(Person, bytes, structure);
```

That extra `structure` argument is the only difference from Zod and ArkType. All three produce the same eight bytes and fingerprint.

## Convert once

The plan is cached by the identity of **both** the schema and structure objects. Creating a new structure on every call therefore rebuilds the plan, and `toStandardJsonSchema` also has its own cost.

```ts
// Cached.
const PersonWire = compile(Person, toStandardJsonSchema(Person));

// Not cached: a new structure object per call.
encode(Person, person, toStandardJsonSchema(Person));
```

Hoist the structure to a module constant, or keep the `compile` codec.

## Wire mapping

| Valibot | Wire |
| --- | --- |
| `v.string()` | varint length + UTF-8 |
| `v.boolean()` | one byte |
| `v.pipe(v.number(), v.integer())` | ZigZag varint |
| `+ v.minValue(0)` | plain varint |
| `v.number()` | float64, always 8 bytes |
| `v.picklist([...])` | varint index in sorted order |
| `v.literal(...)` | zero bytes |
| `v.array(T)` | varint count + elements |
| `v.tuple([...])` | elements only |
| `v.object({...})` | presence bitmap + values in canonical key order |
| `v.optional(T)` | a bit in the presence bitmap |
| `v.nullable(T)` | discriminator byte + value |

Add `v.minValue(0)` when the value cannot be negative. Signed integers use ZigZag encoding and need an extra byte at lower values.

## Extra properties

All four variants compile.

| Schema | `{ a: "x", b: 1 }` |
| --- | --- |
| `v.object` | encodes; Valibot strips `b` |
| `v.strictObject` | Valibot throws `Invalid key: Expected never but received "b"` |
| `v.looseObject` | shorn throws `Unknown object property "b"` |
| `v.record` | encodes as a record: keys on the wire |

Only `v.strictObject` emits `additionalProperties: false`. The converter omits that setting for `v.object` and `v.looseObject`, so shorn checks extras itself. That is why `looseObject` produces shorn's error instead of passing the property through.

In contrast, Zod's `z.looseObject` emits `additionalProperties: true`, so shorn refuses it when the codec is built. The similar API names produce different results because their JSON Schema converters emit different structures.

The [fingerprint](/versioning/fingerprinting/) excludes `rejectUnknown`. As a result, `v.object`, `v.strictObject`, and equivalent Zod schemas share the same bytes and fingerprint.

## Rich types

`v.date()` throws *"The 'date' schema cannot be converted to JSON Schema"* before shorn receives it. `v.pipe` transforms also have no reverse operation through Standard Schema. Convert rich values at the application boundary; see [Date, BigInt, Map, Set](/schemas/rich-types/).
