---
title: Valibot
description: Valibot keeps JSON Schema conversion in a separate package, so shorn takes the converted structure as an option.
---

Valibot implements Standard Schema but provides JSON Schema conversion in a separate, tree-shakeable package. Pass the output of its official converter to shorn.

```ts
import * as v from "valibot";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { decode, encode } from "@chichurita/shorn";

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

Only `v.strictObject` emits `additionalProperties: false`. The converter omits it for `v.object` and `v.looseObject`, so shorn checks extras itself — which is why `looseObject` produces shorn's error rather than passing the property through. Zod's `z.looseObject` emits `additionalProperties: true` and is an open shape instead; the similar names diverge because the two converters emit different structures.

The [fingerprint](/versioning/fingerprinting/) excludes `rejectUnknown`, so `v.object`, `v.strictObject`, and equivalent Zod schemas share the same bytes and fingerprint.

## Rich types

`v.date()`, `v.bigint()`, `v.set()` and `v.map()` encode natively, but not through `toStandardJsonSchema`. That wrapper takes no options, so there is no slot to tag them in. Use the raw converter with `valibotOverride`, and pass the plain document it returns as `structure`:

```ts
import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";
import { compile, valibotOverride } from "@chichurita/shorn";

const Person = v.object({
  when: v.date(),
  id: v.bigint(),
  tags: v.set(v.string()),
  scores: v.map(v.string(), v.number()),
});

const structure = toJsonSchema(Person, { overrideSchema: valibotOverride(toJsonSchema) });
const codec = compile(Person, structure);
```

`compile` accepts a plain JSON Schema document as well as a Standard JSON Schema implementation, which is what makes the raw converter usable here. The override writes shorn's [`x-shorn`](/schemas/rich-types/#the-x-shorn-keyword) keyword, so the codec is the same one a Zod schema of the same shape produces.

The converter is an argument rather than an import: shorn depends on no validator, and a Set inside a Set has to be converted through the same hook or the inner one would throw where the outer one did not. Hoist `structure` to a module constant as with any Valibot structure, or the codec is rebuilt per call.

Without the override, Valibot's converter refuses all four before shorn sees anything, and shorn keeps the reason and appends the remedy:

```
The "date" schema cannot be converted to JSON Schema. (shorn has no wire form
for this value; convert it at the edge, see Rejected Shapes)
```

`v.pipe(v.string(), v.isoTimestamp())` needs none of this: it converts to `format: "date-time"`, which shorn packs into 6 bytes, and it accepts only the `toISOString()` spelling. A `v.transform` has no reverse operation through Standard Schema and stays refused. See [Date, BigInt, Map, Set](/schemas/rich-types/).
