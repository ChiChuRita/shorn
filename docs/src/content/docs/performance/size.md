---
title: Payload Size
description: Smallest raw payload in every measured fixture, smallest gzip in both large profiles, sixth under Brotli on repetitive data.
---

Size is the axis shorn leads. Every number is from `pnpm bench:all` on Node v22.23.1, Apple M4 Pro, macOS arm64.

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

shorn is smallest or tied on every fixture. Two caveats apply: bare shorn, Avro, and Protobuf payloads require the correct schema outside the payload, and shared-record sizes exclude their record table.

The Unicode row shows where the savings come from. shorn removes field names, tags, and syntax, but it does not shrink string content. Payloads dominated by structure and numbers can be about 75% smaller than JSON. Payloads dominated by free text see smaller gains.

## Compressed, 100,000 events

Roughly 4.2 MB of shorn bytes, against 16 MB of JSON, a batch large enough that compression is a real decision rather than a rounding error.

### Repetitive data

| Codec | Raw | Gzip | Brotli q6 |
| --- | ---: | ---: | ---: |
| **shorn** | **4,231,777** | **924,494** | 603,189 |
| SchemaPack | 4,331,777 | 937,975 | 597,776 |
| Avro | 4,344,802 | 935,333 | 632,034 |
| msgpackr records | 4,995,339 | 1,114,738 | **513,630** |
| Protobuf.js | 5,781,774 | 980,559 | 618,608 |
| JSON | 16,340,686 | 1,474,952 | 985,919 |

shorn is smallest raw and under gzip. **It is not smallest under Brotli:** msgpackr records are 17% smaller, and SchemaPack is slightly smaller. Brotli compresses their repeated metadata particularly well.

Compression CPU for the shorn payload: gzip 78.99 ms, gunzip 4.12 ms, Brotli q6 42.19 ms, unbrotli 5.25 ms.

### High-entropy data

| Codec | Raw | Gzip | Brotli q6 |
| --- | ---: | ---: | ---: |
| **shorn** | **6,987,333** | **2,337,080** | 2,084,918 |
| SchemaPack | 7,087,333 | 2,540,070 | 2,089,259 |
| Avro | 7,100,358 | 2,446,369 | 2,187,026 |
| msgpackr records | 7,750,895 | 2,598,288 | 2,235,235 |
| Protobuf.js | 8,487,330 | 2,508,528 | **1,943,144** |
| JSON | 18,996,242 | 3,001,786 | 2,580,139 |

shorn is smallest raw and under gzip, and second under Brotli. Compared with JSON, it is 63% smaller raw, 22% smaller under gzip, and 19% smaller under Brotli. Protobuf compresses best under Brotli in this fixture despite being 21% larger raw.

Compression CPU: gzip 111.90 ms, gunzip 8.29 ms, Brotli q6 163.15 ms, unbrotli 12.47 ms.

## Compression caveat

shorn is not smallest under every compressor. Brotli makes msgpackr records or Protobuf smaller in these fixtures. shorn is smallest raw and under gzip in both 100,000-event profiles.

## Cutting bytes further

- **Declare non-negative integers.** ZigZag doubles the magnitude, so an `int` crosses every varint boundary at half the value.
- **Use enums, not free strings**, for closed sets: one varint index against length plus content.
- **Prefer literals** where a field is constant: zero bytes.
- **Choose a compact timestamp form.** ISO-8601 is ~25 bytes, epoch millis 6–7. shorn will not choose for you. See [rich types](/schemas/rich-types/).
- **Choose framing deliberately.** Use a 4-byte fingerprint for persistent data. Pinned RPC can stay bare, and a fingerprint carried in a header need not be repeated in the payload.

## Reproducing

```sh
pnpm bench          # small fixtures
pnpm bench:large    # 100,000 repetitive events
pnpm bench:entropy  # 100,000 high-entropy events
pnpm bench:all      # everything, plus correctness checks
```

Run the complete benchmark on one machine when comparing results; do not combine rows from different runs or environments.
