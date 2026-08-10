import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  compile,
  fingerprinted,
  type Infer,
  m,
  type Schema,
} from "../src/index.js";
import * as shorn from "../src/index.js";
import { mulberry32, schemaGen } from "./generate.js";

/**
 * The axes where a regression is a *changed number*, not a thrown error.
 *
 * `golden.test.ts` pins the bytes of the shapes someone wrote down. This pins the
 * bytes of two thousand generated shapes as one digest, the payload size of the
 * documented schemas as exact integers, and the public surface as an exact list.
 * A refactor that is byte-identical leaves every value here untouched; one that is
 * not names precisely what moved.
 *
 * When a change is intentional, update the constant in the same commit — the
 * diff is then the wire-format change, reviewable on its own.
 */

const digest = (input: string): string =>
  createHash("sha256").update(input).digest("hex").slice(0, 16);

describe("wire format digest over generated shapes", () => {
  /**
   * 2,000 seeded (schema, value) pairs hashed into one string.
   *
   * Deliberately not a per-case snapshot: the point is a single value that changes
   * if and only if some byte, somewhere, changed. `WIRE_DIGEST_SAMPLE` below turns
   * a failure into a diffable list, so the digest costs nothing to diagnose.
   */
  const WIRE_DIGEST = "b6072d833e3ee48a";

  function corpus(count: number): string[] {
    const lines: string[] = [];
    for (let seed = 1; seed <= count; seed++) {
      const rng = mulberry32(seed * 2_654_435_761);
      const gen = schemaGen(rng, 4);
      const value = gen.sample(rng);
      lines.push(`${seed}:${[...gen.schema.encode(value)].join(",")}`);
    }
    return lines;
  }

  it("hashes to a pinned value", () => {
    const lines = corpus(2000);
    const actual = digest(lines.join("\n"));
    if (actual !== WIRE_DIGEST) {
      // Name the first divergence rather than only the hash, so the failure says
      // which shape moved instead of "some byte changed somewhere".
      const sample = lines.slice(0, 5).join("\n  ");
      throw new Error(
        `Wire format digest changed: expected ${WIRE_DIGEST}, got ${actual}.\n` +
          `If this is intentional, update WIRE_DIGEST in this file in the same commit.\n` +
          `First encodings for reference:\n  ${sample}`,
      );
    }
  });
});

describe("payload size is pinned per documented schema", () => {
  // The headline claim is bytes on the wire. Any of these growing is a regression
  // even when every test still passes.
  const person = m.object({ age: m.uint(), name: m.string(), sex: m.enum(["F", "M", "X"]) });
  const event = m.object({
    active: m.boolean(),
    actor: person,
    id: m.uint(),
    metrics: m.object({ cpu: m.float64(), memory: m.uint() }),
    tags: m.array(m.string()),
    timestamp: m.uint(),
  });

  const CASES: ReadonlyArray<readonly [string, Schema<unknown>, unknown, number]> = [
    ["empty string", m.string(), "", 1],
    ["ascii 5", m.string(), "Rahul", 6],
    ["uint 0", m.uint(), 0, 1],
    ["uint 127", m.uint(), 127, 1],
    ["uint 128", m.uint(), 128, 2],
    ["uint 2^32", m.uint(), 2 ** 32, 5],
    ["uint ms timestamp", m.uint(), 1_725_435_678_000, 6],
    ["uint MAX_SAFE", m.uint(), Number.MAX_SAFE_INTEGER, 8],
    ["int -1", m.int(), -1, 1],
    ["int MIN_SAFE", m.int(), Number.MIN_SAFE_INTEGER, 8],
    ["boolean", m.boolean(), true, 1],
    ["float64", m.float64(), 1.5, 8],
    ["float32", m.float32(), 1.5, 4],
    ["enum of 3", m.enum(["F", "M", "X"]), "M", 1],
    ["person", person, { age: 25, name: "Rahul", sex: "M" }, 8],
    [
      "nested event",
      event,
      {
        active: true,
        actor: { age: 25, name: "Rahul", sex: "M" },
        id: 731_942,
        metrics: { cpu: 0.5, memory: 512_000 },
        tags: ["api", "edge"],
        timestamp: 1_725_435_678,
      },
      38,
    ],
    ["empty array", m.array(m.uint()), [], 1],
    ["array of 3 uints", m.array(m.uint()), [1, 2, 3], 4],
    ["8 absent optionals", m.object(
      Object.fromEntries("abcdefgh".split("").map((key) => [key, m.uint().optional()])),
    ), {}, 1],
    ["9 absent optionals", m.object(
      Object.fromEntries("abcdefghi".split("").map((key) => [key, m.uint().optional()])),
    ), {}, 2],
  ];

  for (const [name, schema, value, bytes] of CASES) {
    it(`${name} is ${bytes} byte${bytes === 1 ? "" : "s"}`, () => {
      expect(schema.encode(value).length).toBe(bytes);
    });
  }

  it("the fingerprint envelope costs exactly its retained width", () => {
    const codec = compile(z.object({ a: z.string() }));
    const bare = codec.encode({ a: "x" }).length;
    for (const width of [1, 2, 3, 4] as const) {
      expect(fingerprinted(codec, { bytes: width }).encode({ a: "x" }).length).toBe(bare + width);
    }
  });
});

