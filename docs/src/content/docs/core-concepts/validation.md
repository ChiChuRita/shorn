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

## Skipping validation

Between two services you own, on a link you own, the checks are work you have already done. `unchecked()` returns the same codec with the validator removed:

```ts
const wire = unchecked(compile(Person));

wire.encode(person); // byte-identical to compile(Person).encode(person)
wire.decode(bytes);  // no refinements run
```

The bytes do not change, so a validated decoder reads what an unchecked encoder wrote, and the other way round. Only the checks go away — and that is most of the cost. On the Person fixture, validation takes 25.16M encodes/s down to 8.93M and 67.55M decodes/s down to 12.07M; see [Throughput](/performance/throughput/#validation-included).

What you give up:

- **Refinements, both ways.** A negative age, a malformed email, a string over its maximum — all encode and decode fine if the wire type can carry them.
- **Transforms, not only checks.** The validator is not run at all, so a `z.string().trim()` or a `z.coerce` no longer changes the value. It goes out exactly as handed over.
- **Semantic version skew.** Bytes written against a schema that differs only in its refinements now decode silently. `fingerprinted()` still catches a *structural* difference — it composes, prefix check included — but a fingerprint has never covered refinements.

What you keep: every structural check. Bounds on each read, the length limits, the trailing-byte refusal. Malformed input still throws `DecodeError` rather than escaping as a wrong value. See [Hostile Input](/hostile-input/).

Keep the validated codec at any boundary you do not own. `unchecked()` is for the hop between your own processes, not for the edge.

## Which entry point

| Situation | Use |
| --- | --- |
| Ordinary code | `encode` / `decode` |
| Untrusted input | `safeEncode` / `safeDecode` |
| Async refinement | `encodeAsync` / `decodeAsync`, on the schema or a codec |
| A codec to pass around | `compile` |
| Stored, queued, version-crossing | `fingerprinted(compile(schema), { bytes: 4 })` |
| Trusted producer you own, both ends | `unchecked(compile(schema))` |

All of them use the same structural decode path and report the same malformed-input errors.
