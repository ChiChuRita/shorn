import { type, scope } from "arktype";
import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { z } from "zod";
import {
  DecodeError,
  EncodeError,
  compile,
  type EncodableStandardSchema,
} from "../src/index.js";
import { containsNaN } from "./generate.js";

/**
 * The cross-vendor fuzz matrix.
 *
 * `vendors.test.ts` proves one case per wire shape agrees across vendors; this file is
 * the wide version — every shape a vendor can spell, especially the ones whose bytes
 * depend on the payload rather than on the schema (unions, `any`, records, recursion) —
 * crossed with the decoder contract from `fuzz.test.ts`: truncate it, extend it, flip
 * every byte, and it either throws a `DecodeError` or decodes to something that
 * re-encodes to exactly those bytes.
 *
 * A missing vendor on a case means that vendor cannot spell the shape, and the comment
 * on the case says which and why. Do not fill one in without checking it emits the same
 * JSON Schema shape — a silently different shape passes its own round-trip and fails the
 * byte-equality assertion, which is the point of running all three.
 */

interface Case {
  readonly name: string;
  readonly zod?: EncodableStandardSchema;
  readonly valibot?: EncodableStandardSchema;
  readonly arktype?: EncodableStandardSchema;
  /** Values every listed vendor accepts. */
  readonly values: readonly unknown[];
  /** Values `encode` must refuse — the validator half, which the bytes never see. */
  readonly invalid?: readonly unknown[];
}

const val = (schema: v.GenericSchema): EncodableStandardSchema =>
  toStandardJsonSchema(schema) as EncodableStandardSchema;

const vint = v.pipe(v.number(), v.integer());
const vuint = v.pipe(v.number(), v.integer(), v.minValue(0));

const UUID = "0192e4c6-3c0e-7000-8000-0000000000ff";

// Recursive spellings, one per vendor. Zod points the cycle at the root through a
// getter; valibot needs the type written out because `lazy` is opaque to inference;
// arktype needs a scope, since a bare `type` has no name to refer back to.
const zodTree = z.object({
  value: z.string(),
  get children() {
    return z.array(zodTree);
  },
});
const zodList = z.object({
  name: z.string(),
  get next() {
    return zodList.nullable();
  },
});

type VTree = { value: string; children: VTree[] };
const valibotTree: v.GenericSchema<VTree> = v.object({
  value: v.string(),
  children: v.array(v.lazy(() => valibotTree)),
});
type VList = { name: string; next: VList | null };
const valibotList: v.GenericSchema<VList> = v.object({
  name: v.string(),
  next: v.nullable(v.lazy(() => valibotList)),
});

const arkTree = scope({ tree: { value: "string", children: "tree[]" } }).export().tree;
const arkList = scope({ list: { name: "string", next: "list | null" } }).export().list;

const KEYS9 = ["a", "b", "c", "d", "e", "f", "g", "h", "i"] as const;
const ENUM_BIG = Array.from({ length: 200 }, (_, i) => `v${String(i).padStart(3, "0")}`) as [
  string,
  ...string[],
];

