# Changelog

## 0.8.1

**Same bytes.** Every payload and fingerprint from 0.8.0 is unchanged. This release wins back a slowdown 0.8.0 shipped, and corrects its notes.

### `encodeInto` is as fast as in 0.7.3 again

0.8.0 made `encodeInto` about a third slower on a small frame: 24 ns to 37 ns for the Person fixture into a 64-byte frame. The 0.8.0 entry below says throughput did not regress, and for `encodeInto` that was wrong. The cost came from 0.8.0's fix that stopped a small view of a large buffer pinning the whole buffer. To decide that, `encodeInto` read `target.buffer` on every call, and for a small typed array V8 has to create an `ArrayBuffer` to answer. The decision is now made once, when a target first arrives, since a view's buffer never changes. The memory fix still holds: a 16-byte view of a 256 MB buffer is released once your code drops it.

### ArkType

- A bigint literal such as `type({ v: "1n" })` is refused as `ArkType's unit 1n has no JSON Schema form`, where 0.8.0 wrote `unit 1`.
- **Missing from 0.8.0's notes:** if you set ArkType's JSON Schema fallback globally, for instance `configure({ toJsonSchema: { fallback: { predicate: ctx => ctx.base } } })`, shorn's own fallback takes precedence for every constraint shorn has no hook for. A `.narrow()` field that compiled under 0.7.x with that setting is refused from 0.8.0 on. ArkType applies a library's `default` ahead of a global per-constraint setting, and shorn needs that `default` to refuse what ArkType 2.2.9 no longer does. Convert such a field at the edge.
- **0.8.0's notes overstated one item:** a `.narrow()` predicate and an intersection of two patterns would have round-tripped under ArkType 2.2.9. They stay refused because every earlier ArkType refused them. A symbol key behaved like the array with a property: encode succeeded and decode refused the bytes.

### Also missing from 0.8.0's notes

The published type declarations no longer list shorn's undocumented internal members: `_slots`, `_yieldsNull`, `_yieldsUndefined`, `_source`, `_structural`, `_failingChild` and the `FailingChild` interface. They are still there at runtime, but code that read them, or a subclass that overrode `_failingChild`, no longer typechecks. The members the `m` reference documents for subclassing (`_minWidth`, `_encode`, `_decode`, `Reader`, `Writer`) are unchanged. The entry points now carry hover documentation.

### Docs

The `unchecked()` speedup quoted on the validation and throughput pages was from before 0.8.0 made Zod-validated encode and decode 25 to 45% faster. It is now 1.7× on encode and 2.5× on decode, not 2.1× and 3.8×. `compile` is 12.64 KB gzip.

## 0.8.0

**Wire-breaking: every fingerprint moves, and some union shapes write new bytes.** A `fingerprinted()` payload stored under 0.7.x is not recognised by 0.8.0, at any width. Bare payloads, written without `fingerprinted()`, are unchanged except for the union shapes listed below. Pre-1.0, a wire change ships as a minor bump.

### Fingerprints

- **The hash is mixed before it is cut to width.** The low bits of the old FNV-1a hash ignored character order, so two schemas whose signatures differed only by a permutation (two fields swapping types, an `.optional()` moving from one field to another) agreed in their low three bits at every width. The hash now finishes with murmur3's `fmix32`. Every fingerprint changes; no payload byte does.
- **The default width is 4 bytes, not 3.** The envelope exists for stored data, and the docs already told you to pass `{ bytes: 4 }` for it. A codec that names its width is unaffected by this item, but still gets the new hash. The width is hashed in, so keep one width per registry.
- **A recursive type has one signature however it is spelled.** Mutually recursive types from Valibot, Zod objects declaring a mutual recursion in the other order, and recursion reached through an array used to carry a signature that depended on where the walk first entered the cycle. They now agree across Zod, Valibot and ArkType. Their bytes do not move. A document whose `$ref`s lead only to each other, such as `{"$ref":"#"}`, is now refused at compile instead of failing on first use.

### Union bytes

A union is now flattened before it is classified, so one union type has one wire shape whatever nesting the validator chose. Before this, Zod 4.4, Zod 4.5 and Valibot could write the same type differently, and neither payload decoded with the other's codec. These shapes write new bytes:

