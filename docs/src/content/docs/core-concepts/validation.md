---
title: Validation
description: Your library validates on encode and again on decode. Throwing, result-returning, and async variants, and how each composes with a codec.
---

shorn runs your schema **both** ways: encode validates before writing bytes, decode validates the structurally-decoded value before returning it.

```ts
const bytes = encode(Person, person); // validates, then writes
const back = decode(Person, bytes);   // reads, then validates
```

These checks are not redundant. The wire format knows that a field is a string; only your schema knows that it must be a non-empty email address under 64 characters.

| Error | Thrown when |
| --- | --- |
| `EncodeError` | validation failed on the way in, or the schema cannot be encoded |
| `DecodeError` | the bytes are malformed, **or** validation failed on the way out |

`DecodeError.offset` is the byte position reached. See [Errors](/api/errors/).

## Results instead of exceptions

```ts
const result = safeDecode(Person, bytes);
if (result.success) result.data; // typed
else result.error;               // always an Error, non-Error throws are wrapped
```

Use the safe variants at boundaries where malformed input is expected rather than exceptional.

## Async validation

A schema with an async refinement cannot use `encode`/`decode`: they throw and say so.

```ts
const bytes = await encodeAsync(Person, person);
const back = await decodeAsync(Person, bytes);
```

Both take either the Standard Schema or a codec built from it. There are no safe async variants; use `try`/`catch`.

Nothing shorn does is itself asynchronous: reading and writing bytes is synchronous work with no I/O. The only `await` is your validator's, which is why these are separate functions rather than a `Promise` every caller has to unwrap.

### Async validation and fingerprints

These compose. Pass the fingerprinted codec to the async entry points and the prefix is written and checked exactly as on the sync path:

```ts
const PersonWire = fingerprinted(compile(Person), { bytes: 4 });

const bytes = await encodeAsync(PersonWire, person); // 4-byte fingerprint + payload
const back = await decodeAsync(PersonWire, bytes);   // checks the prefix, then awaits
```

A codec with no validator to await (an `m` schema, or a `compile()` codec behind `nullable()`/`optional()`) is refused rather than quietly encoded synchronously.

## Which entry point

| Situation | Use |
| --- | --- |
| Ordinary code | `encode` / `decode` |
| Untrusted input | `safeEncode` / `safeDecode` |
| Async refinement | `encodeAsync` / `decodeAsync`, on the schema or a codec |
| A codec to pass around | `compile` |
| Stored, queued, version-crossing | `fingerprinted(compile(schema), { bytes: 4 })` |

All five use the same structural decode path and report the same malformed-input errors.
