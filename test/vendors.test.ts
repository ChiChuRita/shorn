import { type } from "arktype";
import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { z } from "zod";
import { compile, type EncodableStandardSchema } from "../src/index.js";

// The zod-facing tests in standard.test.ts prove each wire shape once; this file
// proves the *vendors* agree. Each vendor spells the same JSON Schema differently
// (valibot goes through @valibot/to-json-schema, arktype through its own emitter),
// so a shape can work from zod's output and still fail from another's. One case
// per wire shape: round-trip under every vendor, and identical bytes across them.

interface VendorCase {
  readonly name: string;
  readonly zod: EncodableStandardSchema;
  readonly valibot: EncodableStandardSchema;
  readonly arktype?: EncodableStandardSchema;
  readonly values: readonly unknown[];
}

const fromValibot = (schema: v.GenericSchema): EncodableStandardSchema =>
  toStandardJsonSchema(schema) as EncodableStandardSchema;

const cases: readonly VendorCase[] = [
  {
    name: "scalars in an object",
    zod: z.object({ s: z.string(), i: z.int(), u: z.int().nonnegative(), f: z.number(), b: z.boolean() }),
    valibot: fromValibot(
      v.object({
        s: v.string(),
        i: v.pipe(v.number(), v.integer()),
        u: v.pipe(v.number(), v.integer(), v.minValue(0)),
        f: v.number(),
        b: v.boolean(),
      }),
    ),
    arktype: type({ s: "string", i: "number.integer", u: "number.integer >= 0", f: "number", b: "boolean" }),
    values: [
      { s: "hi", i: -3, u: 7, f: 1.5, b: true },
      { s: "", i: 0, u: 0, f: -0.25, b: false },
    ],
  },
  {
    name: "string literal",
    zod: z.literal("on"),
    valibot: fromValibot(v.literal("on")),
    arktype: type("'on'"),
    values: ["on"],
  },
  {
    name: "string enum",
    zod: z.enum(["red", "green", "blue"]),
    valibot: fromValibot(v.picklist(["red", "green", "blue"])),
    arktype: type("'red' | 'green' | 'blue'"),
    values: ["red", "blue"],
  },
  {
    name: "nullable string",
    zod: z.string().nullable(),
    valibot: fromValibot(v.nullable(v.string())),
    arktype: type("string | null"),
    values: ["x", null],
  },
  {
    name: "null field",
    zod: z.object({ error: z.null(), n: z.int() }),
    valibot: fromValibot(v.object({ error: v.null(), n: v.pipe(v.number(), v.integer()) })),
    arktype: type({ error: "null", n: "number.integer" }),
    values: [{ error: null, n: 7 }],
  },
  {
    name: "optional field",
    zod: z.object({ a: z.string(), b: z.int().optional() }),
    valibot: fromValibot(v.object({ a: v.string(), b: v.optional(v.pipe(v.number(), v.integer())) })),
    arktype: type({ a: "string", "b?": "number.integer" }),
    values: [{ a: "x", b: 2 }, { a: "x" }],
  },
  {
    name: "array of integers",
    zod: z.array(z.int()),
    valibot: fromValibot(v.array(v.pipe(v.number(), v.integer()))),
    arktype: type("number.integer[]"),
    values: [[], [1, -2, 3]],
  },
  {
    name: "fixed-length array",
    zod: z.array(z.int()).length(3),
    valibot: fromValibot(v.pipe(v.array(v.pipe(v.number(), v.integer())), v.length(3))),
    arktype: type("number.integer[] == 3"),
    values: [[1, 2, 3]],
  },
  {
    name: "tuple",
    zod: z.tuple([z.string(), z.int(), z.boolean()]),
    valibot: fromValibot(v.tuple([v.string(), v.pipe(v.number(), v.integer()), v.boolean()])),
    arktype: type(["string", "number.integer", "boolean"]),
    values: [["a", -1, true]],
  },
  {
    name: "record",
    zod: z.record(z.string(), z.int()),
    valibot: fromValibot(v.record(v.string(), v.pipe(v.number(), v.integer()))),
    arktype: type({ "[string]": "number.integer" }),
    values: [{}, { alpha: 1, beta: -2 }],
  },
  {
    name: "nested object",
    zod: z.object({ user: z.object({ name: z.string(), tags: z.array(z.string()) }) }),
    valibot: fromValibot(v.object({ user: v.object({ name: v.string(), tags: v.array(v.string()) }) })),
    arktype: type({ user: { name: "string", tags: "string[]" } }),
    values: [{ user: { name: "r", tags: ["a", "b"] } }],
  },
  {
    name: "discriminated union",
    zod: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("click"), x: z.int() }),
      z.object({ kind: z.literal("key"), code: z.string() }),
    ]),
    valibot: fromValibot(
      v.variant("kind", [
        v.object({ kind: v.literal("click"), x: v.pipe(v.number(), v.integer()) }),
        v.object({ kind: v.literal("key"), code: v.string() }),
      ]),
    ),
    arktype: type({ kind: "'click'", x: "number.integer" }).or({ kind: "'key'", code: "string" }),
    values: [
      { kind: "click", x: 3 },
      { kind: "key", code: "a" },
    ],
  },
  {
    name: "uuid",
    zod: z.uuid(),
    valibot: fromValibot(v.pipe(v.string(), v.uuid())),
    arktype: type("string.uuid"),
    values: ["0192e4c6-3c0e-7000-8000-0000000000ff"],
  },
  {
    name: "nullable uuid",
    zod: z.uuid().nullable(),
    valibot: fromValibot(v.nullable(v.pipe(v.string(), v.uuid()))),
    arktype: type("string.uuid | null"),
    values: ["0192e4c6-3c0e-7000-8000-0000000000ff", null],
  },
  {
    name: "dynamic value",
    zod: z.any(),
    valibot: fromValibot(v.any()),
    arktype: type("unknown"),
    values: [null, true, 1.5, "hi", [1, ["a"]], { b: 2 }],
  },
];

describe("every wire shape works from every vendor's JSON Schema", () => {
  for (const c of cases) {
    describe(c.name, () => {
      const vendors = Object.entries({ zod: c.zod, valibot: c.valibot, arktype: c.arktype }).filter(
        (entry): entry is [string, EncodableStandardSchema] => entry[1] !== undefined,
      );

      for (const [vendor, schema] of vendors) {
        it(`round-trips under ${vendor}`, () => {
          const codec = compile(schema);
          for (const value of c.values) {
            expect(codec.decode(codec.encode(value as never))).toEqual(value);
          }
        });
      }

      it("produces the same bytes under every vendor", () => {
        for (const value of c.values) {
          const encodings = vendors.map(
            ([vendor, schema]) => [vendor, [...compile(schema).encode(value as never)].join(",")] as const,
          );
          for (const [vendor, encoded] of encodings) {
            expect({ vendor, encoded }).toEqual({ vendor, encoded: encodings[0]![1] });
          }
        }
      });
    });
  }
});