const cases: readonly Case[] = [
  // ---------------------------------------------------------------- scalars
  {
    name: "string",
    zod: z.string(),
    valibot: val(v.string()),
    arktype: type("string"),
    values: ["", "x", "héllo", "\u{1F600}", "x".repeat(500)],
    invalid: [1, null, undefined, {}],
  },
  {
    name: "int",
    zod: z.int(),
    valibot: val(vint),
    arktype: type("number.integer"),
    values: [0, 1, -1, 127, -128, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER],
    invalid: [1.5, "1", NaN],
  },
  {
    name: "uint",
    zod: z.int().nonnegative(),
    valibot: val(vuint),
    arktype: type("number.integer >= 0"),
    values: [0, 1, 127, 128, 16_384, Number.MAX_SAFE_INTEGER],
    invalid: [-1, 1.5],
  },
  {
    name: "uint from a positive bound",
    // `.positive()` is `exclusiveMinimum: 0`, the other spelling of the same floor.
    zod: z.int().positive(),
    valibot: val(v.pipe(v.number(), v.integer(), v.minValue(1))),
    values: [1, 2, 1000],
    invalid: [0, -1],
  },
  {
    name: "float64",
    zod: z.number(),
    valibot: val(v.number()),
    arktype: type("number"),
    values: [0, -0, 1.5, -1.5, 1e300, 5e-324],
    invalid: ["1", null],
  },
  {
    // Zod is left out on purpose: `z.number()` is finite-only, so Infinity never
    // reaches the encoder from it. The other two pass it straight through.
    name: "non-finite float64",
    valibot: val(v.number()),
    arktype: type("number"),
    values: [Infinity, -Infinity],
  },
  {
    name: "boolean",
    zod: z.boolean(),
    valibot: val(v.boolean()),
    arktype: type("boolean"),
    values: [true, false],
    invalid: [0, "true"],
  },
  {
    name: "null",
    zod: z.null(),
    valibot: val(v.null()),
    arktype: type("null"),
    values: [null],
    invalid: [undefined, 0],
  },
  {
    name: "uuid",
    zod: z.uuid(),
    valibot: val(v.pipe(v.string(), v.uuid())),
    arktype: type("string.uuid"),
    values: [UUID, "00000000-0000-0000-0000-000000000000"],
    invalid: ["not-a-uuid", ""],
  },
  {
    name: "any",
    zod: z.any(),
    valibot: val(v.any()),
    arktype: type("unknown"),
    values: [
      null,
      true,
      false,
      0,
      -1,
      1.5,
      "",
      "hi",
      [],
      [1, "a", null, [2, { b: true }]],
      {},
      { a: 1, b: [null, { c: "d" }] },
    ],
  },
  {
    name: "unknown",
    zod: z.unknown(),
    valibot: val(v.unknown()),
    values: [null, 1, "x", [1], { a: 1 }],
  },

  // --------------------------------------------------------------- literals
  {
    name: "literal string",
    zod: z.literal("on"),
    valibot: val(v.literal("on")),
    arktype: type("'on'"),
    values: ["on"],
    invalid: ["off", 1],
  },
  {
    name: "literal number",
    zod: z.literal(7),
    valibot: val(v.literal(7)),
    arktype: type("7"),
    values: [7],
    invalid: [8, "7"],
  },
  {
    name: "literal true",
    zod: z.literal(true),
    valibot: val(v.literal(true)),
    arktype: type("true"),
    values: [true],
    invalid: [false],
  },
  {
    name: "literal null",
    zod: z.literal(null),
    valibot: val(v.null()),
    arktype: type("null"),
    values: [null],
  },
  {
    name: "enum of three",
    zod: z.enum(["red", "green", "blue"]),
    valibot: val(v.picklist(["red", "green", "blue"])),
    arktype: type("'red' | 'green' | 'blue'"),
    values: ["red", "green", "blue"],
    invalid: ["pink"],
  },
  {
    name: "enum past the one-byte index",
    zod: z.enum(ENUM_BIG),
    valibot: val(v.picklist([...ENUM_BIG])),
    values: [ENUM_BIG[0], ENUM_BIG[127], ENUM_BIG[128], ENUM_BIG[199]],
    invalid: ["v200"],
  },

  // ------------------------------------------------------- nullable/optional
  {
    name: "nullable string",
    zod: z.string().nullable(),
    valibot: val(v.nullable(v.string())),
    arktype: type("string | null"),
    values: [null, "", "x"],
    invalid: [undefined, 1],
  },
  {
    name: "nullable any",
    // `any` already decodes to null, so the marker is dropped rather than doubled.
    zod: z.any().nullable(),
    valibot: val(v.nullable(v.any())),
    values: [null, 1, "x", { a: null }],
  },
  {
    name: "nullable array of objects",
    zod: z.array(z.object({ a: z.int() })).nullable(),
    valibot: val(v.nullable(v.array(v.object({ a: vint })))),
    arktype: type({ a: "number.integer" }).array().or("null"),
    values: [null, [], [{ a: 1 }, { a: -2 }]],
  },
  {
    name: "nullable nested in an object, beside an optional",
    zod: z.object({ a: z.string().nullable(), b: z.int().optional(), c: z.boolean() }),
    valibot: val(v.object({ a: v.nullable(v.string()), b: v.optional(vint), c: v.boolean() })),
    arktype: type({ a: "string | null", "b?": "number.integer", c: "boolean" }),
    values: [
      { a: null, c: true },
      { a: "x", b: 1, c: false },
      { a: null, b: -1, c: true },
    ],
  },
  {
    name: "optional nullable field",
    zod: z.object({ a: z.string().nullable().optional() }),
    valibot: val(v.object({ a: v.optional(v.nullable(v.string())) })),
    arktype: type({ "a?": "string | null" }),
    values: [{}, { a: null }, { a: "x" }],
  },
  {
    name: "nine optional fields, two bitmap bytes",
    zod: z.object(Object.fromEntries(KEYS9.map((k) => [k, z.int().optional()]))),
    valibot: val(v.object(Object.fromEntries(KEYS9.map((k) => [k, v.optional(vint)])))),
    values: [
      {},
      { a: 1 },
      { i: 9 },
      Object.fromEntries(KEYS9.map((k, index) => [k, index])),
      { a: 1, e: 5, i: 9 },
    ],
  },

  // --------------------------------------------------------------- containers
  {
    name: "array of strings",
    zod: z.array(z.string()),
    valibot: val(v.array(v.string())),
    arktype: type("string[]"),
    values: [[], ["a"], ["", "b", "ç"], Array.from({ length: 40 }, (_, i) => `s${i}`)],
    invalid: [null, [1]],
  },
  {
    name: "fixed-length array",
    zod: z.array(z.int()).length(3),
    valibot: val(v.pipe(v.array(vint), v.length(3))),
    arktype: type("number.integer[] == 3"),
    values: [[1, 2, 3], [0, 0, 0]],
    invalid: [[1, 2], [1, 2, 3, 4]],
  },
  {
    name: "array of arrays",
    zod: z.array(z.array(z.int())),
    valibot: val(v.array(v.array(vint))),
    arktype: type("number.integer[][]"),
    values: [[], [[]], [[1], [], [2, 3]]],
  },
  {
    name: "array of objects",
    zod: z.array(z.object({ a: z.string(), b: z.int().optional() })),
    valibot: val(v.array(v.object({ a: v.string(), b: v.optional(vint) }))),
    arktype: type({ a: "string", "b?": "number.integer" }).array(),
    values: [[], [{ a: "x" }], [{ a: "x", b: 1 }, { a: "y" }]],
  },
  {
    name: "array of any",
    zod: z.array(z.any()),
    valibot: val(v.array(v.any())),
    arktype: type("unknown[]"),
    values: [[], [null], [1, "a", [true], { b: null }]],
  },
  {
    name: "array of unknown",
    zod: z.array(z.unknown()),
    valibot: val(v.array(v.unknown())),
    values: [[], [null, 1, "a"]],
  },
  {
    name: "array of nullable strings",
    zod: z.array(z.string().nullable()),
    valibot: val(v.array(v.nullable(v.string()))),
    arktype: type("(string | null)[]"),
    values: [[], [null], ["a", null, ""]],
  },
  {
    name: "two hundred elements, past the one-byte count",
    zod: z.array(z.int()),
    valibot: val(v.array(vint)),
    arktype: type("number.integer[]"),
    values: [Array.from({ length: 200 }, (_, i) => i - 100)],
  },
  {
    name: "a string past the two-byte length varint",
    zod: z.string(),
    valibot: val(v.string()),
    arktype: type("string"),
    values: ["ü".repeat(20_000)],
  },
  {
    name: "tuple",
    zod: z.tuple([z.string(), z.int(), z.boolean()]),
    valibot: val(v.tuple([v.string(), vint, v.boolean()])),
    arktype: type(["string", "number.integer", "boolean"]),
    // A fourth element is not on the invalid list: valibot's `tuple` is loose and
    // accepts it, and shorn then writes the three declared slots and drops it.
    values: [["a", -1, true], ["", 0, false]],
    invalid: [["a", -1]],
  },
  {
    name: "tuple with rest",
    zod: z.tuple([z.string()], z.int()),
    valibot: val(v.tupleWithRest([v.string()], vint)),
    arktype: type(["string", "...", "number.integer[]"]),
    values: [["a"], ["a", 1], ["a", 1, -2, 3]],
  },
  {
    name: "tuple of mixed containers",
    zod: z.tuple([z.array(z.int()), z.object({ a: z.string() }), z.any()]),
    valibot: val(v.tuple([v.array(vint), v.object({ a: v.string() }), v.any()])),
    values: [
      [[], { a: "" }, null],
      [[1, 2], { a: "x" }, { deep: [1, null] }],
    ],
  },
  {
    name: "record of ints",
    zod: z.record(z.string(), z.int()),
    valibot: val(v.record(v.string(), vint)),
    arktype: type({ "[string]": "number.integer" }),
    values: [{}, { a: 1 }, { a: 1, b: -2, "": 0, "é": 3 }],
  },
  {
    name: "record of objects",
    zod: z.record(z.string(), z.object({ n: z.int() })),
    valibot: val(v.record(v.string(), v.object({ n: vint }))),
    arktype: type({ "[string]": { n: "number.integer" } }),
    values: [{}, { a: { n: 1 } }, { a: { n: 1 }, b: { n: -2 } }],
  },
  {
    name: "record of any",
    zod: z.record(z.string(), z.any()),
    valibot: val(v.record(v.string(), v.any())),
    values: [{}, { a: null }, { a: [1, { b: "c" }], d: true }],
  },
  {
    name: "open object: declared fields plus a catchall",
    zod: z.object({ a: z.string() }).catchall(z.int()),
    valibot: val(v.objectWithRest({ a: v.string() }, vint)),
    values: [{ a: "x" }, { a: "x", b: 1 }, { a: "x", b: 1, c: -2 }],
  },
  {
    name: "nested objects",
    zod: z.object({
      user: z.object({ name: z.string(), tags: z.array(z.string()) }),
      meta: z.object({ n: z.int(), inner: z.object({ f: z.boolean() }) }),
    }),
    valibot: val(
      v.object({
        user: v.object({ name: v.string(), tags: v.array(v.string()) }),
        meta: v.object({ n: vint, inner: v.object({ f: v.boolean() }) }),
      }),
    ),
    arktype: type({
      user: { name: "string", tags: "string[]" },
      meta: { n: "number.integer", inner: { f: "boolean" } },
    }),
    values: [{ user: { name: "r", tags: [] }, meta: { n: 0, inner: { f: false } } }],
  },
  {
    name: "object whose only field is a literal, so it writes no bytes",
    zod: z.object({ kind: z.literal("only") }),
    valibot: val(v.object({ kind: v.literal("only") })),
    arktype: type({ kind: "'only'" }),
    values: [{ kind: "only" }],
  },
  {
    name: "strict object",
    zod: z.strictObject({ a: z.string(), b: z.int() }),
    valibot: val(v.strictObject({ a: v.string(), b: vint })),
    values: [{ a: "x", b: -1 }],
  },
  {
    // valibot is left out: `looseObject` emits no `additionalProperties` at all, which
    // shorn reads as a closed object, so an extra property throws rather than riding
    // along. Same source intent, different bytes per vendor — see "known gaps".
    name: "loose object: declared fields plus an any-typed catchall",
    zod: z.looseObject({ a: z.string() }),
    values: [{ a: "x" }, { a: "x", b: 1 }, { a: "x", b: [null, { c: true }] }],
  },
  {
    name: "empty object",
    zod: z.object({}),
    valibot: val(v.object({})),
    values: [{}],
  },
  {
    name: "twenty required fields with unicode keys",
    zod: z.object(
      Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`kü${i}`, z.int()])),
    ),
    valibot: val(
      v.object(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`kü${i}`, vint]))),
    ),
    values: [Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`kü${i}`, i - 10]))],
  },
  {
    name: "optional array, optional record, optional object",
    zod: z.object({
      xs: z.array(z.int()).optional(),
      map: z.record(z.string(), z.int()).optional(),
      obj: z.object({ a: z.string() }).optional(),
    }),
    valibot: val(
      v.object({
        xs: v.optional(v.array(vint)),
        map: v.optional(v.record(v.string(), vint)),
        obj: v.optional(v.object({ a: v.string() })),
      }),
    ),
    values: [{}, { xs: [] }, { xs: [1], map: {}, obj: { a: "" } }, { map: { k: 1 } }],
  },
  {
    name: "nullable record and nullable nested object",
    zod: z.object({
      map: z.record(z.string(), z.int()).nullable(),
      obj: z.object({ a: z.string() }).nullable(),
    }),
    valibot: val(
      v.object({
        map: v.nullable(v.record(v.string(), vint)),
        obj: v.nullable(v.object({ a: v.string() })),
      }),
    ),
    values: [
      { map: null, obj: null },
      { map: { a: 1 }, obj: { a: "x" } },
    ],
  },

  // ------------------------------------------------------------------ unions
  {
    name: "discriminated union, two branches",
    zod: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("click"), x: z.int() }),
      z.object({ kind: z.literal("key"), code: z.string() }),
    ]),
    valibot: val(
      v.variant("kind", [
        v.object({ kind: v.literal("click"), x: vint }),
        v.object({ kind: v.literal("key"), code: v.string() }),
      ]),
    ),
    arktype: type({ kind: "'click'", x: "number.integer" }).or({
      kind: "'key'",
      code: "string",
    }),
    values: [
      { kind: "click", x: 3 },
      { kind: "key", code: "a" },
    ],
    invalid: [{ kind: "other" }, { kind: "click", x: "3" }],
  },
  {
    name: "discriminated union, four branches of unlike shape",
    zod: z.discriminatedUnion("t", [
      z.object({ t: z.literal("a") }),
      z.object({ t: z.literal("b"), items: z.array(z.int()) }),
      z.object({ t: z.literal("c"), nested: z.object({ deep: z.string().nullable() }) }),
      z.object({ t: z.literal("d"), free: z.any() }),
    ]),
    valibot: val(
      v.variant("t", [
        v.object({ t: v.literal("a") }),
        v.object({ t: v.literal("b"), items: v.array(vint) }),
        v.object({ t: v.literal("c"), nested: v.object({ deep: v.nullable(v.string()) }) }),
        v.object({ t: v.literal("d"), free: v.any() }),
      ]),
    ),
    values: [
      { t: "a" },
      { t: "b", items: [] },
      { t: "b", items: [1, -2] },
      { t: "c", nested: { deep: null } },
      { t: "c", nested: { deep: "x" } },
      { t: "d", free: [1, { a: null }] },
    ],
  },
  {
    name: "discriminated union on a numeric discriminant",
    zod: z.discriminatedUnion("v", [
      z.object({ v: z.literal(1), a: z.string() }),
      z.object({ v: z.literal(2), b: z.int() }),
    ]),
    valibot: val(
      v.variant("v", [
        v.object({ v: v.literal(1), a: v.string() }),
        v.object({ v: v.literal(2), b: vint }),
      ]),
    ),
    values: [
      { v: 1, a: "x" },
      { v: 2, b: -1 },
    ],
  },
  {
    name: "discriminated union nested in an object and an array",
    zod: z.object({
      events: z.array(
        z.discriminatedUnion("k", [
          z.object({ k: z.literal("n"), n: z.int() }),
          z.object({ k: z.literal("s"), s: z.string() }),
        ]),
      ),
    }),
    valibot: val(
      v.object({
        events: v.array(
          v.variant("k", [
            v.object({ k: v.literal("n"), n: vint }),
            v.object({ k: v.literal("s"), s: v.string() }),
          ]),
        ),
      }),
    ),
    values: [
      { events: [] },
      { events: [{ k: "n", n: 1 }, { k: "s", s: "a" }, { k: "n", n: -3 }] },
    ],
  },
  {
    name: "type-disjoint union: string, number, boolean",
    zod: z.union([z.string(), z.number(), z.boolean()]),
    valibot: val(v.union([v.string(), v.number(), v.boolean()])),
    arktype: type("string | number | boolean"),
    values: ["", "x", 0, 1.5, true, false],
    invalid: [null, [], {}],
  },
  {
    name: "type-disjoint union: object, array, string, null",
    zod: z.union([z.object({ a: z.int() }), z.array(z.int()), z.string(), z.null()]),
    valibot: val(v.union([v.object({ a: vint }), v.array(vint), v.string(), v.null()])),
    values: [{ a: 1 }, [], [1, 2], "x", null],
  },
  {
    name: "type-disjoint union inside an array",
    zod: z.array(z.union([z.string(), z.number()])),
    valibot: val(v.array(v.union([v.string(), v.number()]))),
    arktype: type("(string | number)[]"),
    values: [[], ["a"], ["a", 1, "b", 2.5]],
  },
  {
    name: "nullable discriminated union",
    zod: z
      .discriminatedUnion("k", [
        z.object({ k: z.literal("a"), n: z.int() }),
        z.object({ k: z.literal("b") }),
      ])
      .nullable(),
    valibot: val(
      v.nullable(
        v.variant("k", [v.object({ k: v.literal("a"), n: vint }), v.object({ k: v.literal("b") })]),
      ),
    ),
    values: [null, { k: "a", n: 1 }, { k: "b" }],
  },
  {
    name: "discriminated union with a union-typed field in one branch",
    zod: z.discriminatedUnion("k", [
      z.object({ k: z.literal("a"), payload: z.union([z.string(), z.number()]) }),
      z.object({ k: z.literal("b"), payload: z.any() }),
    ]),
    valibot: val(
      v.variant("k", [
        v.object({ k: v.literal("a"), payload: v.union([v.string(), v.number()]) }),
        v.object({ k: v.literal("b"), payload: v.any() }),
      ]),
    ),
    values: [
      { k: "a", payload: "x" },
      { k: "a", payload: 1.5 },
      { k: "b", payload: null },
      { k: "b", payload: { deep: [1] } },
    ],
  },
  {
    name: "optional field holding a discriminated union",
    zod: z.object({
      hit: z
        .discriminatedUnion("k", [
          z.object({ k: z.literal("a") }),
          z.object({ k: z.literal("b"), n: z.int() }),
        ])
        .optional(),
    }),
    valibot: val(
      v.object({
        hit: v.optional(
          v.variant("k", [
            v.object({ k: v.literal("a") }),
            v.object({ k: v.literal("b"), n: vint }),
          ]),
        ),
      }),
    ),
    values: [{}, { hit: { k: "a" } }, { hit: { k: "b", n: 2 } }],
  },
  {
    name: "record whose values are a type-disjoint union",
    zod: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    valibot: val(v.record(v.string(), v.union([v.string(), v.number(), v.boolean()]))),
    values: [{}, { a: "x" }, { a: "x", b: 1.5, c: true }],
  },
  {
    name: "union of two literals with unlike types",
    zod: z.union([z.literal("a"), z.literal(1)]),
    valibot: val(v.union([v.literal("a"), v.literal(1)])),
    values: ["a", 1],
    invalid: ["b", 2],
  },
  {
    name: "type-disjoint union whose object branch holds a discriminated union",
    zod: z.union([
      z.string(),
      z.object({
        inner: z.discriminatedUnion("k", [
          z.object({ k: z.literal("a") }),
          z.object({ k: z.literal("b"), n: z.int() }),
        ]),
      }),
    ]),
    valibot: val(
      v.union([
        v.string(),
        v.object({
          inner: v.variant("k", [
            v.object({ k: v.literal("a") }),
            v.object({ k: v.literal("b"), n: vint }),
          ]),
        }),
      ]),
    ),
    values: ["x", { inner: { k: "a" } }, { inner: { k: "b", n: -1 } }],
  },
  {
    name: "tuple holding a union, a nullable and a record",
    zod: z.tuple([
      z.union([z.string(), z.number()]),
      z.boolean().nullable(),
      z.record(z.string(), z.int()),
    ]),
    valibot: val(
      v.tuple([
        v.union([v.string(), v.number()]),
        v.nullable(v.boolean()),
        v.record(v.string(), vint),
      ]),
    ),
    values: [
      ["x", null, {}],
      [1.5, true, { a: 1 }],
    ],
  },

  // --------------------------------------------------------------- recursion
  {
    name: "recursive tree",
    zod: zodTree,
    valibot: val(valibotTree),
    arktype: arkTree as unknown as EncodableStandardSchema,
    values: [
      { value: "", children: [] },
      { value: "r", children: [{ value: "a", children: [{ value: "b", children: [] }] }] },
      {
        value: "wide",
        children: Array.from({ length: 5 }, (_, i) => ({ value: `c${i}`, children: [] })),
      },
    ],
  },
  {
    name: "recursive list through a nullable back-edge",
    zod: zodList,
    valibot: val(valibotList),
    arktype: arkList as unknown as EncodableStandardSchema,
    values: [
      { name: "a", next: null },
      { name: "a", next: { name: "b", next: { name: "c", next: null } } },
    ],
  },
  {
    name: "recursion under an array of objects",
    zod: z.object({ roots: z.array(zodTree) }),
    valibot: val(v.object({ roots: v.array(valibotTree) })),
    values: [{ roots: [] }, { roots: [{ value: "a", children: [{ value: "b", children: [] }] }] }],
  },
  {
    name: "recursion in a discriminated union branch",
    zod: z.discriminatedUnion("k", [
      z.object({ k: z.literal("leaf"), v: z.int() }),
      z.object({ k: z.literal("tree"), t: zodTree }),
    ]),
    valibot: val(
      v.variant("k", [
        v.object({ k: v.literal("leaf"), v: vint }),
        v.object({ k: v.literal("tree"), t: valibotTree }),
      ]),
    ),
    values: [
      { k: "leaf", v: 1 },
      { k: "tree", t: { value: "r", children: [] } },
    ],
  },

  // ------------------------------------------------------------------- depth
  {
    name: "eight levels of nesting",
    zod: z.object({
      a: z.object({
        b: z.object({
          c: z.object({
            d: z.object({ e: z.object({ f: z.object({ g: z.array(z.int()) }) }) }),
          }),
        }),
      }),
    }),
    valibot: val(
      v.object({
        a: v.object({
          b: v.object({
            c: v.object({
              d: v.object({ e: v.object({ f: v.object({ g: v.array(vint) }) }) }),
            }),
          }),
        }),
      }),
    ),
    values: [{ a: { b: { c: { d: { e: { f: { g: [] } } } } } } }, { a: { b: { c: { d: { e: { f: { g: [1, -2] } } } } } } }],
  },
  {
    name: "a realistic message: every shape at once",
    zod: z.object({
      id: z.uuid(),
      seq: z.int().nonnegative(),
      kind: z.enum(["create", "update", "delete"]),
      body: z.discriminatedUnion("t", [
        z.object({ t: z.literal("text"), text: z.string() }),
        z.object({ t: z.literal("blob"), size: z.int().nonnegative(), meta: z.record(z.string(), z.string()) }),
      ]),
      tags: z.array(z.string()),
      trace: z.string().nullable(),
      extra: z.any().optional(),
    }),
    valibot: val(
      v.object({
        id: v.pipe(v.string(), v.uuid()),
        seq: vuint,
        kind: v.picklist(["create", "update", "delete"]),
        body: v.variant("t", [
          v.object({ t: v.literal("text"), text: v.string() }),
          v.object({ t: v.literal("blob"), size: vuint, meta: v.record(v.string(), v.string()) }),
        ]),
        tags: v.array(v.string()),
        trace: v.nullable(v.string()),
        extra: v.optional(v.any()),
      }),
    ),
    values: [
      {
        id: UUID,
        seq: 0,
        kind: "create",
        body: { t: "text", text: "" },
        tags: [],
        trace: null,
      },
      {
        id: UUID,
        seq: 4_000_000,
        kind: "delete",
        body: { t: "blob", size: 12, meta: { a: "1", b: "2" } },
        tags: ["x", "ü"],
        trace: "abc",
        extra: { nested: [1, null, { deep: true }] },
      },
    ],
  },
];

