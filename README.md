# shorn

shorn turns a validation schema you already have into compact binary
serialization. Pass a Zod, Valibot, or ArkType schema to `encode` and get bytes
back — no schema language, no code generation, no second source of truth.

Field names and type tags stay out of the payload because the schema already
provides them. The saving comes from the schema, not a compressor, so it costs
no CPU: up to 6.2× faster to encode and 14.5× faster to decode than JSON bytes.

shorn is experimental alpha and runs in Node, Bun, Deno, browsers, and workers.

## Installation

```sh
npm install shorn zod
```

ESM only, Node 20 or newer. `require("shorn")` works from Node 20.19 and 22.12 on;
before that a CommonJS caller needs `await import("shorn")`.

## Encode a value

```ts
import { z } from "zod";
import { decode, encode } from "shorn";

const Person = z.object({
  name: z.string(),
  age: z.int().nonnegative(),
  sex: z.enum(["M", "F", "X"]),
});

const person = { name: "Grace", age: 45, sex: "F" } as const;

const bytes = encode(Person, person); // Uint8Array(8)
const back = decode(Person, bytes);   // typed and validated
```

The same record is 35 bytes of minified JSON. Validation runs on encode and
again on decode, and equivalent schemas across validators produce the same bytes.

## Store and queue safely

Bare payloads carry no wire identifier. Add a fingerprint to anything stored,
queued, or read across deployments:

```ts
import { compile, fingerprinted } from "shorn";

const PersonWire = fingerprinted(compile(Person), { bytes: 4 });

const bytes = PersonWire.encode(person); // 4-byte fingerprint + payload
PersonWire.decode(bytes);                // rejects a different wire shape
```

A fingerprint identifies wire structure, not refinements. Keep old codecs while
old payloads exist.

## Use another validator

Pass a Zod 4.2+ schema or an ArkType 2.1.28+ type directly. For Valibot 1.x,
pass `toStandardJsonSchema(schema)` as the trailing argument. shorn reads
validation through [Standard Schema](https://standardschema.dev/schema) and
structure through [Standard JSON Schema](https://standardschema.dev/json-schema).

## Scope

shorn covers strings, booleans, integers, numbers, literals, enums, nullable
values, arrays, tuples, records, discriminated unions, dynamic values
(`z.any()`), and objects — closed or open, with optional fields. It does not
support undiscriminated unions, recursive schemas, streaming, or automatic
schema evolution. `Date`, `bigint`, `Map`, and `Set` need an explicit wire
representation.

## Documentation

See [getting started](https://shorn.dev/getting-started/introduction/) and the
[API reference](https://shorn.dev/api/overview/) for the complete workflow. The
docs also cover the [byte layout](https://shorn.dev/wire-format/layout/),
[supported types](https://shorn.dev/schemas/supported-types/),
[rejected shapes](https://shorn.dev/schemas/rejected-shapes/),
[fingerprinting](https://shorn.dev/versioning/fingerprinting/), and
[performance](https://shorn.dev/performance/throughput/).

MIT licensed.
