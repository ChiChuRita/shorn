import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DecodeError, compile, encode, type Schema } from "../src/index.js";
import { below, mulberry32, pick, randomString } from "./generate.js";

/**
 * The same generative pressure `property.test.ts` puts on the `m.*` builders,
 * aimed at the compile seam instead.
 *
 * That suite builds wire schemas directly, so it never exercises the JSON Schema
 * translation in `standard.ts` — and that translation is where the doubled
 * `nullable()` aliasing bug actually lived, found only because someone wrote that
 * one case out by hand. Generating vendor schemas covers the seam the same way.
 */
const CASES = Number(process.env.SHORN_PROPERTY_CASES ?? 400);
const TIMEOUT = Math.max(10_000, CASES * 30);

const breathe = (seed: number): Promise<void> | undefined =>
  seed % 500 === 0 ? new Promise<void>((resolve) => setTimeout(resolve, 0)) : undefined;

type Rng = () => number;

interface ZodGen {
  readonly schema: z.ZodType;
  readonly sample: (rng: Rng) => unknown;
  /** Mirrors `Schema._minWidth === 0`: refused as an array element at compile time. */
  readonly zeroWidth: boolean;
  /** Mirrors `Schema._yieldsNull`: `nullable()` refuses to stack a second marker. */
  readonly yieldsNull: boolean;
}

function leaf(rng: Rng): ZodGen {
  switch (below(rng, 7)) {
    case 0:
      // `minimum >= 0` is what routes an integer to the uint wire type.
      return {
        schema: z.int().nonnegative(),
        zeroWidth: false,
        yieldsNull: false,
        sample: (r) => pick(r, [0, 1, 127, 128, 16_384, Number.MAX_SAFE_INTEGER, below(r, 1e6)]),
      };
    case 1:
      return {
        schema: z.int(),
        zeroWidth: false,
        yieldsNull: false,
        sample: (r) =>
          pick(r, [0, -1, 1, -128, 2_097_152, Number.MIN_SAFE_INTEGER, below(r, 1e6) - 5e5]),
      };
    case 2:
      return {
        schema: z.string(),
        zeroWidth: false,
        yieldsNull: false,
        sample: (r) => randomString(r, 40),
      };
    case 3:
      return { schema: z.boolean(), zeroWidth: false, yieldsNull: false, sample: (r) => r() < 0.5 };
    case 4:
      // Finite only: zod's `number` rejects NaN and the infinities, so anything else
      // would fail validation inside encode and test the generator, not the library.
      return {
        schema: z.number(),
        zeroWidth: false,
        yieldsNull: false,
        sample: (r) => pick(r, [0, -0, 1.5, 5e-324, (r() - 0.5) * 1e18]),
      };
    case 5: {
      const values = Array.from({ length: 1 + below(rng, 40) }, (_, index) => `e${index}`);
      return {
        schema: z.enum(values as [string, ...string[]]),
        zeroWidth: false,
        yieldsNull: false,
        sample: (r) => pick(r, values),
      };
    }
    default: {
      const value = pick(rng, ["fixed", 7, true, null] as const);
      return {
        schema: z.literal(value),
        zeroWidth: true, // a literal writes no bytes
        yieldsNull: value === null,
        sample: () => value,
      };
    }
  }
}

function zodGen(rng: Rng, depth: number): ZodGen {
  if (depth <= 0 || rng() < 0.45) return leaf(rng);

  switch (below(rng, 3)) {
    case 0: {
      // Doubled nullability is deliberate and legal — zod nests `anyOf` and the wire
      // side must collapse it — but nullable over a bare null literal is refused at
      // construction, so drawing one would fail the generator rather than the library.
      let inner = zodGen(rng, depth - 1);
      for (let attempt = 0; attempt < 8 && inner.yieldsNull; attempt++) inner = zodGen(rng, depth - 1);
      if (inner.yieldsNull) inner = leaf(() => 0.5);
      return {
        schema: inner.schema.nullable(),
        zeroWidth: false, // the null marker is always a byte
        yieldsNull: true,
        sample: (r) => (r() < 0.3 ? null : inner.sample(r)),
      };
    }
    case 1: {
      let item = zodGen(rng, depth - 1);
      for (let attempt = 0; attempt < 8 && item.zeroWidth; attempt++) item = zodGen(rng, depth - 1);
      if (item.zeroWidth) item = leaf(() => 0.5);
      return {
        schema: z.array(item.schema),
        zeroWidth: false,
        yieldsNull: false,
        sample: (r) => Array.from({ length: below(r, 5) }, () => item.sample(r)),
      };
    }
    default: {
      const keys = [...new Set(Array.from({ length: below(rng, 6) }, () => pick(rng, KEY_POOL)))];
      const fields = keys.map((key) => ({
        key,
        gen: zodGen(rng, depth - 1),
        // Optionality only exists on an object property — JSON Schema expresses it as
        // absence from `required`, and there is no standalone `undefined` node.
        optional: rng() < 0.4,
      }));
      const shape: Record<string, z.ZodType> = {};
      for (const field of fields) {
        shape[field.key] = field.optional ? field.gen.schema.optional() : field.gen.schema;
      }
      return {
        schema: z.object(shape as z.ZodRawShape),
        // Mirrors ObjectSchema: the presence bitmap is a byte, so any optional gives width.
        zeroWidth: fields.every((field) => !field.optional && field.gen.zeroWidth),
        yieldsNull: false,
        sample: (r) => {
          // Null-prototype, as `generate.ts` does: on a plain `{}` a skipped optional
          // named `toString` still resolves to the inherited function, and `__proto__`
          // sets the prototype instead of an own property. Both would fail validation
          // in the generator rather than exercise anything in the library.
          const value: Record<string, unknown> = Object.create(null);
          for (const field of fields) {
            if (field.optional && r() < 0.35) continue;
            value[field.key] = field.gen.sample(r);
          }
          return value;
        },
      };
    }
  }
}