const REPLACEMENTS = [0x00, 0x01, 0x02, 0x7f, 0x80, 0xff];
/** Mutating every byte of a long payload buys nothing the first stretch has not shown. */
const MUTATION_LIMIT = 96;

function listVendors(c: Case): ReadonlyArray<readonly [string, EncodableStandardSchema]> {
  return Object.entries({ zod: c.zod, valibot: c.valibot, arktype: c.arktype }).filter(
    (entry): entry is [string, EncodableStandardSchema] => entry[1] !== undefined,
  );
}

describe("cross-vendor fuzz", () => {
  for (const c of cases) {
    const vendors = listVendors(c);

    describe(c.name, () => {
      for (const [vendor, schema] of vendors) {
        it(`${vendor}: round-trips canonically`, () => {
          const codec = compile(schema);
          for (const value of c.values) {
            const bytes = codec.encode(value as never);
            const decoded = codec.decode(bytes);
            expect(decoded).toEqual(value);
            expect([...codec.encode(decoded as never)]).toEqual([...bytes]);
          }
        });

        it(`${vendor}: survives truncation, extension and every byte flip`, () => {
          const codec = compile(schema);
          for (const value of c.values) {
            const bytes = codec.encode(value as never);

            // Every prefix of a short payload; a stride over a long one, since
            // slicing 20 kB once per byte is quadratic and shows nothing new.
            const step = Math.max(1, Math.ceil(bytes.length / 512));
            for (let length = 0; length < bytes.length; length += step) {
              const prefix = bytes.slice(0, length);
              let decoded: unknown;
              try {
                decoded = codec.decode(prefix);
              } catch (error) {
                expect(error).toBeInstanceOf(DecodeError);
                expect(Number.isSafeInteger((error as DecodeError).offset)).toBe(true);
                continue;
              }
              // A shorter prefix is a legal encoding only if it re-encodes to itself.
              expect([...codec.encode(decoded as never)]).toEqual([...prefix]);
            }

            for (const suffix of [[0], [0xff], [0, 0]]) {
              const extended = Uint8Array.from([...bytes, ...suffix]);
              expect(() => codec.decode(extended)).toThrow(DecodeError);
            }

            for (let index = 0; index < Math.min(bytes.length, MUTATION_LIMIT); index++) {
              for (const replacement of REPLACEMENTS) {
                if (bytes[index] === replacement) continue;
                const mutated = Uint8Array.from(bytes);
                mutated[index] = replacement;
                let decoded: unknown;
                try {
                  decoded = codec.decode(mutated);
                } catch (error) {
                  expect(error).toBeInstanceOf(DecodeError);
                  continue;
                }
                if (containsNaN(decoded)) continue;
                expect([...codec.encode(decoded as never)]).toEqual([...mutated]);
              }
            }
          }
        });

        if (c.invalid !== undefined) {
          it(`${vendor}: refuses values the validator rejects`, () => {
            const codec = compile(schema);
            for (const value of c.invalid!) {
              expect(() => codec.encode(value as never)).toThrow(EncodeError);
            }
          });
        }
      }

      if (vendors.length > 1) {
        it("agrees on bytes and on the fingerprint signature across vendors", () => {
          const codecs = vendors.map(([vendor, schema]) => [vendor, compile(schema)] as const);
          {
            const signatures = codecs.map(([vendor, codec]) => [vendor, codec.signature] as const);
            for (const [vendor, signature] of signatures) {
              expect({ vendor, signature }).toEqual({ vendor, signature: signatures[0]![1] });
            }
          }
          for (const value of c.values) {
            const encodings = codecs.map(
              ([vendor, codec]) => [vendor, [...codec.encode(value as never)].join(",")] as const,
            );
            for (const [vendor, encoded] of encodings) {
              expect({ vendor, encoded }).toEqual({ vendor, encoded: encodings[0]![1] });
            }
          }
        });

        it("decodes every vendor's bytes with every other vendor's codec", () => {
          const codecs = vendors.map(([, schema]) => compile(schema));
          for (const value of c.values) {
            for (const writer of codecs) {
              const bytes = writer.encode(value as never);
              for (const reader of codecs) expect(reader.decode(bytes)).toEqual(value);
            }
          }
        });
      }
    });
  }
});

