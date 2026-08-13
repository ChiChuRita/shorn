# Changelog

## 0.0.1 — unreleased

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
