---
title: Throughput
description: Encode and decode benchmarks against JSON and schema-based binary codecs.
---

shorn is faster than byte-producing JSON in every fixture measured. Against the binary codecs it leads on record-shaped data. It does **not** lead on document-shaped data: a payload made of many separate strings is decoded faster by msgpackr's `bundleStrings` mode, whatever alphabet those strings use.

## Against JSON

`JSON bytes` converts to and from a `Uint8Array`, which makes it the direct comparison for a binary transport.

| Fixture | shorn enc | JSON enc | shorn dec | JSON dec |
| --- | ---: | ---: | ---: | ---: |
| Person | **20.98M** | 4.52M | **62.57M** | 4.57M |
| Unicode person | **8.44M** | 3.76M | **9.38M** | 3.53M |
| Nested event | **8.19M** | 1.33M | **11.86M** | 1.68M |
| 100-event batch | **94.9k** | 35.4k | **123.2k** | 20.2k |
| Person, validated | **8.35M** | 3.58M | **11.56M** | 3.55M |

Across these fixtures shorn is up to 6.2× faster to encode and up to 13.7× faster to decode. The ASCII payloads also use as little as 23% of JSON's bytes. The Unicode payload uses 53%.

`JSON.stringify` to a string reaches 10.17M encodes/s for Person. That baseline does less work, because it stops at a JavaScript string rather than producing bytes.

## Against binary codecs

msgpackr has three modes. This table compares against one of them. `bundleStrings` is measured in the document section below, where it wins decode outright.

| Fixture | Op | shorn | Avro | SchemaPack | msgpackr records |
| --- | --- | ---: | ---: | ---: | ---: |
| Person | enc | **20.98M** | 16.52M | 11.70M | 10.15M |
| Person | dec | **62.57M** | 25.18M | 15.43M | 18.50M |
| Unicode person | enc | **8.44M** | 5.73M | 6.69M | 7.03M |
| Unicode person | dec | 9.38M | **9.69M** | 8.04M | 3.77M |
| Nested event | enc | **8.19M** | 6.28M | 4.09M | 3.52M |
| Nested event | dec | **11.86M** | 5.25M | 4.83M | 8.04M |
| 100 events | enc | **94.9K** | 41.8K | 53.7K | 26.0K |
| 100 events | dec | **123.2K** | 51.6K | 57.5K | 87.3K |

Two of these margins are ties, not leads. **Person encode** shows 27% over Avro in this shared-process table, but measured alone in its own process the gap is 2%. Quote that figure. **Unicode decode** shows Avro 3% ahead, which is the same width. The decode columns on the nested and batch fixtures are the margins with real room in them.

### Documents: where msgpackr decodes faster

The fixtures above are records: few keys, short strings, no optional fields. A document, meaning many keys, mostly string content, and arrays whose elements have different key sets, measures differently:

| Codec | Bytes | Encode | Decode |
| --- | ---: | ---: | ---: |
| **shorn** | **2,236** | **264.2K** | 314.6K |
| msgpackr shared records | 2,268 | 85.6K | 364.7K |
| msgpackr bundled strings | 2,341 | 157.7K | **535.4K** |
| cbor-x shared records | 2,321 | 82.5K | 334.7K |
| @msgpack/msgpack | 2,872 | 85.9K | 96.6K |
| JSON bytes | 3,334 | 140.6K | 141.1K |

shorn is smallest and fastest to encode, by 68% over the next codec, and fourth to decode. The cause is one string-decode call per string. `bundleStrings` writes all string content into one contiguous region and decodes it in a single call. shorn pays that call once per string, and 87% of this payload is string bytes.

**The alphabet has nothing to do with it.** The fixture is pure ASCII and shorn still decodes it at 59% of `bundleStrings`. What costs is the *number* of strings, not what is in them.

The remaining gap is a wire-format question rather than a tuning one: bundling strings would change the bytes.

:::caution[Microbenchmark margins vary]
The codecs share one benchmark process, so small margins can move between runs. In isolated Person-encode measurements on the same machine, shorn took 45.05 ns and Avro 46.09 ns: a 2% difference, against the 27% the shared table shows. Treat narrow results as directional and benchmark representative production data.
:::

## Validation included

| Codec | Bytes | Encode | Decode |
| --- | ---: | ---: | ---: |
| **shorn + Zod** | **8** | **8.35M** | **11.56M** |
| Zod + Avro | **8** | 8.15M | 9.90M |
| Zod + SchemaPack | 9 | 6.91M | 7.82M |
| Zod + JSON string | 35 | 6.27M | 4.06M |
| Zod + JSON bytes | 35 | 3.58M | 3.55M |

Validation is most of the end-to-end cost, and it flattens the encode column. Once Zod runs on every value, shorn and Avro encode at the same speed within noise, because the validator is the work. Decode still separates them, at 17% over Avro.

On the Person fixture the raw codec runs at 20.98M encodes/s and 62.57M decodes/s. Adding Zod brings those down to 8.35M and 11.56M.

Between services you own, `unchecked(compile(schema))` writes the same bytes at the raw-codec speed, giving up every refinement on both sides in exchange. See [Skipping Validation](/core-concepts/validation/#skipping-validation).

## Methodology

Tests ran on Node v22.23.1, an Apple M4 Pro, and macOS arm64. Small-fixture results are the median of seven samples of about 180 ms each, after warm-up. The [100,000-event](/performance/size/#fixtures) results use three single-operation samples, because one operation already processes the whole value. Every codec has to round-trip to the same logical value.

Schema construction is excluded here and measured separately as [cold setup](/performance/footprint/). Raw tests use each codec's normal API with SchemaPack validation disabled. Protobuf.js includes `fromObject` and `toObject` so that it exposes the same string-enum API as the others.

Object schemas that qualify use generated encode and decode functions. A strict Content Security Policy falls back to the interpreted path with identical bytes and results. See [Compilation and Caching](/core-concepts/compile-and-caching/#generated-encoders) for which schemas take which path.

```sh
pnpm bench
pnpm bench:all
```

Benchmark your own schemas and traffic before making a production decision.
