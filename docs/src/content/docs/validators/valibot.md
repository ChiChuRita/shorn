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

That extra `structure` argument is the only difference from Zod and ArkType. All three produce the same eight bytes and fingerprint. Add `v.minValue(0)` wherever the value cannot be negative: signed integers use ZigZag encoding and need an extra byte at lower values. [Supported Types](/schemas/supported-types/) maps every Valibot shape to its bytes.

## Convert once

The plan is cached by the identity of **both** the schema and structure objects. Creating a new structure on every call rebuilds the plan, and `toStandardJsonSchema` also has its own cost, so an inline call pays twice.

```ts
// Cached.
const PersonWire = compile(Person, toStandardJsonSchema(Person));

// Not cached: a new structure object per call.
encode(Person, person, toStandardJsonSchema(Person));
```

Hoist the structure to a module constant, or keep the `compile` codec.

## Extra properties

All four variants compile.

| Schema | `{ a: "x", b: 1 }` |
| --- | --- |
| `v.object` | encodes; Valibot strips `b` |
| `v.strictObject` | Valibot throws `Invalid key: Expected never but received "b"` |
| `v.looseObject` | shorn throws `Unknown object property "b"` |
| `v.record` | encodes as a record: keys on the wire |

Only `v.strictObject` emits `additionalProperties: false`. The converter omits that setting for `v.object` and `v.looseObject`, so shorn checks extras itself — which is why `looseObject` produces shorn's error instead of passing the property through. Zod's `z.looseObject` emits `additionalProperties: true` and is an open shape instead. The similar API names diverge because their JSON Schema converters emit different structures.

The [fingerprint](/versioning/fingerprinting/) excludes `rejectUnknown`, so `v.object`, `v.strictObject`, and equivalent Zod schemas share the same bytes and fingerprint.

## Rich types

`v.date()` throws *"The 'date' schema cannot be converted to JSON Schema"* before shorn receives it, and `v.pipe` transforms have no reverse operation through Standard Schema. Convert at the application boundary; see [Date, BigInt, Map, Set](/schemas/rich-types/).
