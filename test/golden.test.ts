import { readFileSync } from "node:fs";
import { type } from "arktype";
import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { z } from "zod";
import { compile, m, type Schema } from "../src/index.js";

const bytes = (value: Uint8Array) => [...value];

/**
 * The `###` headings of docs/src/content/docs/wire-format/layout.md, which is where every
 * vector's `row` comes from. A parenthetical is dropped: "Records (keys the schema does
 * not name)" is the "Records" row.
 */
const layoutPage = new URL("../docs/src/content/docs/wire-format/layout.md", import.meta.url);
const documentedSections = [
  ...readFileSync(layoutPage, "utf8").matchAll(/^### (.+?)(?: \(.*\))?$/gm),
].map((match) => match[1]!);

/** The recursive example on the byte layout page: a tree through a `$ref` to the root. */
const Node = z.object({
  value: z.string(),
  get children() {
    return z.array(Node);
  },
});

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
  // `m.tuple` takes no rest element, so these come through `compile`.
  {
    row: "Tuples",
    name: "a rest element is written as an array after the fixed items",
    schema: compile(z.tuple([z.string()], z.int())),
    value: ["a", 1, 2],
    expected: [1, 97, 2, 2, 4],
  },
  {
    row: "Tuples",
    name: "an empty rest still writes its count",
    schema: compile(z.tuple([z.string()], z.int())),
    value: ["a"],
    expected: [1, 97, 0],
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
    row: "Arrays",
    name: "a fixed count is left out, as a tuple's is",
    schema: m.array(m.uint(), 3),
    value: [1, 2, 3],
    expected: [1, 2, 3],
  },
  {
    row: "Arrays",
    name: "a fixed count from minItems equal to maxItems",
    schema: compile(z.array(z.uint32()).length(3)),
    value: [1, 2, 3],
    expected: [1, 2, 3],
  },
  {
    row: "Arrays",
    name: "a fixed count of zero-width elements writes nothing",
    schema: m.array(m.literal("x"), 2),
    value: ["x", "x"],
    expected: [],
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
  // A numeric enum is ordered by each member's JSON text, not by `<`: "10" sorts before
  // "9", so the larger number takes the smaller index.
  {
    row: "Enums",
    name: "a numeric enum orders by JSON text, so 9 is index 1",
    schema: m.enum([9, 10]),
    value: 9,
    expected: [1],
  },
  {
    row: "Enums",
    name: "a numeric enum orders by JSON text, so 10 is index 0",
    schema: m.enum([9, 10]),
    value: 10,
    expected: [0],
  },
  // A mixed enum, the same rule: `"ok"` (a quote), `200`, `false`, `null`.
  {
    row: "Enums",
    name: "a mixed enum puts a string member first, by its quote",
    schema: m.enum([200, "ok", null, false]),
    value: "ok",
    expected: [0],
  },
  {
    row: "Enums",
    name: "a mixed enum puts a number before the keywords",
    schema: m.enum([200, "ok", null, false]),
    value: 200,
    expected: [1],
  },
  {
    row: "Enums",
    name: "a mixed enum puts false before null",
    schema: m.enum([200, "ok", null, false]),
    value: false,
    expected: [2],
  },
  {
    row: "Enums",
    name: "a mixed enum puts null last",
    schema: m.enum([200, "ok", null, false]),
    value: null,
    expected: [3],
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
  // Records, open objects, unions and dynamic values have no `m` builder, so everything
  // from here down comes through `compile`.
  {
    row: "Records",
    name: "count, then each key as a string before its value, keys sorted",
    schema: compile(z.record(z.string(), z.int())),
    value: { b: 2, a: 1 },
    expected: [2, 1, 97, 2, 1, 98, 4],
  },
  {
    row: "Records",
    name: "an empty record is the count alone",
    schema: compile(z.record(z.string(), z.int())),
    value: {},
    expected: [0],
  },
  {
    row: "Open objects",
    name: "nothing extra still pays the one-byte count",
    schema: compile(z.looseObject({ a: z.string() })),
    value: { a: "x" },
    expected: [1, 120, 0],
  },
  {
    row: "Open objects",
    name: "declared fields first, then the extras as a record of dynamic values",
    schema: compile(z.looseObject({ a: z.string() })),
    value: { a: "x", n: 5 },
    expected: [1, 120, 1, 1, 110, 3, 10],
  },
  {
    row: "Open objects",
    name: "extras are sorted like any record's keys",
    schema: compile(z.looseObject({ a: z.string() })),
    value: { a: "x", z: null, n: [true] },
    expected: [1, 120, 2, 1, 110, 6, 1, 2, 1, 122, 0],
  },
  {
    row: "Open objects",
    name: "a catchall's extras carry no tag, only their keys",
    schema: compile(z.object({ a: z.string() }).catchall(z.int())),
    value: { a: "x", n: 5 },
    expected: [1, 120, 1, 1, 110, 10],
  },
  {
    row: "Discriminated unions",
    name: "the branch index stands in for the discriminant, which writes nothing",
    schema: compile(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("click"), x: z.int() }),
        z.object({ kind: z.literal("key"), code: z.string() }),
      ]),
    ),
    value: { kind: "click", x: 3 },
    expected: [0, 6],
  },
  {
    row: "Discriminated unions",
    name: "branches are ordered by discriminant value, not declaration",
    schema: compile(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("key"), code: z.string() }),
        z.object({ kind: z.literal("click"), x: z.int() }),
      ]),
    ),
    value: { kind: "key", code: "a" },
    expected: [1, 1, 97],
  },
  {
    row: "Type-disjoint unions",
    name: "the index names the JSON type, and string sorts after number",
    schema: compile(z.union([z.string(), z.number()])),
    value: "hi",
    expected: [1, 2, 104, 105],
  },
  {
    row: "Type-disjoint unions",
    name: "a number branch is index 0, then its float64",
    schema: compile(z.union([z.string(), z.number()])),
    value: 42,
    expected: [0, 0, 0, 0, 0, 0, 0, 69, 64],
  },
  {
    row: "Type-disjoint unions",
    name: "every type name has its rank: array, boolean, null, object, string",
    schema: compile(
      z.union([z.object({ a: z.int() }), z.array(z.int()), z.string(), z.null(), z.boolean()]),
    ),
    value: null,
    expected: [2],
  },
  // The page shows `[1, 97, 0]` here, `value` first. Fields go in canonical key order and
  // `children` sorts before `value`, so the child count leads: these are the bytes the
  // encoder writes, and the ones every payload already stored holds.
  {
    row: "Recursive schemas",
    name: "a leaf writes only its own fields, children first",
    schema: compile(Node),
    value: { value: "a", children: [] },
    expected: [0, 1, 97],
  },
  {
    row: "Recursive schemas",
    name: "each level is inlined where its parent holds it",
    schema: compile(Node),
    value: { value: "a", children: [{ value: "b", children: [] }] },
    expected: [1, 0, 1, 98, 1, 97],
  },
  {
    row: "Dynamic values",
    name: "tag 0 is null",
    schema: compile(z.any()),
    value: null,
    expected: [0],
  },
  {
    row: "Dynamic values",
    name: "tag 1 is false",
    schema: compile(z.any()),
    value: false,
    expected: [1],
  },
  {
    row: "Dynamic values",
    name: "tag 2 is true",
    schema: compile(z.any()),
    value: true,
    expected: [2],
  },
  {
    row: "Dynamic values",
    name: "tag 3 is a safe integer, ZigZag",
    schema: compile(z.any()),
    value: 5,
    expected: [3, 10],
  },
  {
    row: "Dynamic values",
    name: "tag 4 is any other number, float64",
    schema: compile(z.any()),
    value: 1.5,
    expected: [4, 0, 0, 0, 0, 0, 0, 248, 63],
  },
  {
    row: "Dynamic values",
    name: "-0 takes tag 4, since tag 3 has no sign to keep",
    schema: compile(z.any()),
    value: -0,
    expected: [4, 0, 0, 0, 0, 0, 0, 0, 128],
  },
  {
    row: "Dynamic values",
    name: "an integer past the safe range takes tag 4",
    schema: compile(z.any()),
    value: 2 ** 53,
    expected: [4, 0, 0, 0, 0, 0, 0, 64, 67],
  },
  {
    row: "Dynamic values",
    name: "tag 5 is a string",
    schema: compile(z.any()),
    value: "hi",
    expected: [5, 2, 104, 105],
  },
  {
    row: "Dynamic values",
    name: "tag 6 is an array of tagged values",
    schema: compile(z.any()),
    value: [1, "a"],
    expected: [6, 2, 3, 2, 5, 1, 97],
  },
  {
    row: "Dynamic values",
    name: "an array nested in an array",
    schema: compile(z.any()),
    value: [[]],
    expected: [6, 1, 6, 0],
  },
  {
    row: "Dynamic values",
    name: "tag 7 is an object, as a record of tagged values",
    schema: compile(z.any()),
    value: { a: 1 },
    expected: [7, 1, 1, 97, 3, 2],
  },
  {
    row: "Dynamic values",
    name: "nested objects and arrays, keys sorted at every level",
    schema: compile(z.any()),
    value: { b: [null], a: {} },
    expected: [7, 2, 1, 97, 7, 0, 1, 98, 6, 1, 0],
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

  // The sections are read off the page rather than listed here, so a section added there
  // without a vector fails, and so does a vector filed under a heading the page no longer
  // has. "Optional marker" is the one row outside it: a standalone `m.string().optional()`,
  // which no JSON Schema can produce and which the page has no section for.
  it("covers every section of the byte layout page, and files every vector under one", () => {
    const covered = new Set(vectors.map((vector) => vector.row));
    expect(documentedSections).toContain("Records");
    expect([...covered].sort()).toEqual([...documentedSections, "Optional marker"].sort());
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
