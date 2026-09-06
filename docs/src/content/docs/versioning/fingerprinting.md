---
title: Wire Fingerprints
description: Prefix payloads with a short wire-shape identifier, choose a width, and understand what it cannot detect.
---

A bare payload does not say which wire shape wrote it. Decode it with the wrong shape and you can get back a value that looks plausible but is wrong.

```ts
const PersonWire = fingerprinted(compile(Person), { bytes: 4 });

const bytes = PersonWire.encode(person); // 4-byte prefix + payload
PersonWire.decode(bytes);                // rejects a different wire shape
```

Use a fingerprint for anything stored, queued, or read across deployments. A bare payload is fine only when both ends are pinned to one wire shape.

## What it identifies

The fingerprint is a hash of the canonical **wire structure**. It changes whenever bytes could move: adding, removing, or renaming a field; changing a type; making a field required or optional; changing enum members; switching an integer between signed and unsigned; reordering a tuple.

A `Set` and an array of the same element type write byte-identical payloads and still get different fingerprints. That is deliberate: they decode to different values, so a payload written as one must not be read back as the other. A `Map` and an array of `[key, value]` tuples are the same case.

The fingerprint does **not** change for refinements, property declaration order, strictness, which validator you used, or conversion functions. So a stricter `.max()` can start rejecting old data without changing the fingerprint. If validation behavior is part of your data version, carry an application version separately in a header, column, or envelope. A wire fingerprint is not a complete schema version.

Validator independence holds for recursive schemas too, even though validators spell them differently (Zod points the cycle at the root; Valibot inlines the root and repeats it under `$defs`), because a root that merely duplicates a definition is folded back onto it. **One known exception:** two *mutually* recursive definitions are not deduplicated, so a mutually recursive type may fingerprint differently across validators. Keep both codecs, or write that type in one validator only.

## Choose a width

shorn supports 1 to 4 bytes and defaults to 3. Each width is a truncated 32-bit FNV-1a hash.

| Bytes | Possible fingerprints | Approx. collision chance at 1,000 registered shapes |
| ---: | ---: | ---: |
| 1 | 256 | effectively certain |
| 2 | 65,536 | effectively certain |
| 3 | 16,777,216 | 2.9% |
| 4 | 4,294,967,296 | 0.012% |

These figures use the birthday approximation and assume the hash spreads evenly. FNV-1a is not a cryptographic hash, and a collision is deterministic: two shapes either collide or they do not, and every decode gives the same answer.

**Use 4 bytes for persistent data.** The 3-byte default favors very small payloads and small, controlled registries. No width is collision-proof, so reject duplicate `fingerprintHex` values when you build a registry, and carry an application version when identity has to be unambiguous.

## Carry it separately

```ts
codec.fingerprint;    // Uint8Array, fresh copy
codec.fingerprintHex; // lowercase hex, stable Map key
```

Either value can live in a Kafka header, a database column, or a filename while the payload stays bare.

If the schema has an async refinement, pass the fingerprinted codec straight to `encodeAsync`/`decodeAsync`. The prefix is written and checked on that path exactly as on the sync one.

## Limits

- `fingerprinted()` needs a codec created by `compile()`. Low-level `m` codecs have no structural signature to hash.
- It detects a wire-shape mismatch but does not resolve it. See [Schema Changes](/versioning/schema-evolution/).
- It is unkeyed and can be forged. It provides neither authentication nor confidentiality.
- It cannot tell apart two schemas that share a wire shape but validate differently.

Sign or encrypt payloads when authenticity or secrecy matters.
