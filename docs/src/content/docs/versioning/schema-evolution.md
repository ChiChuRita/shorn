---
title: Schema Changes
description: shorn does not resolve schema changes. Keep old codecs and pick one by wire fingerprint or by an application version.
---

shorn does not do schema evolution. A positional payload has to be decoded with the exact wire shape that wrote it.

## Changes that alter the wire shape

Keep every historical codec and dispatch on the fingerprint. Four bytes are recommended for persistent data.

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

Write with the newest codec. Remove an old one only after no payloads use it anymore.

## Changes that keep the same wire shape

Refinements, object strictness, validator choice, and conversion functions do not change the fingerprint. If those need their own versions, carry an application version in a header or a database column and dispatch on that instead.

A fingerprint registry on its own cannot hold two validation versions of the same wire shape. They have the same key.

## Migrating stored data

1. Keep the old schema unchanged.
2. Add the new schema and its codec.
3. Register both and reject duplicate keys.
4. Write new data with the new codec.
5. Re-encode old data, then remove the old codec.

```ts
function migrate(payload: Uint8Array) {
  const old = v1.decode(payload);
  const [firstName, ...rest] = old.name.split(" ");
  return v2.encode({ ...old, firstName, lastName: rest.join(" ") });
}
```

If you need automatic, cross-language schema evolution rather than an explicit migration, use Avro or Protobuf.

## Format stability

Compatible shorn releases do not change the encoding of existing wire shapes. New wire types can be added without changing existing fingerprints. Any change to the bytes an existing schema produces is treated as wire-breaking however small it is, and is called out in the changelog. While the version is below 1.0 such a change can ship in a minor release, so read the changelog before upgrading if you have payloads in storage or in a queue.
