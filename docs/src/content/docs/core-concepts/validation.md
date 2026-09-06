---
title: Validation
description: Your library validates on encode and again on decode. Throwing, result-returning, and async variants, and how each one works with a codec.
---

shorn runs your schema in **both** directions. Encode validates before writing any bytes. Decode validates the value it has just read before returning it.

```ts
const bytes = encode(Person, person); // validates, then writes
const back = decode(Person, bytes);   // reads, then validates
```

The two checks are not redundant. The wire format knows a field is a string. Only your schema knows it has to be a non-empty email address under 64 characters.

A failure on the way in is an `EncodeError`. A failure on the way out is a `DecodeError`, the same class that malformed bytes produce. See [Errors](/api/errors/).

## Results instead of exceptions

```ts
const result = safeDecode(Person, bytes);
if (result.success) result.data; // typed
else result.error;               // always an Error, non-Error throws are wrapped
```

Use the safe variants at boundaries where malformed input is normal traffic rather than a surprise.

## Async validation

A schema with an async refinement cannot go through `encode` or `decode`. They throw and tell you so.

```ts
const bytes = await encodeAsync(Person, person);
const back = await decodeAsync(Person, bytes);
```

Both accept either the Standard Schema or a codec built from it. There are no safe async variants, so use `try`/`catch`.

Nothing shorn does is asynchronous on its own. Reading and writing bytes involves no I/O. The only `await` is your validator's, which is why these are separate functions rather than a `Promise` every caller has to unwrap.

Fingerprints work here too. Pass the fingerprinted codec to the async entry points and the prefix is written and checked exactly as on the sync path:

```ts
const PersonWire = fingerprinted(compile(Person), { bytes: 4 });

const bytes = await encodeAsync(PersonWire, person); // 4-byte fingerprint + payload
const back = await decodeAsync(PersonWire, bytes);   // checks the prefix, then awaits
```

A codec with no validator to await, such as an `m` schema or a `compile()` codec wrapped in `nullable()` or `optional()`, is refused rather than quietly run synchronously.

## Skipping validation

Between two services you own, over a link you own, the checks repeat work you have already done. `unchecked()` returns the same codec with the validator removed:

```ts
const wire = unchecked(compile(Person));

wire.encode(person); // byte-identical to compile(Person).encode(person)
wire.decode(bytes);  // no refinements run
```

The bytes do not change, so a validated decoder reads what an unchecked encoder wrote, and the other way round. Only the checks go away, and they are most of the cost. On the Person fixture, validation takes 22.28M encodes/s down to 8.18M and 62.49M decodes/s down to 11.57M; see [Throughput](/performance/throughput/#validation-included).

What you give up:

- **Refinements, in both directions.** A negative age, a malformed email, a string over its maximum: all of them encode and decode fine as long as the wire type can carry them.
- **Transforms, not only checks.** The validator does not run at all, so `z.string().trim()` or `z.coerce` no longer changes the value. It goes out exactly as you handed it over.
- **Protection against rule changes.** Bytes written against a schema that differs only in its refinements now decode silently. `fingerprinted()` still catches a *structural* difference, but a fingerprint has never covered refinements.

What you keep: every structural check. Bounds on each read, the length limits, the refusal of trailing bytes. Malformed input still throws `DecodeError` rather than escaping as a wrong value. See [Hostile Input](/hostile-input/).

Keep the validated codec at any boundary you do not own. `unchecked()` is for the hop between your own processes, not for the edge.

Every entry point uses the same structural decode path and reports the same errors for malformed input. [API Overview](/api/overview/) has a table of which one to reach for.
