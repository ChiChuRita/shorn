---
title: Footprint
description: Bundle size, cold setup, and memory. The wire codec is 5.45 KB gzip, 8% under the smallest measured alternative.
---

## Bundle size

An esbuild-minified browser bundle for each imported codec API. Validation libraries and schema declarations are excluded from every row. shorn appears twice: `m` is the bare wire codec and the comparable surface, since every other codec here validates nothing; `compile` adds the Standard Schema adapter.

| Codec | Minified | Gzip |
| --- | ---: | ---: |
| **shorn `m`** (wire codec) | **17.37 KB** | **5.45 KB** |
| @msgpack/msgpack | 21.20 KB | 5.93 KB |
| msgpackr | 27.59 KB | 10.39 KB |
| cbor-x | 29.10 KB | 10.82 KB |
| shorn `compile` (validating) | 30.67 KB | 9.62 KB |
| protobufjs/light | 88.35 KB | 25.93 KB |

**shorn's wire codec is the smallest measured, 8% under `@msgpack/msgpack` gzipped.** `compile` is 77% larger gzipped because it validates on encode and decode, which no other row does — it is still under both msgpackr and cbor-x, which validate nothing. Compare the row that matches what you ship.

Recent throughput work narrowed that margin from 26%; at 8% it remains a lead to defend.

`avsc` needs a browser `stream` polyfill and SchemaPack needs a `buffer` polyfill, so neither has a comparable zero-polyfill result.

### It tree-shakes per feature

| import set | minified | gzip | this row adds |
| --- | ---: | ---: | ---: |
| `compile` | 31,424 | 9,871 | — |
| + `m` | 32,016 | 10,018 | 147 gzip |
| + `safeEncode` / `safeDecode` | 32,249 | 10,100 | 82 gzip |
| + `encodeAsync` / `decodeAsync` | 32,820 | 10,276 | 176 gzip |
| + `fingerprinted` | 34,231 | 10,709 | 433 gzip |
| everything | 34,980 | 10,934 | 225 gzip |

**Only users who import a feature pay for it.** Fingerprinting is the most expensive single import at 433 gzip bytes, and a bundle that never calls `fingerprinted()` never carries it.

These numbers have grown across releases, spent on schema coverage — discriminated unions, records, open objects, dynamic values, packed UUIDs, non-string enums, fixed-length arrays, tuple rest elements, type-disjoint unions, and recursive schemas — and earlier, 334 gzip bytes on a generated encoder for objects with optional fields and a faster string encoder, worth about two thirds on document encode and decode.

0.3.0 spent 98 gzip bytes on the wire codec (`m`), the first release to spend them on correctness rather than coverage: a bound on what a fixed-count array of zero-width elements can allocate from an empty payload, which without it was an unrecoverable out-of-memory abort, and refusals that report a hostile value's type instead of running its `toString`. It was 175 bytes before trimming — the message that names the three zero-width shapes moved to [the error reference](/api/errors/) at 28 bytes, one shared message replaced two at 56, and a `try`/`catch` gave way to a `typeof` gate at 28. Throughput and the bytes on the wire did not move.

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

Two fast paths are used when the runtime happens to offer them, found by global lookup and never imported:

- **Decoding** prefers `Buffer.prototype.utf8Slice`, 45% cheaper than `TextDecoder`. Without it (browsers, workers, Deno without the Node shim), `TextDecoder` is used instead.
- **Encoding** checks for unpaired surrogates with `String.prototype.isWellFormed`. Without it (Safari below 16.4, Firefox below 119), a `\p{Surrogate}` regex is used instead.

Either way the bytes, the API, and the rejection of malformed input are identical — only the speed changes.

The full comparison and a smoke test also ran under **Bun 1.3.14**. Rankings vary by runtime. Browser bundle size is measured, but browser execution is not part of the benchmark matrix.

## Reproducing

```sh
pnpm bench:bundle   # bundle sizes per import set
pnpm bench:startup  # cold setup
pnpm bench:memory   # retained memory in isolated processes
```
