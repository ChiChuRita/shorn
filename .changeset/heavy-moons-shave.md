---
"shorn": minor
---

Add `unchecked()`: the same codec with the validator removed.

Between two services you own, on a link you own, validation is work the process has
already done — the producer built the value from a typed source, and the consumer is
about to hand it to typed code. `unchecked()` returns the structural half of a
`compile()` codec, so the checks are skipped on both sides:

```ts
const wire = unchecked(compile(Person));

wire.encode(person); // byte-identical to compile(Person).encode(person)
wire.decode(bytes);  // no refinements run
```

On the three-field zod person fixture in `bench/regression.mjs`, that is 8.26M → 19.09M
encodes/s and 10.89M → 40.77M decodes/s: 2.3x and 3.7x. The ratio is that large because
the generated encoders and decoders shipped earlier made the structural half cheap
enough that validation is now most of the remaining cost — it is a fact about this
codec, not about your validator.

The bytes do not change, so a validated decoder reads what an unchecked encoder wrote
and a rollout can be gradual. Every structural check survives: bounds on each read, the
length limits, the trailing-byte refusal. Malformed input is still a `DecodeError`
rather than a wrong value.

What you give up is the whole validator, not only the checks that were going to pass. A
transform such as `z.string().trim()` no longer runs, so the value goes out exactly as
handed over — and bytes written against a schema differing only in its refinements now
decode silently. `fingerprinted()` composes and still catches a *structural* mismatch,
prefix check included, but a fingerprint has never covered refinements. Keep the
validated codec at any boundary you do not own.

It is a codec rather than an option on `encode`/`compile` on purpose: the decision is
per-link, not per-call, so it belongs at module scope where it can be found by reading
one definition instead of every call site. A codec with no validator to remove — an `m`
schema, or a `compile()` codec behind `nullable()`/`optional()` — is refused rather than
returned unchanged, because returning the second one would keep validating under a name
that says it does not.

Importers of `unchecked` pay 64 gzip bytes; nobody else pays anything.
