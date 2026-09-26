---
title: Wire fingerprints
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

The fingerprint does not change for refinements, property declaration order, strictness, which validator you used, or conversion functions. So a stricter `.max()` can start rejecting old data without changing the fingerprint. If validation behavior is part of your data version, carry an application version separately in a header, column, or envelope. A wire fingerprint is not a complete schema version.

Nor does the fingerprint change with how a union is written: flat or nested, as `anyOf` or a `type` array, as literals or as an enum, with `.nullable()` or a `null` branch. One union type has one wire shape, so it has one fingerprint.

Recursive schemas get the same guarantee, although validators spell them differently. Zod points a `$ref` at a definition from wherever the type is used, while Valibot inlines one copy there. Which of two mutually recursive types becomes the definition depends on the validator, and in Zod on which field is declared first. shorn reads the definitions as one graph, merges any two nodes that unfold to the same type, and numbers what is left from the root outward. One recursive type therefore has one fingerprint, however it arrives.

## Choose a width

shorn supports 1 to 4 bytes and defaults to 4. Each width is cut from one 32-bit hash of the signature: FNV-1a, finished with murmur3's `fmix32` so that every bit depends on every character. Without that last step, an edit that only reorders the signature, such as two fields swapping types, left three bits of every fingerprint unchanged. A 1-byte fingerprint then caught it no more often than a 5-bit one would.

| Bytes | Possible fingerprints | Approx. collision chance at 1,000 registered shapes |
| ---: | ---: | ---: |
| 1 | 256 | effectively certain |
| 2 | 65,536 | effectively certain |
| 3 | 16,777,216 | 2.9% |
| 4 | 4,294,967,296 | 0.012% |

These figures use the birthday approximation and assume the hash spreads evenly, which the mixing step is there to make true at every width. It is still not a cryptographic hash, and a collision is deterministic: two shapes either collide or they do not, and every decode gives the same answer.

**The default of 4 bytes is the width for persistent data.** Choose 3 or fewer only for very small payloads in a small, controlled registry. Keep one width per registry: the width is part of what is hashed, so a schema's 3-byte fingerprint is not the start of its 4-byte one. No width is collision-proof, so reject duplicate `fingerprintHex` values when you build a registry, and carry an application version when identity has to be unambiguous.

## Carry it separately

The codec exposes the fingerprint in two forms:

```ts
codec.fingerprint;    // Uint8Array, fresh copy
codec.fingerprintHex; // lowercase hex, stable Map key
```

Either value can live in a Kafka header, a database column, or a filename while the payload stays bare.

If the schema has an async refinement, pass the fingerprinted codec straight to `encodeAsync`/`decodeAsync`. The prefix is written and checked on that path exactly as on the sync one.

## What a fingerprint cannot do

Four limits apply:

- `fingerprinted()` needs a codec created by `compile()`. Low-level `m` codecs have no structural signature to hash.
- It detects a wire-shape mismatch but does not resolve it. See [Schema changes](/versioning/schema-evolution/).
- It is unkeyed, so anyone can forge it. It neither authenticates nor hides a payload.
- It cannot tell apart two schemas that share a wire shape but validate differently.

Sign or encrypt payloads when authenticity or secrecy matters.
