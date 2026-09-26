---
title: Errors
description: EncodeError, DecodeError, and what every message you can hit means.
---

shorn throws two error classes. `EncodeError` covers everything that fails on the way in, including a schema shorn cannot encode. `DecodeError` covers everything that fails on the way out. This page lists every message and its cause.

```ts
class EncodeError extends Error {
  readonly path?: string
  readonly issues?: readonly StandardSchemaV1.Issue[]
}
class DecodeError extends Error {
  readonly offset: number
  readonly issues?: readonly StandardSchemaV1.Issue[]
}
```

| Error | Thrown when |
| --- | --- |
| `EncodeError` | validation failed on the way in, or the schema cannot be encoded |
| `DecodeError` | the bytes are malformed, or validation failed on the way out |

`DecodeError.offset` is the byte position the decoder had reached. For a validation failure it equals the payload length, because structural decoding has to consume every byte before validation runs. Every `DecodeError` message already ends with ` at byte N` for that position, so the decode messages below are listed without it.

```ts
try {
  decode(Person, bytes);
} catch (error) {
  if (error instanceof DecodeError) {
    console.error(`bad payload: ${error.message}`);
  }
}
```

To avoid exceptions for bad input, use `safeDecode`. It returns either `{ success: true, data }` or `{ success: false, error }`, and wraps anything thrown that is not already an `Error`. A schema shorn cannot compile, or an argument that is not a schema, still throws from the first call: that is a bug in the program rather than in the input, and a failed result would read as the caller's fault.

## Locating the failure

`EncodeError.path` names the value that failed, as `user.address.zip` or `tags[3]`. It is absent when the value as a whole was refused, for example an array passed where an object was expected.

- When the validator refused the value, `path` is the first issue's path, and `message` starts each issue with its own path: `tags[1]: Invalid input: expected string, received number`.
- When the validator passed the value and the encoder refused it, as it does a lone surrogate or an array over the size limit, the path is appended to `message`: `String contains an unpaired surrogate at user.note`. The same holds for everything the `m` API and `unchecked()` refuse.

```ts
try {
  encode(Person, person);
} catch (error) {
  if (error instanceof EncodeError) console.error(error.path); // "address.zip"
}
```

`issues` is set when a validator rejected the value. It holds the validator's own [Standard Schema issues](https://standardschema.dev) rather than the `; `-joined summary in `message`. Use it to build a field-keyed response without running the validator a second time. A `DecodeError` from a failed validation carries the same array. A path segment can be a key or a `{ key }` object, which is what Valibot writes, so read `key` off it:

```ts
const result = safeDecode(Person, bytes);
if (!result.success && result.error instanceof DecodeError) {
  const fields = result.error.issues?.map((issue) =>
    issue.path?.map((segment) => (typeof segment === "object" ? segment.key : segment)).join("."),
  );
  return Response.json({ fields }, { status: 422 });
}
```

Errors that wrap another error set `cause`: a validation failure rethrown as a `DecodeError`, a refusal from a validator's own JSON Schema conversion, and an invalid UTF-8 read.

## Schema-construction errors

All of these are `EncodeError` instances thrown when the codec is built. See [Rejected shapes](/schemas/rejected-shapes/) for what to do about each one.

