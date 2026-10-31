---
title: Footprint
description: Bundle size, cold setup, and memory, measured against the other codecs.
---

Every number here is from Node v24.18.0, Apple M4 Pro, macOS 27.0.1 arm64. Each table comes from a single run: bundle bytes from `pnpm bench:bundle`, cold setup from `pnpm bench:startup`, retained memory from `pnpm bench:memory`. Results from different runs or machines are not comparable, so they are never mixed in one table. The bundle scripts print raw byte counts; the tables below convert them at 1 KB = 1,000 bytes throughout. Memory is reported in MiB, as the memory script measures it.

## Bundle size

An esbuild-minified browser bundle for each codec API as imported. Validation libraries and schema declarations are excluded from every row. shorn appears twice: `m` is the bare wire codec and the comparable surface, since no other codec here validates anything; `compile` adds the Standard Schema adapter.

| Codec | Minified | Gzip |
| --- | ---: | ---: |
| @msgpack/msgpack | 21.20 KB | 5.93 KB |
| **shorn `m`** (wire codec) | **21.19 KB** | **6.48 KB** |
| msgpackr | 27.59 KB | 10.39 KB |
| cbor-x | 29.61 KB | 10.99 KB |
| shorn `compile` (validating) | 40.09 KB | 12.64 KB |
| protobufjs/light | 89.15 KB | 26.08 KB |

`@msgpack/msgpack` is the smallest measured gzipped. shorn's wire codec is 9% larger gzipped, 555 bytes, though 10 bytes smaller minified. What that 555 bytes buys is native `Date`, `bigint`, `Set` and `Map` on the `m` namespace, which no other row has. What those four builders cost on their own was not measured in this run, so no figure for them is published here.

`compile` is 95% larger than `m` gzipped because it validates on encode and decode, which no other row does, and it sits about 2.2 KB over msgpackr and 1.7 KB over cbor-x, which validate nothing. Compare the row that matches what you ship.

`avsc` needs a browser `stream` polyfill and SchemaPack needs a `buffer` polyfill, so neither has a comparable zero-polyfill result.

### It tree-shakes per feature

| import set | minified | gzip | this row adds |
| --- | ---: | ---: | ---: |
| `compile` | 40,091 | 12,645 | |
| + `m` | 40,756 | 12,825 | 180 gzip |
| + `safeEncode` / `safeDecode` | 41,055 | 12,908 | 83 gzip |
| + `encodeAsync` / `decodeAsync` | 41,610 | 13,081 | 173 gzip |
| + `fingerprinted` | 43,103 | 13,559 | 478 gzip |
| + `encodeInto` | 43,767 | 13,800 | 241 gzip |
| everything | 44,950 | 14,155 | 355 gzip |

**Only code that imports a feature pays for it.** Fingerprinting is the most expensive single import at 478 gzip bytes, and a bundle that never calls `fingerprinted()` never carries it. `valibotOverride` is in the last row only. `m` is one object, so importing it keeps all of its builders.

These numbers grow as schema coverage grows. What each release spent, and on what, is in the [changelog](https://github.com/ChiChuRita/shorn/blob/main/CHANGELOG.md). Add the size of your validator if it is not already part of the application.

## Cold setup

Schema and codec construction plus the first Person encode.

| Codec | Cold setup |
| --- | ---: |
| JSON | 0.09 µs |
| msgpackr records | 0.38 µs |
| SchemaPack | 2.49 µs |
| **shorn + Zod** | **45.76 µs** |
| Avro / avsc | 61.30 µs |
| Protobuf.js reflection | 175.26 µs |

shorn starts faster than Avro but slower than SchemaPack. Most of shorn's time is Zod building the schema, which an application that uses Zod already pays. A long-lived server pays it once. It can matter in a serverless function that handles one request, so define schemas at module scope and let warm invocations reuse them.

## Retained memory

Steady-state retained memory after repeated forced GC in isolated processes, for [100,000 decoded events](/performance/size/#fixtures). This does not measure transient peak allocation.

| Codec | Payload | Encode retained | Decoded value | RSS increase |
| --- | ---: | ---: | ---: | ---: |
| shorn | **4.04 MiB** | **4.13 MiB** | 36.63 MiB | 61.14 MiB |
| Avro | 4.14 MiB | 4.18 MiB | 32.10 MiB | 70.58 MiB |
| SchemaPack | 4.13 MiB | 4.16 MiB | 47.81 MiB | 103.58 MiB |
| msgpackr records | 4.76 MiB | 17.02 MiB | 32.35 MiB | 54.91 MiB |
| JSON | 15.58 MiB | 15.58 MiB | **23.94 MiB** | **48.09 MiB** |

**Encoding a 4.04 MiB payload retains 4.13 MiB.** The encoded output is an exact-size copy, so keeping it does not keep a larger backing buffer alive, and internal buffers larger than 64 KiB are released.

Decoded memory is fourth of the five: only SchemaPack retains more. RSS is below SchemaPack and Avro, and above JSON and msgpackr records. RSS is the noisiest column: Avro's was under shorn's in earlier recordings and is 9.44 MiB over it here, and JSON's moved from above shorn's to below it between recordings.

## Runtime portability

shorn targets `es2022` with esbuild's `neutral` platform setting. It is ESM only and imports no Node built-in, so it runs in Node 20+, Bun, Deno, browsers, and workers.

Two fast paths are used when the runtime happens to offer them. Both are found by looking up a global, never by importing:

- **Decoding**: uses `Buffer.prototype.utf8Slice` when present and `TextDecoder` otherwise (browsers, workers, Deno without the Node shim). `pnpm bench:strings` measures how much that path saves; it is not part of this run, so no figure for it is published here.
- **Encoding**: checks for unpaired surrogates with `String.prototype.isWellFormed` when present and a `\p{Surrogate}` regex otherwise (Safari below 16.4, Firefox below 119).

Either way the bytes, the API, and the rejection of malformed input are identical. Only the speed changes.

This run is Node only. The full comparison and a smoke test have also been run under Bun, and rankings vary by runtime. Browser bundle size is measured, but browser execution is not part of the benchmark matrix.

## Reproduce these numbers

```sh
pnpm bench:bundle   # bundle sizes per import set
pnpm bench:startup  # cold setup
pnpm bench:memory   # retained memory in isolated processes
```
