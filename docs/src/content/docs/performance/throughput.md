---
title: Throughput
description: Encode and decode benchmarks against JSON and schema-based binary codecs.
---

shorn is faster than byte-producing JSON in every measured fixture. Against the binary codecs it leads on record-shaped data. It does **not** lead on document-shaped data: a payload made of many separate strings is decoded faster by msgpackr's `bundleStrings` mode, whatever alphabet those strings are in.

## Against JSON

`JSON bytes` converts to and from a `Uint8Array`, making it the direct comparison for binary transports.

| Fixture | shorn enc | JSON enc | shorn dec | JSON dec |
| --- | ---: | ---: | ---: | ---: |
| Person | **25.10M** | 4.43M | **62.54M** | 4.61M |
| Unicode person | **8.97M** | 3.71M | **9.61M** | 3.48M |
| Nested event | **8.33M** | 1.38M | **11.31M** | 1.67M |
| 100-event batch | **96.1k** | 35.4k | **117.7k** | 19.7k |
| Person, validated | **8.65M** | 3.63M | **11.62M** | 3.67M |

Across these fixtures shorn is up to 6.0× faster to encode and up to 13.6× faster to decode. The ASCII payloads also use as little as 23% of JSON's bytes; the Unicode payload uses 53%.

`JSON.stringify` to a string reaches 10.39M encodes/s for Person. That baseline does less work, because it stops at a JavaScript string rather than producing bytes.

## Against binary codecs

Three msgpackr modes exist; this table compares against one. `bundleStrings` is measured in the document section below, where it wins decode outright.

| Fixture | Op | shorn | Avro | SchemaPack | msgpackr records |
| --- | --- | ---: | ---: | ---: | ---: |
| Person | enc | **25.10M** | 21.56M | 11.74M | 9.70M |
| Person | dec | **62.54M** | 25.09M | 15.18M | 18.03M |
| Unicode person | enc | **8.97M** | 5.90M | 6.51M | 7.30M |
| Unicode person | dec | 9.61M | **9.98M** | 7.78M | 3.80M |
| Nested event | enc | **8.33M** | 6.59M | 3.77M | 3.52M |
| Nested event | dec | **11.31M** | 5.49M | 4.81M | 8.09M |
| 100 events | enc | **96.1K** | 41.2K | 47.2K | 25.4K |
| 100 events | dec | **117.7K** | 53.6K | 56.7K | 84.6K |

Two margins here should not be read off the table. **Person encode** shows a 16% lead over Avro, but measured alone in its own process the gap is 4% — 40.44 ns against 42.29 ns — because every codec here shares one process and Avro's Person-encode column moves by 20% between runs with nothing in either codec changed. Quote the isolated figure. **Unicode decode** shows Avro 4% ahead, which is the same width and equally a tie. The decode columns on the nested and batch fixtures are the margins with room in them.

Unicode-heavy data is no longer a clear exception on decode. Avro led it by 19% before shorn's string decoding stopped allocating a view of every string; the gap is now 4%, which is inside this harness's noise. Unicode *encode* moved from level with msgpackr records to 23% ahead of them.

### Documents are the other exception, and it is not about Unicode

The fixtures above are records: few keys, short strings, no optional fields. A document — many keys, most of the payload being string content, arrays whose elements have different key sets — measures differently, and this is the honest comparison on one:

| Codec | Bytes | Encode | Decode |
| --- | ---: | ---: | ---: |
| **shorn** | **2,236** | **249.6K** | 310.0K |
| msgpackr shared records | 2,268 | 85.4K | 365.7K |
| msgpackr bundled strings | 2,341 | 154.0K | **540.7K** |
| cbor-x shared records | 2,321 | 80.3K | 336.8K |
| @msgpack/msgpack | 2,872 | 85.7K | 95.9K |
| JSON bytes | 3,334 | 142.2K | 142.3K |

shorn is smallest and fastest to encode — by 62% over the next codec — and fourth to decode. The cause is one string-decode call per string: `bundleStrings` writes all string content contiguously and decodes it in a single call, which is the cost shorn pays once per string. 87% of this payload is string bytes.

**The alphabet is irrelevant to this.** That fixture is pure ASCII — every character one byte — and shorn still decodes it at 57% of `bundleStrings`. Reading the Unicode row above and concluding that ASCII API payloads are safely in the winning column is the wrong conclusion: what costs is the *number* of strings, not what is in them.

These decode figures are 45% better than when this fixture was added, in three steps: optional-field objects stopped falling back to the interpreted path on decode (17%), strings began decoding through Node's own UTF-8 decoder where one exists (a further 10%), and that decoder stopped being handed a freshly allocated view of every string (a further 15%). Encode moved further still — optional-field objects now generate their encoder too, and string encoding stopped walking each string once to total its UTF-8 length before writing it. The remaining gap to `bundleStrings` is real, open, and a wire-format question rather than a tuning one — bundling strings would change the bytes.

:::caution[Microbenchmark margins vary]
The codecs share one benchmark process, so small margins can move between runs. In isolated Person-encode measurements on the same machine, shorn took 40.44 ns and Avro 42.29 ns: a 4% difference, against the 16% the shared table shows. Treat narrow results as directional and benchmark representative production data.
:::

## Validation included

| Codec | Bytes | Encode | Decode |
| --- | ---: | ---: | ---: |
| **shorn + Zod** | **8** | **8.65M** | **11.62M** |
| Zod + Avro | **8** | 8.24M | 9.89M |
| Zod + SchemaPack | 9 | 6.61M | 7.76M |
| Zod + JSON string | 35 | 5.70M | 4.11M |
| Zod + JSON bytes | 35 | 3.63M | 3.67M |

Validation is a large part of end-to-end cost, and it is what flattens the encode column: once Zod runs on every value, shorn and Avro encode at the same speed within noise — shorn is nominally 5% ahead here, where an earlier run had Avro 1% ahead — because the validator, not the codec, is the work. Decode still separates them, at 17% over Avro.

On the Person fixture the raw codec runs at 25.10M encodes/s and 62.54M decodes/s; adding Zod reduces those to 8.65M and 11.62M.

Between services you own, `unchecked(compile(schema))` writes the same bytes at the raw-codec figures, giving up every refinement on both sides in exchange — see [Skipping Validation](/core-concepts/validation/#skipping-validation).

## Methodology

Tests ran on Node v22.23.1, an Apple M4 Pro, and macOS arm64. Small-fixture results are the median of seven samples of about 180 ms after warm-up. The [100,000-event](/performance/size/#fixtures) results use three single-operation samples, because one operation already processes the whole value. Every codec must round-trip to the same logical value.

Schema construction is excluded and measured separately as [cold setup](/performance/footprint/). Raw tests use each codec's normal API with SchemaPack validation disabled. Protobuf.js includes `fromObject` and `toObject` so it exposes the same string-enum API.

Eligible object schemas use specialized runtime-generated encode and decode functions; a strict Content Security Policy falls back to the interpreted path with identical bytes and results. See [Compilation and Caching](/core-concepts/compile-and-caching/#runtime-specialization) for which schemas take which path.

```sh
pnpm bench
pnpm bench:all
```

Benchmark your own schemas and traffic before making a production decision.
