---
title: Throughput
description: Encode and decode benchmarks against JSON and schema-based binary codecs.
---

shorn is faster than byte-producing JSON in every measured fixture. Against the binary codecs, it leads on record-shaped data. It does **not** lead on document-shaped data: a payload made of many separate strings is decoded faster by msgpackr's `bundleStrings` mode, whatever alphabet those strings are in.

## Against JSON

`JSON bytes` converts to and from a `Uint8Array`, making it the direct comparison for binary transports.

| Fixture | shorn enc | JSON enc | shorn dec | JSON dec |
| --- | ---: | ---: | ---: | ---: |
| Person | **25.16M** | 4.74M | **67.55M** | 4.67M |
| Unicode person | **7.74M** | 3.77M | **7.68M** | 3.58M |
| Nested event | **8.64M** | 1.40M | **11.45M** | 1.74M |
| 100-event batch | **100.1k** | 36.3k | **116.3k** | 21.2k |
| Person, validated | **8.93M** | 3.69M | **12.07M** | 3.54M |

Across these fixtures, shorn is up to 6.2× faster to encode and up to 14.5× faster to decode. The ASCII payloads also use as little as 23% of JSON's bytes; the Unicode payload uses 53%.

`JSON.stringify` to a string reaches 10.82M encodes/s for Person. That baseline does less work because it stops at a JavaScript string rather than producing bytes.

## Against binary codecs

Three msgpackr modes exist and this table compares against one of them. `bundleStrings` is measured in the document section below, where it wins decode outright.

| Fixture | Op | shorn | Avro | SchemaPack | msgpackr records |
| --- | --- | ---: | ---: | ---: | ---: |
| Person | enc | **25.16M** | 17.10M | 12.55M | 10.55M |
| Person | dec | **67.55M** | 25.59M | 16.12M | 18.96M |
| Unicode person | enc | 7.74M | 5.77M | 6.98M | **8.04M** |
| Unicode person | dec | 7.68M | **9.93M** | 8.25M | 3.97M |
| Nested event | enc | **8.64M** | 6.42M | 4.19M | 3.71M |
| Nested event | dec | **11.45M** | 5.44M | 4.94M | 8.36M |
| 100 events | enc | **100.1K** | 41.2K | 53.4K | 26.9K |
| 100 events | dec | **116.3K** | 52.8K | 57.5K | 88.1K |

Unicode-heavy data is one exception: msgpackr records encode it 4% faster, and Avro decodes it faster. String processing dominates that fixture.

### Documents are the other exception, and it is not about Unicode

The fixtures above are records: few keys, short strings, no optional fields. A document — many keys, most of the payload being string content, arrays whose elements have different key sets — measures differently, and this is the honest comparison on one:

| Codec | Bytes | Encode | Decode |
| --- | ---: | ---: | ---: |
| **shorn** | **2,236** | **166.5K** | 216.1K |
| msgpackr shared records | 2,268 | 89.8K | 383.1K |
| msgpackr bundled strings | 2,341 | 158.3K | **556.9K** |
| cbor-x shared records | 2,321 | 85.4K | 350.6K |
| @msgpack/msgpack | 2,872 | 86.9K | 98.2K |
| JSON bytes | 3,334 | 149.6K | 145.5K |

shorn is smallest and fastest to encode, and fourth to decode. The cause is one string-decode call per string: `bundleStrings` writes all string content contiguously and decodes it in a single call, which is the cost shorn pays once per string. 87% of this payload is string bytes.

**The alphabet is irrelevant to this.** That fixture is pure ASCII — every character one byte — and shorn still decodes it at 39% of `bundleStrings`. Reading the Unicode row above and concluding that ASCII API payloads are safely in the winning column is the wrong conclusion: what costs is the *number* of strings, not what is in them.

These decode figures are already 21% better than when this fixture was added: optional-field objects stopped falling back to the interpreted path (17%), and strings now decode through Node's own UTF-8 decoder where one exists (a further 10%). The remaining gap to `bundleStrings` is real, open, and a wire-format question rather than a tuning one — bundling strings would change the bytes.

:::caution[Microbenchmark margins vary]
The codecs share one benchmark process, so small margins can move between runs. In isolated Person-encode measurements on the same machine, shorn took 42.54 ns and Avro 48.22 ns: a 13% difference. Treat narrow results as directional and benchmark representative production data.
:::

## Validation included

| Codec | Bytes | Encode | Decode |
| --- | ---: | ---: | ---: |
| **shorn + Zod** | **8** | **8.93M** | **12.07M** |
| Zod + Avro | **8** | 8.47M | 10.10M |
| Zod + SchemaPack | 9 | 7.00M | 7.90M |
| Zod + JSON string | 35 | 6.42M | 4.09M |
| Zod + JSON bytes | 35 | 3.69M | 3.54M |

Validation is a large part of end-to-end cost. On the Person fixture, the raw codec runs at 25.16M encodes/s and 67.55M decodes/s; adding Zod reduces those figures to 8.93M and 12.07M.

Between services you own, `unchecked(compile(schema))` writes the same bytes at the raw-codec figures. It gives up every refinement in exchange, on both sides — see [Skipping Validation](/core-concepts/validation/#skipping-validation).

## Runtime behavior

Eligible object schemas use specialized runtime-generated encode and decode functions. **Decoding is generated for schemas with optional fields too** — each optional's position in the presence bitmap is fixed by the schema, so it compiles to a constant mask test. Encoding still takes the interpreted path when a schema has optional fields, as do both directions for a `__proto__` field, an open object, and an optional named after an `Object.prototype` member. A strict Content Security Policy that blocks `new Function` also uses the interpreted path, with identical bytes and results. See [Compilation and Caching](/core-concepts/compile-and-caching/).

## Methodology

Tests ran on Node v22.23.1, an Apple M4 Pro, and macOS arm64. Small-fixture results are the median of seven samples of about 180 ms after warm-up. The [100,000-event](/performance/size/#fixtures) results use three single-operation samples, because one operation already processes the whole value. Every codec must round-trip to the same logical value.

Schema construction is excluded and measured separately as [cold setup](/performance/footprint/). Raw tests use each codec's normal API with SchemaPack validation disabled. Protobuf.js includes `fromObject` and `toObject` so it exposes the same string-enum API.

```sh
pnpm bench
pnpm bench:all
```

Benchmark your own schemas and traffic before making a production decision.
