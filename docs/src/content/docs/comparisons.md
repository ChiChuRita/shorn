---
title: Comparisons
description: How shorn relates to JSON, to schema-driven codecs like Avro and Protobuf, and to self-describing ones like MessagePack and CBOR.
---

Every codec here keeps some structural information out of the payload, or none at all. What separates them is which schema you have to maintain, and what you get back for it.

| Need | Prefer |
| --- | --- |
| An existing TypeScript validator, no second schema | shorn |
| Automatic schema evolution or cross-language readers | Avro |
| gRPC or an established `.proto` workflow | Protobuf |
| Self-describing values or broad rich-type support | MessagePack or CBOR |
| Universal, inspectable text | JSON |

## Against JSON

JSON writes the field names and the syntax into every payload. shorn leaves that structure in the validation schema both sides already share, and that is where the size and speed difference comes from.

```ts
// JSON
const body = JSON.stringify(person);
const parsed = Person.parse(JSON.parse(text));

// shorn
const body = encode(Person, person);
const parsed = decode(Person, body);
```

Send it as `Content-Type: application/octet-stream`. `Date`, `bigint`, `Map` and `Set` need no conversion; each has a [wire form of its own](/schemas/rich-types/).

Gzipping the JSON is not the same saving. A compressor shrinks repeated content. shorn removes structure before any compressor runs, and the two stack. In the [100,000-event benchmarks](/performance/size/#compressed-100000-events), gzipped shorn is 27% smaller than gzipped JSON on repetitive data and 14% smaller on high-entropy data, because gzipped JSON still spends bits on field names shorn never wrote. Gzip also costs 48 to 99 ms of CPU per batch there, while shorn's saving is free, and it applies to payloads far too small to be worth compressing at all.

Stay on JSON when other languages or generic tools have to read the payload, when humans need to inspect or edit it directly, when streaming matters, or when the traffic is too small for another format to pay for itself.

## Against Avro, Protobuf, and SchemaPack

These also keep structure out of the payload, so the comparison is about where the schema lives. Theirs is a separate artifact you keep in sync: a `.proto` file, an Avro schema, a builder DSL. shorn's is the validator you already run, real code your compiler checks and your editor refactors. Types come from the validator's own inference, a single lookup, so shorn adds no type-level work for the TypeScript server.

| Codec | Schema workflow | Evolution | Languages |
| --- | --- | --- | --- |
| **shorn** | Existing Standard Schema validator | Mismatch detection only | TypeScript/JavaScript |
| **Avro** | Separate Avro schema | Reader/writer resolution | Cross-language |
| **Protobuf** | Separate `.proto`; codegen or reflection | Field-tag compatibility | Cross-language |
| **SchemaPack** | JavaScript builder DSL | None | JavaScript |

Choose **Avro** for automatic schema resolution, cross-language readers, or mature data-platform tooling. Choose **Protobuf** for cross-language RPC and gRPC. Its runtime reflection avoids generated code, but the `.proto` file is still a separate source of truth. Choose **SchemaPack** if a JavaScript-only builder schema is fine and you do not need automatic evolution.

## Against MessagePack and CBOR

These are self-describing: a decoder can read the values without your application schema. shorn leaves that metadata out because both ends already have the validator.

| | shorn | MessagePack / CBOR |
| --- | --- | --- |
| Structure | Existing validation schema | Included in each value |
| Generic inspection | Requires the schema | Supported |
| Rich values | `Date`, `bigint`, `Map`, `Set` built in | Often built in |
| Cross-language | No | Yes |
| Streaming | No | Available |

msgpackr and cbor-x can move repeated field names into a shared record table, which shrinks payloads but requires both ends to keep that table in sync. shorn uses the validation schema as its shared structure instead. msgpackr's `bundleStrings` mode also decodes document-shaped payloads faster than shorn does. That gap is measured honestly in [Throughput](/performance/throughput/#documents-where-msgpackr-decodes-faster).

Choose MessagePack or CBOR when payloads have to be self-describing, when other languages need to decode them, or when a value shorn has no wire form for, such as `undefined` or a class instance, has to travel as itself.

## The measurements

[Payload Size](/performance/size/), [Throughput](/performance/throughput/), and [Footprint](/performance/footprint/) hold every number behind these comparisons, including shared-record modes and compression.
