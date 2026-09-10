---
title: Throughput
description: Encode and decode benchmarks against JSON and schema-based binary codecs.
---

shorn is faster than byte-producing JSON in every fixture measured. Against the binary codecs it leads on record-shaped data. It does **not** lead on document-shaped data: a payload made of many separate strings is decoded faster by msgpackr's `bundleStrings` mode, whatever alphabet those strings use.

## Methodology

Tests ran on Node v24.18.0, an Apple M4 Pro, and macOS 26.6.2 arm64. Every table on this page comes from one run of `pnpm bench`, the small-fixture suite. Results from different runs or machines are not comparable, so they are never mixed in one table. Small-fixture results are the median of seven samples of about 180 ms each, after warm-up. The [100,000-event](/performance/size/#fixtures) results, published under [payload size](/performance/size/), use three single-operation samples, because one operation already processes the whole value. Every codec has to round-trip to the same logical value.

Schema construction is excluded here and measured separately as [cold setup](/performance/footprint/). Raw tests use each codec's normal API with SchemaPack validation disabled. Protobuf.js includes `fromObject` and `toObject` so that it exposes the same string-enum API as the others.

Object schemas that qualify use generated encode and decode functions. A strict Content Security Policy falls back to the interpreted path with identical bytes and results. See [Compilation and Caching](/core-concepts/compile-and-caching/#generated-encoders) for which schemas take which path.

## Against JSON

`JSON bytes` converts to and from a `Uint8Array`, which makes it the direct comparison for a binary transport.

| Fixture | shorn enc | JSON enc | shorn dec | JSON dec |
| --- | ---: | ---: | ---: | ---: |
| Person | **23.07M** | 4.21M | **66.26M** | 5.10M |
| Unicode person | **7.76M** | 3.01M | **8.27M** | 3.92M |
| Nested event | **8.54M** | 1.28M | **12.35M** | 1.84M |
| 100-event batch | **97.3k** | 29.7k | **121.3k** | 22.3k |
| Person, validated | **8.49M** | 3.46M | **11.92M** | 3.88M |

Across these fixtures shorn is up to 6.7× faster to encode, on the nested event, and up to 13.0× faster to decode, on Person. The ASCII payloads also use as little as 23% of JSON's bytes. The Unicode payload uses 53%.

`JSON.stringify` to a string reaches 9.34M encodes/s for Person. That baseline does less work, because it stops at a JavaScript string rather than producing bytes.

## Against binary codecs

msgpackr has three modes. This table compares against one of them. `bundleStrings` is measured in the document section below, where it wins decode outright.

| Fixture | Op | shorn | Avro | SchemaPack | msgpackr records |
| --- | --- | ---: | ---: | ---: | ---: |
| Person | enc | **23.07M** | 6.32M | 8.03M | 10.01M |
| Person | dec | **66.26M** | 20.77M | 12.25M | 19.24M |
| Unicode person | enc | **7.76M** | 3.85M | 5.61M | 7.36M |
| Unicode person | dec | 8.27M | **8.71M** | 6.70M | 3.76M |
| Nested event | enc | **8.54M** | 3.53M | 2.91M | 3.53M |
| Nested event | dec | **12.35M** | 4.49M | 4.08M | 8.11M |
| 100 events | enc | **97.3K** | 36.1K | 35.2K | 26.0K |
| 100 events | dec | **121.3K** | 44.2K | 45.8K | 89.6K |

:::caution[Narrow margins are noise]
The codecs share one benchmark process, so small margins move between runs. Two rows here are that narrow: **Unicode person encode**, where shorn is 6% over msgpackr records, and **Unicode person decode**, where Avro is 5% over shorn. Treat both as ties. **Person encode** used to be a margin of that width against Avro and is not one in this run, at 3.6× over it. A margin that moves that far between recordings is itself a reason to distrust any single number here. The decode columns on the Person, nested and batch fixtures are the margins with real room in them. Benchmark representative production data before deciding.
:::

### Documents: where msgpackr decodes faster

The fixtures above are records: few keys, short strings, no optional fields. A document, meaning many keys, mostly string content, and arrays whose elements have different key sets, measures differently:

| Codec | Bytes | Encode | Decode |
| --- | ---: | ---: | ---: |
| **shorn** | **2,218** | **266.9K** | 294.1K |
| msgpackr shared records | 2,250 | 150.2K | 478.1K |
| msgpackr bundled strings | 2,316 | 166.1K | **607.5K** |
| cbor-x shared records | 2,303 | 145.2K | 444.1K |
| @msgpack/msgpack | 2,854 | 91.6K | 94.5K |
| JSON bytes | 3,316 | 183.3K | 175.1K |

shorn is smallest and fastest to encode, by 46% over the next codec, which here is `JSON bytes`, and fourth to decode. The cause is one string-decode call per string. `bundleStrings` writes all string content into one contiguous region and decodes it in a single call. shorn pays that call once per string, and 87% of this payload is string bytes spread across 88 separate strings.

**The alphabet has nothing to do with it.** The fixture is pure ASCII and shorn still decodes it at 48% of `bundleStrings`. What costs is the *number* of strings, not what is in them.

The remaining gap is a wire-format question rather than a tuning one: bundling strings would change the bytes.

## Validation included

| Codec | Bytes | Encode | Decode |
| --- | ---: | ---: | ---: |
| **shorn + Zod** | **8** | **8.49M** | **11.92M** |
| Zod + Avro | **8** | 4.30M | 8.75M |
| Zod + SchemaPack | 9 | 5.50M | 6.60M |
| Zod + JSON string | 35 | 5.99M | 4.79M |
| Zod + JSON bytes | 35 | 3.46M | 3.88M |

Validation is most of the end-to-end cost, and it narrows the field. On Person, shorn's raw lead over Avro is 3.6× encoding and 3.2× decoding; with Zod on every value it comes down to 2.0× and 1.4×, because the validator is then most of the work. Earlier recordings flattened the encode column to a tie with Avro. This run does not: shorn stays 97% ahead on encode and 36% ahead on decode.

On the Person fixture the raw codec runs at 23.07M encodes/s and 66.26M decodes/s. Adding Zod brings those down to 8.49M and 11.92M.

Between services you own, `unchecked(compile(schema))` writes the same bytes at the raw-codec speed, giving up every refinement on both sides in exchange. See [Skipping Validation](/core-concepts/validation/#skipping-validation).

## Reproducing

```sh
pnpm bench
pnpm bench:all
```

Benchmark your own schemas and traffic before making a production decision.
