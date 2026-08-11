---
title: Comparisons
description: How shorn relates to JSON, to schema-driven codecs like Avro and Protobuf, and to self-describing ones like MessagePack and CBOR.
---

Every codec here keeps some structural information out of the payload, or none at all. What separates them is which schema you maintain and what you get back for it.

| Need | Prefer |
| --- | --- |
| An existing TypeScript validator, no second schema | shorn |
| Automatic schema evolution or cross-language readers | Avro |
| gRPC or an established `.proto` workflow | Protobuf |
| Self-describing values or broad rich-type support | MessagePack or CBOR |
| Universal, inspectable text | JSON |

## Against JSON

JSON carries field names and syntax in every payload. shorn leaves that structure in the shared validation schema, which is where the size and speed difference comes from.

```ts
// JSON
const body = JSON.stringify(person);
const parsed = Person.parse(JSON.parse(text));

// shorn
const body = encode(Person, person);
const parsed = decode(Person, body);
```

Send it as `Content-Type: application/octet-stream`, and convert `Date`, `bigint`, `Map`, and `Set` to explicit [wire-friendly forms](/schemas/rich-types/) first.

Gzipping the JSON is not the same saving. A compressor shrinks repeated content; shorn removes structure before any compressor runs, and the two compose. In the [100,000-event benchmarks](/performance/size/#compressed-100000-events), gzipped shorn is 37% smaller than gzipped JSON on repetitive data and 22% smaller on high-entropy data, because gzipped JSON still spends compressed bits on the field names and syntax shorn never wrote. Gzip also costs measured CPU — 79 to 112 ms per batch there — while shorn's reduction is free, and it applies to payloads far too small to be worth compressing at all: nothing gzips an 8-byte record.

Stay on JSON when other languages or generic tools must read the payload, when humans need to inspect or edit it directly, when streaming matters, or when the traffic is too small for another format to pay for itself.

## Against Avro, Protobuf, and SchemaPack

These also keep structure outside the payload, so the comparison is about workflow rather than bytes — and about where the schema lives. Theirs is a separate artifact to keep in sync (a `.proto` file, an Avro schema, a builder DSL); shorn's is the validator you already run, real code that your compiler checks and your editor refactors. TypeScript types come from the validator's own inference (`StandardSchemaV1.InferOutput`), a single type lookup, so shorn adds no type-level parsing for tsserver to re-run on every keystroke.

| Codec | Schema workflow | Evolution | Languages |
| --- | --- | --- | --- |
| **shorn** | Existing Standard Schema validator | Mismatch detection only | TypeScript/JavaScript |
| **Avro** | Separate Avro schema | Reader/writer resolution | Cross-language |
| **Protobuf** | Separate `.proto`; codegen or reflection | Field-tag compatibility | Cross-language |
| **SchemaPack** | JavaScript builder DSL | None | JavaScript |

Choose **Avro** for automatic schema resolution, cross-language readers, or mature data-platform tooling. Choose **Protobuf** for cross-language RPC and gRPC; runtime reflection avoids generated code, but the `.proto` remains a separate source of truth. Choose **SchemaPack** if a JavaScript-only builder schema is fine and automatic evolution is unnecessary.

## Against MessagePack and CBOR

These are self-describing: a decoder reads values without your application schema. shorn omits that metadata because both endpoints already have the validator.

| | shorn | MessagePack / CBOR |
| --- | --- | --- |
| Structure | Existing validation schema | Included in each value |
| Generic inspection | Requires the schema | Supported |
| Rich values | Explicit conversion | Often built in |
| Cross-language | No | Yes |
| Streaming | No | Available |

msgpackr and cbor-x can move repeated field names into a shared record table, which shrinks payloads but requires both endpoints to synchronize that table. shorn uses the validation schema as its shared structure instead. Their `bundleStrings` mode also decodes document-shaped payloads faster than shorn does; that gap is measured honestly in [Throughput](/performance/throughput/#documents-are-the-other-exception-and-it-is-not-about-unicode).

Choose MessagePack or CBOR when payloads must be self-describing, other languages need to decode them, or native `Date`, `Map`, `Set`, and `bigint` support matters.

## The measurements

[Payload Size](/performance/size/), [Throughput](/performance/throughput/), and [Footprint](/performance/footprint/) carry every number behind these comparisons, including shared-record modes and compression.
