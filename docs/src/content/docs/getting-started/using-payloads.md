---
title: Using Payloads
description: Send shorn bytes over HTTP, store or queue them safely, and frame multiple values.
---

## HTTP

```ts
const body = encode(Person, person);

await fetch("/people", {
  method: "POST",
  headers: { "Content-Type": "application/octet-stream" },
  body,
});
```

Decode an incoming body from its `ArrayBuffer`, using `safeDecode` where malformed input is expected rather than exceptional:

```ts
const bytes = new Uint8Array(await request.arrayBuffer());
const result = safeDecode(Person, bytes);
```

## Storage and queues

```ts
const StoredPerson = fingerprinted(compile(Person), { bytes: 4 });
await queue.send(StoredPerson.encode(person));
```

Keep every historical codec while its payloads exist. The wire fingerprint does not cover refinements or conversion behavior, so if those need versioning too, store an application version in a header or column.

## Multiple values

A shorn payload has no overall length prefix, and trailing bytes are rejected. Do not concatenate payloads and expect `decode` to find their boundaries. Use one transport message per value, or add an external length prefix when writing several values to a stream or file.

## Security

Compact bytes are not encrypted, and wire fingerprints are not authentication tags. Use your transport's normal encryption and authentication controls. See [Hostile Input](/hostile-input/).
