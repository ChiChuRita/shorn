---
title: Hostile Input
description: Decoder checks, allocation limits, and security boundaries for untrusted payloads.
---

A tagless decoder relies on the schema to interpret every byte. Bounds and length checks are therefore essential when payloads are untrusted.

## What is checked

| Check | Behavior |
| --- | --- |
| Read past end of input | `DecodeError` with byte offset |
| Trailing bytes after a complete value | `DecodeError` |
| Non-canonical (overlong) varint | `DecodeError` |
| Varint beyond the safe integer range | `DecodeError` |
| Invalid UTF-8 | `DecodeError`, fatal rather than replacing |
| Boolean byte other than 0 or 1 | `DecodeError` |
| Enum index past the last member | `DecodeError` |
| Unknown object property | `EncodeError` on the way in |
| Input that is not a `Uint8Array` | `DecodeError`, not a raw `TypeError` |
| `__proto__` as a decoded key | handled; the decode target is null-prototype |
| Record keys out of order, or repeated | `DecodeError` |
| Dynamic value nested past 64 levels | `DecodeError` |
| Unknown dynamic type tag | `DecodeError` |
| Union branch index past the last branch | `DecodeError` |
| Open-object extra repeating a declared field | `DecodeError` |

Hard limits are **1,000,000** collection elements and **64 MiB** for strings or byte arrays. These are backstops; the input-length checks below provide the main allocation defense.

## Allocation is bounded by input length, not schema shape

A naive decoder can allocate far more memory than the payload size suggests. A seven-byte payload can declare an array with one million elements, and nested arrays can multiply that allocation.

Every schema carries a **`_minWidth`**, the fewest bytes one value can occupy. Before allocating an array, the decoder multiplies this width by the declared count and checks that enough input remains.

Because `_minWidth` is computed during codec construction, the runtime check adds one multiplication per decoded array.

This is why **arrays of zero-width elements are rejected during codec construction**. Literals, empty tuples, and empty objects use no bytes, so the decoder could not verify the declared count against the payload length. A tuple may still contain them because its length comes from the schema.

### The one exception

An array whose count the schema fixes — `minItems` equal to `maxItems` — is exempt from that rejection for the same reason a tuple is, and its `_minWidth` is then `count × 0 = 0`. A variable-length container around it therefore repeats that free allocation once per byte of input: `z.array(z.object({ n: z.int(), pad: z.array(z.literal("x")).length(1_000_000) }))` turns 101 bytes into 100 million array slots. Nothing an attacker sends reaches this on its own — it needs a schema that declares a large fixed-count array of a constant — but if you write one, bound the outer collection yourself.

## Encode memory

`encode` returns an **exact-size copy** instead of a view into an oversized buffer. It also releases internal buffers larger than 64 KiB.

## Security boundaries

- **No security audit or coverage-guided fuzzing.** Property-based and mutation tests are not substitutes for either.
- **No depth limit from the schema.** A schema nested about 5,900 levels deep can exhaust the JavaScript stack and throw `RangeError` instead of `DecodeError`. This requires a hostile **schema**, not merely hostile bytes. Limit depth if schemas come from untrusted input. Depth chosen by the *payload* is a different matter and is capped: a dynamic value nests at most 64 levels, on both sides.
- **Not a sandbox.** Validation code runs with the same privileges as the application.
- **Not authentication or encryption.** Fingerprints are unkeyed and payloads are readable to anyone with the schema.

## Practical guidance

**Use `safeDecode` at untrusted boundaries**, where malformed input should be handled as normal traffic.

```ts
const result = safeDecode(Person, bytes);
if (!result.success) return new Response("Bad request", { status: 400 });
```

**Use a 4-byte wire fingerprint for stored and queued payloads.** It is not a security feature and cannot distinguish validation-only schema changes. See [Wire Fingerprints](/versioning/fingerprinting/).

**Encrypt when secrecy matters.** Compact is not confidential.

**Cap payload size at the transport.** The 64 MiB limit is a backstop, not a policy.

**Do not treat the fingerprint as authentication.** Sign or encrypt if you need authenticity.
