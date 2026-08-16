---
title: How It Works
description: Where the bytes go, and the four steps between a JavaScript value and shorn's bytes.
---

## Where the bytes go

One small record as minified JSON:

```text
{"name":"Grace","age":45,"sex":"F"}   35 bytes
```

The schema already knows the field names, so they do not need to be sent:

```text
["Grace",45,"F"]                      16 bytes
```

The schema also knows the order and the types, so the brackets, commas and quotes are not needed either, and `"F"` is one of three known values so it can be an index instead of a string:

```text
2d 05 47 72 61 63 65 00               8 bytes
│  │  └─────┬──────┘ │
│  │        │        └── sex, index 0 of the enum
│  │        └── "Grace"
│  └── string length, 5
└── age, 45
```

The middle step is the uncontroversial one: the array carries the same information as the object, because the reader knows what each position means. shorn takes that same move one step further. The schema is what makes both steps safe.

`2d` is age 45, and it comes first because fields are written in [canonical order](/core-concepts/canonical-bytes/) rather than declaration order. `00` is the index of `"F"` in the sorted enum `["F", "M", "X"]`. [Byte Layout](/wire-format/layout/) has every wire type.

## The four steps

```
value ──▶ validate ──▶ wire plan ──▶ bytes
          (Standard    (Standard
           Schema)      JSON Schema)
```

1. **Your validator checks the value** through Standard Schema, including rules such as `.min(1)`, `.email()`, and `.refine()`.
2. **Standard JSON Schema supplies structure**: field names, types, optionality. shorn converts it to a wire plan once and caches it by schema identity.
3. **The plan writes values** with no keys and no type tags.
4. **Decode runs in reverse**, and validates again with your original library.

A payload that decodes structurally but fails a refinement is a `DecodeError`, never an accepted value.

Both interfaces are vendor-neutral — Standard Schema supplies `validate(value)`, Standard JSON Schema supplies `jsonSchema.input()` and `.output()` — so shorn needs no validator-specific code. This also creates its main limitation: **shorn cannot encode anything JSON Schema cannot describe.** See [Date, BigInt, Map, Set](/schemas/rich-types/).

## The wire plan

The JSON Schema becomes a `WireShape`, a small closed union:

```
any | boolean | float64 | int | string | uint | uuid
| { array } | { tuple } | { object, rejectUnknown } | { record }
| { enum }  | { literal } | { nullable } | { ref }
| { union, on, cases } | { union, types }
```

The two union variants are the two ways a branch can be named without trying it: `on`/`cases` is a discriminant property, `types` is the JSON type of the value. A union whose branches could overlap has neither and is [refused](/schemas/rejected-shapes/#overlapping-unions).

A `{ ref }` is the back-edge of a cycle, and the only shape that is not self-contained: it indexes a definition table the document carries beside its root shape. The table appears only when a `$ref` actually closes a cycle — a `$ref` reached twice but never through itself is inlined — so no non-recursive schema's signature moved when recursion was added.

Two details drive the choices that matter:

- **`type: "integer"` with `minimum >= 0`** becomes `uint` (plain varint); without it, `int` (ZigZag), which crosses every size boundary at half the value.
- **`additionalProperties`** determines how extra fields are handled. `false` means the validator handles them. If the option is absent, shorn refuses extras during encoding. `true` or a schema makes the object open.

Both `jsonSchema.input()` and `.output()` are converted and compared; a schema whose two sides differ needs a bidirectional codec and is refused.

## Compiled, then signed

The `WireShape` becomes a tree of `Schema` objects, the same objects the [`m` API](/api/m/) builds by hand, which is why the two produce identical bytes.

Each node carries a `_minWidth`: the fewest bytes any value of that shape can occupy. That is what lets an array refuse an impossible element count *before* allocating. See [Hostile Input](/hostile-input/).

A cycle is built definitions first, as nodes that exist before the schemas they stand for do — every container reads its children's `_minWidth` in its own constructor, so a back-edge has to be answerable before the cycle it closes is built. Those nodes are also where nesting depth is counted, since depth comes from the payload there rather than from the schema.

shorn also stores a canonical string signature: the `WireShape` as JSON without `rejectUnknown`. [`fingerprinted()`](/versioning/fingerprinting/) hashes this signature. Removing `rejectUnknown` lets equivalent Zod and ArkType schemas agree even though they handle extra properties differently. The `m` API has no signature, so `fingerprinted()` refuses codecs built with `m`.

The plan is cached in a `WeakMap` keyed by schema identity, so conversion runs once per schema. See [Compilation and Caching](/core-concepts/compile-and-caching/).