- a nullable union spelled nested: `v.nullable(v.union([a, b]))`, Zod's `.nullable()` on a union whose branch carries a keyword, and any nullable union from Zod 4.4. `string | number | null` now writes `"s"` as `02 01 73` rather than `01 01 01 73`.
- a literal union of mixed type, `z.union([z.literal("a"), z.literal(1)])`, and Valibot's mixed `v.picklist(["a", 1])`: now the enum `z.literal(["a", 1])` writes.
- a literal list holding `null`, `z.literal(["a", "b", null])`: now what `z.enum(["a", "b"]).nullable()` writes.
- a one-member enum, `z.enum(["a"])`: now zero bytes, like `z.literal("a")`. An array, Set or Map of one is therefore refused, as an array of a literal always was.
- a one-branch union, `v.union([v.string()])`: now the branch itself.
- `z.literal([true, false])`: same bytes, new fingerprint, as `boolean`.

Flat unions, `.nullable()` on one type, nullable enums, discriminated unions and enums of two or more members are unchanged byte for byte. Newly compiling: unions of same-type literals with or without `null`, ArkType's discriminated union `| null`, literals beside other types, and nested unions.

### Newly compiling

- **A field with a default.** `z.string().default("x")` and ArkType's `"string = 'x'"` used to be refused as having different input and output shapes. They now compile as an optional field, the shape Valibot's `v.optional(v.string(), "x")` already had, so all three write the same bytes and fingerprint.
- **The safe variants take a codec.** `safeEncode(fingerprinted(compile(S)), value)` and `safeDecode(codec, bytes)` work, as `encodeAsync` and `decodeAsync` already did.

### Behaviour changes

- **`safeEncode` and `safeDecode` throw for a broken schema.** A schema `compile()` refuses, or an argument that is not a schema, now throws from the first call instead of coming back as `{ success: false }`. A bad value or bad bytes is still a result. This is the line Zod's own `safeParse` draws.
- **Newly refused at compile**, each because it compiled to a codec that could not round-trip:
  - `z.codec()`, whose transform ran a second time on decode. A seconds-to-milliseconds codec came back a thousand times too large. Compile its wire side, and call `z.encode()` and `z.decode()` around it.
  - A Zod field named `__proto__`, which Zod 4.6's validator drops from every value.
  - `new OptionalSchema(new OptionalSchema(...))` and the nullable equivalent, which `.optional()` and `.nullable()` already refused.
  - An `m` container around a `compile()` codec whose empty-payload allocation passes the ceiling 0.3.0 set. The `compile()` codec now reports the bound its `unchecked()` half always did.
  - **ArkType 2.2.9**: `undefined`, a tuple with elements after a variadic one, a symbol key, an array carrying a property, and a `.narrow()` predicate. ArkType 2.2.9 stopped refusing these itself and described them partly, so each compiled to a codec that threw on every encode. The array with a property was worse: encode succeeded and dropped the property, and decode refused those bytes. shorn now refuses every ArkType constraint it has no hook for, on every supported ArkType version, with `ArkType's <code> has no JSON Schema form (shorn has no wire form for this value; convert it at the edge, see Rejected Shapes)`.

### Fixes, same bytes

- A string starting with U+FEFF decoded one character short wherever `TextDecoder` was used: browsers, workers and Deno for any such string, and Node when the string also held a U+FFFD.
- A Zod refinement that throws, under a sync entry point, no longer leaves an unhandled rejection that ends the Node process after the `EncodeError`.
- `EncodeError.path` names the value that actually failed. A validator failure takes its path from the validator's first issue and writes indexes as `tags[1]`, with no ` at ...` suffix. A container that refuses a value itself no longer blames a child.
- `decode` names what it was handed, `received ArrayBuffer` or `received null`, instead of `received object`.
- `encodeInto` with a Standard Schema throws an `EncodeError` naming the fix instead of `codec._encode is not a function`, and no longer keeps a large `ArrayBuffer` alive through a small view of it.
- `encode(schema, value)` types `value` as the validator's input, so a branded, coerced or defaulted field takes what the validator accepts.

### Cost

`compile` grows from 11.52 KB to 12.63 KB gzip, mostly from union flattening (264 B) and recursive-type minimization (494 B). The `m` bundle grows from 6.45 KB to 6.48 KB. Encode and decode throughput did not regress. The tested ArkType is now 2.2.9 and Zod 4.6.7.

