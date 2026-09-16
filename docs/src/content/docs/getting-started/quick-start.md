---
title: Quick start
description: Encode, decode, reuse a compiled codec, and add a wire identifier to payloads you store.
---

This page takes one Zod schema from a first encode to a codec you can store payloads with. Every snippet below builds on these imports.

```ts
import { z } from "zod";
import { compile, decode, encode, fingerprinted, safeDecode } from "@chichurita/shorn";

const Person = z.object({
  name: z.string(),
  age: z.int().nonnegative(),
  sex: z.enum(["M", "F", "X"]),
});

const person = { name: "Grace", age: 45, sex: "F" } as const;

const bytes = encode(Person, person);
const back = decode(Person, bytes); // typed and validated
```

The payload is eight bytes. Field names and type tags never leave the schema. [Where the bytes go](/core-concepts/how-it-works/#where-the-bytes-go) labels each of those eight bytes, and [Byte layout](/wire-format/layout/) covers every wire type.

Pass Zod and ArkType schemas as they are. Valibot needs one extra argument, the converted structure. See [Valibot](/validators/valibot/).

## Reuse a codec object

`compile` returns the same cached plan as a codec object:

```ts
const PersonWire = compile(Person);

PersonWire.encode(person);
PersonWire.decode(bytes);
```

Use `compile` when you want a codec you can pass around or keep in a registry. It is not faster than calling `encode` and `decode` directly: both forms share one cached plan per schema object.

## Store or queue data

A bare payload does not say which schema wrote it. Decode it with the wrong schema and you may get a plausible but wrong value. For anything that will be stored, queued, or read by a later deployment, add a four-byte fingerprint:

```ts
const StoredPerson = fingerprinted(compile(Person), { bytes: 4 });

const stored = StoredPerson.encode(person);
StoredPerson.decode(stored); // rejects a different wire shape
```

A fingerprint identifies the wire shape only. It does not change when you add a validation rule such as `.max()`. Read [Wire fingerprints](/versioning/fingerprinting/) before storing data.

## Handle expected failures

Where bad input is normal traffic rather than a surprise, use the safe variant and get a result object instead of an exception:

```ts
const result = safeDecode(Person, bytes);
if (!result.success) return new Response("Bad request", { status: 400 });
result.data; // typed
```
