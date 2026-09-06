---
title: Errors
description: EncodeError, DecodeError, and what every message you can hit means.
---

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
| `DecodeError` | the bytes are malformed, **or** validation failed on the way out |

`DecodeError.offset` is the byte position the decoder had reached. For a validation failure it equals the payload length, because structural decoding has to consume every byte before validation runs.

```ts
try {
  decode(Person, bytes);
} catch (error) {
  if (error instanceof DecodeError) {
    console.error(`bad payload at byte ${error.offset}: ${error.message}`);
  }
}
```

To avoid exceptions, use `safeDecode`. It returns either `{ success: true, data }` or `{ success: false, error }`, and wraps anything thrown that is not already an `Error`.

## Locating the failure

`EncodeError.path` names the value that failed, as `user.address.zip` or `tags[3]`, and is also appended to `message`. It is absent when no single field is at fault, for example when an array was passed where an object was expected.

```ts
try {
  encode(Person, person);
} catch (error) {
  if (error instanceof EncodeError) console.error(error.path); // "address.zip"
}
```

`issues` is set when a validator rejected the value. It holds the validator's own [Standard Schema issues](https://standardschema.dev) rather than the `; `-joined summary in `message`. Use it to build a field-keyed response without running the validator a second time. A `DecodeError` from a failed validation carries the same array.

```ts
const result = safeDecode(Person, bytes);
if (!result.success && result.error instanceof DecodeError) {
  return Response.json(
    { fields: result.error.issues?.map((issue) => issue.path?.join(".")) },
    { status: 422 },
  );
}
```

Errors that wrap another error set `cause`: a validation failure rethrown as a `DecodeError`, a refusal from a validator's own JSON Schema conversion, and an invalid UTF-8 read.

## Schema-construction errors

All of these are `EncodeError` instances thrown when the codec is built. See [Rejected Shapes](/schemas/rejected-shapes/) for what to do about each one.

| Message | Cause |
| --- | --- |
| `Only nullable, discriminated and type-disjoint JSON Schema unions are currently supported` | a union with two branches of one JSON type and no property that is a distinct `const` in every branch, whether written as `anyOf`, `oneOf` or a `type` array |
| `Empty enums are unsupported` | an enum with no members |
| `Enum member … has no JSON text of its own` | `NaN`, an infinity or `-0` in a mixed enum. None of the four survives the JSON text a mixed enum is ordered by |
| `Invalid fixed array length X` | `minItems === maxItems` outside 0 to 1,000,000 |
| `Array elements must occupy at least one byte, or a fixed count of them must stay under the collection limit` | an array of zero-width elements: a literal, an empty tuple, an empty object, or an object or tuple built only from those. A variable count can never be checked against the payload. A fixed count can be, but only up to 1,000,000 elements in total across nesting, since a fixed count needs no payload at all to satisfy |
| `Set elements must occupy at least one byte` | the same for a Set, which has no fixed-count form to exempt |
| `Map entries must occupy at least one byte` | the same for a Map, counting key and value together |
| `Unsupported JSON Schema literal` | a literal that is not a string, number, boolean, or null |
| `Unsupported Standard JSON Schema type X` | a type with no wire shape. `X` is the type keyword, or `object` when the document put an object there |
| `Unsupported Standard JSON Schema node` | a non-object node where a schema was expected |
| `Unsupported JSON Schema reference "…"; only same-document references are supported` | a `$ref` naming another document |
| `JSON Schema reference "…" does not resolve` | a `$ref` whose pointer names nothing in the document |
| `Unsupported JSON Schema combinator X` | `allOf` (an intersection) or `not` (`z.never()`) |
| `Unsupported x-shorn kind X` | shorn's own keyword carrying anything but `date`, `bigint`, `set` or `map`. `X` is the value, or its type when it is not a string |
| `A recursive type inside a Set or Map is not supported; hold the recursion in an array or an object instead` | a cycle reached through a Set element or a Map key or value. That child is converted as a document of its own, so a `$ref` in it would resolve against the root instead |
| `A Set or Map element has no Standard JSON Schema of its own` | a Set or Map whose element is not a schema shorn can convert on its own |
| `ArkType's Set carries no element type, so there is nothing to encode its members as; convert it at the edge` | ArkType's `Set` or `Map` keyword. Neither names the type of its members, and a format without type tags writes members and nothing else |
| `X cannot be represented in JSON Schema` | a Zod or ArkType type with no wire form: `undefined`, `void`, `symbol`, `nan`, `custom`, `function`, `transform`, and ArkType protos such as `RegExp` or `URL`. `X` is the validator's own name for it |
| `A literal undefined or bigint cannot be represented in JSON Schema` | `z.literal(undefined)` or `z.literal(1n)`. Zod would drop the first member and write the second as a number, so either would decode to a different value than was declared |
| `The second argument must be a Standard JSON Schema implementation (toStandardJsonSchema(schema) for Valibot) or a JSON Schema document` | a `structure` that is neither. A plain object counts as a document when it has `$schema`, `$ref`, `type`, `anyOf`, `oneOf`, `const`, `enum`, `properties` or `x-shorn`. A validator passed twice, or a structure wrapped in `{ structure }`, has none of those |
| `Required property "x" has no schema` | `required` names a property that is missing from `properties` |
| `A "__proto__" property does not survive a JSON Schema; rename the field` | a field named `__proto__`. No validator's JSON Schema can carry it: the key sets the prototype of the `properties` object instead of joining it, so the field would be missing from the wire shape |
| `Schemas with different input and output wire shapes require a bidirectional codec and are not yet supported` | a default or widening refinement makes the two sides differ |
| `Standard Schema provides validation but not structure; pass a Standard JSON Schema implementation as the second argument` | Valibot, Zod before 4.2, ArkType before 2.1.28 |
| `This schema already decodes to null; wrapping it in nullable() would give null two encodings` | `m.literal(null).nullable()`, or a second null marker over one already reachable. Never from a validator schema: `compile()` drops a redundant wrapper instead of reaching this |
| `This schema already decodes to undefined; wrapping it in optional() would give undefined two encodings` | a second presence marker over one already reachable |
| `fingerprinted() needs a codec built from a Standard JSON Schema; compile() returns one, the low-level m API does not` | `fingerprinted(m.object(...))` |
| `Fingerprint bytes must be 1, 2, 3 or 4, received X` | an out-of-range `bytes` option. `X` is the value, or its type when the value is neither a number nor a string |
| `unchecked() needs a codec with a validator to remove; compile() returns one, optionally wrapped by fingerprinted(), and the low-level m API is already unvalidated` | `unchecked(m.object(...))`, or `unchecked(compile(schema).nullable())` |