describe("encode and decode agree about what a Uint8Array is", () => {
  // `decode` deliberately accepts bytes minted in another realm — a node:vm
  // context, an iframe, a worker — because `instanceof` is realm-scoped and the
  // bytes are structurally identical. `m.bytes()` encode used a bare `instanceof`,
  // so the same array could be read out of a payload and not written back into one.
  const foreign = runInNewContext("Uint8Array.from([1, 2, 3, 255])") as Uint8Array;

  it("the fixture is genuinely foreign, or this proves nothing", () => {
    expect(foreign instanceof Uint8Array).toBe(false);
    expect(Object.prototype.toString.call(foreign)).toBe("[object Uint8Array]");
  });

  it("accepts a foreign Uint8Array as a bytes field value", () => {
    const schema = m.object({ blob: m.bytes(), name: m.string() });
    const bytes = schema.encode({ blob: foreign, name: "x" });
    const decoded = schema.decode(bytes);
    expect([...decoded.blob]).toEqual([1, 2, 3, 255]);
    expect([...schema.encode(decoded)]).toEqual([...bytes]);
  });

  it("accepts every host byte view the decoder does", () => {
    class Branded extends Uint8Array {}
    const backing = new ArrayBuffer(16);
    const offset = new Uint8Array(backing, 4, 3);
    offset.set([7, 8, 9]);
    for (const value of [
      Uint8Array.from([7, 8, 9]),
      Buffer.from([7, 8, 9]) as unknown as Uint8Array,
      Branded.from([7, 8, 9]),
      offset,
      runInNewContext("Uint8Array.from([7, 8, 9])") as Uint8Array,
    ]) {
      expect([...m.bytes().decode(m.bytes().encode(value))]).toEqual([7, 8, 9]);
    }
  });

  it("still refuses anything that is not a byte view", () => {
    for (const value of [null, undefined, [1, 2, 3], "abc", new ArrayBuffer(3), { length: 3 }]) {
      expect(() => m.bytes().encode(value as never)).toThrow(shorn.EncodeError);
    }
    // An Int8Array has the same bytes and a different tag: refused, not reinterpreted.
    expect(() => m.bytes().encode(Int8Array.from([1, 2]) as never)).toThrow(shorn.EncodeError);
  });
});

