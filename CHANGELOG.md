# Changelog

## 0.2.0

**Wire-breaking, one shape.** A recursive type reached through a wrapper — `z.object({ roots: z.array(Tree) })` rather than `Tree` itself — now derives the same fingerprint from every validator. Valibot's spelling of such a schema previously derived a different one from zod's while writing byte-identical payloads, so `fingerprinted()` rejected payloads it could decode. Its fingerprint moves onto the bytes it was already writing; zod's and arktype's do not move, no other signature changes, and no payload's bytes change. A `fingerprinted()` payload written by 0.1.0 against that one shape under Valibot is refused by 0.2.0 — re-encode it, or pin both ends.

### Every validator now agrees on every shape

Found by a cross-vendor fuzz matrix: ~65 wire shapes crossed with Zod, Valibot and ArkType, and with the decoder contract — every truncated prefix, appended trailing bytes, every byte flipped to six values. The decoder held everywhere. Every fix below is in the JSON Schema bridge, and every one was a shape that compiled from one validator and not another.

**A field named `__proto__` is refused instead of silently dropped.** No validator's JSON Schema can carry one: Valibot's emitter assigns the key, which sets the prototype of the `properties` object rather than joining it, and Zod drops the property while still listing it in `required`. The codec was built without the field, so `unchecked()` encoded and decoded without it — data lost with no error. Both spellings now throw `A "__proto__" property does not survive a JSON Schema; rename the field`. One spelling stays unfixable from here: optional under Zod, the field leaves no trace in the emitted document at all. The `m` API was never affected.

**`unknown[]` compiles from ArkType.** It writes a bare `{"type":"array"}` with no `items`, which was refused with `Arrays require an item schema`; Zod and Valibot write `items: {}` and compiled. Absent `items` leaves the elements unconstrained, which is what `any` already means here. That error message is gone.

**A union of literals compiles from Valibot.** Its branches carry a `const` and no `type`, and a branch's type was read from `type` alone. A `const` names its own JSON type, so it is now read from either — which also puts `v.nullable(v.literal("a"))` on the same nullable path Zod takes.

### Cost

179 gzip bytes on the `compile` row. `m` is unchanged, so the size comparison against other codecs does not move.

## 0.1.0

First release. The wire format is **not** frozen: payloads written by this version are
not guaranteed to decode under the next one, and the version stays below `1.0.0` until
it is. See [wire format](https://shorn.dev/wire-format/).

### What it does

Turns a Standard Schema you already have — Zod, Valibot, or ArkType — into a compact
binary codec, with `compile()`, `encode()`, `decode()`, and the `m` builders for
schema-less use. `fingerprinted()` adds a prefix that catches a structural mismatch
between writer and reader.

### Notable in this release

**`unchecked()`** — the same codec with the validator removed, for links where both ends
are yours and validation is work the process has already done. On the three-field person
fixture that is 2.3x encode and 3.7x decode. Bytes are identical, so a validated decoder
reads what an unchecked encoder wrote and a rollout can be gradual. Every structural
check survives — bounds, length limits, trailing-byte refusal — but transforms such as
`z.string().trim()` no longer run, and bytes written against a schema that differs only
in its refinements now decode silently. Keep the validated codec at any boundary you do
not own.

**`require("@chichurita/shorn")` resolves.** The `exports` map declared only an `import` condition,
so CommonJS callers were refused by the resolver before Node could decide whether it
could load an ES module. There is still no CommonJS build and no plan for one — Node
20.19+ and 22.12+ reach the ESM build through `require`, older versions get
`ERR_REQUIRE_ESM`, and `await import("@chichurita/shorn")` remains the portable form.

**Generated decoders for objects with optional fields**, rather than the interpreted
loop — 17% faster on a document-shaped payload. Three shapes stay interpreted because
they need `defineProperty`: a `__proto__` field, an open object, and an optional named
after an `Object.prototype` member.

**Strings decode through `Buffer.prototype.utf8Slice`** where it exists, which is ~45%
cheaper than `TextDecoder.decode` at every length measured. Malformed input still
throws: `utf8Slice` substitutes U+FFFD where the fatal decoder throws, so a result
containing U+FFFD is re-run through `TextDecoder`. Environments without the Node global
keep the `TextDecoder` path.

---

Detailed rationale and measurements for the four entries above were written as
changesets. They live in git at `1922796:.changeset/` — the last commit that carries
them, before changesets was removed.
