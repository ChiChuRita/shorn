---
title: shorn vs JSON
description: Choose between compact schema-guided bytes and universal inspectable text.
---

JSON carries field names and syntax in every payload. shorn leaves that structure in the shared validation schema.

```ts
const json = new TextEncoder().encode(JSON.stringify(person));
const binary = encode(Person, person);
```

## Choose shorn when

- Both endpoints are TypeScript or JavaScript.
- You already validate with Zod, Valibot, or ArkType.
- Network, storage, or queue volume makes payload size meaningful.
- Binary output is acceptable.

## Choose JSON when

- Other languages or generic tools must read the payload.
- Humans need to inspect or edit it directly.
- Streaming support matters.
- The traffic is too small for another format to pay for itself.

## Migration

```ts
// JSON
const body = JSON.stringify(person);
const parsed = Person.parse(JSON.parse(text));

// shorn
const body = encode(Person, person);
const parsed = decode(Person, body);
```

Use `Content-Type: application/octet-stream`. Convert `Date`, `bigint`, `Map`, and `Set` to explicit [wire-friendly forms](/schemas/rich-types/).

See [Payload Size](/performance/size/) and [Throughput](/performance/throughput/) for current measurements.