describe("public API surface is pinned", () => {
  // A rename or an accidental export is a breaking change that no other test sees.
  it("exports exactly this set of names", () => {
    // Includes the low-level `Reader`, `Writer` and the schema base classes: they
    // are exported, so they are API, and a change to that decision should be a
    // deliberate edit here rather than a silent one.
    expect(Object.keys(shorn).sort()).toEqual([
      "DecodeError",
      "EncodeError",
      "FingerprintedSchema",
      "NullableSchema",
      "OptionalSchema",
      "Reader",
      "Schema",
      "Writer",
      "compile",
      "decode",
      "decodeAsync",
      "encode",
      "encodeAsync",
      "fingerprinted",
      "m",
      "safeDecode",
      "safeEncode",
      "unchecked",
    ]);
  });

  it("exposes exactly these schema constructors on m", () => {
    expect(Object.keys(m).sort()).toEqual([
      "array",
      "boolean",
      "bytes",
      "enum",
      "float32",
      "float64",
      "int",
      "literal",
      "object",
      "string",
      "tuple",
      "uint",
    ]);
  });

  it("keeps the errors constructible with the documented shape", () => {
    expect(new shorn.DecodeError("x", 3).offset).toBe(3);
    expect(new shorn.DecodeError("x", 3).name).toBe("DecodeError");
    expect(new shorn.EncodeError("x").name).toBe("EncodeError");
  });
});

/**
 * Flattens the `required & optional` intersection `ObjectOutput` builds.
 *
 * The intersection is what the compiler holds; this is what a caller sees in a
 * tooltip and writes down in their own types, so it is the form worth pinning.
 * Homomorphic, so `?` and `readonly` survive.
 */
type Flat<T> = { [K in keyof T]: T[K] } & {};

describe("type inference is pinned", () => {
  // `pnpm typecheck` proves the library compiles; these prove it still infers what
  // callers depend on. A change here breaks users without failing a runtime test.
  it("infers primitives and collections", () => {
    expectTypeOf<Infer<ReturnType<typeof m.string>>>().toEqualTypeOf<string>();
    expectTypeOf<Infer<ReturnType<typeof m.uint>>>().toEqualTypeOf<number>();
    expectTypeOf<Infer<ReturnType<typeof m.bytes>>>().toEqualTypeOf<Uint8Array>();
    expectTypeOf<Infer<typeof arrayOfString>>().toEqualTypeOf<string[]>();
  });
  const arrayOfString = m.array(m.string());

  it("makes optional fields optional keys, not `| undefined` required keys", () => {
    const schema = m.object({ id: m.uint(), nickname: m.string().optional() });
    expectTypeOf<Flat<Infer<typeof schema>>>().toEqualTypeOf<{ id: number; nickname?: string }>();
  });

  it("keeps nullable a value union, not an optional key", () => {
    const schema = m.object({ parent: m.string().nullable() });
    expectTypeOf<Flat<Infer<typeof schema>>>().toEqualTypeOf<{ parent: string | null }>();
  });

  it("agrees with the runtime about which keys may be omitted", () => {
    // The pair that matters. `NullableSchema` is structurally identical to
    // `OptionalSchema` unless one carries a brand, so `{ parent: nullable }` once
    // inferred `parent?` while the encoder still demanded it: omitting the field
    // type-checked and threw in production. Assert both halves together, because
    // either alone passes while they disagree.
    const nullable = m.object({ parent: m.string().nullable() });
    expect(() => nullable.encode({} as never)).toThrow(shorn.EncodeError);
    expect(nullable.encode({ parent: null })).toBeInstanceOf(Uint8Array);

    const optional = m.object({ nickname: m.string().optional() });
    expect(optional.encode({})).toBeInstanceOf(Uint8Array);
    expectTypeOf<Flat<Infer<typeof optional>>>().toEqualTypeOf<{ nickname?: string }>();
  });

  it("infers tuples positionally", () => {
    const schema = m.tuple([m.string(), m.uint(), m.boolean()]);
    expectTypeOf<Infer<typeof schema>>().toEqualTypeOf<[string, number, boolean]>();
  });

  it("narrows literals and enums to their members", () => {
    expectTypeOf<Infer<ReturnType<typeof literal>>>().toEqualTypeOf<"fixed">();
    expectTypeOf<Infer<typeof colour>>().toEqualTypeOf<"blue" | "red">();
  });
  const literal = () => m.literal("fixed");
  const colour = m.enum(["red", "blue"]);

  it("carries a Standard Schema's output type through compile", () => {
    const schema = z.object({ id: z.string(), count: z.int().nonnegative() });
    type Decoded = ReturnType<ReturnType<typeof compile<typeof schema>>["decode"]>;
    expectTypeOf<Decoded>().toEqualTypeOf<{ id: string; count: number }>();
  });
});
