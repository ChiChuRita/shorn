---
title: vs Avro, Protobuf, SchemaPack
description: Compare schema workflow, evolution, interoperability, and runtime requirements.
---

All four formats keep structural information outside each payload. The main difference is which schema you maintain and what compatibility model it provides.

| Codec | Schema workflow | Evolution | Languages |
| --- | --- | --- | --- |
| **shorn** | Existing Standard Schema validator | Mismatch detection only | TypeScript/JavaScript |
| **Avro** | Separate Avro schema | Reader/writer resolution | Cross-language |
| **Protobuf** | Separate `.proto`; codegen or reflection | Field-tag compatibility | Cross-language |
| **SchemaPack** | JavaScript builder DSL | None | JavaScript |

## Choose shorn when

You already validate with Zod, Valibot, or ArkType and want compact bytes without another schema definition or build step.

## Choose Avro when

You need automatic schema resolution, cross-language readers, or mature data-platform tooling.

## Choose Protobuf when

You need cross-language RPC, gRPC, or an existing `.proto` ecosystem. Runtime reflection can avoid generated code, but the `.proto` schema remains a separate source of truth.

## Choose SchemaPack when

A JavaScript-only builder schema is acceptable and automatic evolution is unnecessary.

See [Payload Size](/performance/size/), [Throughput](/performance/throughput/), and [Footprint](/performance/footprint/) for the measured comparison.