describe("refusals are the same from every vendor", () => {
  const refusals: ReadonlyArray<{
    readonly name: string;
    readonly zod: () => unknown;
    /** Absent when valibot's JSON Schema does not describe the same thing. */
    readonly valibot?: () => unknown;
    readonly message: RegExp;
  }> = [
    {
      name: "a union of two branches sharing a JSON type",
      zod: () => compile(z.union([z.string(), z.string().max(2)])),
      valibot: () => compile(val(v.union([v.string(), v.pipe(v.string(), v.maxLength(2))]))),
      message: /nullable, discriminated and type-disjoint/,
    },
    {
      name: "a union of integer and number, which no value tells apart",
      zod: () => compile(z.union([z.int(), z.number()])),
      valibot: () => compile(val(v.union([vint, v.number()]))),
      message: /nullable, discriminated and type-disjoint/,
    },
    {
      // The field does not survive either vendor's JSON Schema: valibot's key sets the
      // prototype of `properties`, zod's is dropped from `properties` and left in
      // `required`. Both used to compile to an object missing the field, and an
      // unvalidated codec then dropped its value on the wire without a word.
      //
      // Only the *required* spelling is refusable. Optional under zod, the field leaves
      // no trace at all in the document — nothing shorn can see — so it is still
      // silently absent from the bytes. That one has to be fixed in zod.
      name: "a field named __proto__, which no vendor's JSON Schema can carry",
      zod: () => compile(z.object({ ["__proto__"]: z.string(), safe: z.int() })),
      valibot: () => compile(val(v.object({ ["__proto__"]: v.string(), safe: vint }))),
      message: /"__proto__" property does not survive/,
    },
    {
      // valibot has no entry: it writes the default as a `default` keyword on an
      // optional property, identical on both sides, so the field simply compiles as
      // optional and the validator fills it on the way in.
      name: "a default, whose input and output shapes differ",
      zod: () => compile(z.object({ a: z.string().default("x") })),
      message: /different input and output wire shapes|bidirectional/,
    },
    {
      name: "a Date, which JSON Schema cannot spell",
      zod: () => compile(z.date()),
      valibot: () => compile(val(v.date())),
      message: /shorn encodes the wire shape/,
    },
  ];

  for (const refusal of refusals) {
    it(refusal.name, () => {
      expect(refusal.zod).toThrow(EncodeError);
      expect(refusal.zod).toThrow(refusal.message);
      if (refusal.valibot === undefined) return;
      expect(refusal.valibot).toThrow(EncodeError);
      expect(refusal.valibot).toThrow(refusal.message);
    });
  }
});

