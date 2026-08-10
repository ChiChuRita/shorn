# shorn

Already using Zod, Valibot, or ArkType? shorn is a one-line drop-in that turns
the schema you already have into compact binary serialization: `encode(Person, person)`.

No schema language, no code generation, no second source of truth — your
validation schema is the codec.

```sh
npm install shorn zod
```

ESM only, Node 20 or newer. A CommonJS caller needs `await import("shorn")`.

## Quick start

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

The same record is 35 bytes of minified JSON. shorn omits field names and type
tags because the schema already provides them.

## Why shorn

- Use your existing Zod, Valibot, or ArkType schema.
- Pay no CPU for the smaller payload: the bytes come from the schema, not a
  compressor. Up to 6.2× faster to encode and 14.5× faster to decode than JSON
  bytes. Gzip still composes on top but is not needed for the saving.
- Validate on encode and again on decode.
- Produce canonical bytes across equivalent validator schemas.
- Run in Node, Bun, Deno, browsers, and workers.
- Keep the runtime small and tree-shaken per feature.

[See the benchmarks and comparisons →](https://shorn.dev/getting-started/why-shorn/)

## Store and queue safely

Bare payloads contain no wire identifier. Add a fingerprint to anything stored,
queued, or read across deployments:

```ts
import { compile, fingerprinted } from "shorn";

const PersonWire = fingerprinted(compile(Person), { bytes: 4 });

const bytes = PersonWire.encode(person); // 4-byte fingerprint + payload
PersonWire.decode(bytes);                // rejects a different wire shape
```

Fingerprints identify wire structure, not refinements or other validation behavior.
Keep old codecs while old payloads exist, and carry an application version when
validation semantics also need versioning.

[Read about fingerprinting and schema changes →](https://shorn.dev/versioning/fingerprinting/)

## Validator support

| Validator | Setup |
| --- | --- |
| Zod 4.2+ | Pass the schema directly |
| ArkType 2.1.28+ | Pass the type directly |
| Valibot 1.x | Pass `toStandardJsonSchema(schema)` as the trailing argument |

shorn uses [Standard Schema](https://standardschema.dev/schema) for validation and
[Standard JSON Schema](https://standardschema.dev/json-schema) for structure.

## Supported scope

shorn supports strings, booleans, integers, numbers, literals, enums, nullable
values, arrays, tuples, records, discriminated unions, dynamic values
(`z.any()`), and objects — closed or open, with optional fields.

It does not support undiscriminated unions, recursive schemas, streaming, or
automatic schema evolution. `Date`, `bigint`, `Map`, and `Set` need an explicit
wire representation.

[Supported types →](https://shorn.dev/schemas/supported-types/) ·
[Rejected shapes →](https://shorn.dev/schemas/rejected-shapes/) ·
[Rich types →](https://shorn.dev/schemas/rich-types/)

## Encoding in brief

- Objects omit field names and write values in canonical key order.
- Non-negative and signed integers use varints; strings use length-prefixed UTF-8.
- Arrays write an element count; tuples take their length from the schema.
- Optional object fields use a presence bitmap.

[See the complete byte layout →](https://shorn.dev/wire-format/layout/)

## API

```ts
encode(schema, value, options?);
decode(schema, bytes, options?);
safeEncode(schema, value, options?);
safeDecode(schema, bytes, options?);
encodeAsync(schemaOrCodec, value, options?);
decodeAsync(schemaOrCodec, bytes, options?);
compile(schema, options?);
fingerprinted(codec, options?);
```

The async pair is for schemas with async refinements. It accepts a codec as well
as a schema, so it composes with `fingerprinted()`.

The low-level `m` builders expose the same wire format without a validation
library.

**[Documentation](https://shorn.dev/)** ·
**[API reference](https://shorn.dev/api/overview/)** ·
**[Performance](https://shorn.dev/performance/throughput/)**

Experimental alpha. MIT licensed.
