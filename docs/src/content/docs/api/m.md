---
title: m Builders
description: Reference for the low-level wire builders, Reader and Writer, and Infer.
---

`m` builds a codec directly from the wire format, without Standard Schema or JSON Schema. Reach for it when no validation schema exists, when you need `m.bytes()` or `m.float32()`, or when you are writing a protocol fixture or custom codec.

```ts
import { m, type Infer } from "@chichurita/shorn";

const Point = m.object({ x: m.int(), y: m.int() });
type Point = Infer<typeof Point>; // { x: number; y: number }
```

It is an escape hatch, not a replacement for your validator: `m` checks only what encoding the wire format requires, and implements no refinements, business rules, or general validation. `fingerprinted()` cannot wrap an `m` codec, because there is no structural signature to hash.

## Primitives

| Builder | Type | Wire |
| --- | --- | --- |
| `m.string()` | `Schema<string>` | varint byte length + UTF-8 |
| `m.bytes()` | `Schema<Uint8Array>` | varint byte length + raw |
| `m.boolean()` | `Schema<boolean>` | one byte, `0` or `1` |
| `m.uint()` | `Schema<number>` | varint; non-negative safe integers |
| `m.int()` | `Schema<number>` | ZigZag varint |
| `m.float32()` | `Schema<number>` | 4 bytes, little-endian |
| `m.float64()` | `Schema<number>` | 8 bytes, little-endian |
| `m.date()` | `Schema<Date>` | epoch milliseconds as a ZigZag varint; 6 bytes for any current date |
| `m.bigint()` | `Schema<bigint>` | varint header (byte count doubled, plus the sign bit), then the magnitude little-endian |

`m.bytes()` and `m.float32()` have no JSON Schema form, so validator-backed codecs do not select them automatically. `m.date()` and `m.bigint()` do have one, through shorn's [`x-shorn` keyword](/schemas/rich-types/#the-x-shorn-keyword), so `compile()` reaches the same two classes.

:::caution[`m` does not tree-shake per builder]
`m` is a single object, so `import { m }` retains all sixteen builders whether you call two or sixteen, about 6.4 KB gzip. Bundlers cannot remove individual properties from a live object.
:::

## `m.date()`

```ts
m.date(): Schema<Date>;
```

The `Date`'s epoch milliseconds, ZigZag varint, exactly what `m.int()` writes. An **Invalid Date** is an `EncodeError`, since its time value is `NaN`; so is any other value, including a millisecond number. On decode a count outside ±8.64e15 is a `DecodeError`, because that is where a `Date`'s range ends and no `Date` names it.

A cross-realm `Date` from `node:vm`, an iframe or a worker is accepted through a tag check when `instanceof` fails.

## `m.bigint()`

```ts
m.bigint(): Schema<bigint>;
```

