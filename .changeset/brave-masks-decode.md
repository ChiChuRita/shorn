---
"shorn": patch
---

Objects with optional fields now decode through a generated function instead of the
interpreted loop. Document decode is 17% faster. The wire bytes are unchanged.

The presence bitmap was treated as making the field set ungeneratable, which
conflated two things: *which* fields arrive varies per payload, but each optional's
byte and bit within the bitmap are fixed by the schema. So every optional emits as a
constant mask test — `if(b[2]&16)` — and each field keeps its own monomorphic
`_decode` call site, which is the entire reason the generated decoders are faster
than a loop over `this.fields`.

This was not an edge case. Heterogeneous array elements are the normal shape of a
real document, and running shorn through msgpackr's own benchmark found two of
twelve object types on the interpreted path while shorn decoded 2.1x slower than
msgpackr's shared records. The in-house `document` fixture now reads 216,526 ops/s
against 190,586 before.

Still interpreted, because each needs `defineProperty` rather than an assignment: a
`__proto__` field, an open object, and an optional named after an `Object.prototype`
member. Encoding with optional fields is also unchanged. All 64 subsets of a
six-optional schema are asserted byte-identical and value-identical across the
generated and interpreted paths, and non-canonical bitmap padding is still rejected
by both.

Costs 406 minified and 214 gzip bytes. The published bundle tables move with it:
the `m` row is now 5.10 KB gzip and 12% under `@msgpack/msgpack`, down from 18%,
and the docs say plainly that the margin is narrowing on purpose and is a lead to
defend rather than a settled one.
