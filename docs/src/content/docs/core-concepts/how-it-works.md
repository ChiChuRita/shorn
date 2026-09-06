---
title: How It Works
description: Where the bytes go, and the four steps between a JavaScript value and shorn's bytes.
---

## Where the bytes go

Start with one small record as minified JSON:

```text
{"name":"Grace","age":45,"sex":"F"}   35 bytes
```

The schema already knows the field names, so there is no need to send them:

```text
["Grace",45,"F"]                      16 bytes
```

The schema also knows the order and the type of each field, so the brackets, commas, and quotes can go too. And `"F"` is one of three known enum values, so it can travel as an index instead of a string:

```text
2d 05 47 72 61 63 65 00               8 bytes
│  │  └─────┬──────┘ │
│  │        │        └── sex, index 0 of the enum
│  │        └── "Grace"
│  └── string length, 5
└── age, 45
```

The middle step is one most people accept without argument: an array carries the same information as the object, because the reader knows what each position means. shorn takes that idea one step further, and the schema is what makes both steps safe.

Two details worth noticing. `2d` is age 45, and it comes first even though `name` was declared first, because fields are written in [canonical order](/core-concepts/canonical-bytes/), not declaration order. `00` is the index of `"F"` in the sorted enum `["F", "M", "X"]`. [Byte Layout](/wire-format/layout/) covers every wire type this way.

## The four steps

```
value ──▶ validate ──▶ wire plan ──▶ bytes
          (Standard    (Standard
           Schema)      JSON Schema)
```

1. **Your validator checks the value** through Standard Schema. That includes every rule you wrote, such as `.min(1)`, `.email()`, or `.refine()`.
2. **Standard JSON Schema supplies the structure**: field names, types, which fields are optional. shorn turns that into a wire plan once and caches it per schema object.
3. **The plan writes the values**, with no keys and no type tags.
4. **Decoding runs the same steps backwards**, and validates again with your original library.

A payload that decodes structurally but fails one of your rules is a `DecodeError`. It is never handed back as an accepted value.

Both interfaces are vendor-neutral. Standard Schema gives shorn `validate(value)`, and Standard JSON Schema gives it `jsonSchema.input()` and `.output()`. That is why shorn needs no code specific to any one validator. Where JSON Schema has no way to describe something, shorn adds one extension keyword of its own, `x-shorn`. That keyword is how `Date`, `bigint`, `Map` and `Set` reach the wire. What is left after that has no wire form at all: `undefined`, `NaN`, a symbol, a class instance. See [Date, BigInt, Map, Set](/schemas/rich-types/).

## The wire plan

The JSON Schema becomes a `WireShape`, a small closed set of cases:

```
any | boolean | float64 | int | string | uint | uuid
| { array } | { tuple } | { object, rejectUnknown } | { record }
| { enum }  | { literal } | { nullable } | { ref }
| { union, on, cases } | { union, types }
```

The two union cases are the two ways a branch can be identified without trying each one. `on`/`cases` means one property names the branch, a discriminant. `types` means the JSON type of the value names the branch. A union whose branches could overlap has neither, and is [refused](/schemas/rejected-shapes/#overlapping-unions).

A `{ ref }` is the back edge of a cycle in a recursive schema. It is the only shape that is not self-contained: it points into a table of definitions that the plan carries alongside its root shape. That table exists only when a `$ref` actually closes a cycle. A `$ref` that is reached twice but never through itself is simply inlined.

Two details decide most of what matters:

- **`type: "integer"` with `minimum >= 0`** becomes `uint`, a plain varint. Without the bound it becomes `int`, which uses ZigZag encoding and so crosses every size boundary at half the value.
- **`additionalProperties`** decides what happens to fields the schema does not name. `false` means the validator already handles them. If the keyword is absent, shorn refuses extras during encoding. `true` or a schema makes the object open.

shorn converts both `jsonSchema.input()` and `.output()` and compares them. If the two sides differ, the schema would need a codec that runs in two directions, and it is refused.

## Compiled, then signed

The `WireShape` becomes a tree of `Schema` objects. These are the same objects the [`m` API](/api/m/) builds by hand, which is why the two produce identical bytes.

Each node carries a `_minWidth`, the fewest bytes any value of that shape can occupy. That number lets an array refuse an impossible element count before allocating anything. See [Hostile Input](/hostile-input/).

A cycle is built definitions first, so a back edge can report its `_minWidth` before the cycle it closes exists. Those nodes are also where nesting depth is counted, because in a recursive schema the depth comes from the payload rather than the schema.

shorn also stores a canonical string signature: the `WireShape` written as JSON, minus `rejectUnknown`. Leaving that flag out lets equivalent Zod and ArkType schemas agree even though they handle extra properties differently. [`fingerprinted()`](/versioning/fingerprinting/) hashes this signature. An `m` codec has no signature, so `fingerprinted()` refuses it.

The plan is cached in a `WeakMap` keyed by the schema object, so conversion runs once per schema. See [Compilation and Caching](/core-concepts/compile-and-caching/).
