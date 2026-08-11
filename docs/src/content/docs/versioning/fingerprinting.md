---
title: Wire Fingerprints
description: Prefix payloads with a short wire-shape identifier, choose an appropriate width, and understand what it cannot detect.
---

Bare payloads do not identify their wire shape, and decoding with the wrong shape can return a plausible but incorrect value.

```ts
const PersonWire = fingerprinted(compile(Person), { bytes: 4 });

const bytes = PersonWire.encode(person); // 4-byte prefix + payload
PersonWire.decode(bytes);                // rejects a different wire shape
```

Use a fingerprint for stored, queued, or version-crossing payloads. Bare payloads are appropriate only when both endpoints are pinned to one wire shape.

## What it identifies

The fingerprint hashes the canonical **wire structure**. It changes when bytes can move: adding, removing, or renaming a field; changing a type; required ↔ optional; changing enum members; signed ↔ unsigned integer; or reordering a tuple.

It does **not** change for refinements, property declaration order, strictness, validator choice, or conversion functions. A stricter `.max()` can therefore reject old data without changing the fingerprint. If validation behavior is part of your data version, carry an application version separately in a header, column, or envelope — a wire fingerprint is not a complete schema version.

## Choose a width

shorn supports 1–4 bytes and defaults to 3. Each width truncates a 32-bit FNV-1a hash.

| Bytes | Possible fingerprints | Approx. collision chance at 1,000 registered shapes |
| ---: | ---: | ---: |
| 1 | 256 | effectively certain |
| 2 | 65,536 | effectively certain |
| 3 | 16,777,216 | 2.9% |
| 4 | 4,294,967,296 | 0.012% |

The registry figures use the birthday approximation and assume uniform hashes. FNV-1a is not cryptographic, and a collision is deterministic rather than a fresh chance on every decode.

**Use 4 bytes for persistent data.** The 3-byte default favors very small payloads and small, controlled registries. No supported width is collision-proof, so reject duplicate `fingerprintHex` values when building a registry, and use an application version or full signature when identity must be unambiguous.

## Carry it separately

```ts
codec.fingerprint;    // Uint8Array, fresh copy
codec.fingerprintHex; // lowercase hex, stable Map key
```

These values can live in a Kafka header, database column, or filename while the payload stays bare.

Pass the fingerprinted codec straight to `encodeAsync`/`decodeAsync` when the schema has an async refinement. The prefix is written and checked on that path exactly as on the sync one, so wire identity and an awaited refinement compose without carrying the fingerprint out of band.

## Limits

- `fingerprinted()` requires a codec created by `compile()`; low-level `m` codecs have no structural signature.
- It detects wire-shape mismatches but does not resolve them. See [Schema Changes](/versioning/schema-evolution/).
- It is unkeyed and forgeable, and provides neither authentication nor confidentiality.
- It cannot distinguish schemas that share a wire shape but differ in validation behavior.

Sign or encrypt payloads when authenticity or secrecy matters.
