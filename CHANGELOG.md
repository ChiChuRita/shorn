# Changelog

## 0.5.0

**Same bytes, one command fewer.** Every payload written by 0.4.x decodes unchanged, every fingerprint is the one it was, and no library export changed shape. `dist/index.js` is byte-identical to 0.4.1's, and every size and bundle row of the regression gate reads +0.0%. The minor bump is for a surface removed beside the library rather than anything altered inside it: installing the package no longer installs a command.

### The `shorn` command is gone

0.4.0 shipped `shorn encode` and `shorn decode` as a `bin` in the package. Both are removed, together with the `bin` field, the second build that produced `dist/cli.mjs`, and the CLI page of the docs. The command was a thin shell over `encode()` and `decode()`: import a module, pick an export, JSON on one side and bytes on the other. That is a few lines against the library for any given schema module, and not a surface worth a second build, a manifest field, and a docs page to keep true.

A script that called `npx shorn` has two routes. Pin `@chichurita/shorn@0.4.1`, which keeps the command as it was. Or replace the call with a module of your own, which also spares the import-and-pick-an-export step because it names the schema directly:

```js
// encode.mjs: JSON on stdin, bytes on stdout
import { encode } from "@chichurita/shorn";
import { Person } from "./person.mjs";
const json = await new Response(process.stdin).text();
process.stdout.write(encode(Person, JSON.parse(json)));
```

### The library is untouched

No source under `src/` other than the two CLI files changed, no export was added or removed, and the package is still ESM only on Node 20 or newer. Nothing a program that imports shorn does is different.

## 0.4.1

**Same bytes, faster in three places.** Every payload written by 0.4.0 decodes unchanged, every fingerprint is the one it was, and no export changed shape. The patch is in how the codec runs, not in what it writes: every input that encoded or decoded before still does, to the same bytes and the same value, and every input that was refused is refused with the same message, except one retired varint message named below. Figures are medians over five separate processes against the 0.4.0 build on the same machine; the regression gate read no row outside its tolerance.

### ArkType and Valibot objects take the generated encoder

Every ArkType object and Valibot's `v.object()` produce a JSON Schema with no `additionalProperties`, so shorn checks for unknown keys when it encodes. That check used to keep the whole object on the interpreted field loop, and the same eight bytes cost 94 ns from an ArkType schema against 48 ns from a Zod one, whose schema says `additionalProperties: false`. The scan for unknown keys now runs first and the generated function writes the fields. An ArkType person encodes 32% faster through `unchecked()`, an array of a hundred of them 42% faster, and a validated encode 23% faster. Zod objects were already generated and do not move. The refusal is the same: an unknown key throws `Unknown object property "x"` before a field is written.

### UUIDs decode seven times faster

A `format: "uuid"` field decoded through `toString(16)` on four-byte words. Those words are heap numbers, V8's radix conversion for them is slow, and it was the whole cost: about 600 ns per UUID. A 256-entry byte-to-hex table brings that to about 80 ns for the same lowercase, dashed string. The table is built by the first UUID decoded, so a bundle that imports only `m`, which cannot build a UUID schema, does not carry it. Encode was already fast and is untouched.

### Multi-byte integers decode on the integer unit

`Reader` had two varint loops, one for unsigned values and one for the ZigZag path signed integers take, both in float arithmetic with a `Number.isSafeInteger` per byte, and only the unsigned one had an inline one-byte fast path. They now share one slow body behind the same fast path. Bytes one to four land in one 32-bit register and five to eight in a second, combined once; a value past 2^53 or an encoding past eight bytes goes to a separate BigInt tail. Two-byte signed integers decode 12% faster, two-byte unsigned 11%, three-byte 8%, six-byte millisecond timestamps 19%, and the nested-event fixture 4%. The regression gate, a different harness, read the 500-timestamp row 22% up and nested decode 8% up.

