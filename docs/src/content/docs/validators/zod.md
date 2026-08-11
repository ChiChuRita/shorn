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

Use `z.int().nonnegative()` wherever the value cannot be negative: shorn then writes an unsigned varint, and `127` takes one byte instead of the two a ZigZag `int` spends. [Supported Types](/schemas/supported-types/) maps every Zod shape to its bytes.

## Extra properties

| Schema | `{ name: "Grace", extra: true }` |
| --- | --- |
| `z.object` | encodes; Zod strips `extra` first |
| `z.strictObject` | Zod throws `Unrecognized key: "extra"` |
| `z.looseObject` | encodes; extras follow the declared fields as a record |

`z.object` and `z.strictObject` produce the same bytes and fingerprint because both emit `additionalProperties: false`. `z.looseObject` and `z.record` are open shapes whose keys go on the wire; see [Supported Types](/schemas/supported-types/#records-open-objects-and-dynamic-values).

## Rich types: `z.codec()`

`z.date()` and `z.bigint()` fail during JSON Schema conversion, before shorn receives them. Zod is the one validator that can declare both directions of the conversion in the schema itself:

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

Two calls are needed because Standard Schema has no reverse operation, so shorn cannot run `z.encode` for you without validator-specific code. See [Date, BigInt, Map, Set](/schemas/rich-types/).

## Version note

Zod 4.2 is the floor. Earlier Zod 4 releases lack Standard JSON Schema, so `encode` throws *"provides validation but not structure"*. Pass the `structure` argument from `z.toJSONSchema`.