/**
 * Known gaps, pinned with `it.fails` so the suite stays green today and turns red the
 * moment one is fixed — at which point flip the test to a normal `it`. Each one is a
 * disagreement between vendors over a shape shorn otherwise supports.
 */
describe("known gaps", () => {
  it("compiles an arktype array of unknown, which carries no `items`", () => {
    // `type("unknown[]")` emits a bare `{type:"array"}`. JSON Schema leaves the items
    // unconstrained there, which is what `any` already means to shorn — zod and valibot
    // both write `items: {}` and compile. Refusing it makes `unknown[]` vendor-specific.
    const codec = compile(type("unknown[]") as unknown as EncodableStandardSchema);
    expect(codec.decode(codec.encode([1, "x"] as never))).toEqual([1, "x"]);
  });

  it.fails("carries extra properties out of a valibot looseObject", () => {
    // valibot emits no `additionalProperties`, which shorn reads as a closed object, so
    // the extras a `looseObject` exists to keep are refused. Zod's `looseObject` emits
    // `additionalProperties: {}` and keeps them. One intent, two wire shapes.
    const codec = compile(val(v.looseObject({ a: v.string() })));
    expect(codec.decode(codec.encode({ a: "x", b: 1 } as never))).toEqual({ a: "x", b: 1 });
  });

  it("gives one recursive type one fingerprint, whichever vendor wrote it", () => {
    // Same bytes, different signature: zod refs its definition from the use site while
    // valibot inlines one unrolling there and refs from inside it. `toWireShape` folds
    // only a *root* that duplicates a definition, so a recursive type reached through a
    // wrapper keeps two spellings — and `fingerprinted()` then rejects bytes it can
    // decode, which is the false positive it exists to not produce.
    const zodCodec = compile(z.object({ roots: z.array(zodTree) }));
    const valibotCodec = compile(val(v.object({ roots: v.array(valibotTree) })));
    const value = { roots: [{ value: "a", children: [{ value: "b", children: [] }] }] };
    expect([...valibotCodec.encode(value as never)]).toEqual([...zodCodec.encode(value as never)]);
    expect(valibotCodec.signature).toBe(zodCodec.signature);
  });
});
