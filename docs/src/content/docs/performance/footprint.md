---
title: Footprint
description: Bundle size, cold setup, and memory. The wire codec is 5.18 KB gzip, 13% under the smallest measured alternative.
---

## Bundle size

An esbuild-minified browser bundle for each imported codec API. Validation libraries and schema declarations are excluded from every row. shorn appears twice: `m` is the bare wire codec and the comparable surface, since every other codec here validates nothing; `compile` adds the Standard Schema adapter.

| Codec | Minified | Gzip |
| --- | ---: | ---: |
| **shorn `m`** (wire codec) | **16.87 KB** | **5.18 KB** |
| @msgpack/msgpack | 21.20 KB | 5.93 KB |
| msgpackr | 27.59 KB | 10.39 KB |
| cbor-x | 29.10 KB | 10.82 KB |
| shorn `compile` (validating) | 29.84 KB | 9.28 KB |
| protobufjs/light | 88.35 KB | 25.93 KB |

**shorn's wire codec is the smallest measured, 13% under `@msgpack/msgpack` gzipped.** `compile` is 56% larger gzipped because it validates on encode and decode, which no other row does — it is still under both msgpackr and cbor-x, which validate nothing. Compare the row that matches what you ship.

That margin was 26% two releases ago and is narrowing on purpose: the decode work below bought throughput with bytes, and each trade was argued against this table rather than assumed. It is a lead to defend, not a settled one.

`avsc` needs a browser `stream` polyfill and SchemaPack needs a `buffer` polyfill, so neither has a comparable zero-polyfill result.

### It tree-shakes per feature

| import set | minified | gzip | this row adds |
| --- | ---: | ---: | ---: |
| `compile` | 29,846 | 9,279 | — |
| + `m` | 30,439 | 9,422 | 143 gzip |
| + `safeEncode` / `safeDecode` | 30,672 | 9,506 | 84 gzip |
| + `encodeAsync` / `decodeAsync` | 31,267 | 9,685 | 179 gzip |
| + `fingerprinted` | 32,630 | 10,101 | 416 gzip |
| everything | 33,379 | 10,322 | 221 gzip |

**Only users who import a feature pay for it.** Fingerprinting is the most expensive single import at 421 gzip bytes, and a bundle that never calls `fingerprinted()` never carries it.

These numbers grew over the previous release, spent on schema coverage: discriminated unions, records, open objects, dynamic values, packed UUIDs, non-string enums, fixed-length arrays, and tuple rest elements — shapes that previously did not compile at all.

The most recent 949 gzip bytes bought the last three: **type-disjoint unions**, **recursive schemas**, and a round of cross-validator agreement — 179 of them for four shapes that compiled from one validator and not another, or lost a field on the way to the wire. All three land in the `compile` row, since the adapter is what reads a `$ref`, what decides a union's branches cannot overlap, and what reads one validator's JSON Schema as the same shape as another's; `m` is unchanged and stays the smallest row in the table.

The functional helpers and fingerprinting tree-shake by export. `m` is one object, so importing it retains all of its builders. Add the size of your validator if it is not already part of the application.

## Cold setup

Schema and codec construction plus the first Person encode.

| Codec | Cold setup |
| --- | ---: |
| JSON | 0.08 µs |
| msgpackr records | 1.00 µs |
| SchemaPack | 3.00 µs |
| **shorn + Zod** | **52–66 µs** |
| Avro / avsc | 68.99 µs |
| Protobuf.js reflection | 187.75 µs |

shorn starts faster than Avro but slower than SchemaPack. **Most of shorn's time is Zod schema construction**, which applications using Zod already pay. Usually negligible in a long-lived server; it can matter in a serverless function that handles one request, so define schemas at module scope and warm invocations reuse them.

## Memory

Steady-state retained memory after repeated forced GC in isolated processes, for [100,000 decoded events](/performance/size/#fixtures). Does **not** measure transient peak allocation.

| Codec | Payload | Encode retained | Decoded value | RSS increase |
| --- | ---: | ---: | ---: | ---: |
| shorn | **4.04 MiB** | **4.11 MiB** | 36.66 MiB | 72.80 MiB |
| Avro | 4.14 MiB | 4.20 MiB | 33.64 MiB | 61.22 MiB |
| SchemaPack | 4.13 MiB | 4.17 MiB | 47.82 MiB | 64.17 MiB |
| msgpackr records | 4.76 MiB | 17.05 MiB | 32.44 MiB | **62.20 MiB** |
| JSON | 15.58 MiB | 15.58 MiB | **24.03 MiB** | 88.69 MiB |

**Encoding a 4.04 MiB payload retains 4.11 MiB.** Encoded output is an exact-size copy, so retaining it does not retain a larger backing buffer, and internal buffers larger than 64 KiB are released. Decoded memory is middle of pack, RSS below JSON but above Avro and msgpackr records.

## Runtime portability

shorn targets `es2022` with esbuild's `neutral` platform setting. It is ESM-only and imports no Node built-in, so it runs in Node 20+, Bun, Deno, browsers, and workers.

One Node facility is used when it happens to be there: string decoding prefers `Buffer.prototype.utf8Slice`, which is 45% cheaper than `TextDecoder`. It is found by a global lookup and never imported, so a browser, a worker, or a Deno without the Node shim simply uses `TextDecoder` instead — same bytes, same rejection of malformed UTF-8, slower decode. Nothing about the wire format or the API changes with it.

The full comparison and a smoke test also ran under **Bun 1.3.14**. Rankings vary by runtime. Browser bundle size is measured, but browser execution is not part of the benchmark matrix.

## Reproducing

```sh
pnpm bench:bundle   # bundle sizes per import set
pnpm bench:startup  # cold setup
pnpm bench:memory   # retained memory in isolated processes
```