/**
 * Narrower than the `m.*` pool in `generate.ts`, which keeps `__proto__`,
 * `toString` and friends. Both exclusions are zod's limits, not shorn's, and
 * generating them would assert against zod rather than against the seam:
 *
 * - `__proto__` never arrives. zod builds its JSON Schema `properties` on a plain
 *   object literal, so the key sets that object's prototype instead of becoming a
 *   property, and shorn is handed a schema with no such field.
 * - An `Object.prototype` member name cannot be an optional property at all.
 *   `z.object({ valueOf: z.array(z.string()).optional() }).parse({})` throws on its
 *   own, reading the inherited function as the field's value.
 *
 * The native path owns every one of these keys and `core.test.ts` pins it there.
 */
const KEY_POOL = ["id", "name", "a", "z", "kind", "über", "zzz", "_"] as const;

/**
 * Every draw is meant to be compilable — the generator mirrors the constraints
 * `standard.ts` enforces — so a refusal is a failure, not a case to skip. Measured
 * at 20,000 draws before this was tightened: 100% compiled. A `try`/`continue`
 * here would let a regression that refused every schema report a green suite.
 */
const codecFor = (schema: z.ZodType): Schema<unknown> => compile(schema) as Schema<unknown>;

describe("property: generated vendor schemas through the compile seam", { timeout: TIMEOUT }, () => {
  it("round-trips, and encode after decode is a fixed point", async () => {
    for (let seed = 1; seed <= CASES; seed++) {
      await breathe(seed);
      const rng = mulberry32(seed * 2_654_435_761);
      const gen = zodGen(rng, 4);
      const codec = codecFor(gen.schema);
      const value = gen.sample(rng);
      const bytes = codec.encode(value);
      expect(codec.decode(bytes), `seed ${seed}`).toEqual(value);
      expect([...codec.encode(codec.decode(bytes))], `seed ${seed}`).toEqual([...bytes]);
      // The top-level entry point must agree with the cached codec it delegates to.
      expect([...encode(gen.schema, value)], `seed ${seed}`).toEqual([...bytes]);
    }
  });

  it("is deterministic across separately compiled instances of the same schema", async () => {
    for (let seed = 1; seed <= CASES; seed++) {
      await breathe(seed);
      const rng = mulberry32(seed * 40_503);
      const gen = zodGen(rng, 4);
      const first = codecFor(gen.schema);
      // A second compile of an identical-but-distinct schema must produce the same
      // bytes, or the compile cache would be the only thing holding canonicality up.
      const second = codecFor(zodGen(mulberry32(seed * 40_503), 4).schema);
      const value = gen.sample(rng);
      expect([...second.encode(value)], `seed ${seed}`).toEqual([...first.encode(value)]);
    }
  });

  it("never lets a non-DecodeError escape any corruption of a valid payload", async () => {
    for (let seed = 1; seed <= CASES; seed++) {
      await breathe(seed);
      const rng = mulberry32(seed * 15_485_863);
      const gen = zodGen(rng, 4);
      const codec = codecFor(gen.schema);
      const bytes = codec.encode(gen.sample(rng));

      const variants: Uint8Array[] = [];
      for (let index = 0; index < Math.min(bytes.length, 16); index++) {
        for (const replacement of [0x00, 0x01, 0x7f, 0x80, 0xff]) {
          const mutated = Uint8Array.from(bytes);
          mutated[index] = replacement;
          variants.push(mutated);
        }
      }
      variants.push(bytes.slice(0, Math.max(0, bytes.length - 1)));
      variants.push(Uint8Array.from([...bytes, 0]));

      for (const variant of variants) {
        let decoded: unknown;
        try {
          decoded = codec.decode(variant);
        } catch (error) {
          expect(error, `seed ${seed}`).toBeInstanceOf(DecodeError);
          expect(Number.isSafeInteger((error as DecodeError).offset), `seed ${seed}`).toBe(true);
          continue;
        }
        // Accepted by both the reader and the vendor's validate(), so canonicality
        // still binds: it must re-encode to exactly the bytes it was read from.
        expect([...codec.encode(decoded)], `seed ${seed}`).toEqual([...variant]);
      }
    }
  });

  it("never lets a non-DecodeError escape arbitrary bytes", async () => {
    for (let seed = 1; seed <= CASES; seed++) {
      await breathe(seed);
      const rng = mulberry32(seed * 99_991);
      const gen = zodGen(rng, 4);
      const codec = codecFor(gen.schema);
      for (let attempt = 0; attempt < 16; attempt++) {
        const bytes = Uint8Array.from({ length: below(rng, 48) }, () =>
          rng() < 0.4 ? pick(rng, [0x00, 0x01, 0x7f, 0x80, 0xff]) : below(rng, 256),
        );
        let decoded: unknown;
        try {
          decoded = codec.decode(bytes);
        } catch (error) {
          expect(error, `seed ${seed}`).toBeInstanceOf(DecodeError);
          continue;
        }
        expect([...codec.encode(decoded)], `seed ${seed}`).toEqual([...bytes]);
      }
    }
  });

  it("never pollutes Object.prototype from a decoded __proto__ key", async () => {
    const before = Object.getOwnPropertyNames(Object.prototype).length;
    for (let seed = 1; seed <= Math.min(CASES, 5000); seed++) {
      const rng = mulberry32(seed * 7_919);
      const gen = zodGen(rng, 4);
      const codec = codecFor(gen.schema);
      codec.decode(codec.encode(gen.sample(rng)));
    }
    expect(Object.getOwnPropertyNames(Object.prototype).length).toBe(before);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});
