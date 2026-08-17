# Changelog

## 0.2.2

**Same bytes, better errors.** Nothing on the wire moves and no API changes; payloads written by 0.2.1 decode unchanged and vice versa. If you store or queue shorn payloads, this upgrade needs nothing from you.

### `EncodeError.path` reaches every value the encoder refuses

`path` names the value that failed and is documented as absent only when no single field is at fault. Three cases broke that, and all three are cases where a validator passes the value and only the writer refuses it — a lone surrogate in a string, an oversized array, a value the schema cannot hold. With a plain type error the vendor's own issue path covered the gap.

**An open object's extra keys were outside the walk.** A value refused among the keys the schema does not name reported no path at all, and one level down reported the enclosing field — pointing you at a value that was fine. `{ id: "ok", note: "…lone surrogate" }` under `z.object({ id: z.string() }).catchall(z.string())` now reports `note`, and `o.note` when nested.

**`optional()` and `nullable()` ended the walk.** The same schema reported `[0].a` in one position and `[0]` in another: `m.array(m.object({ a: m.string() }))` named the field, and adding `.optional()` to that object stopped at the index. Inside an object schema the wrapper was already invisible, because the object unwraps an optional when it is built, so this only ever affected an array, tuple, record, or union element.

**`m.uint()` and `m.int()` threw a raw `TypeError`.** For a value JavaScript declines to coerce — a symbol, or an object whose `valueOf` or `Symbol.toPrimitive` throws — the error escaping was a `TypeError` with no path, not the `EncodeError` every other leaf throws and every other leaf documents. A caller narrowing on `EncodeError` fell through it. Neither cause was a missing type check: the fast path compared the value before the predicate that would have answered safely, and the message meant to explain the refusal interpolated a value that cannot be interpolated.

Three messages moved for values that were already refused as `EncodeError`. `m.uint()` given `"5"` says `received string` where it said `received 5`, and given `null` says `received object`, matching `Expected a Uint8Array, received …` beside it.

### Cost

399 minified bytes and 66 gzipped on the `compile` row. The wire codec (`m`) is **unchanged gzipped** — 5514 bytes before and after — because moving the open-object walk off `ObjectSchema` and onto a shape only the Standard Schema bridge builds took 14 gzip bytes back out of `m`, and the numeric guard put the same 14 back. `m` cannot build an open object, so a branch there would have charged every wire-codec bundle for a path it can never take.

Two cheaper shapes of the numeric guard were measured and dropped: both moved it into `Writer.varuint`, saving 45 and 65 minified bytes, and both cost 2-4% on multi-byte integers, where the leaf costs 1%. Every other caller of that writer hands it a number it computed itself.

## 0.2.1

**Same bytes, faster.** Nothing on the wire moves and no API changes; payloads written by 0.2.0 decode unchanged and vice versa. If you store or queue shorn payloads, this upgrade needs nothing from you.

### Documents encode 68% faster and decode 60% faster

Document-shaped data — many keys, optional fields, most of the payload being string content — was the shape shorn was slowest on, and it moved for three reasons.

**Objects with optional fields now build their encoder at construction**, as objects without them already did. Which fields arrive varies per payload, but each optional's bit in the presence bitmap is fixed by the schema, so the bitmap is assembled from constants instead of allocating a byte array and a parallel value array on every encode. Records with optional fields encode 2.2x faster; an array of them, 3.6x.

**String encoding stopped measuring strings twice.** It walked every string once to total its UTF-8 length and again to write the bytes, when `TextEncoder` already reports the total. That walk was 85% of the cost of encoding a 256-byte ASCII string and 99% at 64 KB. A 4.5 KB string now encodes about 17x faster, a 258-byte one 2.9x, and the Unicode benchmark fixture 65%.

**String decoding stopped allocating a view of every string** before handing it to the decoder, which accepts offsets directly. A thousand short strings decode 75% faster. On the Unicode fixture this closes most of a gap against Avro that used to be 19%.

### Bundle cost

The wire codec (`m`) grows 5.18 KB → 5.52 KB gzipped, which takes its lead over `@msgpack/msgpack` from 13% to 7%. That is the number that got worse, and it is stated in [footprint](https://shorn.dev/performance/footprint/) rather than left for you to find. A fourth optimization worth 2x on short non-ASCII strings was measured, priced at a further 238 gzip bytes, and dropped as not worth it.

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
