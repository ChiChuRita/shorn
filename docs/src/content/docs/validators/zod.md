---
title: Zod
description: Zod 4.2+ implements both Standard interfaces directly, so shorn needs no adapter and no second argument.
---

Zod 4.2 and newer implements both Standard Schema and Standard JSON Schema on the schema object itself. Pass the schema and nothing else.

```ts
import { z } from "zod";
import { compile, decode, encode, fingerprinted } from "@chichurita/shorn";

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

Use `z.int().nonnegative()` wherever a value cannot be negative. shorn then writes an unsigned varint, and `127` takes one byte instead of the two a signed `int` spends. [Supported Types](/schemas/supported-types/) maps every Zod shape to its bytes.

## Extra properties

| Schema | `{ name: "Grace", extra: true }` |
| --- | --- |
| `z.object` | encodes; Zod strips `extra` first |
| `z.strictObject` | Zod throws `Unrecognized key: "extra"` |
| `z.looseObject` | encodes; extras follow the declared fields as a record |

`z.object` and `z.strictObject` produce the same bytes and fingerprint, because both emit `additionalProperties: false`. `z.looseObject` and `z.record` are open shapes whose keys go on the wire; see [Supported Types](/schemas/supported-types/#records-open-objects-and-dynamic-values).

## Rich types

`z.date()`, `z.bigint()`, `z.set()` and `z.map()` all encode natively. Pass the schema and nothing else:

```ts
const Event = z.object({
  when: z.date(),        // 6 bytes, epoch milliseconds
  id: z.bigint(),        // header byte + the magnitude
  tags: z.set(z.string()),
  scores: z.map(z.string(), z.int()),
});

const codec = compile(Event);
```

JSON Schema has no keyword for any of the four, so shorn asks Zod to write shorn's own. It detects the Zod vendor and passes `unrepresentable: "any"` plus an `override` hook to Zod's Standard JSON Schema method. The hook tags these four with [`x-shorn`](/schemas/rich-types/#the-x-shorn-keyword) and re-throws for the types that still have no wire form. `z.iso.datetime()` is packed into the same 6 bytes, and accepts only the `toISOString()` spelling.

`z.date().nullable()` works, and so does a Set of Sets. A recursive type reached through a Set or Map element is [refused](/schemas/rejected-shapes/#recursion-through-a-set-or-map). A Date cannot be a branch of a type-disjoint union, because it has no JSON type to identify it by.

### What is still refused

`z.undefined()`, `z.void()`, `z.symbol()`, `z.nan()`, `z.custom()`, `z.function()` and a transform still fail at compile, each named by Zod's own word for it:

```
undefined cannot be represented in JSON Schema
```

`z.literal(undefined)` and a bigint literal get a line of their own, because with the representability check off Zod would drop the first and write the second as a number.

For a **transform**, `z.codec()` declares both directions in the schema itself, and shorn encodes the wire side:

```ts
const Rich = z.object({
  slug: z.codec(z.string(), z.string(), {
    decode: (text) => text.trim(),
    encode: (text) => text.trim(),
  }),
});

const Wire = z.object({ slug: z.string() });
const codec = fingerprinted(compile(Wire));

const bytes = codec.encode(z.encode(Rich, value));
const back = z.decode(Rich, codec.decode(bytes));
```

It takes two calls because Standard Schema has no reverse operation, so shorn cannot call `z.encode` for you without validator-specific code. See [Date, BigInt, Map, Set](/schemas/rich-types/).

## Version note

Zod 4.2 is the minimum. Earlier Zod 4 releases lack Standard JSON Schema, so `encode` throws *"provides validation but not structure"*. On those versions, pass the `structure` argument from `z.toJSONSchema`.
