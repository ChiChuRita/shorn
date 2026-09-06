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

On the receiving side, read the body as an `ArrayBuffer` and wrap it in a `Uint8Array`. Use `safeDecode` when malformed input is something you expect to see, so a bad request becomes a result instead of an exception:

```ts
const bytes = new Uint8Array(await request.arrayBuffer());
const result = safeDecode(Person, bytes);
```

## Storage and queues

```ts
const StoredPerson = fingerprinted(compile(Person), { bytes: 4 });
await queue.send(StoredPerson.encode(person));
```

Keep every old codec for as long as payloads written by it still exist. The fingerprint covers the wire shape but not validation rules or conversion functions. If those need versioning too, store an application version in a header or a database column.

## Multiple values

A shorn payload has no overall length prefix, and any bytes left over after a value cause an error. So do not concatenate payloads and expect `decode` to find where one ends and the next begins. Send one value per transport message, or write your own length prefix in front of each value when several go into one stream or file.

## Security

Compact is not encrypted, and a fingerprint is not an authentication tag. Use your transport's normal encryption and authentication. See [Hostile Input](/hostile-input/) for what the decoder checks on its own.
