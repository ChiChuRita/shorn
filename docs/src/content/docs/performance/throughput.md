---
title: Throughput
description: Encode and decode benchmarks against JSON and schema-based binary codecs.
---

shorn is faster than byte-producing JSON in every measured fixture. Against the binary codecs, it leads most fixtures; text-heavy Unicode data is the exception.

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

Unicode-heavy data is the exception: msgpackr records encode it 4% faster, and Avro decodes it faster. String processing dominates that fixture.

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

Eligible object schemas use specialized runtime-generated encode and decode functions. Schemas with optional fields use the interpreted path. A strict Content Security Policy that blocks `new Function` also uses the interpreted path, with identical bytes and results. See [Compilation and Caching](/core-concepts/compile-and-caching/).

## Methodology

Tests ran on Node v22.23.1, an Apple M4 Pro, and macOS arm64. Small-fixture results are the median of seven samples of about 180 ms after warm-up. The [100,000-event](/performance/size/#fixtures) results use three single-operation samples, because one operation already processes the whole value. Every codec must round-trip to the same logical value.

Schema construction is excluded and measured separately as [cold setup](/performance/footprint/). Raw tests use each codec's normal API with SchemaPack validation disabled. Protobuf.js includes `fromObject` and `toObject` so it exposes the same string-enum API.

```sh
pnpm bench
pnpm bench:all
```

Benchmark your own schemas and traffic before making a production decision.
