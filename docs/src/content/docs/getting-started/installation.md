---
title: Installation
description: Install shorn alongside any Standard Schema validator. Zod and ArkType need nothing extra; Valibot needs its JSON Schema converter.
---

```sh
npm install @chichurita/shorn zod
# or
npm install @chichurita/shorn arktype
# or
npm install @chichurita/shorn valibot @valibot/to-json-schema
```

shorn has a single dependency, `@standard-schema/spec`, and it contains only types. The package is ESM only and imports nothing from Node's built-in modules, so the same build runs in browsers, workers, Bun, and Deno.

## Which validator needs what

shorn needs two things from a validator: Standard Schema for validation and Standard JSON Schema for structure. Zod and ArkType provide both on the schema object itself. Valibot keeps its JSON Schema conversion in a separate package, so you pass the converted structure as an extra argument.

| Validator | Version | Extra package | Call style |
| --- | --- | --- | --- |
| [Zod](/validators/zod/) | 4.2+ | none | `encode(Person, value)` |
| [ArkType](/validators/arktype/) | 2.1.28+ | none | `encode(Person, value)` |
| [Valibot](/validators/valibot/) | 1.x | `@valibot/to-json-schema` | `encode(Person, value, structure)` |

Any other validator that implements both interfaces works with no adapter.

## Requirements

**Node 20 or newer**, or any runtime that has `DataView`, `Uint8Array`, `TextDecoder` with the `fatal` option, and `TextEncoder` with `encodeInto`. Some React Native polyfills leave out `encodeInto`. **TypeScript 5.x** gives you typed results, so `decode` returns your schema's type instead of `unknown`.

There is no CommonJS build. From Node 20.19 and 22.12 on, `require("@chichurita/shorn")` still works, because those versions can `require` an ES module directly. On older versions, a CommonJS caller needs `await import("@chichurita/shorn")`.

## Verify

```ts
import { z } from "zod";
import { decode, encode } from "@chichurita/shorn";

const Person = z.object({ name: z.string(), age: z.int().nonnegative() });
const bytes = encode(Person, { name: "Ada", age: 36 });

bytes.length;          // 5
decode(Person, bytes); // { name: "Ada", age: 36 }
```

If this throws an `EncodeError`, the schema uses a shape shorn cannot encode. [Rejected Shapes](/schemas/rejected-shapes/) lists every one of them and what to use instead.