Any width up to a 64 MiB magnitude, the same ceiling `m.bytes()` has. Zero is one byte. The encoding is canonical on both sides: a header of `1`, which would be negative zero, and a magnitude with a zero high byte are both refused on decode as `Non-canonical bigint`. See [Byte Layout](/wire-format/layout/#bigints) for the table.

## `m.literal(value)`

```ts
m.literal<const T extends string | number | boolean | null>(value: T): Schema<T>;
```

Literals use zero bytes. They cannot be array elements because the decoder could not verify the declared element count against the payload length.

## `m.enum(values)`

```ts
m.enum<const T extends readonly [EnumValue, ...EnumValue[]]>(values: T): Schema<T[number]>;
```

A varint index into the **sorted, deduplicated** member list, so declaration order does not affect bytes. At least one member required; an index past the last is a `DecodeError`.

Members may be any scalar (string, number, boolean, or null), so `m.enum([200, 404])` is a one-byte index rather than two floats. An all-string enum sorts by value; any other sorts by each member's JSON text, since `<` is not a total order across mixed types. An enum listing `null` cannot be wrapped in `nullable()`, which would give null two encodings.

## `m.array(item, length?)`

```ts
m.array<T>(item: Schema<T>, length?: number): Schema<T[]>;
```

Writes a varint count followed by the elements in order. Codec construction fails if `item` can use zero bytes. Arrays are limited to 1,000,000 elements, and impossible counts are rejected before allocation.

Pass `length` for a fixed-size array: the count comes from the schema and is not written, and the element may be zero-width, exactly as in a tuple. `compile` selects this when `minItems` equals `maxItems`. An encoded value whose length disagrees is an `EncodeError`. A zero-width element makes the count answerable to the schema alone, so construction fails when the slots one would fill from no input — multiplied through nesting, summed through zero-width objects and tuples — pass 1,000,000.

## `m.set(item)`

```ts
m.set<T>(item: Schema<T>): Schema<Set<T>>;
```

A varint count, then the elements in iteration order. Byte-identical to `m.array(item)` over the same elements; the two differ in what they decode to and in their signature.

Construction fails if `item` can use zero bytes, exactly as `m.array` fails, and there is no fixed-count form to exempt it:

```
Set elements must occupy at least one byte
```

Sets are limited to 1,000,000 elements, and an impossible count is rejected before allocation. A **duplicate element** in the payload is a `DecodeError`: folding it would let one value re-encode to a shorter payload than the one it was read from.

## `m.map(key, value)`

```ts
m.map<K, V>(key: Schema<K>, value: Schema<V>): Schema<Map<K, V>>;
```

A varint count, then each key followed by its value, in iteration order. Byte-identical to `m.array(m.tuple([key, value]))`. The key may be any schema.

An entry must occupy at least one byte, counting **key and value together**, so `m.map(m.literal("x"), m.string())` builds and `m.map(m.literal("x"), m.literal("y"))` throws `Map entries must occupy at least one byte`. Same 1,000,000 ceiling as a Set, and a **duplicate key** is a `DecodeError` for the same reason.

## `m.tuple(items)`

```ts
m.tuple<const S extends readonly Schema<unknown>[]>(items: S): Schema<TupleOutput<S>>;
```

Elements only; length from the schema, positions never reordered. **May** contain zero-width elements, unlike `m.array`.

## `m.object(shape)`

```ts
m.object<S extends Shape>(shape: S): Schema<ObjectOutput<S>>;
```

Presence bitmap for optional fields (`ceil(n / 8)` bytes, omitted when nothing is optional), then values in **canonical key order**, UTF-16 ascending. Declaration order is irrelevant.

**Undeclared properties are dropped, not rejected.** `m.object({ a: m.uint() }).encode({ a: 1, extra: "x" })` writes one byte and decodes to `{ a: 1 }`. This matches Zod's own default, which strips unknown keys before shorn ever sees the value.

If an extra property should be an error instead, use a validator: `compile(z.strictObject({ … }))` rejects with `Unrecognized key: "extra"`. The `m` builders have no strict variant, since rejecting means scanning every key on every encode.

## `.optional()` and `.nullable()`

```ts
m.object({
  name: m.string(),
  nickname: m.string().optional(), // a bit in the presence bitmap
  manager: m.string().nullable(),  // discriminator byte, then the value
});
```

`optional()` is only meaningful as an object field: it *is* the bitmap bit. `nullable()` works anywhere and always costs one byte.

### Markers never stack

A second marker for a value the schema can already produce would give that value two encodings — `[0]` and `[1, 0]` would both decode to `undefined` — so shorn refuses it, in one of two ways.

**Repeating the same wrapper is a no-op.** It returns the identical object, so this is safe in generic code that does not know what it was handed:

```ts
const a = m.string().optional();
a.optional() === a; // true
```

**Producing a second marker for the same value throws an `EncodeError`** when the codec is built:

```ts
m.literal(null).nullable();                 // throws: already decodes to null
m.string().optional().nullable().optional(); // throws: already decodes to undefined
m.string().nullable().optional().nullable(); // throws: already decodes to null
compile(z.string().nullable()).nullable();   // throws, carried through compile
```

Both flags propagate through the other wrapper, `compile()`, and `fingerprinted()`, so a stack three deep is caught as readily as one. Mixing the two markers once is fine and is a real shape: `m.string().optional().nullable()` distinguishes absent from null.

## `Reader` and `Writer`

```ts
class Writer {
  byte(value: number): void;
  bytes(value: Uint8Array): void;
  varuint(value: number): void;
  varuintBigInt(value: bigint): void;
  string(value: string): void;
  float32(value: number): void;
  float64(value: number): void;
  finish(): Uint8Array;
  reset(): void;
}

class Reader {
  readonly position: number;
  readonly done: boolean;
  readonly remaining: number;
  byte(): number;
  bytes(length: number): Uint8Array;
  string(): string;
  varuint(): number;
  varuintWide(): number | bigint;
  float32(): number;
  float64(): number;
}
```

```ts
class Pair extends Schema<[number, number]> {
  _minWidth = 2; // fewest bytes a value can occupy

  _encode(writer: Writer, value: [number, number]) {
    writer.varuint(value[0]);
    writer.varuint(value[1]);
  }

  _decode(reader: Reader): [number, number] {
    return [reader.varuint(), reader.varuint()];
  }
}
```

Set `_minWidth` if the schema may be used as an array element. It lets `m.array` reject an impossible count before allocating. A schema with width 0 cannot be an array element.

`reader.bytes(n)` returns a **view over the input**, not a copy: it aliases the caller's `Uint8Array`, so anything you hand out of a custom codec must be copied first — `new Uint8Array(reader.bytes(n))`, which is what `m.bytes()` does. Read with `byte()` instead when you only need the values and would rather not allocate the view at all.

This surface is unstable: `_encode`, `_decode`, and `_minWidth` can change in a minor release.

## Types

```ts
type Infer<S extends Schema<unknown>> = S["_output"];
type Shape = Record<string, Schema<unknown>>;
type ObjectOutput<S extends Shape>; // the decoded object type for a shape
```

## Byte-compatible with `compile`

```ts
compile(z.object({ name: z.string(), age: z.int().nonnegative() }));
m.object({ name: m.string(), age: m.uint() });
// byte-identical output for the same value
```

`m` cannot override canonical field order or the enum index base, which keeps it byte-compatible with `compile`.
