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

`DecodeError.offset` is the byte position reached. For a validation failure, it equals the payload length because structural decoding must consume every byte before validation runs.

```ts
try {
  decode(Person, bytes);
} catch (error) {
  if (error instanceof DecodeError) {
    console.error(`bad payload at byte ${error.offset}: ${error.message}`);
  }
}
```

To avoid exceptions, use `safeDecode`. It returns either `{ success: true, data }` or `{ success: false, error }` and wraps values that are not already `Error` objects.

## Locating the failure

`EncodeError.path` names the value that failed, as `user.address.zip` or `tags[3]`, and the same path is already appended to `message`. It is set for a value the encoder refused; it is absent when no single field is at fault, such as an array passed where an object was expected.

```ts
try {
  encode(Person, person);
} catch (error) {
  if (error instanceof EncodeError) console.error(error.path); // "address.zip"
}
```

`issues` is set when a validator rejected the value, and holds the vendor's own [Standard Schema issues](https://standardschema.dev) rather than the `; `-joined summary in `message`. Use it to answer with a field-keyed response without running the validator a second time. It survives the class change on the way out, so a `DecodeError` from a failed validation carries the same array.

```ts
const result = safeDecode(Person, bytes);
if (!result.success && result.error instanceof DecodeError) {
  return Response.json(
    { fields: result.error.issues?.map((issue) => issue.path?.join(".")) },
    { status: 422 },
  );
}
```

Errors that wrap another error set `cause`: a validation failure rethrown as a `DecodeError`, a rich-type rejection from a validator's JSON Schema conversion, and an invalid UTF-8 read.

## Schema-construction errors

These are all `EncodeError` instances thrown when the codec is built. See [Rejected Shapes](/schemas/rejected-shapes/) for workarounds.

| Message | Cause |
| --- | --- |
| `Only nullable and discriminated JSON Schema unions are currently supported` | a union with no property that is a distinct `const` in every branch |
| `Only nullable JSON Schema type arrays are currently supported` | a `type` array with >1 non-null entry |
| `Arrays require an item schema` | an array with no `items` |
| `Empty enums are unsupported` | an enum with no members |
| `Enum member … has no JSON text of its own` | `NaN`, an infinity or `-0` in a mixed enum; none of the four survives the JSON text a mixed enum is ordered by |
| `Invalid fixed array length X` | `minItems === maxItems` outside 0 to 1,000,000 |
| `Unsupported JSON Schema literal` | a literal that is not string, number, boolean, or null |
| `Unsupported Standard JSON Schema type X` | a type with no wire shape |
| `Unsupported Standard JSON Schema node` | a non-object node where a schema was expected |
| `Recursive schemas ($ref) are not supported; flatten to a fixed depth or nest the recursive part as bytes` | `z.lazy()`, a self-referential getter, any `$ref` |
| `Unsupported JSON Schema combinator X` | `allOf` (an intersection) or `not` (`z.never()`) |
| `The second argument must be a Standard JSON Schema implementation — toStandardJsonSchema(schema) for Valibot` | a raw JSON Schema object, or the structure wrapped in `{ structure }` |
| `Required property "x" has no schema` | `required` names a property absent from `properties` |
| `Schemas with different input and output wire shapes require a bidirectional codec and are not yet supported` | a default or widening refinement makes the sides differ |
| `Standard Schema provides validation but not structure; pass a Standard JSON Schema implementation as the second argument` | Valibot, Zod < 4.2, ArkType < 2.1.28 |
| `This schema already decodes to null; wrapping it in nullable() would give null two encodings` | `m.literal(null).nullable()`, or a second null marker over one already reachable |
| `This schema already decodes to undefined; wrapping it in optional() would give undefined two encodings` | a second presence marker over one already reachable |
| `fingerprinted() needs a codec built from a Standard JSON Schema; compile() returns one, the low-level m API does not` | `fingerprinted(m.object(...))` |
| `Fingerprint bytes must be 1, 2, 3 or 4, received X` | out-of-range `bytes` option |

### Rich types

```
<the vendor's own message> — shorn encodes the wire shape; convert rich types
at the edge (README: Dates, BigInt, Map and Set)
```

shorn preserves the validator's original reason and appends guidance. This applies to `Date`, `bigint`, `Map`, `Set`, `undefined`, `NaN`, and transforms. See [Date, BigInt, Map, Set](/schemas/rich-types/).

### Async

```
This Standard Schema validates asynchronously; use encodeAsync/decodeAsync,
which accept either this schema or a codec built from it.
```

The remedy is followable from every codec that reaches this error, fingerprinted ones included. A codec that has no validator at all gets a different message:

```
This codec has no validator to await; async validation needs a codec from
compile(), optionally wrapped by fingerprinted()
```

## Encode-time value errors

| Message | Cause |
| --- | --- |
| `Unknown object property "x"` | an extra property where the vendor left `additionalProperties` absent: ArkType by default, Valibot's `object` and `looseObject` |
| `Expected a lowercase UUID, received X` | an uppercase or malformed UUID under a `format: "uuid"` schema; 16 bytes have no case to remember |
| `Expected an array with N items` | a length that disagrees with `minItems === maxItems` |
| `Cannot encode X as a dynamic value` | a `Date`, `Map`, `Set`, class instance, function or symbol under `z.any()` |
| `Dynamic value nests deeper than 64` | a dynamic value 65 levels deep, or an object that holds itself |
| `Record is too large` | a record with more than 1,000,000 entries |
| `No union branch has "kind" = X` | a discriminant value no branch declares |
| `Expected a tuple with at least N items` | fewer items than a rest tuple's fixed part |
| *validation issues, joined by `; `* | your refinements failed; paths prefixed as `field.nested: message` |

## Decode-time errors

All `DecodeError` with an `offset`.

| Message | Cause |
| --- | --- |
| `Expected a Uint8Array, received X` | wrong input type; offset 0 |
| `Unexpected trailing data` | bytes remained after a complete value |
| `Payload was written by a different schema (expected fingerprint XXXXXX)` | the wire fingerprint differs |
| *out-of-bounds read* | truncated payload |
| *non-canonical varint* | overlong, e.g. `[129, 0]` for `1` |
| *unsafe integer* | a varint beyond the safe integer range |
| *invalid UTF-8* | decoding is fatal, not replacing |
| *invalid boolean* | a byte other than `0` or `1` |
| *invalid enum index* | past the last member |
| *element count exceeds remaining input* | a count the payload cannot satisfy |
| `Record keys are out of canonical order` | keys not ascending, or a key repeated |
| `Non-canonical dynamic number` | an integer written under the float tag |
| `Unknown dynamic tag X` | a tag byte above 7 |
| `Dynamic value nests deeper than 64` | a payload that nests past the limit |
| `Unknown union branch X` | a branch index past the last branch |
| `Extra property "x" repeats a declared field` | an open object's tail naming a key the schema declares |

Handle fingerprint mismatches explicitly. Fingerprints are short wire-shape identifiers, not complete schema versions; see [Wire Fingerprints](/versioning/fingerprinting/).

## One error that is not a `DecodeError`

A schema nested about 5,900 levels deep can overflow the JavaScript stack and throw `RangeError` instead of `DecodeError`. This requires a hostile **schema**, not only hostile bytes. Limit schema depth if schemas come from untrusted input. See [Hostile Input](/hostile-input/).
