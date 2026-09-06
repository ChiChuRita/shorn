---
title: Footprint
description: Bundle size, cold setup, and memory. The wire codec is 6.44 KB gzip, 9% over the smallest measured alternative since Date, bigint, Set and Map arrived.
---

## Bundle size

An esbuild-minified browser bundle for each codec API as imported. Validation libraries and schema declarations are excluded from every row. shorn appears twice: `m` is the bare wire codec and the comparable surface, since no other codec here validates anything; `compile` adds the Standard Schema adapter.

| Codec | Minified | Gzip |
| --- | ---: | ---: |
| @msgpack/msgpack | 21.20 KB | 5.93 KB |
| **shorn `m`** (wire codec) | **21.14 KB** | **6.44 KB** |
| msgpackr | 27.59 KB | 10.39 KB |
| cbor-x | 29.10 KB | 10.82 KB |
| shorn `compile` (validating) | 37.54 KB | 11.55 KB |
| protobufjs/light | 88.35 KB | 25.93 KB |

**`@msgpack/msgpack` is the smallest measured. shorn's wire codec is 9% larger gzipped.** That gap is the price of native `Date`, `bigint`, `Set` and `Map`: 871 gzip bytes on `m`, spent deliberately in this release so that every builder stays on one namespace. `compile` is 79% larger than `m` because it validates on encode and decode, which no other row does, and it now sits about 1.1 KB over msgpackr and cbor-x, which validate nothing. Compare the row that matches what you ship.

Before this release the wire codec led `@msgpack/msgpack` by 6%, down from 26% as throughput work traded bytes for speed. The lead was given up knowingly, not lost by drift.

`avsc` needs a browser `stream` polyfill and SchemaPack needs a `buffer` polyfill, so neither has a comparable zero-polyfill result.

### It tree-shakes per feature

| import set | minified | gzip | this row adds |
| --- | ---: | ---: | ---: |
| `compile` | 37,539 | 11,548 | |
| + `m` | 38,200 | 11,724 | 176 gzip |
| + `safeEncode` / `safeDecode` | 38,433 | 11,814 | 90 gzip |
| + `encodeAsync` / `decodeAsync` | 39,004 | 11,994 | 180 gzip |
| + `fingerprinted` | 40,415 | 12,423 | 429 gzip |
| + `encodeInto` | 40,958 | 12,602 | 179 gzip |
| everything | 41,993 | 12,927 | 325 gzip |

**Only code that imports a feature pays for it.** Fingerprinting is the most expensive single import at 429 gzip bytes, and a bundle that never calls `fingerprinted()` never carries it. `valibotOverride` is in the last row only.

These numbers have grown across releases, spent on schema coverage: discriminated unions, records, open objects, dynamic values, packed UUIDs, non-string enums, fixed-length arrays, tuple rest elements, type-disjoint unions, and recursive schemas. Earlier, 334 gzip bytes went on a generated encoder for objects with optional fields and a faster string encoder, worth about two thirds on document encode and decode.

0.3.0 spent 96 gzip bytes on the wire codec (`m`) as the regression gate measures it, the first release to spend them on correctness rather than coverage: a bound on what a fixed-count array of zero-width elements can allocate from an empty payload, which without it was an unrecoverable out-of-memory abort, and refusals that report a hostile value's type instead of calling its `toString`. It was 175 bytes before trimming. The message that names the three zero-width shapes moved to [the error reference](/api/errors/) for 28 bytes, one shared message replaced two for 56, and a `try`/`catch` gave way to a `typeof` gate for 28. Throughput and the bytes on the wire did not move.

0.4.1 spent 22 gzip bytes on `m`, 21 of them on a varint reader that keeps multi-byte integers on the integer unit and one on letting objects that reject unknown properties use the generated encoder. Both bought throughput rather than coverage, and `compile` came out 2 bytes smaller.

0.6.0 added `encodeInto`: 185 gzip bytes for a bundle that imports it, and 12 on `m` for the writer's float view now covering the target's own window, since a frame slice rarely starts at byte zero. The two helper methods that would have made it tidier measured at 91 gzip bytes on every `m` bundle and were not shipped.

The release after it spent 871 gzip bytes on `m` and about 1.7 KB on `compile` for native `Date`, `bigint`, `Set` and `Map`: four schema classes, the hex table they share with UUIDs, the `x-shorn` keyword, and the Zod and ArkType hooks that write it. The `date-time` class is reached only from `compile()` and costs `m` nothing. It is the first spend that moved a row past a competitor rather than nearer to one. [Date, BigInt, Map, Set](/schemas/rich-types/) has what it bought.

The functional helpers and fingerprinting tree-shake by export. `m` is one object, so importing it keeps all of its builders. Add the size of your validator if it is not already part of the application.

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

shorn starts faster than Avro but slower than SchemaPack. **Most of shorn's time is Zod building the schema**, which an application that uses Zod already pays. That is usually negligible in a long-lived server. It can matter in a serverless function that handles one request, so define schemas at module scope and let warm invocations reuse them.

## Memory

Steady-state retained memory after repeated forced GC in isolated processes, for [100,000 decoded events](/performance/size/#fixtures). This does **not** measure transient peak allocation.

| Codec | Payload | Encode retained | Decoded value | RSS increase |
| --- | ---: | ---: | ---: | ---: |
| shorn | **4.04 MiB** | **4.11 MiB** | 36.66 MiB | 72.80 MiB |
| Avro | 4.14 MiB | 4.20 MiB | 33.64 MiB | 61.22 MiB |
| SchemaPack | 4.13 MiB | 4.17 MiB | 47.82 MiB | 64.17 MiB |
| msgpackr records | 4.76 MiB | 17.05 MiB | 32.44 MiB | **62.20 MiB** |
| JSON | 15.58 MiB | 15.58 MiB | **24.03 MiB** | 88.69 MiB |

**Encoding a 4.04 MiB payload retains 4.11 MiB.** The encoded output is an exact-size copy, so keeping it does not keep a larger backing buffer alive, and internal buffers larger than 64 KiB are released. Decoded memory is middle of the pack. RSS is below JSON but above Avro and msgpackr records.

## Runtime portability

shorn targets `es2022` with esbuild's `neutral` platform setting. It is ESM only and imports no Node built-in, so it runs in Node 20+, Bun, Deno, browsers, and workers.

Two fast paths are used when the runtime happens to offer them. Both are found by looking up a global, never by importing:

- **Decoding** prefers `Buffer.prototype.utf8Slice`, 45% cheaper than `TextDecoder`. Without it (browsers, workers, Deno without the Node shim), `TextDecoder` is used instead.
- **Encoding** checks for unpaired surrogates with `String.prototype.isWellFormed`. Without it (Safari below 16.4, Firefox below 119), a `\p{Surrogate}` regex is used instead.

Either way the bytes, the API, and the rejection of malformed input are identical. Only the speed changes.

The full comparison and a smoke test also ran under **Bun 1.3.14**. Rankings vary by runtime. Browser bundle size is measured, but browser execution is not part of the benchmark matrix.

## Reproducing

```sh
pnpm bench:bundle   # bundle sizes per import set
pnpm bench:startup  # cold setup
pnpm bench:memory   # retained memory in isolated processes
```
