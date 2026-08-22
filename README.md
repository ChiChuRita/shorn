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
No IDL, no codegen, no second source of truth.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@chichurita/shorn"><img src="https://img.shields.io/npm/v/%40chichurita%2Fshorn" alt="npm version"></a>
  <a href="https://github.com/ChiChuRita/shorn/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/ChiChuRita/shorn/ci.yml?branch=main" alt="CI status"></a>
  <img src="https://img.shields.io/badge/gzip-5.45_kB-blue" alt="bundle size, 5.45 kB gzip">
  <a href="https://github.com/ChiChuRita/shorn/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/%40chichurita%2Fshorn" alt="MIT license"></a>
</p>

## Installation

```sh
npm install @chichurita/shorn zod
```

Runs in Node, Bun, Deno, browsers, and workers.

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

The picture above is the whole story: field names, brackets, and quotes never
reach the wire because the schema already carries them, and enum members travel
as an index. The byte-by-byte walk lives in
[how it works](https://shorn.dev/core-concepts/how-it-works/#where-the-bytes-go).

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

## Use it from a shell

Installing the package also puts a `shorn` command on the path, for scripts and
agents that need a payload without writing an integration:

```sh
$ echo '{"name":"Grace","age":45,"sex":"F"}' | npx shorn encode ./person.mjs --export Person --base64
LQVHcmFjZQA=
$ echo 'LQVHcmFjZQA=' | npx shorn decode ./person.mjs --export Person --base64
{"name":"Grace","age":45,"sex":"F"}
```

`encode` takes a JSON value on stdin and writes bytes on stdout, `decode` does the
reverse, and `--base64` puts text on the byte side of either. The module path is
imported: it can export a Zod or ArkType schema, or a codec from `compile()`. Without
`--export`, shorn takes the default export, or the only export when there is exactly
one. Errors are one line on stderr, and the exit code is 0 for success, 1 for a
failure, 2 for a command line shorn could not read. `shorn --help` lists the lot.

## Scope

shorn covers strings, booleans, integers, numbers, literals, enums, nullable
values, arrays, tuples, records, unions — discriminated, or with no two branches
sharing a JSON type — recursive schemas, dynamic values (`z.any()`), and
objects — closed or open, with optional fields. It does not support unions whose
branches overlap, streaming, or automatic schema evolution. `Date`, `bigint`,
`Map`, and `Set` need an explicit wire representation.

The saving comes from the schema, not a compressor, so it costs no CPU: up to
6.0× faster to encode and 13.6× faster to decode than JSON bytes. The low-level
`m` API bundles to 5.45 KB gzip; `compile` with validation is 9.62 KB
(esbuild-minified browser bundles, schema declarations excluded).

## Documentation

See [getting started](https://shorn.dev/getting-started/introduction/) and the
[API reference](https://shorn.dev/api/overview/) for the complete workflow. The
docs also cover the [byte layout](https://shorn.dev/wire-format/layout/),
[supported types](https://shorn.dev/schemas/supported-types/),
[rejected shapes](https://shorn.dev/schemas/rejected-shapes/),
[fingerprinting](https://shorn.dev/versioning/fingerprinting/),
[performance](https://shorn.dev/performance/throughput/), and the
[CLI](https://shorn.dev/cli/).

MIT licensed.
