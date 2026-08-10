---
title: Quick Start
description: Encode, decode, reuse a compiled codec, and add wire identity for persistent payloads.
---

```ts
import { z } from "zod";
import { compile, decode, encode, fingerprinted, safeDecode } from "shorn";

const Person = z.object({
  name: z.string(),
  age: z.int().nonnegative(),
  sex: z.enum(["M", "F", "X"]),
});

const person = { name: "Grace", age: 45, sex: "F" } as const;

const bytes = encode(Person, person);
const back = decode(Person, bytes); // typed and validated
```

The payload is eight bytes: field names and type tags remain in the schema. See [Byte Layout](/wire-format/layout/) for the exact encoding.

## Reuse a codec object

```ts
const PersonWire = compile(Person);

PersonWire.encode(person);
PersonWire.decode(bytes);
```

Use `compile` when you want a codec to pass around or store in a registry. The functional API caches the same codec by schema identity.

## Store or queue data

Bare payloads contain no wire identifier. Add a four-byte fingerprint to persistent or version-crossing data:

```ts
const StoredPerson = fingerprinted(compile(Person), { bytes: 4 });

const stored = StoredPerson.encode(person);
StoredPerson.decode(stored); // rejects a different wire shape
```

Fingerprints identify wire structure, not refinements or other validation behavior. Read [Wire Fingerprints](/versioning/fingerprinting/) before storing data.

## Handle expected failures

```ts
const result = safeDecode(Person, bytes);
if (!result.success) return new Response("Bad request", { status: 400 });
result.data; // typed
```

Valibot requires one additional structure object. See [Valibot](/validators/valibot/). Zod and ArkType schemas can be passed directly.
