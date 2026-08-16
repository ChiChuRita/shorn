# shorn

shorn turns a validation schema you already have into compact binary
serialization. Pass a Zod, Valibot, or ArkType schema to `encode` and get bytes
back — no schema language, no code generation, no second source of truth.

Field names and type tags stay out of the payload because the schema already
provides them. The saving comes from the schema, not a compressor, so it costs
no CPU: up to 6.0× faster to encode and 13.6× faster to decode than JSON bytes.

shorn is experimental alpha and runs in Node, Bun, Deno, browsers, and workers.

## Installation

```sh
npm install @chichurita/shorn zod
```

ESM only, Node 20 or newer. `require("@chichurita/shorn")` works from Node 20.19 and 22.12 on;
before that a CommonJS caller needs `await import("@chichurita/shorn")`.

## Encode a value

```ts
import { z } from "zod";
import { decode, encode } from "@chichurita/shorn";

const Person = z.object({
  name: z.string(),
  age: z.int().nonnegative(),
  sex: z.enum(["M", "F", "X"]),
});

const person = { name: "Grace", age: 45, sex: "F" } as const;

const bytes = encode(Person, person); // Uint8Array(8)
const back = decode(Person, bytes);   // typed and validated
```

Validation runs on encode and again on decode, and equivalent schemas across
validators produce the same bytes.

## Where the bytes go

The same record as minified JSON:

```text
{"name":"Grace","age":45,"sex":"F"}   35 bytes
```

The schema already knows the field names, so they do not need to be sent:

```text
["Grace",45,"F"]                      16 bytes
```

The schema also knows the order and the types, so the brackets, commas and
quotes are not needed either, and `"F"` is one of three known values so it can
be an index instead of a string:

```text
2d 05 47 72 61 63 65 00               8 bytes
│  │  └─────┬──────┘ │
│  │        │        └── sex, index 0 of the enum
│  │        └── "Grace"
│  └── string length, 5
└── age, 45
```

The middle step is the uncontroversial one: the array carries the same
information as the object, because the reader knows what each position means.
shorn takes that same move one step further, and the schema is what makes both
steps safe.

`2d` is age 45, first because fields are written in canonical order rather than
declaration order. `00` is the index of `"F"` in the sorted enum
`["F", "M", "X"]`.

## Store and queue safely

Bare payloads carry no wire identifier. Add a fingerprint to anything stored,
queued, or read across deployments:

```ts
import { compile, fingerprinted } from "@chichurita/shorn";

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
values, arrays, tuples, records, unions — discriminated, or with no two branches
sharing a JSON type — recursive schemas, dynamic values (`z.any()`), and
objects — closed or open, with optional fields. It does not support unions whose
branches overlap, streaming, or automatic schema evolution. `Date`, `bigint`,
`Map`, and `Set` need an explicit wire representation.

## Documentation

See [getting started](https://shorn.dev/getting-started/introduction/) and the
[API reference](https://shorn.dev/api/overview/) for the complete workflow. The
docs also cover the [byte layout](https://shorn.dev/wire-format/layout/),
[supported types](https://shorn.dev/schemas/supported-types/),
[rejected shapes](https://shorn.dev/schemas/rejected-shapes/),
[fingerprinting](https://shorn.dev/versioning/fingerprinting/), and
[performance](https://shorn.dev/performance/throughput/).

MIT licensed.
