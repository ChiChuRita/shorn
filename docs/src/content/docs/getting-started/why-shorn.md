---
title: Why shorn?
description: Reuse your validation schema as the wire schema instead of maintaining a second definition.
---

JSON, MessagePack, and CBOR repeat field names or type information in each payload. Avro and Protobuf avoid most of that overhead, but require a separate schema model.

shorn uses the Zod, Valibot, or ArkType schema your application already maintains:

```ts
const bytes = encode(Person, person);
const back = decode(Person, bytes);
```

There is no IDL, code-generation step, or generated output. The same validator runs before encoding and after decoding.

## Good fit

- Both endpoints use TypeScript or JavaScript.
- The application already validates its data.
- Payload size or serialization cost matters.
- Both endpoints can share the same wire shape.

## Tradeoffs

- Payloads are opaque without their schema.
- Schema changes require explicit version handling.
- Cross-language decoding, streaming, and random access are not supported.
- Rich values such as `Date`, `bigint`, `Map`, and `Set` need explicit wire forms.

## Compared with alternatives

| Need | Prefer |
| --- | --- |
| Existing TypeScript validator, no second schema | shorn |
| Automatic schema evolution or cross-language readers | Avro |
| gRPC or an established `.proto` workflow | Protobuf |
| Self-describing values or broad rich-type support | MessagePack or CBOR |
| Universal, inspectable text | JSON |

See [Payload Size](/performance/size/), [Throughput](/performance/throughput/), and [Footprint](/performance/footprint/) for the current benchmark results and methodology.
