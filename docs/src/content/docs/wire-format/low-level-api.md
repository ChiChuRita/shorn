---
title: Low-Level m API
description: Build a wire codec directly when no validator schema is available or when you need raw bytes or float32.
---

`m` builds codecs without Standard Schema or JSON Schema.

```ts
import { m } from "shorn";

const Person = m.object({
  name: m.string(),
  age: m.uint(),
  sex: m.enum(["M", "F", "X"]),
});

const bytes = Person.encode({ name: "Grace", age: 45, sex: "F" });
const back = Person.decode(bytes);
```

Use it when:

- no validation schema exists;
- you need `m.bytes()` or `m.float32()`;
- you are implementing a protocol fixture or custom codec.

`m` checks only what is necessary to encode the wire format. It does not implement refinements, business rules, or general validation.

## Limits

- Field and enum order remain canonical and cannot be configured.
- `fingerprinted()` cannot wrap an `m` codec because no structural signature exists.
- Importing `m` retains all builders; they do not tree-shake individually.
- Custom `Schema` internals are unstable and may change in a minor release.

See [m Builders](/api/m/) for every builder, type signature, and the custom `Schema` API.
