---
title: Hostile Input
description: Decoder checks, allocation limits, and security boundaries for untrusted payloads.
---

A decoder with no type tags relies on the schema to interpret every byte. That makes bounds and length checks essential when payloads come from somewhere you do not trust.

## What is checked

| Check | Behavior |
| --- | --- |
| Read past end of input | `DecodeError` with byte offset |
| Trailing bytes after a complete value | `DecodeError` |
| Non-canonical (overlong) varint | `DecodeError` |
| Varint beyond the safe integer range | `DecodeError` |
| Invalid UTF-8 | `DecodeError`, strict rather than replacing |
| Boolean byte other than 0 or 1 | `DecodeError` |
| Enum index past the last member | `DecodeError` |
| Unknown object property | `EncodeError` on the way in |
| Input that is not a `Uint8Array` | `DecodeError`, not a raw `TypeError` |
| `__proto__` as a decoded key | handled; the decode target has a null prototype |
| Record keys out of order, or repeated | `DecodeError` |
| Dynamic value nested past 64 levels | `DecodeError` |
| Recursive schema nested past 256 levels | `DecodeError` |
| Unknown dynamic type tag | `DecodeError` |
| Union branch index past the last branch | `DecodeError` |
| Open-object extra repeating a declared field | `DecodeError` |

The hard limits are **1,000,000** elements per collection, Sets and Maps included, and **64 MiB** for a string, a byte array, or a BigInt magnitude. These are backstops. The input-length check below is the main defense against over-allocation.

## Allocation is bounded by input length, not schema shape

A naive decoder can allocate far more memory than the payload size suggests. A seven-byte payload can declare an array of one million elements, and nested arrays multiply that.

Every schema carries a **`_minWidth`**, the fewest bytes one value of that schema can occupy. Before allocating an array, the decoder multiplies that width by the declared count and checks that at least that much input remains. `_minWidth` is computed when the codec is built, so the runtime check costs one multiplication per decoded array.

A recursive schema's back edge reports one byte rather than a measured width. A cycle a value can escape has to pass through an optional field, a nullable marker, an array count, a record count, or a union index, and each of those costs at least one byte. The check holds at the same strength it has for a string.

This is why **arrays of zero-width elements are rejected when the codec is built**. Literals, empty tuples, and empty objects use no bytes, so the decoder could not check the declared count against the payload length. A tuple may still contain them, because its length comes from the schema. A Set and a Map follow the array's rule with no exception at all, since neither has a fixed-count form.

### The one exception, and its own ceiling

An array whose count the schema fixes (`minItems` equal to `maxItems`) is exempt for the same reason a tuple is, so its `_minWidth` can be `count × 0 = 0`. Such an array needs no payload at all to fill, so it answers to a second bound instead: the **total** number of slots a codec can allocate from no input, summed through zero-width objects and tuples and multiplied through nesting, must stay under the 1,000,000 collection limit. Building the codec fails otherwise. One fixed array of a million literals is fine. A second one wrapped around it is not, and neither is `z.array(z.array(z.literal("x")).length(1000)).length(1000)`.

Without that bound, nesting multiplied without limit and no caller could step in. Three levels of a million turned an **empty** payload into 10¹⁸ slots and took the process down with an unrecoverable out-of-memory abort. Fixed in 0.3.0.

A variable-length container around a fixed one is still yours to bound, because there the payload chooses how many times to repeat it. `z.array(z.object({ n: z.int(), pad: z.array(z.literal("x")).length(1_000_000) }))` turns 101 bytes into 100 million array slots. Cap the outer collection yourself.

## Security boundaries

- **No security audit or coverage-guided fuzzing.** Property-based and mutation tests are not a substitute for either.
- **No depth limit from the schema.** Every walk over a schema recurses with it, so a deeply nested one exhausts the JavaScript stack and throws `RangeError` rather than an `EncodeError` or a `DecodeError`. Measured on Node 22, `compile()` gives out at about **1,400** levels of nested objects and the `m` builders at about **1,600**, so the ceiling is hit while the codec is built, before any payload is read. This takes a hostile **schema**, not merely hostile bytes, and a `RangeError` is recoverable, unlike the allocation abort above. Limit depth if schemas come from untrusted input. Depth chosen by the *payload* is capped on both sides: a dynamic value nests at most 64 levels and a recursive schema at most 256, so neither can turn a few bytes per level into unbounded stack.
- **Not a sandbox.** Validation code runs with the same privileges as your application.
- **Not authentication or encryption.** Fingerprints are unkeyed, and payloads are readable by anyone with the schema.

## Practical guidance

**Use `safeDecode` at untrusted boundaries**, where malformed input is normal traffic.

```ts
const result = safeDecode(Person, bytes);
if (!result.success) return new Response("Bad request", { status: 400 });
```

**Use a 4-byte wire fingerprint for stored and queued payloads.** It is not a security feature and cannot tell apart schema changes that only touch validation; see [Wire Fingerprints](/versioning/fingerprinting/). Do not treat it as authentication. Sign or encrypt if you need authenticity.

**Cap payload size at the transport.** The 64 MiB limit is a backstop, not a policy.

**Encrypt when secrecy matters.** Compact is not confidential.

`encode` returns an exact-size copy rather than a view into an oversized buffer, and releases internal buffers larger than 64 KiB.
