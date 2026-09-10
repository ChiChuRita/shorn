---
title: Footprint
description: Bundle size, cold setup, and memory, measured against the other codecs.
---

Every number here is from Node v24.18.0, Apple M4 Pro, macOS 26.6.2 arm64. Each table comes from a single run: bundle bytes from `pnpm bench:bundle`, cold setup from `pnpm bench:startup`, retained memory from `pnpm bench:memory`. Results from different runs or machines are not comparable, so they are never mixed in one table. The bundle scripts print raw byte counts; the tables below convert them at 1 KB = 1,000 bytes throughout. Memory is reported in MiB, as the memory script measures it.

## Bundle size

An esbuild-minified browser bundle for each codec API as imported. Validation libraries and schema declarations are excluded from every row. shorn appears twice: `m` is the bare wire codec and the comparable surface, since no other codec here validates anything; `compile` adds the Standard Schema adapter.

| Codec | Minified | Gzip |
| --- | ---: | ---: |
| @msgpack/msgpack | 21.20 KB | 5.93 KB |
| **shorn `m`** (wire codec) | **21.17 KB** | **6.45 KB** |
| msgpackr | 27.59 KB | 10.39 KB |
| cbor-x | 29.10 KB | 10.82 KB |
| shorn `compile` (validating) | 37.36 KB | 11.52 KB |
| protobufjs/light | 88.35 KB | 25.93 KB |

**`@msgpack/msgpack` is the smallest measured gzipped. shorn's wire codec is 9% larger gzipped**, 525 bytes, though 37 bytes smaller minified. What that 525 bytes buys is native `Date`, `bigint`, `Set` and `Map` on the `m` namespace, which no other row carries. What those four builders cost on their own was not measured in this run, so no figure for them is published here. `compile` is 78% larger than `m` gzipped because it validates on encode and decode, which no other row does, and it sits about 1.1 KB over msgpackr and 0.7 KB over cbor-x, which validate nothing. Compare the row that matches what you ship.

`avsc` needs a browser `stream` polyfill and SchemaPack needs a `buffer` polyfill, so neither has a comparable zero-polyfill result.

### It tree-shakes per feature

| import set | minified | gzip | this row adds |
| --- | ---: | ---: | ---: |
| `compile` | 37,361 | 11,519 | |
| + `m` | 38,022 | 11,693 | 174 gzip |
| + `safeEncode` / `safeDecode` | 38,255 | 11,784 | 91 gzip |
| + `encodeAsync` / `decodeAsync` | 38,826 | 11,966 | 182 gzip |
| + `fingerprinted` | 40,237 | 12,394 | 428 gzip |
| + `encodeInto` | 40,780 | 12,572 | 178 gzip |
| everything | 41,980 | 12,919 | 347 gzip |

**Only code that imports a feature pays for it.** Fingerprinting is the most expensive single import at 428 gzip bytes, and a bundle that never calls `fingerprinted()` never carries it. `valibotOverride` is in the last row only. `m` is one object, so importing it keeps all of its builders.

These numbers grow as schema coverage grows. What each release spent, and on what, is in the [changelog](https://github.com/ChiChuRita/shorn/blob/main/CHANGELOG.md). Add the size of your validator if it is not already part of the application.

## Cold setup

Schema and codec construction plus the first Person encode.

| Codec | Cold setup |
| --- | ---: |
| JSON | 0.09 µs |
| msgpackr records | 0.40 µs |
| SchemaPack | 2.72 µs |
| **shorn + Zod** | **52.07 µs** |
| Avro / avsc | 65.19 µs |
| Protobuf.js reflection | 181.42 µs |

shorn starts faster than Avro but slower than SchemaPack. **Most of shorn's time is Zod building the schema**, which an application that uses Zod already pays. That is usually negligible in a long-lived server. It can matter in a serverless function that handles one request, so define schemas at module scope and let warm invocations reuse them.

## Memory

Steady-state retained memory after repeated forced GC in isolated processes, for [100,000 decoded events](/performance/size/#fixtures). This does **not** measure transient peak allocation.

| Codec | Payload | Encode retained | Decoded value | RSS increase |
| --- | ---: | ---: | ---: | ---: |
| shorn | **4.04 MiB** | **4.13 MiB** | 36.63 MiB | 69.77 MiB |
| Avro | 4.14 MiB | 4.18 MiB | 32.10 MiB | 70.86 MiB |
| SchemaPack | 4.13 MiB | 4.16 MiB | 47.81 MiB | 102.86 MiB |
| msgpackr records | 4.76 MiB | 17.02 MiB | 32.35 MiB | **59.73 MiB** |
| JSON | 15.58 MiB | 15.58 MiB | **23.94 MiB** | 76.11 MiB |

**Encoding a 4.04 MiB payload retains 4.13 MiB.** The encoded output is an exact-size copy, so keeping it does not keep a larger backing buffer alive, and internal buffers larger than 64 KiB are released. Decoded memory is fourth of the five: only SchemaPack retains more. RSS lands below JSON, SchemaPack and Avro, and above msgpackr records alone. Avro's RSS was under shorn's in earlier recordings and is 1.09 MiB over it here, which is close enough to call a tie rather than a win either way.

## Runtime portability

shorn targets `es2022` with esbuild's `neutral` platform setting. It is ESM only and imports no Node built-in, so it runs in Node 20+, Bun, Deno, browsers, and workers.

Two fast paths are used when the runtime happens to offer them. Both are found by looking up a global, never by importing:

- **Decoding** prefers `Buffer.prototype.utf8Slice` over `TextDecoder`. Without it (browsers, workers, Deno without the Node shim), `TextDecoder` is used instead. `pnpm bench:strings` measures how much that path saves; it is not part of this run, so no figure for it is published here.
- **Encoding** checks for unpaired surrogates with `String.prototype.isWellFormed`. Without it (Safari below 16.4, Firefox below 119), a `\p{Surrogate}` regex is used instead.

Either way the bytes, the API, and the rejection of malformed input are identical. Only the speed changes.

This run is Node only. The full comparison and a smoke test have also been run under Bun, and rankings vary by runtime. Browser bundle size is measured, but browser execution is not part of the benchmark matrix.

## Reproducing

```sh
pnpm bench:bundle   # bundle sizes per import set
pnpm bench:startup  # cold setup
pnpm bench:memory   # retained memory in isolated processes
```