## 0.7.3

**Same bytes, same code.** README only: the `require()` resolution note and the paragraph on what a fingerprint covers are gone from the README. Both still live in the docs, under [installation](https://shorn.dev/getting-started/installation/) and [fingerprinting](https://shorn.dev/versioning/fingerprinting/).

## 0.7.2

**Same bytes, same code.** `dist/` is identical to 0.7.1; this release exists so the package page on npm shows the current README.

### README

Rewritten in plainer English and shortened since 0.7.1, and the sentence on `require()` is back: there is no CommonJS build, `require("@chichurita/shorn")` reaches the ESM build from Node 20.19 and 22.12 on, and older versions need `await import()`. The `exports` map has offered the `require` condition since 0.1.0; the README stopped saying when it works.

### Behind the release

The publish workflow now runs every action from a pinned commit SHA and asserts the bundled npm supports trusted publishing instead of installing `npm@latest` right before publishing. CI additionally runs the suite against the latest Zod, Valibot and ArkType on every push, so a validator changing its JSON Schema output, as Zod 4.5 did, turns `main` red before it reaches a user. From this release on, each tag also appears on the GitHub Releases page with its changelog entry.

## 0.7.1

**Same bytes.** Every payload written by 0.7.0 decodes unchanged and no fingerprint moves. One schema shape that failed to compile now compiles.

### A JSON Schema `type` array is read as a union

Zod 4.5.0 changed how `toJSONSchema()` spells a union of bare types (colinhacks/zod#6339). `z.union([z.string(), z.number()])` and `z.string().nullable()` used to come out as `anyOf`; from 4.5 they come out as `type: ["string", "number"]` and `type: ["string", "null"]`. shorn only accepted the two-member nullable form of a `type` array, so a plain type-disjoint union from Zod 4.5 refused to compile with `Only nullable JSON Schema type arrays are currently supported`.

A `type` array is now expanded into one branch per member and read by the same rules as `anyOf` and `oneOf`. Both spellings give one wire shape and one fingerprint, so a codec built from Zod 4.4 and one built from Zod 4.5 read each other's bytes. A union no value can tell apart, such as `type: ["integer", "number"]`, is refused with the union message: `Only nullable, discriminated and type-disjoint JSON Schema unions are currently supported`. The type-array message is retired.

The `compile` bundle is 31 gzip bytes smaller. The test suite passes on Zod 4.4 and 4.5.4.

## 0.7.0

**Wire-breaking for one shape: a `format: "date-time"` string.** A schema holding `z.iso.datetime()`, or any JSON Schema string with that format, now writes different bytes and derives a different fingerprint. Payloads it wrote under 0.6.0 cannot be read by 0.7.0, and the reverse. Every other shape is unchanged. Pre-1.0, a wire change ships as a minor bump.

### `Date`, `bigint`, `Set` and `Map` encode natively

```ts
const Event = z.object({
  when: z.date(),
  id: z.bigint(),
  tags: z.set(z.string()),
  scores: z.map(z.string(), z.int()),
});
const codec = compile(Event);
codec.decode(codec.encode(value)); // a Date, a bigint, a Set and a Map come back
```

All four used to be refused, because JSON Schema has no keyword for them. They now have wire forms of their own, as `m.date()`, `m.bigint()`, `m.set(item)` and `m.map(key, value)`, and through `compile()`:

| Type | Bytes |
| --- | --- |
| `Date` | epoch milliseconds as a ZigZag varint, 6 bytes for any current date |
| `bigint` | a varint header (magnitude byte count doubled, plus the sign), then the magnitude little-endian |
| `Set<T>` | a varint count then the elements, exactly what `z.array(T)` writes |
| `Map<K, V>` | a varint count then each key followed by its value, exactly what an array of `[K, V]` tuples writes |

Set and Map keep iteration order. A Set and an array of the same element write identical bytes but carry different fingerprints, since they decode to different things. An Invalid Date is refused at encode. On decode, a duplicate Set element or Map key is refused, and so is `-0` in either position, because `Set.add` and `Map.set` would fold it into `+0` and the payload could not re-encode to itself.

Zod and ArkType need nothing beyond the schema: `z.date()`, `z.bigint()`, `z.set()`, `z.map()`, and ArkType's `Date` and `bigint`. ArkType's `Set` and `Map` keywords carry no element type and are refused. Valibot's Standard JSON Schema wrapper takes no options, so its four go through the raw converter and a new export:

```ts
import { toJsonSchema } from "@valibot/to-json-schema";
import { compile, valibotOverride } from "@chichurita/shorn";

const structure = toJsonSchema(Person, { overrideSchema: valibotOverride(toJsonSchema) });
const codec = compile(Person, structure);
```

`structure` now also accepts a plain JSON Schema document. The four types travel on shorn's own extension keyword, `x-shorn`, with values `date`, `bigint`, `set` and `map`; a hand-written document may carry it too. A recursive type reached through a Set or Map element is refused; hold the recursion in an array or an object instead.

### `date-time` strings take the Date form

The one change to existing bytes. A `date-time` string is stored as the instant it names, 6 bytes rather than 24 to 30 characters, and decodes back to the `toISOString()` spelling. Only that spelling is accepted at encode: epoch milliseconds cannot remember a fractional-digit count or an offset, so a string that would come back different is refused rather than silently normalized, the same rule uppercase UUIDs follow. `z.iso.date()` and `z.iso.time()` stay strings.

### What still needs the edge

`undefined`, `NaN` as a type, symbols, functions, transforms and class instances have no wire form and are refused at compile as before. Where a vendor's converter throws on its own, shorn appends `(shorn has no wire form for this value; convert it at the edge, see Rejected Shapes)`.

### Cost

The `m` bundle grows from 5,573 to 6,444 B gzip and now sits 9% above `@msgpack/msgpack` rather than under it. Four schema classes and the hex table `bigint` shares with UUIDs account for it. Throughput did not move; every existing size fixture is byte-identical.

## 0.6.0

**Same bytes, one new export.** Every payload written by 0.5.0 or earlier decodes unchanged and no fingerprint moves.

### `encodeInto(codec, value, target, offset?)`

```ts
const frame = new Uint8Array(65_536);
let end = 0;
for (const event of events) end = encodeInto(codec, event, frame, end);
socket.send(frame.subarray(0, end));
```

Writes the bytes `codec.encode(value)` would produce into a `Uint8Array` you own and returns the offset past the last one. It skips the output allocation and the copy that follows it, about 40% of a small encode: a Person goes from 48 ns to 23 ns, and a frame of 100 Persons builds in 40% of the time. Works with any codec from `compile()`, `fingerprinted()`, `unchecked()`, or `m`.

Use it in transports and frame builders. `encode()` stays the default. Decoding needs no counterpart because `decode()` already accepts `frame.subarray(start, end)`.

Throws `EncodeError`, with the field path, when the value does not fit, the offset is outside the target, or the target is not a `Uint8Array`. After a too-small target, bytes from the offset on are unspecified.

A free function rather than a method, so it tree-shakes: 185 gzip bytes if you import it, 12 on the `m` row if you do not.

## 0.5.0

**Same bytes, the `shorn` command is gone.** Every payload written by 0.4.x decodes unchanged, no fingerprint moves, and no library export changed. `dist/index.js` is byte-identical to 0.4.1's. The minor bump is because installing the package no longer installs a command.

0.4.0 shipped `shorn encode` and `shorn decode` as a `bin`. Both are removed, together with the second build that produced `dist/cli.mjs` and the CLI docs page. The command was a thin shell over `encode()` and `decode()`, and not worth a second build and a docs page to keep true.

A script that called `npx shorn` has two routes. Pin `@chichurita/shorn@0.4.1`, which keeps the command. Or replace the call with a small module of your own:

```js
// encode.mjs: JSON on stdin, bytes on stdout
import { encode } from "@chichurita/shorn";
import { Person } from "./person.mjs";
const json = await new Response(process.stdin).text();
process.stdout.write(encode(Person, JSON.parse(json)));
```

## 0.4.1

**Same bytes, faster in three places.** Every payload written by 0.4.0 decodes unchanged, no fingerprint moves, and no export changed. Every input that was accepted still is, and every input that was refused still is, with the same message except one retired varint message named below.

### ArkType and Valibot objects take the generated encoder

ArkType objects and Valibot's `v.object()` produce a JSON Schema with no `additionalProperties`, so shorn checks for unknown keys when it encodes. That check used to force the whole object onto the interpreted path, so the same eight bytes cost 94 ns from an ArkType schema against 48 ns from a Zod one. The scan for unknown keys now runs first and the generated function writes the fields. An ArkType person encodes 32% faster through `unchecked()`, an array of a hundred of them 42% faster, and a validated encode 23% faster. Zod objects were already generated. The refusal is unchanged: an unknown key throws `Unknown object property "x"`.

### UUIDs decode seven times faster

A `format: "uuid"` field decoded through `toString(16)` on four-byte words, about 600 ns per UUID. A 256-entry byte-to-hex table brings that to about 80 ns. The table is built by the first UUID decoded, so a bundle that imports only `m` does not carry it.

### Multi-byte integers decode faster

`Reader` had two varint loops in float arithmetic. They now share one integer-unit body behind the same one-byte fast path. Two-byte signed integers decode 12% faster, two-byte unsigned 11%, three-byte 8%, six-byte millisecond timestamps 19%, and the nested-event fixture 4%.

One message is retired: `Invalid or unsafe variable-length integer`. An unsigned varint past its cap now reports `Unexpected end of input` or `Invalid variable-length integer`. The set of accepted and refused inputs is identical.

### Cost

The `m` bundle grows by 22 gzip bytes, 5,539 to 5,561. `compile` is 2 bytes smaller. The footprint page had said the wire codec was 8% under `@msgpack/msgpack` gzipped since before 0.3.0; the correct figure for this build is 6%, and every published number was re-run.

## 0.4.0

**Same bytes, plus a `shorn` command.** Every payload written by 0.3.x decodes unchanged, no fingerprint moves, and no export changed. Installing the package now also installs a command. (Removed again in 0.5.0.)

```sh
$ echo '{"name":"Grace","age":45,"sex":"F"}' | npx shorn encode ./person.mjs --export Person --base64
LQVHcmFjZQA=
$ echo 'LQVHcmFjZQA=' | npx shorn decode ./person.mjs --export Person --base64
{"name":"Grace","age":45,"sex":"F"}
```

`encode` reads a JSON value on stdin and writes bytes on stdout, `decode` reverses it, and `--base64` puts text on the byte side of either. The module path is imported, so it can export a Zod schema, an ArkType type, or a codec from `compile()`, `fingerprinted()`, or `m`. Without `--export`, shorn takes the default export, or the only export when there is exactly one. Exit codes are 0 for success, 1 for a failure, and 2 for a bad command line. Arguments are parsed with `parseArgs` from `node:util`, so this adds no dependency.

`dist/index.js` is byte-identical to 0.3.0's. The CLI is built separately and imports the library at runtime, so importing shorn in an application costs what it did before.

## 0.3.0

**Same bytes, and one class of schema stops compiling.** Every payload written by 0.2.x decodes unchanged, no fingerprint moves, and no export changed. A shape that could allocate without bound from an empty payload is now refused when the codec is built, and one shape that used to be refused now compiles.

Found by a fuzzing pass over the JSON Schema translation: 60,000 generated schema documents crossed with generated values and byte mutations, plus a 200,000-case run aimed at the allocation bound below.

### An empty payload could exhaust memory and kill the process

An array whose count the schema fixes (`minItems` equal to `maxItems`) may hold a zero-width element, because its count comes from the schema rather than from the payload. Nothing bounded that count once it was nested, and nesting multiplies:

```ts
const bomb = z.array(z.array(z.array(z.literal("x")).length(1_000_000)).length(1_000_000)).length(1_000_000);
decode(bomb, new Uint8Array(0));  // 10^18 slots. Process gone.
```

There is no payload and no outer container to cap, so no caller could intervene, and the failure was an unrecoverable out-of-memory abort rather than a catchable error.

Codec construction now bounds the slots such a schema can fill from an empty payload, multiplied through nesting, at the same 1,000,000 collection limit a length varint has. One fixed array of a million literals still works. Two of them nested do not:

```
Array elements must occupy at least one byte, or a fixed count of them must stay under the collection limit
```

That message replaces the array-of-zero-width-elements refusal and covers both cases.

### A validator that throws escaped every entry point

A Standard Schema is expected to report problems as issues, but a `refine` whose body throws is all it takes to escape. That error came out of `encode`, `decode`, `encodeAsync` and `decodeAsync` unchanged, so `instanceof EncodeError` narrowing and the `safeEncode`/`safeDecode` error type fell through it.

A throw from the validator is now an `EncodeError` on the way in and a `DecodeError` on the way out, with `cause` set to the original. A thrown non-`Error` is reported as `The validator threw a value that is not an Error`. A getter or proxy trap of your own that throws while the encoder reads a property still propagates unchanged.

### `-0` silently became `0` through an enum

`m.enum([0, 1])` accepted `-0` and decoded it back as `0`. It is now refused with `Unknown enum value -0`, as `m.literal(0).encode(-0)` always was.

### A recursive nullable type did not compile

`T | null` where `T` is itself a recursive `T | null` failed with `This schema already decodes to null; wrapping it in nullable() would give null two encodings`, blaming a `.nullable()` the caller wrote for a marker shorn had added. The redundant marker now comes off. No fingerprint moves, since every schema this affected threw.

### Four refusals reported the wrong error

A message that quotes a value has to be able to print it. An object with a null prototype, an object whose `toString` throws, a `BigInt`, or a cycle replaced the `EncodeError` with a `TypeError`. `EncodeError` narrowing and `safeEncode` now hold for all of them.

| Where | Was | Now |
| --- | --- | --- |
| an unmatched enum value | `TypeError: Cannot convert object to primitive value` | `Unknown enum value object` |
| a malformed UUID | the same | `Expected a lowercase UUID, received object` |
| an unmatched union discriminant | `TypeError: Do not know how to serialize a BigInt` | `No union branch has "kind" = bigint` |
| an out-of-range `fingerprinted({ bytes })` | `TypeError` | `Fingerprint bytes must be 1, 2, 3 or 4, received object` |
| an unreadable `type` in a fetched JSON Schema | `TypeError` | `Unsupported Standard JSON Schema type object` |

### Docs corrections

A cached codec is built from the schema as it first read it. A hand-built Standard Schema that later reports a different structure keeps the old plan; Zod, Valibot and ArkType schemas are immutable, so this cannot happen with them. Now stated in [Compilation and Caching](https://shorn.dev/core-concepts/compile-and-caching/).

The documented schema depth limit was wrong. A deeply nested schema throws `RangeError` at about **1,400** levels through `compile()` and **1,600** through `m` on Node 22, not 5,900, and while the codec is built rather than while a payload is read.

### Cost

96 gzip bytes on the wire codec (`m`), 5,443 to 5,539, and 265 on the full export surface. Throughput did not move, and every payload-size row is byte-identical.

## 0.2.3

**Same bytes, smaller bundles.** Payloads written by 0.2.2 decode unchanged and no API changes.

Object codecs kept each field's key, schema and optional-bit position as named properties, which minifiers preserved. They are now tuples, so the emitted bundle carries positions instead of names. The wire codec (`m`) drops from 17,890 to 17,369 minified bytes (-2.9%) and from 5,514 to 5,443 gzip bytes (-1.3%). `compile + m` and the full export surface each drop about 1.7% minified.

## 0.2.2

**Same bytes, better errors.** Payloads written by 0.2.1 decode unchanged and no API changes.

### `EncodeError.path` reaches every value the encoder refuses

`path` names the value that failed. Three cases lost it, all where a validator passes the value and only the writer refuses it, such as a lone surrogate in a string or an oversized array:

- **An open object's extra keys.** A value refused among the keys the schema does not name reported no path, or the enclosing field. `{ id: "ok", note: "…lone surrogate" }` under `z.object({ id: z.string() }).catchall(z.string())` now reports `note`, and `o.note` when nested.
- **`optional()` and `nullable()` ended the walk.** `m.array(m.object({ a: m.string() }))` reported `[0].a`, and adding `.optional()` to the object stopped at `[0]`. Only array, tuple, record, and union elements were affected.
- **`m.uint()` and `m.int()` threw a raw `TypeError`** for a value JavaScript cannot coerce, such as a symbol or an object whose `valueOf` throws. They now throw `EncodeError` like every other leaf.

Three messages changed wording: `m.uint()` given `"5"` says `received string` where it said `received 5`, and given `null` says `received object`.

### Cost

399 minified bytes and 66 gzipped on the `compile` row. The wire codec (`m`) is unchanged gzipped, at 5,514 bytes.

## 0.2.1

**Same bytes, faster.** Payloads written by 0.2.0 decode unchanged and no API changes.

### Documents encode 68% faster and decode 60% faster

Document-shaped data, with many keys, optional fields, and mostly string content, was the shape shorn was slowest on. Three changes:

- **Objects with optional fields now build their encoder at construction.** Each optional's bit in the presence bitmap is fixed by the schema, so the bitmap is assembled from constants. Records with optional fields encode 2.2x faster; an array of them, 3.6x.
- **String encoding stopped measuring strings twice.** It walked every string once for its UTF-8 length and again to write it, when `TextEncoder` already reports the total. A 4.5 KB string now encodes about 17x faster, a 258-byte one 2.9x, and the Unicode benchmark fixture 65%.
- **String decoding stopped allocating a view of every string** before decoding it. A thousand short strings decode 75% faster.

### Cost

The wire codec (`m`) grows from 5.18 KB to 5.52 KB gzipped, which takes its lead over `@msgpack/msgpack` from 13% to 7%.

## 0.2.0

**Wire-breaking, one shape.** A recursive type reached through a wrapper, such as `z.object({ roots: z.array(Tree) })` rather than `Tree` itself, now derives the same fingerprint from every validator. Valibot's spelling of such a schema derived a different fingerprint from Zod's while writing byte-identical payloads, so `fingerprinted()` rejected payloads it could decode. Only Valibot's fingerprint for that shape moves, and no payload's bytes change. A `fingerprinted()` payload written by 0.1.0 against that shape under Valibot is refused by 0.2.0: re-encode it, or pin both ends.

### Every validator now agrees on every shape

Found by a cross-vendor fuzz matrix: about 65 wire shapes crossed with Zod, Valibot and ArkType, plus every truncation, trailing-byte, and byte-flip mutation of the payloads. The decoder held everywhere. Every fix is in the JSON Schema bridge.

- **A field named `__proto__` is refused instead of silently dropped.** No validator's JSON Schema can carry one, so the codec was built without the field and `unchecked()` lost the data with no error. Both spellings now throw `A "__proto__" property does not survive a JSON Schema; rename the field`. An optional `__proto__` under Zod leaves no trace in the emitted document and cannot be caught from here. The `m` API was never affected.
- **`unknown[]` compiles from ArkType.** It writes `{"type":"array"}` with no `items`, which was refused with `Arrays require an item schema`. Absent `items` now means `any`, as `items: {}` already did. That message is gone.
- **A union of literals compiles from Valibot.** Its branches carry a `const` and no `type`. A `const` names its own JSON type, so the type is now read from either.

### Cost

179 gzip bytes on the `compile` row. `m` is unchanged.

## 0.1.0

First release. The wire format is **not** frozen: payloads written by this version are not guaranteed to decode under the next one, and the version stays below `1.0.0` until it is. See [wire format](https://shorn.dev/wire-format/).

Turns a Standard Schema you already have (Zod, Valibot, or ArkType) into a compact binary codec, with `compile()`, `encode()`, `decode()`, and the `m` builders for schema-less use. `fingerprinted()` adds a prefix that catches a structural mismatch between writer and reader.

- **`unchecked()`** returns the same codec with the validator removed, for links where both ends are yours. On the three-field person fixture that is 2.3x on encode and 3.7x on decode. Bytes are identical, so a validated decoder reads what an unchecked encoder wrote. Every structural check survives, but transforms such as `z.string().trim()` no longer run, and bytes written against a schema that differs only in its refinements decode silently. Keep the validated codec at any boundary you do not own.
- **`require("@chichurita/shorn")` resolves.** The `exports` map declared only an `import` condition. There is still no CommonJS build: Node 20.19+ and 22.12+ reach the ESM build through `require`, older versions get `ERR_REQUIRE_ESM`, and `await import("@chichurita/shorn")` remains the portable form.
- **Generated decoders for objects with optional fields**, 17% faster on a document-shaped payload. A `__proto__` field, an open object, and an optional named after an `Object.prototype` member stay on the interpreted path.
- **Strings decode through `Buffer.prototype.utf8Slice`** where it exists, about 45% cheaper than `TextDecoder.decode`. Malformed input still throws: a result containing U+FFFD is re-checked with the strict decoder.

Detailed rationale for these entries was written as changesets. They live in git at `1922796:.changeset/`, the last commit that carries them.