### Values with no wire form

```
<the vendor's own message> (shorn has no wire form for this value; convert it at
the edge, see Rejected Shapes)
```

This suffix is added when a **validator's own** conversion throws, so the reason stays the validator's and the remedy is shorn's. In practice that means Valibot's converter (`v.undefined()`, a `v.transform`, and `v.date()`, `v.bigint()`, `v.set()` or `v.map()` without the [`valibotOverride` recipe](/validators/valibot/#rich-types)), and an ArkType constraint shorn has no hook for, such as the predicate behind `"string.date"`.

A refusal that is shorn's own carries no suffix, because it already says what to do. Zod's are all in that group: `undefined cannot be represented in JSON Schema` and its siblings come from shorn's conversion hook, not from Zod.

`Date`, `bigint`, `Map`, `Set` and `date-time` strings are no longer in this group. They are [supported](/schemas/rich-types/). What remains is `undefined`, `void`, `nan`, symbols, functions, `custom` types and transforms.

### Async

```
This Standard Schema validates asynchronously; use encodeAsync/decodeAsync,
which accept either this schema or a codec built from it.
```

Every codec that reaches this error can follow the remedy, fingerprinted ones included. A codec with no validator at all gets a different message:

```
This codec has no validator to await; async validation needs a codec from
compile(), optionally wrapped by fingerprinted()
```

## Encode-time value errors

| Message | Cause |
| --- | --- |
| `Unknown object property "x"` | an extra property where the validator left `additionalProperties` out: ArkType by default, Valibot's `object` and `looseObject` |
| `Expected a lowercase UUID, received X` | an uppercase or malformed UUID under a `format: "uuid"` schema. 16 bytes have no case to remember |
| `Expected a canonical ISO-8601 date-time (the toISOString() spelling), received X` | a `format: "date-time"` string in any other spelling. Epoch milliseconds remember neither a fractional-digit count nor an offset, so only the one spelling that survives the round trip is accepted |
| `Expected an ISO-8601 date-time string, received X` | a non-string under the same schema. `X` is its type |
| `Expected a Date, received X` | anything but a `Date` under `m.date()` or `z.date()`, a millisecond number included |
| `Expected a valid Date, received an Invalid Date` | a `Date` whose time value is `NaN`, which no integer holds |
| `Expected a bigint, received X` | anything but a `bigint`, a numeric string or a `number` included |
| `BigInt is too large` | a magnitude past 64 MiB |
| `Expected a Set` / `Expected a Map` | the wrong container. One from another realm is accepted through a tag check when `instanceof` fails |
| `Set is too large` / `Map is too large` | more than 1,000,000 elements or entries |
| `Set changed size during encode` / `Map changed size during encode` | an element getter added or removed members while the encoder was iterating. The count is already on the wire by then, so the payload would not match it |
| `Expected an unsigned safe integer, received X` | `m.uint()` given a negative number, a non-integer, an integer past `Number.MAX_SAFE_INTEGER`, or a value that is not a number |
| `Expected a safe integer, received X` | the same through `m.int()` |
| `Expected an array with N items` | a length that disagrees with `minItems === maxItems` |
| `Cannot encode X as a dynamic value` | a `Date`, `Map`, `Set`, class instance, function or symbol under `z.any()`. A *plain* object is fine whatever realm created it: a `node:vm` context, an iframe, a worker |
| `Dynamic value nests deeper than 64` | a dynamic value 65 levels deep, or an object that contains itself |
| `Recursive value nests deeper than 256` | a recursive schema 257 levels deep, or a cycle with no way out |
| `Record is too large` | a record with more than 1,000,000 entries |
| `No union branch has "kind" = X` | a discriminant value no branch declares. Only reachable through `unchecked()`; a validated codec rejects the value first |
| `Unknown enum value X` | a value no enum member equals. `-0` against a `0` member is one of them: a `0` and a `-0` cannot both survive one index, and `-0` is the one with no way back |
| `No union branch holds X` | a JSON type no branch of a type-disjoint union declares. Only reachable through `unchecked()`; a validated codec rejects the value first |
| `Expected a tuple with at least N items` | fewer items than a rest tuple's fixed part |
| *validation issues, joined by `; `* | your refinements failed. Paths are prefixed as `field.nested: message` |

Every one of these is an `EncodeError`, whatever the value. A `Symbol`, an object with a null prototype, and an object whose `valueOf`, `toString`, `toJSON` or `Symbol.toPrimitive` throws are all refused like any other wrong type. The coercion's own `TypeError` never escapes, so `instanceof EncodeError` and `safeEncode` narrowing hold for anything a caller can pass. Wherever a message quotes a value it does not restrict to a primitive, `X` is the value when printing it is safe and its type (`symbol`, `object`, `bigint`, `function`) when it is not, because a value that cannot be printed cannot explain its own refusal.

The one thing that still escapes as itself is your own code. A getter or a proxy trap that throws while the encoder reads a property propagates unchanged, because swallowing it would report a wrong field instead of the real fault.

## Decode-time errors

All of these are `DecodeError` with an `offset`.

| Message | Cause |
| --- | --- |
| `Expected a Uint8Array, received X` | wrong input type; offset 0 |
| `Unexpected trailing data` | bytes remained after a complete value |
| `Payload was written by a different schema (expected fingerprint XXXXXX)` | the wire fingerprint differs |
| *out-of-bounds read* | truncated payload |
| *non-canonical varint* | overlong, e.g. `[129, 0]` for `1` |
| *unsafe integer* | a varint beyond the safe integer range |
| *invalid UTF-8* | decoding is strict, not replacing |
| *invalid boolean* | a byte other than `0` or `1` |
| *invalid enum index* | past the last member |
| *element count exceeds remaining input* | a count the payload cannot satisfy |
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

Handle a fingerprint mismatch explicitly. A fingerprint is a short wire-shape identifier, not a complete schema version; see [Wire Fingerprints](/versioning/fingerprinting/).

## One error that is not a `DecodeError`

A deeply nested schema overflows the JavaScript stack and throws `RangeError` rather than an `EncodeError` or a `DecodeError`. Measured on Node 22, that happens at about **1,400** levels of nested objects through `compile()` and **1,600** through `m`, so it is reached while the codec is built, not while a payload is read. It takes a hostile **schema**, not merely hostile bytes. Limit schema depth if schemas come from untrusted input. See [Hostile Input](/hostile-input/).
