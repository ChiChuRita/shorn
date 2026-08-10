---
title: Installation
description: Install shorn alongside any Standard Schema validator. Zod and ArkType need nothing extra; Valibot needs its JSON Schema converter.
---

shorn has one dependency, `@standard-schema/spec`, which is types-only.

```sh
npm install shorn zod
# or
npm install shorn arktype
# or
npm install shorn valibot @valibot/to-json-schema
```

shorn is ESM-only and has no Node built-ins. Its `neutral` platform target runs unchanged in browsers, workers, Bun, and Deno.

## Which validator needs what

shorn uses Standard Schema for validation and Standard JSON Schema for structure. Some validators provide both interfaces on one object; others need an extra converter.

| Validator | Version | Extra package | Call style |
| --- | --- | --- | --- |
| [Zod](/validators/zod/) | 4.2+ | none | `encode(Person, value)` |
| [ArkType](/validators/arktype/) | 2.1.28+ | none | `encode(Person, value)` |
| [Valibot](/validators/valibot/) | 1.x | `@valibot/to-json-schema` | `encode(Person, value, structure)` |

Any other validator that implements both interfaces works without an adapter.

## Requirements

- **Node 20+**, or any runtime with `DataView`, `Uint8Array`, `TextDecoder` (with `fatal`) and `TextEncoder`, including `encodeInto`, which some React Native polyfills omit.
- **TypeScript 5.x** for typed results: `decode` returns your schema's type instead of `unknown`.
- **ESM.** There is no CommonJS build.

## Verify

```ts
import { z } from "zod";
import { decode, encode } from "shorn";

const Person = z.object({ name: z.string(), age: z.int().nonnegative() });
const bytes = encode(Person, { name: "Ada", age: 36 });

bytes.length;          // 5
decode(Person, bytes); // { name: "Ada", age: 36 }
```

An `EncodeError` here means the schema uses an unsupported shape. [Rejected Shapes](/schemas/rejected-shapes/) lists each unsupported shape and what to use instead.
