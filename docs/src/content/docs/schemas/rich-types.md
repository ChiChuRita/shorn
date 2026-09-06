---
title: Date, BigInt, Map, Set
description: All four have a native wire form, through the m builders and through compile(). JSON Schema has no keyword for them, so shorn adds one.
---

`Date`, `bigint`, `Map` and `Set` encode natively. A `Date` is 6 bytes, a `Set` costs what the same array costs, and none of the four needs converting at the edge of your application.

```ts
import { z } from "zod";
import { compile } from "@chichurita/shorn";

const Event = z.object({
  when: z.date(),
  id: z.bigint(),
  tags: z.set(z.string()),
  scores: z.map(z.string(), z.int()),
});

const codec = compile(Event);
codec.decode(codec.encode(value)); // a Date, a bigint, a Set and a Map back
```

JSON Schema has no keyword for any of these, and for a long time that was the whole reason they were refused. shorn now supplies one, `x-shorn`, and asks each validator to write it during conversion. See [the extension keyword](#the-x-shorn-keyword) for what it looks like.

## What each validator spells

| Wire shape | Zod | Valibot | ArkType | `m` |
| --- | --- | --- | --- | --- |
| `Date` | `z.date()` | `v.date()` | `"Date"` | `m.date()` |
| `bigint` | `z.bigint()` | `v.bigint()` | `"bigint"` | `m.bigint()` |
| `Set<T>` | `z.set(T)` | `v.set(T)` | refused | `m.set(T)` |
| `Map<K, V>` | `z.map(K, V)` | `v.map(K, V)` | refused | `m.map(K, V)` |
| `date-time` string | `z.iso.datetime()` | `v.pipe(v.string(), v.isoTimestamp())` | none | none |

Zod and ArkType need nothing beyond the schema. Valibot needs the [recipe below](#valibot), because its Standard JSON Schema wrapper takes no options. ArkType's `Set` and `Map` are [refused](/schemas/rejected-shapes/#arktypes-set-and-map), because those keywords carry no element type.

## The wire forms

| Shape | Bytes | Layout |
| --- | --- | --- |
| `Date` | 6 for any current date | epoch milliseconds as a ZigZag varint, exactly what an `int` writes |
| `date-time` string | 6, against about 25 as text | the same, decoded back to the `toISOString()` spelling |
| `bigint` | 1 header byte + one per magnitude byte | a varint header, then the magnitude little-endian |
| `Set<T>` | what `z.array(T)` costs | a varint count, then the elements in iteration order |
| `Map<K, V>` | what `z.array(z.tuple([K, V]))` costs | a varint count, then each key followed by its value |

```ts
m.date().encode(new Date("2026-09-03T12:00:00.000Z"));   // [128, 136, 159, 242, 140, 104]
m.bigint().encode(256n);                                  // [4, 0, 1]
m.set(m.string()).encode(new Set(["a", "b"]));            // [2, 1, 97, 1, 98]
m.map(m.string(), m.uint()).encode(new Map([["x", 1]]));  // [1, 1, 120, 1]
```

[Byte Layout](/wire-format/layout/#dates) walks through each one, the canonical rules, and what the decoder refuses.

A Set writes exactly the bytes an array of the same elements writes, and a Map exactly what an array of `[key, value]` tuples writes. What differs is what they decode to, and their [fingerprint](/versioning/fingerprinting/). A `{ set: T }` signature and an `{ array: T }` signature are deliberately different, so a payload written as one is never read back as the other.

Iteration order reaches the wire. Two Sets with the same members inserted in a different order write different payloads, and each decodes back to its own order.

## `date-time` strings

A `format: "date-time"` string is stored as the instant it names: 6 bytes instead of the 24 to 30 characters of text. Both `z.iso.datetime()` and a hand-written JSON Schema string with that format select it.

**Only the canonical spelling encodes.** A value must equal `new Date(value).toISOString()`. Anything else is refused:

```ts
const When = compile(z.object({ at: z.iso.datetime() }));

When.encode({ at: "2026-09-03T12:00:00.000Z" });      // 6 bytes
When.encode({ at: "2026-09-03T12:00:00Z" });          // refused: no fractional digits
When.encode({ at: "2026-09-03T12:00:00.000+02:00" }); // refused: an offset
When.encode({ at: "2026-09-03T12:00:00.000000Z" });   // refused: six fractional digits
```

> Expected a canonical ISO-8601 date-time (the toISOString() spelling), received X

This is the [UUID rule](/schemas/supported-types/#primitives) again. Epoch milliseconds cannot remember a fractional-digit count or an offset spelling, so exactly one spelling survives the round trip. Silently normalizing the others would make `decode(encode(x))` differ from `x`, which is the one property [canonical bytes](/core-concepts/canonical-bytes/) rest on. Call `toISOString()` at the edge. It is what `JSON.stringify` already does to a Date.

ArkType has no `format: "date-time"` spelling. Its `"string.date.iso"` converts to a pattern, so it stays an ordinary string.

:::caution[Wire-breaking for existing date-time schemas]
A `date-time` string used to travel as its text. A schema holding one now writes different bytes and derives a different fingerprint, so payloads written before this change cannot be read after it. Keep the old codec while old payloads exist; see [Schema Changes](/versioning/schema-evolution/).
:::

## Valibot

Valibot's `toStandardJsonSchema` takes no options, so there is no way to tag its Date, bigint, Set and Map through it. Use the raw converter instead. `valibotOverride` fills the converter's `overrideSchema` slot, and the plain document it returns is a valid `structure`:

```ts
import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";
import { compile, valibotOverride } from "@chichurita/shorn";

const Person = v.object({ when: v.date(), tags: v.set(v.string()) });

const structure = toJsonSchema(Person, { overrideSchema: valibotOverride(toJsonSchema) });
const codec = compile(Person, structure);
```

You pass the converter in rather than shorn importing it, for two reasons. shorn depends on no validator. And a Set inside a Set has to be converted through the same hook, or the inner one would throw where the outer one did not. Hoist `structure` to a module constant, as with any Valibot structure, so the codec stays [cached](/core-concepts/compile-and-caching/).

Without the override, Valibot's converter refuses these four before shorn sees anything. shorn keeps the reason and appends what to do about it.

## The `x-shorn` keyword

`x-shorn` is shorn's JSON Schema extension keyword. Its value is one of `"date"`, `"bigint"`, `"set"` or `"map"`. A set's element and a map's value sit under `items`, exactly where an array's element sits. A map's key sits under `x-shorn-key`. You can write it by hand:

```ts
const structure = {
  type: "object",
  properties: {
    when: { "x-shorn": "date" },
    tags: { "x-shorn": "set", items: { type: "string" } },
    scores: { "x-shorn": "map", "x-shorn-key": { type: "string" }, items: { type: "integer" } },
  },
  required: ["when", "tags", "scores"],
};
```

A node with the keyword needs no `type`, because there is no JSON type to name. Any other value is refused with `Unsupported x-shorn kind X`. This keyword is what each validator hook writes, so a document produced by `valibotOverride` and one written by hand compile to the same codec.

## Limits

**ArkType's `Set` and `Map`.** In ArkType both are keywords, and neither carries an element type, so there is nothing to say how the members should be encoded. They are refused by name rather than encoded as empty containers:

> ArkType's Set carries no element type, so there is nothing to encode its members as; convert it at the edge

**Recursion through a Set or Map.** A set's element is converted as a document of its own and inlined, so a `$ref` inside it would resolve against the wrong document. A recursive type reached that way is refused:

```ts
const Node = z.object({ get kids() { return z.set(Node); } });
compile(Node); // A recursive type inside a Set or Map is not supported
```

Put the recursion in an array or an object instead. Both support cycles; see [Recursive schemas](/schemas/supported-types/#recursive-schemas).

**Unions.** A [type-disjoint union](/schemas/supported-types/#type-disjoint-unions) picks its branch by the JSON type of the value, and none of these four has a JSON type. So `z.union([z.date(), z.string()])` is still refused as an overlapping union. `z.date().nullable()` is fine, and so is a Date inside a discriminated branch.

**Dynamic values.** `z.any()` still refuses a Date, a Map or a Set rather than writing it as the empty object it looks like. A dynamic value describes itself with a one-byte tag, and there is no tag for these.

## What still needs converting at the edge

| Schema | Why | Instead |
| --- | --- | --- |
| `z.undefined()`, `z.void()` | not a JSON value | `z.optional(T)`: one bit in the presence bitmap |
| `z.nan()` | no JSON Schema form for a NaN-only type | a nullable number |
| `z.symbol()` | no data to write | a string |
| `z.function()`, `z.custom()` | nothing to encode | the data the call would return |
| `RegExp` | no wire form worth fixing | the `source` and `flags` strings |
| `URL` | the same | the URL as a string |
| class instances | shorn writes data, not identity | an object of the fields you need |
| transforms, morphs | Standard Schema exposes no reverse direction | a bidirectional pair, below |

A `NaN` or an `Infinity` under a plain `z.number()` is a different matter. `float64` carries either one exactly, and it is Zod that rejects a non-finite number. What has no encoding is the same value used as an [enum member or a literal](/schemas/rejected-shapes/#empty-enums-and-members-with-no-json-text), where it is part of the schema rather than the data.

Zod's message names the type and is kept as it is: `undefined cannot be represented in JSON Schema`, and the same line for `void`, `nan`, `symbol`, `function`, `custom` and `transform`. Where a validator's converter throws something of its own, shorn keeps the reason and appends the remedy:

> \<the vendor's message\> (shorn has no wire form for this value; convert it at
the edge, see Rejected Shapes)

For a **transform**, `z.codec()` declares both directions in the schema itself:

```ts
const Rich = z.object({
  slug: z.codec(z.string(), z.string(), {
    decode: (text) => text.trim(),
    encode: (text) => text.trim(),
  }),
});

const Wire = z.object({ slug: z.string() });
const codec = fingerprinted(compile(Wire));

const bytes = codec.encode(z.encode(Rich, value)); // rich → wire → bytes
const back = z.decode(Rich, codec.decode(bytes));  // bytes → wire → rich
```

It takes two calls because Standard Schema v1 exposes only `validate` and `jsonSchema`. There is no reverse operation in it, and `z.encode` is Zod-specific, so shorn cannot run the conversion for you without validator-specific code. Valibot and ArkType transforms expose no reverse direction at all, so there you write both conversions by hand.

Passing a `structure` does not rescue a bidirectional codec either. Rich values fail validation as wire values, and wire values become rich values the wire codec cannot encode.

The [fingerprint](/versioning/fingerprinting/) identifies only the wire shape, so changing a conversion function without changing that shape does not change the fingerprint.