Two shapes that look the same are cliffs, and the source now says so: a shared body that keeps its BigInt code inline runs 3x slower on two- and three-byte values, and an integer-unit signed reader without the inline one-byte path runs 2x slower on small ones. Both are the inlining-budget behaviour the float reader already documents.

One message is retired: `Invalid or unsafe variable-length integer`. An unsigned varint past its cap now reports `Unexpected end of input` or `Invalid variable-length integer`, at an offset inside the input. The set of accepted and refused inputs is identical.

### What it costs, and what was measured and not shipped

The `m` bundle row grows by 22 gzip bytes as the regression gate measures it, 5,539 to 5,561, 21 of them the varint reader. `compile` is 2 bytes smaller. The wire codec is 6% under `@msgpack/msgpack` gzipped; the footprint page had said 8% since before 0.3.0 and is corrected, with every other published number, from one run of this build.

Removing the `finally` that releases the pooled `Writer` in `Schema.encode` measured 10% on a person encode as a prototype and 0% once `finish()` was kept inside the `try`, where it has to be so that an allocation failure still releases the pool. It stays as it was, and two tests now pin the release after a throwing encode so the next attempt starts from the constraint. A CPU profile of a person encode puts the output allocation in `finish()` at a third of the time, more than every `Writer` leaf call together.

The throughput tables read lower on person encode than the 0.4.0 tables, 21.0M against 25.1M. The gate puts this build within noise of the recorded baseline on that row, and a control run of the unchanged 0.4.0 tree on the same day read 15% under its own recording; each table is one run of one build, and no row is carried over.

## 0.4.0

**Same bytes, and a second way to reach them.** Every payload written by 0.3.x decodes unchanged, every fingerprint is the one it was, and no export changed shape. The minor bump is for a surface added beside the library rather than anything altered inside it: installing the package now also installs a command.

### A `shorn` command, for a shell instead of a module

```sh
$ echo '{"name":"Grace","age":45,"sex":"F"}' | npx shorn encode ./person.mjs --export Person --base64
LQVHcmFjZQA=
$ echo 'LQVHcmFjZQA=' | npx shorn decode ./person.mjs --export Person --base64
{"name":"Grace","age":45,"sex":"F"}
```

`encode` reads a JSON value on stdin and writes the encoded bytes on stdout, `decode` reverses it, and `--base64` puts text on the byte side of either so a payload can travel through a pipe you can read. The module path is imported, so it can export a Zod schema, an ArkType type, or a codec built by `compile()`, `fingerprinted()`, or `m`. Without `--export`, shorn takes the default export, or the only export when there is exactly one, and otherwise names what the module does export and stops.

Errors are one line on stderr. The exit code is 0 for success, 1 for a failure, and 2 for a command line shorn could not read, so a script can tell a bad payload apart from a bad invocation. `shorn --help` lists every flag.

The point is scripting: a shell, a Makefile, or an agent driving a terminal can now produce and read payloads without writing an integration first. Arguments are parsed by `parseArgs` from `node:util`, so this adds no dependency.

### The library is untouched by it

`dist/index.js` comes out byte-identical to 0.3.0's, and the bundle-size rows of the regression gate are unmoved. The CLI is built separately and imports the library at runtime rather than inlining it, so importing shorn in an application costs exactly what it did before. The only new field in the manifest is `bin`.

