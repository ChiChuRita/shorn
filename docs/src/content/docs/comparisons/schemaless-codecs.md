---
title: vs MessagePack and CBOR
description: Compare schema-guided bytes with self-describing binary formats and shared-record modes.
---

MessagePack and CBOR are self-describing: a decoder can read values without your application schema. shorn omits that metadata because both endpoints already have the validator.

| | shorn | MessagePack / CBOR |
| --- | --- | --- |
| Structure | Existing validation schema | Included in each value |
| Generic inspection | Requires the schema | Supported |
| Rich values | Explicit conversion | Often built in |
| Cross-language | No | Yes |
| Streaming | No | Available |

## Shared-record modes

msgpackr and cbor-x can move repeated field names into a shared record table. This reduces payload size but requires both endpoints to synchronize that table. shorn uses the validation schema as its shared structure instead.

## Choose shorn when

Both endpoints have the same validator schema and compact standalone payloads matter.

## Choose MessagePack or CBOR when

Payloads must be self-describing, other languages need to decode them, or native support for values such as `Date`, `Map`, `Set`, and `bigint` matters.

See [Payload Size](/performance/size/), [Throughput](/performance/throughput/), and [Footprint](/performance/footprint/) for current measurements, including shared-record modes and compression.
