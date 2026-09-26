import { type } from "arktype";
import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { z } from "zod";
import { compile, m, type Schema } from "../src/index.js";

const bytes = (value: Uint8Array) => [...value];

interface Vector {
  readonly row: string;
  readonly name: string;
  readonly schema: Schema<unknown>;
  readonly value: unknown;
  readonly expected: readonly number[];
}

const vectors: readonly Vector[] = [
  {
    row: "Objects",
    name: "Person, sorted keys and canonical enum index",
    schema: m.object({ name: m.string(), age: m.uint(), sex: m.enum(["M", "F", "X"]) }),
    value: { name: "Rahul", age: 25, sex: "M" },
    expected: [25, 5, 82, 97, 104, 117, 108, 1],
  },
  {
    row: "Objects",
    name: "declaration order is not wire order",
    schema: m.object({ b: m.uint(), a: m.string() }),
    value: { a: "hi", b: 300 },
    expected: [2, 104, 105, 172, 2],
  },
  {
    row: "Objects",
    name: "sorting recurses at every level",
    schema: m.object({ z: m.object({ y: m.boolean(), x: m.uint() }), a: m.boolean() }),
    value: { a: true, z: { x: 1, y: false } },
    expected: [1, 1, 0],
  },
  {
    row: "Objects",
    name: "empty object is zero bytes",
    schema: m.object({}),
    value: {},
    expected: [],
  },
  {
    row: "Objects",
    name: "three optionals, middle absent",
    schema: m.object({
      b: m.uint().optional(),
      a: m.string(),
      c: m.uint().optional(),
      d: m.uint().optional(),
    }),
    value: { a: "x", b: 1, d: 3 },
    expected: [0b101, 1, 120, 1, 3],
  },
  {
    row: "Objects",
    name: "bitmap is fixed width and always emitted",
    schema: m.object({
      b: m.uint().optional(),
      a: m.string(),
      c: m.uint().optional(),
      d: m.uint().optional(),
    }),
    value: { a: "x" },
    expected: [0, 1, 120],
  },
  {
    row: "Objects",
    name: "nine optionals span two bitmap bytes",
    schema: m.object({
      a: m.uint().optional(),
      b: m.uint().optional(),
      c: m.uint().optional(),
      d: m.uint().optional(),
      e: m.uint().optional(),
      f: m.uint().optional(),
      g: m.uint().optional(),
      h: m.uint().optional(),
      i: m.uint().optional(),
    }),
    value: { i: 5 },
    expected: [0, 1, 5],
  },
  {
    row: "Objects",
    name: "optional rank follows canonical key order",
    schema: m.object({ id: m.uint(), nickname: m.string().optional(), email: m.string().optional() }),
    value: { id: 7, email: "a@b.co" },
    expected: [0b01, 6, 97, 64, 98, 46, 99, 111, 7],
  },
  {
    row: "Objects",
    name: "a nullable field takes no bitmap bit and keeps its own marker",
    schema: m.object({ n: m.boolean().nullable(), o: m.uint().optional(), r: m.string() }),
    value: { n: null, r: "x" },
    expected: [0, 0, 1, 120],
  },
  {
    row: "Objects",
    name: "bitmap width counts optionals only, not nullables",
    schema: m.object({ n: m.boolean().nullable(), o: m.uint().optional(), r: m.string() }),
    value: { n: null, o: 9, r: "x" },
    expected: [1, 0, 9, 1, 120],
  },
  {
    row: "Objects",
    name: "a non-null nullable writes marker then value",
    schema: m.object({ n: m.boolean().nullable(), o: m.uint().optional(), r: m.string() }),
    value: { n: true, r: "x" },
    expected: [0, 1, 1, 1, 120],
  },
  {
    row: "Dates",
    name: "epoch milliseconds as a ZigZag varint",
    schema: m.date(),
    value: new Date("2026-09-03T12:00:00.000Z"),
    expected: [128, 136, 159, 242, 140, 104],
  },
  {
    row: "Dates",
    name: "the epoch itself is one byte",
    schema: m.date(),
    value: new Date(0),
    expected: [0],
  },
  {
    row: "Dates",
    name: "a millisecond before the epoch takes the odd ZigZag half",
    schema: m.date(),
    value: new Date(-1),
    expected: [1],
  },
  {
    row: "Dates",
    name: "a date-time string takes the same bytes as the Date it names",
    schema: compile(z.iso.datetime()),
    value: "2026-09-03T12:00:00.000Z",
    expected: [128, 136, 159, 242, 140, 104],
  },
  {
    row: "BigInts",
    name: "zero is the header alone",
    schema: m.bigint(),
    value: 0n,
    expected: [0],
  },
  {
    row: "BigInts",
    name: "one byte of magnitude, header 2 for one byte and positive",
    schema: m.bigint(),
    value: 255n,
    expected: [2, 255],
  },
  {
    row: "BigInts",
    name: "the sign rides in the header's low bit",
    schema: m.bigint(),
    value: -1n,
    expected: [3, 1],
  },
  {
    row: "BigInts",
    name: "magnitude is little-endian",
    schema: m.bigint(),
    value: 256n,
    expected: [4, 0, 1],
  },
  {
    row: "BigInts",
    name: "past 64 bits, where the varint reader stops",
    schema: m.bigint(),
    value: 2n ** 64n,
    expected: [18, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  },
  {
    row: "Sets",
    name: "count then elements, the array layout",
    schema: m.set(m.string()),
    value: new Set(["a", "b"]),
    expected: [2, 1, 97, 1, 98],
  },
  {
    row: "Sets",
    name: "an empty set is the count alone",
    schema: m.set(m.uint()),
    value: new Set(),
    expected: [0],
  },
  {
    row: "Maps",
    name: "count then key value pairs",
    schema: m.map(m.string(), m.uint()),
    value: new Map([["x", 1], ["y", 300]]),
    expected: [2, 1, 120, 1, 1, 121, 172, 2],
  },
  {
    row: "Maps",
    name: "insertion order is wire order",
    schema: m.map(m.string(), m.uint()),
    value: new Map([["y", 300], ["x", 1]]),
    expected: [2, 1, 121, 172, 2, 1, 120, 1],
  },
  {
    row: "Tuples",
    name: "declared order, no count",
    schema: m.tuple([m.uint(), m.uint()]),
    value: [1, 2],
    expected: [1, 2],
  },
  {
    row: "Tuples",
    name: "positions are never reordered",
    schema: m.tuple([m.string(), m.boolean(), m.int()]),
    value: ["hi", true, -1],
    expected: [2, 104, 105, 1, 1],
  },
  {
    row: "Arrays",
    name: "count then tagless elements",
    schema: m.array(m.uint()),
    value: [1, 2],
    expected: [2, 1, 2],
  },
  {
    row: "Arrays",
    name: "empty array is the count byte alone",
    schema: m.array(m.uint()),
    value: [],
    expected: [0],
  },
  {
    row: "Arrays",
    name: "each variable-length element carries its own length",
    schema: m.array(m.string()),
    value: ["a", "bb"],
    expected: [2, 1, 97, 2, 98, 98],
  },
  {
    row: "Strings and bytes",
    name: "an ascii string",
    schema: m.string(),
    value: "hi",
    expected: [2, 104, 105],
  },
  {
    row: "Strings and bytes",
    name: "empty string is the length byte alone",
    schema: m.string(),
    value: "",
    expected: [0],
  },
  {
    row: "Strings and bytes",
    name: "length is UTF-8 bytes, not code units",
    schema: m.string(),
    value: "hé",
    expected: [3, 104, 195, 169],
  },
  {
    row: "Strings and bytes",
    name: "astral code point",
    schema: m.string(),
    value: "\u{1F600}",
    expected: [4, 240, 159, 152, 128],
  },
  {
    row: "Integers",
    name: "unsigned zero",
    schema: m.uint(),
    value: 0,
    expected: [0],
  },
  {
    row: "Integers",
    name: "largest single-byte unsigned value",
    schema: m.uint(),
    value: 127,
    expected: [127],
  },
  {
    row: "Integers",
    name: "least significant group first",
    schema: m.uint(),
    value: 128,
    expected: [128, 1],
  },
  {
    row: "Integers",
    name: "two groups",
    schema: m.uint(),
    value: 300,
    expected: [172, 2],
  },
  {
    row: "Integers",
    name: "three groups",
    schema: m.uint(),
    value: 16384,
    expected: [128, 128, 1],
  },
  {
    row: "Integers",
    name: "widest safe unsigned integer",
    schema: m.uint(),
    value: Number.MAX_SAFE_INTEGER,
    expected: [255, 255, 255, 255, 255, 255, 255, 15],
  },
  {
    row: "Integers",
    name: "zigzag zero",
    schema: m.int(),
    value: 0,
    expected: [0],
  },
  {
    row: "Integers",
    name: "zigzag minus one",
    schema: m.int(),
    value: -1,
    expected: [1],
  },
  {
    row: "Integers",
    name: "zigzag one",
    schema: m.int(),
    value: 1,
    expected: [2],
  },
  {
    row: "Integers",
    name: "zigzag multi-byte negative",
    schema: m.int(),
    value: -100,
    expected: [199, 1],
  },
  {
    row: "Booleans",
    name: "false is zero",
    schema: m.boolean(),
    value: false,
    expected: [0],
  },
  {
    row: "Booleans",
    name: "true is one",
    schema: m.boolean(),
    value: true,
    expected: [1],
  },
  {
    row: "Enums",
    name: "index is the rank in canonical order",
    schema: m.enum(["M", "F", "X"]),
    value: "M",
    expected: [1],
  },
  {
    row: "Enums",
    name: "uppercase sorts before lowercase",
    schema: m.enum(["a", "B"]),
    value: "B",
    expected: [0],
  },
  {
    row: "Literals",
    name: "a literal contributes no bytes",
    schema: m.literal("x"),
    value: "x",
    expected: [],
  },
  {
    row: "Literals",
    name: "zero width beside a sibling field",
    schema: m.object({ a: m.literal("x"), z: m.uint() }),
    value: { a: "x", z: 7 },
    expected: [7],
  },
  {
    row: "Literals",
    name: "present optional literal still consumes a bitmap bit",
    schema: m.object({ a: m.literal("x").optional(), z: m.uint() }),
    value: { a: "x", z: 7 },
    expected: [1, 7],
  },
  {
    row: "Literals",
    name: "absent optional literal is distinguishable",
    schema: m.object({ a: m.literal("x").optional(), z: m.uint() }),
    value: { z: 7 },
    expected: [0, 7],
  },
  {
    row: "Nullable",
    name: "null is marker zero",
    schema: m.string().nullable(),
    value: null,
    expected: [0],
  },
  {
    row: "Nullable",
    name: "present is marker one then the value",
    schema: m.string().nullable(),
    value: "x",
    expected: [1, 1, 120],
  },
  {
    row: "Floats",
    name: "float64 little-endian",
    schema: m.float64(),
    value: 1.5,
    expected: [0, 0, 0, 0, 0, 0, 248, 63],
  },
  {
    row: "Floats",
    name: "float64 preserves negative zero",
    schema: m.float64(),
    value: -0,
    expected: [0, 0, 0, 0, 0, 0, 0, 128],
  },
  {
    row: "Floats",
    name: "float32 little-endian (m only, unreachable from a JSON Schema)",
    schema: m.float32(),
    value: 1.5,
    expected: [0, 0, 192, 63],
  },
  {
    row: "Strings and bytes",
    name: "bytes are a length then raw content (m only, unreachable from a JSON Schema)",
    schema: m.bytes(),
    value: new Uint8Array([0x00, 0xff, 0x7f]),
    expected: [3, 0, 255, 127],
  },
  {
    row: "Strings and bytes",
    name: "empty bytes are the length byte alone",
    schema: m.bytes(),
    value: new Uint8Array([]),
    expected: [0],
  },
  {
    row: "Optional marker",
    name: "a standalone optional uses a marker, not a bitmap (m only)",
    schema: m.string().optional(),
    value: "x",
    expected: [1, 1, 120],
  },
  {
    row: "Optional marker",
    name: "an absent standalone optional is one byte",
    schema: m.string().optional(),
    value: undefined,
    expected: [0],
  },
  {
    row: "Optional marker",
    name: "an optional array element uses the marker form",
    schema: m.array(m.string().optional()),
    value: ["x", undefined],
    expected: [2, 1, 1, 120, 0],
  },
];

describe("golden vectors", () => {
  for (const vector of vectors) {
    it(`${vector.row}: ${vector.name}`, () => {
      const encoded = vector.schema.encode(vector.value);
      expect(bytes(encoded)).toEqual([...vector.expected]);
      expect(vector.schema.decode(encoded)).toEqual(vector.value);
    });
  }

  it("covers every row of the documented wire format", () => {
    const covered = new Set(vectors.map((vector) => vector.row));
    expect([...covered].sort()).toEqual([
      "Arrays",
      "BigInts",
      "Booleans",
      "Dates",
      "Enums",
      "Floats",
      "Integers",
      "Literals",
      "Maps",
      "Nullable",
      "Objects",
      "Optional marker",
      "Sets",
      "Strings and bytes",
      "Tuples",
    ]);
  });
});

describe("canonical bytes hold across every entry point", () => {
  const value = { name: "Rahul", age: 25, sex: "M" as const };
  const expected = [25, 5, 82, 97, 104, 117, 108, 1];

  const zodPerson = z.object({
    name: z.string(),
    age: z.int().nonnegative(),
    sex: z.enum(["M", "F", "X"]),
  });
  const arkPerson = type({
    name: "string",
    age: "number.integer >= 0",
    sex: "'M' | 'F' | 'X'",
  });
  const valibotPerson = v.object({
    name: v.string(),
    age: v.pipe(v.number(), v.integer(), v.minValue(0)),
    sex: v.picklist(["M", "F", "X"]),
  });

  it("the m seam matches the absolute golden bytes", () => {
    const wire = m.object({ name: m.string(), age: m.uint(), sex: m.enum(["M", "F", "X"]) });
    expect(bytes(wire.encode(value))).toEqual(expected);
  });

  it("every vendor matches the same absolute golden bytes", () => {
    expect(bytes(compile(zodPerson).encode(value))).toEqual(expected);
    expect(bytes(compile(arkPerson).encode(value))).toEqual(expected);
    expect(
      bytes(compile(valibotPerson, toStandardJsonSchema(valibotPerson)).encode(value)),
    ).toEqual(expected);
  });

  it("the m seam and the compile seam agree when field declaration order differs", () => {
    const declared = m.object({ sex: m.enum(["X", "M", "F"]), name: m.string(), age: m.uint() });
    expect(bytes(declared.encode(value))).toEqual(bytes(compile(zodPerson).encode(value)));
  });

  it("agrees for optional fields, where the bitmap index base could drift", () => {
    const wire = m.object({
      nickname: m.string().optional(),
      id: m.uint(),
      email: m.string().optional(),
    });
    const standard = compile(
      z.object({ nickname: z.string().optional(), id: z.int().nonnegative(), email: z.string().optional() }),
    );
    const partial = { id: 7, email: "a@b.co" };
    expect(bytes(wire.encode(partial))).toEqual(bytes(standard.encode(partial)));
  });
});

describe("field values are read as own properties only", () => {
  const schema = m.object({ toString: m.string().optional(), a: m.uint() });

  it("a prototype member is never observed as a present field", () => {
    const nullPrototype = Object.create(null) as { a: number };
    nullPrototype.a = 7;
    // `{ a: 7 }` inherits Object.prototype.toString, so TypeScript rejects it
    // against a `toString?: string` field for the same reason the encoder used
    // to mis-read it. The cast is the point of the test.
    const plain = { a: 7 } as never;
    expect(bytes(schema.encode(plain))).toEqual(bytes(schema.encode(nullPrototype as never)));
    expect(bytes(schema.encode(plain))).toEqual([0, 7]);
  });

  it("holds for every Object.prototype member name", () => {
    for (const key of [
      "toString",
      "constructor",
      "valueOf",
      "hasOwnProperty",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
    ]) {
      const wire = m.object({ [key]: m.string().optional(), a: m.uint() });
      expect(bytes(wire.encode({ a: 1 } as never))).toEqual([0, 1]);
    }
  });

  it("keeps encode after decode a fixed point for a __proto__ optional field", () => {
    const shape = Object.create(null) as Record<string, Schema<unknown>>;
    shape["__proto__"] = m.uint().optional() as unknown as Schema<unknown>;
    shape["a"] = m.uint();
    const wire = m.object(shape);

    const first = wire.encode({ a: 7 } as never);
    expect(bytes(first)).toEqual([0, 7]);
    const second = wire.encode(wire.decode(first) as never);
    expect(bytes(second)).toEqual(bytes(first));
  });

  it("treats an explicitly undefined property as absent", () => {
    const wire = m.object({ a: m.uint(), b: m.uint().optional() });
    const explicit = { a: 1, b: undefined } as never;
    expect(bytes(wire.encode(explicit))).toEqual(bytes(wire.encode({ a: 1 })));
  });
});

describe("the canonical comparator is pinned", () => {
  it("orders by UTF-16 code unit, not by code point", () => {
    const wire = m.object({ "\u{1F600}": m.uint(), "Ａ": m.uint() });
    expect(bytes(wire.encode({ "\u{1F600}": 1, "Ａ": 2 }))).toEqual([1, 2]);
  });

  it("orders uppercase before lowercase and digits before letters", () => {
    const wire = m.object({ b: m.uint(), A: m.uint(), a: m.uint(), B: m.uint(), "_x": m.uint() });
    const encoded = wire.encode({ A: 1, B: 2, _x: 3, a: 4, b: 5 });
    expect(bytes(encoded)).toEqual([1, 2, 3, 4, 5]);
  });

  it("never mutates a caller-owned enum declaration", () => {
    const values: [string, string] = ["B", "A"];
    const wire = m.enum(values);
    expect(values).toEqual(["B", "A"]);
    expect(bytes(wire.encode("A"))).toEqual([0]);
  });

  it("pins the astral ordering rule through the compile seam too", () => {
    const schema = z.object({ "\u{1F600}": z.int().nonnegative(), "Ａ": z.int().nonnegative() });
    expect(bytes(compile(schema).encode({ "\u{1F600}": 1, "Ａ": 2 }))).toEqual([1, 2]);
  });

  it("never mutates a caller-owned tuple declaration", () => {
    const items = [m.string(), m.uint()] as const as unknown as [
      ReturnType<typeof m.string>,
      ReturnType<typeof m.uint>,
    ];
    const wire = m.tuple(items);
    items.reverse();
    expect(bytes(wire.encode(["x", 1]))).toEqual([1, 120, 1]);
  });
});
