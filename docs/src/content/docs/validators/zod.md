---
title: Zod
description: Zod 4.2+ implements both Standard interfaces directly, so shorn needs no adapter and no second argument.
---

Zod 4.2 and newer implements both Standard Schema and Standard JSON Schema directly. Pass the schema and nothing else.

```ts
import { z } from "zod";
import { compile, decode, encode, fingerprinted } from "shorn";

const Person = z.object({
  name: z.string(),
  age: z.int().nonnegative(),
  sex: z.enum(["M", "F", "X"]),
});

const person = { name: "Grace", age: 45, sex: "F" } as const;
const bytes = encode(Person, person); // 8 bytes
const decoded = decode(Person, bytes);

const PersonWire = compile(Person);                 // reusable codec
const PersonStored = fingerprinted(compile(Person), { bytes: 4 });
```

## Wire mapping

| Zod | Wire |
| --- | --- |
| `z.string()` | varint length + UTF-8 |
| `z.boolean()` | one byte |
| `z.int()` | ZigZag varint |
| `z.int().nonnegative()` | plain varint |
| `z.number()` | float64, always 8 bytes |
| `z.enum([...])` | varint index in sorted order |
| `z.literal(...)` | zero bytes |
| `z.array(T)` | varint count + elements |
| `z.tuple([...])` | elements only |
| `z.object` / `z.strictObject` | presence bitmap + values in canonical key order |
| `z.optional()` | a bit in the presence bitmap |
| `z.nullable()` | discriminator byte + value |

Use `z.int().nonnegative()` when the value cannot be negative. shorn then uses an unsigned varint. For example, `127` takes one byte as a `uint` and two bytes as a ZigZag-encoded `int`.

## Extra properties

| Schema | `{ name: "Grace", extra: true }` |
| --- | --- |
| `z.object` | encodes; Zod strips `extra` first |
| `z.strictObject` | Zod throws `Unrecognized key: "extra"` |
| `z.looseObject` | encodes; extras follow the declared fields as a record |

`z.object` and `z.strictObject` produce the same bytes and fingerprint because both emit `additionalProperties: false`. `z.looseObject` and `z.record` are open shapes whose keys go on the wire; see [Supported Types](/schemas/supported-types/#records-open-objects-and-dynamic-values).

## Refinements are validated, not encoded

`.min`, `.max`, `.regex`, `.refine` run on encode and decode and never change a byte. Adding `.max(300)` does not reissue the [fingerprint](/versioning/fingerprinting/).

## Rich types: `z.codec()`

`z.date()` and `z.bigint()` fail during JSON Schema conversion because JSON Schema cannot represent them. Convert at the application boundary:

```ts
const Rich = z.object({
  when: z.codec(z.iso.datetime(), z.date(), {
    decode: (text) => new Date(text),
    encode: (date) => date.toISOString(),
  }),
});

const Wire = z.object({ when: z.iso.datetime() });
const codec = fingerprinted(compile(Wire));

const bytes = codec.encode(z.encode(Rich, value));
const back = z.decode(Rich, codec.decode(bytes));
```

This requires two calls because Standard Schema has no reverse operation. shorn cannot call Zod's `z.encode` without adding validator-specific code. See [Date, BigInt, Map, Set](/schemas/rich-types/).

## Async refinements

```ts
const bytes = await encodeAsync(Person, person);
const back = await decodeAsync(Person, bytes);
```

Both functions accept a codec as readily as the schema, so async validation composes with `fingerprinted()`. See [Validation](/core-concepts/validation/).

## Version note

Zod 4.2 is the floor. Earlier Zod 4 releases lack Standard JSON Schema, so `encode` throws *"provides validation but not structure"*. Pass the `structure` argument from `z.toJSONSchema`.
