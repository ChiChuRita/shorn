<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)"
            srcset="https://raw.githubusercontent.com/ChiChuRita/shorn/main/assets/hero-dark.svg">
    <img width="720"
         alt='{"name":"Grace","age":45,"sex":"F"} is 35 bytes as JSON, 16 as a positional array, and 8 bytes through shorn: 2d is age 45, 05 is the string length, 47 to 65 is Grace, 00 is the enum index of "F"'
         src="https://raw.githubusercontent.com/ChiChuRita/shorn/main/assets/hero-light.svg">
  </picture>
</p>

<p align="center"><b>Your Zod, Valibot, or ArkType schema is already a binary codec.</b><br>
No schema file, no code generation, no second copy of your types to keep in sync.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@chichurita/shorn"><img src="https://img.shields.io/npm/v/%40chichurita%2Fshorn" alt="npm version"></a>
  <a href="https://github.com/ChiChuRita/shorn/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/ChiChuRita/shorn/ci.yml?branch=main" alt="CI status"></a>
  <img src="https://img.shields.io/badge/gzip-6.45_kB-blue" alt="bundle size, 6.45 kB gzip">
  <a href="https://github.com/ChiChuRita/shorn/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/%40chichurita%2Fshorn" alt="MIT license"></a>
</p>

## Installation

```sh
npm install @chichurita/shorn zod
```

Works in Node 20 or newer, Bun, Deno, browsers, and workers. ESM only:
`require("@chichurita/shorn")` reaches the ESM build from Node 20.19 and
22.12 on, and older versions need `await import()`.

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

shorn runs your validator before it writes the bytes, and again after it reads
them back. The same schema written in Zod, Valibot, or ArkType produces the
same bytes.

## Where the bytes go

JSON spends most of its bytes on things both sides already know: field names,
quotes, brackets, and commas. Your schema carries all of that, so shorn leaves
it out and writes only the values. An enum member becomes a small index instead
of a string. The picture above shows the result, and
[how it works](https://shorn.dev/core-concepts/how-it-works/#where-the-bytes-go)
walks through the eight bytes one at a time.

## Store and queue safely

A bare payload does not say which schema wrote it. If the bytes will sit in a
database, a queue, or a file, or cross a deployment boundary, add a fingerprint
so that a mismatch is caught instead of decoded into a wrong value:

```ts
import { compile, fingerprinted } from "@chichurita/shorn";

const PersonWire = fingerprinted(compile(Person), { bytes: 4 });

const bytes = PersonWire.encode(person); // 4-byte fingerprint + payload
PersonWire.decode(bytes);                // rejects a different wire shape
```

The fingerprint identifies the wire shape only. Validation rules such as
`.min()` or `.email()` are not part of it. When a schema changes, keep the old
codec around for as long as old payloads exist.

## Use another validator

Zod 4.2 or newer and ArkType 2.1.28 or newer work as they are: pass the schema.
Valibot 1.x keeps its JSON Schema conversion in a separate package, so pass
`toStandardJsonSchema(schema)` as the last argument. Under the hood, shorn
reads validation through [Standard Schema](https://standardschema.dev/schema)
and structure through
[Standard JSON Schema](https://standardschema.dev/json-schema).

Valibot's wrapper takes no options, so for `Date`, `bigint`, `Map` and `Set`
use the raw converter together with `valibotOverride`:

```ts
import { toJsonSchema } from "@valibot/to-json-schema";
import { compile, valibotOverride } from "@chichurita/shorn";

const structure = toJsonSchema(schema, { overrideSchema: valibotOverride(toJsonSchema) });
const codec = compile(schema, structure);
```

## Scope

Strings, booleans, integers, floats, literals, enums, nullable values, arrays,
tuples, records, recursive schemas, `z.any()`, and objects, closed or open, with
optional fields. Unions need a literal tag in every branch, or branches that
share no JSON type. `Date`, `bigint`, `Map`, and `Set` are supported natively.

Not supported: overlapping unions, streaming, and schema migration.
`undefined`, symbols, `RegExp`, and class instances have no wire form, so
convert those first.

Against JSON bytes, encoding is up to 6.7× faster and decoding up to 13.0×,
with no compressor involved. The `m` API is 6.45 KB gzip; `compile` with
validation is 11.52 KB.

## Documentation

[Getting started](https://shorn.dev/getting-started/introduction/),
[API reference](https://shorn.dev/api/overview/),
[byte layout](https://shorn.dev/wire-format/layout/),
[supported types](https://shorn.dev/schemas/supported-types/),
[rejected shapes](https://shorn.dev/schemas/rejected-shapes/),
[fingerprinting](https://shorn.dev/versioning/fingerprinting/),
[performance](https://shorn.dev/performance/throughput/).

MIT licensed.
