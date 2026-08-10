---
title: How It Works
description: The four steps between a JavaScript value and shorn's bytes.
---

```
value ──▶ validate ──▶ wire plan ──▶ bytes
          (Standard    (Standard
           Schema)      JSON Schema)
```

1. **Your validator checks the value** through Standard Schema, including rules such as `.min(1)`, `.email()`, and `.refine()`.
2. **Standard JSON Schema supplies structure**: field names, types, optionality. shorn converts it to a wire plan once and caches it.
3. **The plan writes values** with no keys and no type tags.
4. **Decode runs in reverse**, and validates again with your original library.

A payload that decodes structurally but fails a refinement is a `DecodeError`, never an accepted value.

## Two interfaces, two jobs

| Interface | Supplies | Used for |
| --- | --- | --- |
| Standard Schema | `validate(value)` | correctness, both directions |
| Standard JSON Schema | `jsonSchema.input()` / `.output()` | structure |

Both interfaces are vendor-neutral, so shorn does not need validator-specific code. This also creates its main limitation: **shorn cannot encode anything JSON Schema cannot describe.** See [Date, BigInt, Map, Set](/schemas/rich-types/).

## The wire plan

The JSON Schema becomes a `WireShape`, a small closed union:

```
boolean | float64 | int | string | uint
| { array } | { tuple } | { object, rejectUnknown }
| { enum }  | { literal } | { nullable }
```

Two details drive the choices that matter:

- **`type: "integer"` with `minimum >= 0`** becomes `uint` (plain varint); without it, `int` (ZigZag), which crosses every size boundary at half the value.
- **`additionalProperties`** determines how extra fields are handled. `false` means the validator handles them. If the option is absent, shorn refuses extras during encoding. `true` or a schema makes the object open, which shorn does not support.

Both `jsonSchema.input()` and `.output()` are converted and compared; a schema whose two sides differ needs a bidirectional codec and is refused.

## Compiled, then signed

The `WireShape` becomes a tree of `Schema` objects, the same objects the [`m` API](/wire-format/low-level-api/) builds by hand, which is why the two produce identical bytes.

Each node carries a `_minWidth`: the fewest bytes any value of that shape can occupy. That is what lets an array refuse an impossible element count *before* allocating. See [Hostile Input](/hostile-input/).

shorn also stores a canonical string signature: the `WireShape` as JSON without `rejectUnknown`. [`fingerprinted()`](/versioning/fingerprinting/) hashes this signature. Removing `rejectUnknown` lets equivalent Zod and ArkType schemas agree even though they handle extra properties differently. The `m` API has no signature, so `fingerprinted()` refuses codecs built with `m`.

## Caching

`encode` and `decode` cache the plan in a `WeakMap` keyed by schema identity, so conversion runs once per schema. See [Compilation and Caching](/core-concepts/compile-and-caching/).