| Message | Cause |
| --- | --- |
| `Only nullable, discriminated and type-disjoint JSON Schema unions are currently supported; give the branches one property that is a distinct const in each, or make no two branches share a JSON type` | a union with two branches of one JSON type, at least one of them not a literal, and no property that is a distinct `const` in every branch, whether written as `anyOf`, `oneOf` or a `type` array, and at any depth of nesting |
| `Empty enums are unsupported` | an enum with no members |
| `Enum values must be unique` | `m.enum` given the same member twice. `compile()` drops a member that a JSON Schema `enum` repeats instead |
| `Enum member … has no JSON text of its own` | `NaN`, an infinity or `-0` in a mixed enum. None of the four survives the JSON text a mixed enum is ordered by |
| `Invalid fixed array length X` | `minItems === maxItems` outside 0 to 1,000,000 |
| `Array elements must occupy at least one byte, or a fixed count of them must stay under the collection limit` | an array of zero-width elements: a literal (a one-member enum is one), an empty tuple, an empty object, or an object or tuple built only from those. A variable count can never be checked against the payload. A fixed count can be, but only up to 1,000,000 elements in total across nesting, since a fixed count needs no payload at all to satisfy |
| `Set elements must occupy at least one byte` | the same for a Set, which has no fixed-count form to exempt |
| `Map entries must occupy at least one byte` | the same for a Map, counting key and value together |
| `Unsupported JSON Schema literal` | a literal that is not a string, number, boolean, or null |
| `Unsupported Standard JSON Schema type X` | a type with no wire shape. `X` is the type keyword, or `object` when the document put an object there |
| `Unsupported Standard JSON Schema node` | a non-object node where a schema was expected, or `$ref`s that lead only to each other, such as `{ "$ref": "#" }` alone |
| `Unsupported JSON Schema reference "…"; only same-document references are supported` | a `$ref` naming another document |
| `JSON Schema reference "…" does not resolve` | a `$ref` whose pointer names nothing in the document |
| `Unsupported JSON Schema combinator X` | `allOf`, an intersection the validator did not merge into one schema, or `not` (`z.never()`) |
| `Unsupported x-shorn kind X` | shorn's own keyword carrying anything but `date`, `bigint`, `set` or `map`. `X` is the value, or its type when it is not a string |
| `A recursive type inside a Set or Map is not supported; hold the recursion in an array or an object instead` | a cycle reached through a Set element or a Map key or value. That child is converted as a document of its own, so a `$ref` in it would resolve against the root instead |
| `A Set or Map element has no Standard JSON Schema of its own` | a Set or Map whose element is not a schema shorn can convert on its own |
| `ArkType's Set carries no element type, so there is nothing to encode its members as; convert it at the edge` | ArkType's `Set` or `Map` keyword. Neither names the type of its members, and a format without type tags writes members and nothing else |
| `X cannot be represented in JSON Schema` | a Zod or ArkType type with no wire form: `undefined`, `void`, `symbol`, `nan`, `custom`, `function`, `transform`, and ArkType protos such as `RegExp` or `URL`. `X` is the validator's own name for it |
| `encodeInto() takes a codec, not a schema` | a Standard Schema passed to `encodeInto()`, which writes with a codec it is handed rather than compiling one. Pass it `compile(schema)` |
| `A z.codec() would transform twice; compile its wire side instead` | a `z.codec()` anywhere in a schema passed to `compile()`. shorn validates on both sides, so decode would run the codec's forward transform a second time. Compile the wire side and call `z.encode()` and `z.decode()` around it |
| `A literal undefined or bigint cannot be represented in JSON Schema` | `z.literal(undefined)` or `z.literal(1n)`. Zod would drop the first member and write the second as a number, so either would decode to a different value than was declared |
| `Expected a Standard Schema (zod, valibot, arktype), received X` | a first argument that is not a Standard Schema. `decode` throws this `EncodeError` too. `X` is `a shorn schema: already a codec, call encode/decode on it directly` for an `m` schema or a codec, `a raw JSON Schema: wrap it in a validator` for an object with a `type` or `$schema`, and otherwise `null` or the value's type |
| `The second argument must be a Standard JSON Schema implementation (toStandardJsonSchema(schema) for Valibot) or a JSON Schema document` | a `structure` that is neither. A plain object counts as a document when it has `$schema`, `$ref`, `type`, `anyOf`, `oneOf`, `const`, `enum`, `properties` or `x-shorn`. A validator passed twice, or a structure wrapped in `{ structure }`, has none of those |
| `Required property "x" has no schema` | `required` names a property that is missing from `properties` |
| `A "__proto__" property does not survive a JSON Schema; rename the field` | a field named `__proto__` in a Zod or Valibot schema. Valibot's converter sets the prototype of `properties` with the key instead of adding the field, and Zod's validator drops the key from every value it returns, so no value could reach the encoder with it. A hand-written JSON Schema document paired with a validator that keeps the key is accepted |
| `Schemas with different input and output wire shapes require a bidirectional codec and are not yet supported` | the two sides differ by more than a default: a pipe into a narrower wire type such as `z.string().pipe(z.uuid())`, or an ArkType morph from a numeric string to a number. A default alone compiles, as an optional field |
| `Standard Schema provides validation but not structure; pass a Standard JSON Schema implementation as the second argument` | Valibot, Zod before 4.2, ArkType before 2.1.28 |
| `This schema already decodes to null; wrapping it in nullable() would give null two encodings` | `m.literal(null).nullable()`, or a second null marker over one already reachable. Never from a validator schema: `compile()` drops a redundant wrapper instead of reaching this |
| `This schema already decodes to undefined; wrapping it in optional() would give undefined two encodings` | a second presence marker over one already reachable |
| `fingerprinted() needs a codec built from a Standard JSON Schema; compile() returns one, the low-level m API does not` | `fingerprinted(m.object(...))` |
| `Fingerprint bytes must be 1, 2, 3 or 4, received X` | an out-of-range `bytes` option. `X` is the value, or its type when the value is neither a number nor a string |
| `unchecked() needs a codec with a validator to remove; compile() returns one, optionally wrapped by fingerprinted(), and the low-level m API is already unvalidated` | `unchecked(m.object(...))`, or `unchecked(compile(schema).nullable())` |