Full reference on the [CLI page](https://shorn.dev/cli/).

## 0.3.0

**Same bytes, and one class of schema stops compiling.** Every payload written by 0.2.x decodes unchanged, every fingerprint is the one it was, and no export changed shape — the byte-layout rows of the regression gate and the golden vectors are identical, and 8,000 generated schemas encode to the same bytes as before. The minor bump is for schemas, not payloads: a shape that could allocate unboundedly from an empty payload is now refused when the codec is built, and one that used to be refused now compiles.

Found by a fuzzing pass over the JSON Schema translation — 60,000 generated schema documents crossed with generated values, byte mutations and arbitrary bytes, plus every schema shape crossed with a pool of hostile values, and a separate 200,000-case run aimed at the allocation bound below.

### An empty payload could exhaust memory and kill the process

An array whose count the schema fixes (`minItems` equal to `maxItems`) may hold a zero-width element — a literal, an empty tuple, an empty object — because its count comes from the schema rather than from the payload. Nothing bounded that count once it was nested, and nesting multiplies:

```ts
const bomb = z.array(z.array(z.array(z.literal("x")).length(1_000_000)).length(1_000_000)).length(1_000_000);
decode(bomb, new Uint8Array(0));  // 10^18 slots. Process gone.
```

This was **not** the documented exemption, which needed a variable-length outer container and told you to cap it yourself. Here there is no payload and no outer container to cap, so no caller could intervene, and the failure was an unrecoverable out-of-memory abort rather than a catchable error.

Codec construction now bounds the slots such a schema can fill from no input — multiplied through nesting, summed through zero-width objects and tuples — at the same 1,000,000 collection limit a length varint answers to. One fixed array of a million literals still works. Two of them nested do not:

```
Array elements must occupy at least one byte, or a fixed count of them must stay under the collection limit
```

That message replaces the array-of-zero-width-elements refusal and now covers both cases, since both come of an element that costs nothing. What counts as zero-width moved into the [error reference](https://shorn.dev/api/errors/).

The bound needed two attempts. The first counted a tuple's items but not the tuple's own array, so `m.array(m.tuple([m.literal(true)]), 999_999)` passed the guard and then allocated *twice* the ceiling — 999,999 outer slots plus one array per tuple. Found by fuzzing the bound itself over 200,000 schemas rather than by re-reading it.

### A validator that throws escaped every entry point

A Standard Schema is expected to report problems as issues, but nothing stops one throwing — `z.int().refine((v) => { … })` whose body throws is all it takes. That error came out of `encode`, `decode`, `encodeAsync` and `decodeAsync` unchanged: a `RangeError` from functions documented to throw only `EncodeError` and `DecodeError`, so `instanceof` narrowing and the `safeEncode`/`safeDecode` error type all fell through it. The async pair are reachable from an ordinary zod schema.

A throw from the validator is now an `EncodeError` on the way in and a `DecodeError` on the way out, with `cause` set to the original and a thrown non-`Error` reported as `The validator threw a value that is not an Error`. A getter or proxy trap of your own that throws while the encoder reads a property still propagates unchanged — only the validator's own call is wrapped, because that is the only layer that knows a validator ran.

### `-0` silently became `0` through an enum

`m.enum([0, 1])` accepted `-0` and decoded it back as `0`, with nothing on either side reporting it. A `Map` keys by SameValueZero, so `-0` found the `0` member and went out as that member's index. `m.literal(0).encode(-0)` has always been refused for exactly this reason; the enum now agrees, with `Unknown enum value -0`.

### A recursive nullable type did not compile

`T | null` where `T` is itself a recursive `T | null` failed to build:

```
This schema already decodes to null; wrapping it in nullable() would give null two encodings
```

The message blamed a `.nullable()` the caller had written for a marker shorn had added. Whether a cycle admits `null` cannot be answered while the cycle is still being built, so the redundant marker went on and was then refused. It now comes off where the definition table exists — which is also where the signature is taken, so the bytes and the fingerprint still agree. No fingerprint moves: every schema this affected threw, so none has payloads.

### Four refusals reported the wrong error

A message that quotes a value has to be able to print it. These interpolated values the schema does not constrain to a primitive, so an object with a null prototype, an object whose `toString` or `toJSON` throws, a `BigInt`, or a cycle replaced the `EncodeError` with a `TypeError` of its own — and told the caller about their getter instead of about their field. `EncodeError` narrowing and `safeEncode` now hold for all of them.

| Where | Was | Now |
| --- | --- | --- |
| an unmatched enum value | `TypeError: Cannot convert object to primitive value` | `Unknown enum value object` |
| a malformed UUID | the same | `Expected a lowercase UUID, received object` |
| an unmatched union discriminant | `TypeError: Do not know how to serialize a BigInt` | `No union branch has "kind" = bigint` |
| an out-of-range `fingerprinted({ bytes })` | `TypeError` | `Fingerprint bytes must be 1, 2, 3 or 4, received object` |
| an unreadable `type` in a fetched JSON Schema | `TypeError` | `Unsupported Standard JSON Schema type object` |

This is the rule `m.uint()` and `m.int()` adopted in 0.2.2, applied to the rest. A getter or proxy trap of your own that throws while the encoder reads a property still propagates unchanged — swallowing it would report a wrong field instead of the real fault.

### Documented: a cached codec is built from the schema as it first read

`compile`, `encode` and `decode` derive the wire plan once per schema object and never ask again, so a hand-built Standard Schema that reports a *different* structure later keeps the old plan and encodes to the old shape silently. This is a property of the cache rather than something shorn can check — re-deriving the JSON Schema to compare it is the entire cost the cache exists to remove — and it cannot arise from Zod, Valibot or ArkType, whose schemas are immutable. Now stated in [Compilation and Caching](https://shorn.dev/core-concepts/compile-and-caching/): treat a hand-built schema as frozen once encoded.

### Corrected: the documented schema depth limit

The docs said a schema nested about 5,900 levels deep throws `RangeError` instead of `DecodeError`. Re-measured on Node 22: it is about **1,400** levels through `compile()` and **1,600** through `m`, and it is thrown while the codec is being built rather than while a payload is read. The boundary is unchanged; only the number was wrong. A depth budget is still [on the roadmap](https://shorn.dev/hostile-input/).

### Cost

**96 gzip bytes on the wire codec (`m`)** — 5,443 → 5,539 — and 265 on the full export surface, over the 1% bundle gate. It was 175 on `m` before trimming: one shared message replaced two (56 bytes), the sentence naming the three zero-width shapes moved to the docs (28), and a `try`/`catch` gave way to a `typeof` gate (28). The remainder is the slot counter and its propagation through objects and tuples, which is what makes the bound sound rather than local, plus 7 bytes for a tuple's own array. Wrapping the validator's throw costs nothing in `m`, which has no validator to wrap.

Throughput did not move. The `-0` guard leads with `value === 0` so the comparison short-circuits before the call; checking the enum member instead measured **-12%** on the unchecked person fixture and was dropped. Every payload-size row is byte-identical, and the hostile-input, startup and memory gates report no regressions.

## 0.2.3

**Same bytes, smaller bundles.** Nothing on the wire moves and no API changes; payloads written by 0.2.2 decode unchanged and vice versa. If you store or queue shorn payloads, this upgrade needs nothing from you.

### Private structure no longer ships as public-sized names

Object codecs kept each field's key, schema and optional-bit position in an object. Those properties are private to shorn, but JavaScript minifiers cannot prove that and preserved their names in every bundle. They are now labeled readonly tuples: the source still destructures them as `key`, `schema` and `optionalIndex`, while the emitted bundle carries positions instead of names. The same compact return shape is used by record code generation and async validation.

The encode entry point now shares one pooled and re-entrant control path instead of duplicating the whole operation, and recursive definition folding no longer creates a closure at every visited node. Private `ObjectSchema` fields were also renamed around what they mean — `encoder`, `knownKeys`, `rejectUnknown` — rather than how they happened to be implemented.

### Bundle reduction

The wire codec (`m`) drops **17,890 → 17,369 minified bytes (−2.9%)** and **5,514 → 5,443 gzip bytes (−1.3%)**. `compile + m` drops 1.7% minified and 0.8% gzip; the full export surface drops 1.7% minified and 0.7% gzip. No feature was removed, every payload-size regression row is byte-identical, and the throughput, hostile-input, startup and memory gates report no regressions.

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
