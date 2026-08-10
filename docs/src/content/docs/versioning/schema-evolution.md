---
title: Schema Changes
description: shorn does not resolve schema changes. Keep old codecs and select them by wire fingerprint or an application version.
---

shorn does not perform schema evolution. A positional payload must be decoded with the wire shape that wrote it.

## Changes that alter the wire shape

Keep each historical codec and dispatch by fingerprint. Four bytes are recommended for persistent data.

```ts
const PREFIX_BYTES = 4;
const v1 = fingerprinted(compile(PersonV1), { bytes: PREFIX_BYTES });
const v2 = fingerprinted(compile(PersonV2), { bytes: PREFIX_BYTES });
const codecs = [v1, v2];

const byWire = new Map<string, (typeof codecs)[number]>();
for (const codec of codecs) {
  if (byWire.has(codec.fingerprintHex)) {
    throw new Error(`Duplicate wire fingerprint ${codec.fingerprintHex}`);
  }
  byWire.set(codec.fingerprintHex, codec);
}

function read(payload: Uint8Array) {
  const key = [...payload.subarray(0, PREFIX_BYTES)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const codec = byWire.get(key);
  if (!codec) throw new Error(`Unknown wire fingerprint ${key}`);
  return codec.decode(payload);
}
```

Write with the newest codec. Remove an old codec only after no payloads use it.

## Changes that keep the same wire shape

Refinements, object strictness, validator choice, and conversion functions do not change the fingerprint. If these semantics need independent versions, carry an application version in a header or database column and dispatch on that value instead.

A fingerprint registry alone cannot hold two validation versions with the same wire shape: they have the same key.

## Migrating stored data

1. Keep the old schema unchanged.
2. Add the new schema and codec.
3. Register both versions and reject duplicate keys.
4. Write new data with the new codec.
5. Re-encode old data, then remove the old codec.

```ts
function migrate(payload: Uint8Array) {
  const old = v1.decode(payload);
  const [firstName, ...rest] = old.name.split(" ");
  return v2.encode({ ...old, firstName, lastName: rest.join(" ") });
}
```

Use Avro or Protobuf when you need automatic cross-language schema evolution rather than explicit migration.

## Format stability

Compatible shorn releases do not change the encoding of existing wire shapes. New wire types may be added without changing existing fingerprints. Any incompatible format change requires a major release and data migration.