### Values with no wire form

```text
<the vendor's own message> (shorn has no wire form for this value; convert it at
the edge, see Rejected Shapes)
```

shorn adds this suffix when a validator's own conversion throws, so the reason stays the validator's and the remedy is shorn's. In practice that means Valibot's converter (`v.undefined()`, a `v.transform`, and `v.date()`, `v.bigint()`, `v.set()` or `v.map()` without the [`valibotOverride` recipe](/validators/valibot/#rich-types)), and an ArkType constraint shorn has no hook for, such as the predicate behind `"string.date"`.

A refusal that is shorn's own carries no suffix, because it already says what to do. Zod's refusals are all in that group: `undefined cannot be represented in JSON Schema` and its siblings come from shorn's conversion hook, not from Zod.

`Date`, `bigint`, `Map`, `Set` and `date-time` strings are [supported](/schemas/rich-types/). What has no wire form is `undefined`, `void`, `nan`, symbols, functions, `custom` types and transforms.

### Async validation on a sync entry point

```text
This Standard Schema validates asynchronously; use encodeAsync/decodeAsync,
which accept either this schema or a codec built from it.
```

Every codec that reaches this error can follow the remedy, fingerprinted ones included. The message can also mean a Zod refinement threw: Zod answers with a Promise whenever one does, so a synchronous schema lands here too. `encodeAsync` then reports the refinement's own error, with the original as `cause`.

A codec with no validator at all gets a different message:

```text
This codec has no validator to await; async validation needs a codec from
compile(), optionally wrapped by fingerprinted()
```

## Encode-time value errors

| Message | Cause |
| --- | --- |
| `Unknown object property "x"` | an extra property where the validator left `additionalProperties` out and let the property through: ArkType by default, and Valibot's `looseObject`. Valibot's `object` strips extras first, so it reaches this only through `unchecked()` |
| `Expected a lowercase UUID, received X` | an uppercase or malformed UUID under a `format: "uuid"` schema. 16 bytes have no case to remember |
| `Expected a canonical ISO-8601 date-time (the toISOString() spelling), received X` | a `format: "date-time"` string in any other spelling. Epoch milliseconds remember neither a fractional-digit count nor an offset, so only the one spelling that survives the round trip is accepted |
| `Expected an ISO-8601 date-time string, received X` | a non-string under the same schema. `X` is its type |
| `String contains an unpaired surrogate` | a string holding a lone UTF-16 surrogate, which UTF-8 has no bytes for. Validators accept one, so `compile(z.string())` reaches this too |
| `Expected a Date, received X` | anything but a `Date` under `m.date()` or `z.date()`, a millisecond number included |
| `Expected a valid Date, received an Invalid Date` | a `Date` whose time value is `NaN`, which no integer holds |
| `Expected a bigint, received X` | anything but a `bigint`, a numeric string or a `number` included |
| `String is too large` / `Byte array is too large` / `BigInt is too large` | more than 64 MiB of UTF-8, of bytes under `m.bytes()`, or of magnitude |
| `Expected a Set` / `Expected a Map` | the wrong container. One from another realm is accepted through a tag check when `instanceof` fails |
| `Array is too large` / `Set is too large` / `Map is too large` | more than 1,000,000 elements or entries |
| `Set changed size during encode` / `Map changed size during encode` | an element getter added or removed members while the encoder was iterating. The count is already on the wire by then, so the payload would not match it |
| `Expected a string` / `Expected a number` / `Expected a boolean` / `Expected an array` / `Expected an object` / `Expected a Uint8Array` | the wrong JavaScript type under a string, float, boolean, array, object or record schema, or under `m.bytes()`. Only reachable through `m` or `unchecked()`; a validated codec rejects the value first |
| `Expected an unsigned safe integer, received X` | `m.uint()` given a negative number, a non-integer, an integer past `Number.MAX_SAFE_INTEGER`, or a value that is not a number |
| `Expected a safe integer, received X` | the same through `m.int()` |
| `Expected an unsigned integer, received X` | a negative `bigint` passed to `Writer.varuintBigInt()` by a custom codec |
| `Expected an array with N items` | a length that disagrees with `minItems === maxItems` |
| `Expected literal X` | anything but the literal's own value, `-0` against a `0` literal included. Through `compile()`, a literal whose JSON Schema lost its value, such as `z.literal(NaN)`; see [Rejected shapes](/schemas/rejected-shapes/#empty-enums-and-members-with-no-json-text) |
| `Cannot encode X as a dynamic value; a dynamic value holds null, a boolean, a number, a string, an array, or a plain object` | a `Date`, `Map`, `Set`, class instance, function, symbol, `bigint` or `undefined` under `z.any()`. `X` is the constructor's name, or the type of a primitive. A *plain* object is fine whatever realm created it: a `node:vm` context, an iframe, a worker |
| `Dynamic value nests deeper than 64` | a dynamic value 65 levels deep, or an object that contains itself |
| `Recursive value nests deeper than 256` | a recursive schema 257 levels deep, or a cycle with no way out |
| `Record is too large` | a record with more than 1,000,000 entries |
| `No union branch has "kind" = X` | a discriminant value no branch declares. Only reachable through `unchecked()`; a validated codec rejects the value first |
| `Unknown enum value X` | a value no enum member equals. `-0` against a `0` member is one of them: a `0` and a `-0` cannot both survive one index, and `-0` is the one with no way back |
| `No union branch holds X` | a JSON type no branch of a type-disjoint union declares. Only reachable through `unchecked()`; a validated codec rejects the value first |
| `Expected a tuple with N items` / `Expected a tuple with at least N items` | a tuple given another number of items, a rest tuple given fewer than its fixed part, or a value that is not an array |
| `Expected a Uint8Array target, received X` | `encodeInto` given a `target` that is not a `Uint8Array`. `X` is its type |
| `Target offset X is outside the target` | an `encodeInto` offset that is negative, not a safe integer, or past the end of `target` |
| `Target buffer is too small for this value` | an `encodeInto` value that does not fit in `target` from `offset` on |
| *validation issues, joined by `; `* | your refinements failed. Each issue is prefixed with its path, as `tags[1].id: message`, and `path` holds the first one's |
| `The validator threw a value that is not an Error` | your validator threw something other than an `Error`, a string for instance |

Every one of these is an `EncodeError`, whatever the value. A `Symbol`, a null-prototype object, or an object whose `valueOf` or `toString` throws is refused like any other wrong type, and no `TypeError` from the coercion escapes. Where a message quotes a value, `X` is the value when printing it is safe and its type (`symbol`, `object`, `bigint`, `function`) when it is not.

The one thing that still escapes as itself is your own code. A getter or a proxy trap that throws while the encoder reads a property propagates unchanged, because swallowing it would report the wrong fault.

## Decode-time errors

All of these are `DecodeError` with an `offset`.

| Message | Cause |
| --- | --- |
| `Expected a Uint8Array, received X` | an input that is not a `Uint8Array`; offset 0. `X` is a primitive's type, `null`, or an object's class, such as `ArrayBuffer`, `DataView`, `Array` or `Promise`. Wrap an `ArrayBuffer` as `new Uint8Array(buffer)`, and a `DataView` as `new Uint8Array(view.buffer, view.byteOffset, view.byteLength)`: `new Uint8Array(view)` is empty |
| `Unexpected trailing data` | bytes remained after a complete value |
| `Payload was written by a different schema (expected fingerprint XXXXXXXX)` | the wire fingerprint differs |
| `Unexpected end of input` | a truncated payload |
| `Non-canonical variable-length integer` | an overlong varint, e.g. `[129, 0]` for `1` |
| `Invalid variable-length integer` | a varint longer than ten bytes |
| `Integer exceeds JavaScript's safe range` | a varint beyond the safe integer range |
| `Invalid byte length N` | a string, byte-array or BigInt length past 64 MiB |
| `Invalid UTF-8` | a malformed sequence. Decoding is strict, not replacing |
| `Invalid boolean N` | a byte other than `0` or `1` |
| `Invalid nullable marker` / `Invalid optional marker` | a marker byte other than `0` or `1` |
| `Non-canonical presence bitmap padding` | a presence bit set above the last optional field |
| `Unknown enum index N` | an index past the last member |
| `Array length N exceeds the limit` / `Record size N exceeds the limit` | a count past 1,000,000 |
| `Array length N exceeds the remaining input` / `Record size N exceeds the remaining input` | a count the payload cannot satisfy, refused before allocation |
| `Record keys are out of canonical order` | keys not ascending, or a key repeated |
| `Date value N is out of range` | a millisecond count outside ±8.64e15, where a `Date`'s range ends |
| `Non-canonical bigint` | a header of `1`, which would be negative zero, or a magnitude with a zero high byte. Either would give one value two encodings |
| `Duplicate Set element` | a payload declaring the same element twice. Merging it would let the value re-encode shorter than the payload it came from |
| `Duplicate Map key` | the same for a Map entry |
| `Set size N exceeds the limit` / `Map size N exceeds the limit` | a count past 1,000,000 |
| `Set size N exceeds the remaining input` / `Map size N exceeds the remaining input` | a count the payload cannot satisfy, refused before allocation |
| `Non-canonical dynamic number` | an integer written under the float tag |
| `Unknown dynamic tag X` | a tag byte above 7 |
| `Dynamic value nests deeper than 64` | a payload that nests past the limit |
| `Recursive value nests deeper than 256` | a payload that nests a recursive schema past the limit |
| `Unknown union branch X` | a branch index past the last branch, discriminated or type-disjoint |
| `Extra property "x" repeats a declared field` | an open object's tail naming a key the schema declares |
| *validation issues, joined by `; `*, or `The validator threw a value that is not an Error` | the bytes decoded, then your validator rejected the value or threw. The text is the same as on encode |

Handle a fingerprint mismatch explicitly. A fingerprint is a short wire-shape identifier, not a complete schema version; see [Wire fingerprints](/versioning/fingerprinting/).

## One error that is not a `DecodeError`

A deeply nested schema overflows the JavaScript stack and throws `RangeError` rather than an `EncodeError` or a `DecodeError`. Measured on Node 24.18.0 with nested objects, a `compile()` codec reaches it while it is built, at about 1,400 levels. An `m` schema builds at any depth and reaches it on use instead, at about 1,600 levels on encode and 8,500 on decode.

A Zod schema overflows sooner, at about 1,300 levels, inside Zod's own JSON Schema conversion. shorn wraps a failure there, so it arrives as an `EncodeError` with the [no-wire-form suffix](#values-with-no-wire-form) on its message and the `RangeError` as its `cause`.

It takes a hostile schema, not merely hostile bytes. Limit schema depth if schemas come from untrusted input. See [Hostile input](/hostile-input/).
