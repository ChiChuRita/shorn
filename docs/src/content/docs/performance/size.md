---
title: Payload Size
description: Smallest raw payload in every measured fixture, smallest gzip in both large profiles, second under Brotli in both.
---

Size is the axis shorn leads. Every number is from Node v22.23.1, Apple M4 Pro, macOS arm64. Each table below comes from a single run — the raw-bytes table from `pnpm bench`, the two compressed tables from `pnpm bench:large` and `pnpm bench:entropy` respectively — because compressed sizes from different fixture runs are not comparable and must not share a table.

## Fixtures

Every benchmark on this site measures the same two shapes, defined once in [`bench/fixtures.mjs`](https://github.com/ChiChuRita/shorn/blob/main/bench/fixtures.mjs):

```ts
const person = m.object({ age: m.uint(), name: m.string(), sex: m.enum(["F", "M", "X"]) });

const event = m.object({
  active: m.boolean(),
  actor: person,
  id: m.uint(),
  metrics: m.object({ cpu: m.float64(), memory: m.uint() }),
  tags: m.array(m.string()),
  timestamp: m.uint(),
});
```

| Fixture | Value | Bytes each |
| --- | --- | ---: |
| Person | one `person`, ASCII name | 8 |
| Unicode person | one `person`, name with 2- and 4-byte characters | 31 |
| Nested event | one `event` | 43 |
| 100 events | array of 100 generated `event`s | 41 |
| 100,000 events, repetitive | the same array at 100,000 entries: three recurring names, two recurring tag sets | 42 |
| 100,000 events, high-entropy | the same 100,000 entries with a mostly unique name and two unique tags each | 70 |

An event is one small application record: a few numbers, a flag, a nested actor, a metrics pair, and a short tag array. The two large profiles differ only in string content, which is the part shorn does not shrink, so they bracket the realistic range: repeated strings favor every compressor, unique strings defeat them.

## Raw bytes

| Codec | Person | Unicode person | Nested event | 100 events |
| --- | ---: | ---: | ---: | ---: |
| **shorn** | **8** | **31** | **43** | **4,135** |
| Avro / avsc | **8** | **31** | 44 | 4,249 |
| SchemaPack | 9 | 32 | 44 | 4,235 |
| msgpackr shared records | 10 | 33 | 52 | 4,993 |
| Protobuf.js reflection | 11 | 34 | 57 | 5,684 |
| cbor-x shared records | 14 | 38 | 62 | 5,972 |
| @msgpack/msgpack | 23 | 46 | 115 | 11,281 |
| msgpackr plain | 25 | 48 | 121 | 11,881 |
| cbor-x plain | 26 | 50 | 122 | 11,972 |
| JSON | 35 | 58 | 163 | 16,148 |

shorn is smallest or tied on every fixture, with two caveats: bare shorn, Avro, and Protobuf payloads require the correct schema outside the payload, and shared-record sizes exclude their record table.

The Unicode row shows where the savings come from. shorn removes field names, tags, and syntax, but does not shrink string content. Payloads dominated by structure and numbers can be about 75% smaller than JSON; payloads dominated by free text see smaller gains.

## Compressed, 100,000 events

Roughly 4.2 MB of shorn bytes against 16 MB of JSON — a batch large enough that compression is a real decision rather than a rounding error.

### Repetitive data

| Codec | Raw | Gzip | Brotli q6 |
| --- | ---: | ---: | ---: |
| **shorn** | **4,276,969** | **1,294,279** | 1,031,628 |
| SchemaPack | 4,376,969 | 1,310,861 | **911,527** |
| Avro | 4,485,280 | 1,333,773 | 1,096,771 |
| msgpackr shared records | 4,995,339 | 1,545,944 | 1,096,702 |
| msgpackr bundled strings | 5,262,688 | 1,468,427 | 1,075,095 |
| Protobuf.js | 5,826,966 | 1,402,471 | 1,054,692 |
| JSON | 16,498,152 | 1,769,924 | 1,731,672 |

shorn is smallest raw and under gzip, and second under Brotli. **SchemaPack is 12% smaller under Brotli** while being 100,000 bytes larger raw, and the reason is specific rather than general: this fixture's `id`, `timestamp` and `memory` are counters, and a fixed-width big-endian integer leaves its high bytes unchanged across thousands of consecutive records, which LZ77 matches as long identical runs. shorn writes LEB128 — 40% fewer bytes for the same counter, but little-endian 7-bit groups lead with the byte that changes every record and straddle boundaries no byte-level matcher lines up with. Density and LZ-friendliness are in tension here, and shorn is on the density side of it by design.

Compression CPU for the shorn payload: gzip 48.22 ms, gunzip 4.46 ms, Brotli q6 62.87 ms, unbrotli 5.79 ms.

### High-entropy data

| Codec | Raw | Gzip | Brotli q6 |
| --- | ---: | ---: | ---: |
| **shorn** | **7,032,525** | **2,843,123** | 2,405,343 |
| SchemaPack | 7,132,525 | 2,956,080 | 2,559,420 |
| Avro | 7,240,836 | 2,933,473 | 2,529,981 |
| msgpackr shared records | 7,750,895 | 2,977,950 | 2,610,896 |
| msgpackr bundled strings | 8,053,257 | 3,078,433 | **2,245,961** |
| Protobuf.js | 8,532,522 | 2,992,114 | 2,471,879 |
| JSON | 19,153,708 | 3,288,544 | 3,213,618 |

shorn is smallest raw and under gzip, and second under Brotli. Against JSON it is 63% smaller raw, 14% smaller under gzip, and 25% smaller under Brotli. msgpackr's bundled-strings mode is 7% smaller under Brotli despite being 15% larger raw: it writes every string's content contiguously, and on data that is mostly unique strings that is the layout Brotli exploits best.

Compression CPU: gzip 99.27 ms, gunzip 8.75 ms, Brotli q6 170.65 ms, unbrotli 13.44 ms.

**The caveat, stated plainly:** shorn is not smallest under every compressor. Under Brotli, SchemaPack wins on repetitive data and msgpackr's bundled strings wins on high-entropy data — and both are in the tables above rather than left out of them. shorn is smallest raw and smallest under gzip in both 100,000-event profiles.

## Cutting bytes further

- **Declare non-negative integers.** ZigZag doubles the magnitude, so an `int` crosses every varint boundary at half the value.
- **Use enums, not free strings**, for closed sets: one varint index against length plus content.
- **Prefer literals** where a field is constant: zero bytes.
- **Choose a compact timestamp form.** ISO-8601 is ~25 bytes, epoch millis 6–7. shorn will not choose for you; see [rich types](/schemas/rich-types/).
- **Choose framing deliberately.** Use a 4-byte fingerprint for persistent data. Pinned RPC can stay bare, and a fingerprint carried in a header need not be repeated in the payload.

## Reproducing

```sh
pnpm bench          # small fixtures
pnpm bench:large    # 100,000 repetitive events
pnpm bench:entropy  # 100,000 high-entropy events
pnpm bench:all      # everything, plus correctness checks
```

Run the complete benchmark on one machine when comparing results; do not combine rows from different runs or environments.
