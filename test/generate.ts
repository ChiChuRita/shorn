import { m, type Schema } from "../src/index.js";

/**
 * Seeded generator of schema trees crossed with values they accept.
 *
 * Shared by `property.test.ts`, which asserts invariants over it, and
 * `regression.test.ts`, which digests its output so any change to the bytes shows
 * up as one failing hash. Kept out of a `.test.ts` file so importing it does not
 * re-run a suite.
 */

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

export const pick = <T>(rng: Rng, values: readonly T[]): T =>
  values[Math.floor(rng() * values.length)]!;
export const below = (rng: Rng, limit: number): number => Math.floor(rng() * limit);

/**
 * A schema paired with a generator for values it accepts.
 *
 * `zeroWidth` mirrors `Schema._minWidth === 0`. The generator has to track it
 * because a zero-width element is refused as an array item at construction, so
 * building one would fail the generator rather than the library.
 */
export interface Gen {
  readonly schema: Schema<unknown>;
  readonly sample: (rng: Rng) => unknown;
  readonly zeroWidth: boolean;
}

/** Well-formed UTF-16 by construction: no lone surrogate ever reaches the encoder. */
export function randomString(rng: Rng, maxLength: number): string {
  const length = below(rng, maxLength);
  let out = "";
  for (let index = 0; index < length; index++) {
    const bucket = rng();
    if (bucket < 0.55) {
      out += String.fromCharCode(0x20 + below(rng, 0x5f)); // 1-byte UTF-8
    } else if (bucket < 0.75) {
      out += String.fromCharCode(0x80 + below(rng, 0x780)); // 2-byte UTF-8
    } else if (bucket < 0.9) {
      // 3-byte UTF-8, skipping the surrogate block entirely.
      const code = 0x800 + below(rng, 0xd800 - 0x800 + (0x10000 - 0xe000));
      out += String.fromCharCode(code < 0xd800 ? code : code + 0x800);
    } else {
      out += String.fromCodePoint(0x10000 + below(rng, 0x100000)); // 4-byte UTF-8
    }
  }
  return out;
}

export function randomSafeInteger(rng: Rng): number {
  return pick(rng, [
    0,
    1,
    -1,
    63,
    64,
    127,
    128,
    16_383,
    16_384,
    2_097_151,
    2_097_152,
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER,
    Math.floor((rng() - 0.5) * 2 * Number.MAX_SAFE_INTEGER),
  ]);
}

export const KEY_POOL = [
  "id", "name", "Name", "a", "z", "__proto__", "constructor", "toString",
  "valueOf", "hasOwnProperty", "über", "kind", "0x", "_", "zzz", "Ω",
] as const;

/** The spec's TimeClip bound: a Date holds no time value past it. */
const MAX_DATE_MS = 8.64e15;

/**
 * `rich` adds Date and bigint leaves, and Set and Map containers in `schemaGen`. Off by
 * default so the corpus every existing digest and seed was recorded against is still
 * the corpus those seeds produce; `regression.test.ts` pins a second digest over the
 * rich corpus.
 */
export function leafGen(rng: Rng, rich = false): Gen {
  switch (below(rng, rich ? 11 : 9)) {
    case 0:
      return { schema: m.uint(), zeroWidth: false, sample: (r) => Math.abs(randomSafeInteger(r)) };
    case 1:
      return { schema: m.int(), zeroWidth: false, sample: randomSafeInteger };
    case 2:
      return { schema: m.string(), zeroWidth: false, sample: (r) => randomString(r, 40) };
    case 3:
      return {
        schema: m.bytes(),
        zeroWidth: false,
        sample: (r) => Uint8Array.from({ length: below(r, 24) }, () => below(r, 256)),
      };
    case 4:
      return { schema: m.boolean(), zeroWidth: false, sample: (r) => r() < 0.5 };
    case 5:
      return {
        schema: m.float32(),
        zeroWidth: false,
        // fround, or the value the encoder writes is not the value it was handed
        // and the round-trip assertion would be testing float32 precision, not shorn.
        sample: (r) => pick(r, [0, -0, Infinity, -Infinity, NaN, Math.fround((r() - 0.5) * 1e6)]),
      };
    case 6:
      return {
        schema: m.float64(),
        zeroWidth: false,
        sample: (r) => pick(r, [0, -0, Infinity, -Infinity, NaN, 5e-324, (r() - 0.5) * 1e18]),
      };
    case 7: {
      const size = 1 + below(rng, 200);
      const values = Array.from({ length: size }, (_, index) => `e${String(index).padStart(3, "0")}`);
      return {
        schema: m.enum(values as [string, ...string[]]),
        zeroWidth: false,
        sample: (r) => values[below(r, values.length)]!,
      };
    }
    case 9:
      return {
        schema: m.date(),
        zeroWidth: false,
        sample: (r) =>
          new Date(
            pick(r, [
              0,
              1,
              -1,
              1_725_435_678_000,
              MAX_DATE_MS,
              -MAX_DATE_MS,
              Math.floor((r() - 0.5) * 2 * MAX_DATE_MS),
            ]),
          ),
      };
    case 10:
      return {
        schema: m.bigint(),
        zeroWidth: false,
        sample: (r) =>
          pick(r, [
            0n,
            1n,
            -1n,
            255n,
            256n,
            -256n,
            2n ** 63n,
            -(2n ** 64n),
            BigInt(randomSafeInteger(r)) * BigInt(randomSafeInteger(r)),
          ]),
      };
    default: {
      const value = pick(rng, ["fixed", 7, true, null] as const);
      // The one zero-width leaf: a literal writes no bytes at all.
      return { schema: m.literal(value), zeroWidth: true, sample: () => value };
    }
  }
}

export const UINT_GEN: Gen = { schema: m.uint(), zeroWidth: false, sample: (r) => below(r, 1000) };

/**
 * Draws an inner schema a wrapper will actually accept.
 *
 * `optional()` and `nullable()` refuse an inner that already decodes to their own
 * sentinel, because that would give one value two encodings. The generator has to
 * respect that or it tests its own bug instead of the library's.
 */
export function wrappable(
  rng: Rng,
  depth: number,
  inputBounded: boolean,
  rejected: (schema: Schema<unknown>) => boolean,
  rich = false,
): Gen {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = schemaGen(rng, depth - 1, inputBounded, rich);
    if (!rejected(candidate.schema)) return candidate;
  }
  return UINT_GEN;
}

/**
 * `inputBounded` drops tuples and literals. A tuple's arity is fixed by the schema,
 * so a zero-byte payload can legitimately yield four elements — schema-bounded, not
 * input-bounded. Only the element-count budget test needs the restriction.
 */
export function schemaGen(rng: Rng, depth: number, inputBounded = false, rich = false): Gen {
  if (depth <= 0 || rng() < 0.45) {
    let leaf = leafGen(rng, rich);
    if (inputBounded) {
      for (let attempt = 0; attempt < 8 && leaf.zeroWidth; attempt++) leaf = leafGen(rng, rich);
      if (leaf.zeroWidth) leaf = UINT_GEN;
    }
    return leaf;
  }

  const choice = below(rng, rich ? 7 : 5);
  switch (inputBounded && choice === 3 ? 4 : choice) {
    case 0: {
      const inner = wrappable(rng, depth, inputBounded, (s) => s._yieldsUndefined, rich);
      return {
        schema: inner.schema.optional(),
        zeroWidth: false, // the presence marker is always a byte
        sample: (r) => (r() < 0.3 ? undefined : inner.sample(r)),
      };
    }
    case 1: {
      const inner = wrappable(rng, depth, inputBounded, (s) => s._yieldsNull, rich);
      return {
        schema: inner.schema.nullable(),
        zeroWidth: false,
        sample: (r) => (r() < 0.3 ? null : inner.sample(r)),
      };
    }
    case 2: {
      // An array of zero-width elements is refused at construction, because no
      // input length could bound its element count.
      const item = wrappable(rng, depth, inputBounded, (schema) => schema._minWidth === 0, rich);
      return {
        schema: m.array(item.schema),
        zeroWidth: false,
        sample: (r) => Array.from({ length: below(r, 6) }, () => item.sample(r)),
      };
    }
    case 3: {
      const items = Array.from({ length: below(rng, 5) }, () =>
        schemaGen(rng, depth - 1, inputBounded, rich),
      );
      return {
        schema: m.tuple(items.map((item) => item.schema)),
        zeroWidth: items.every((item) => item.zeroWidth),
        sample: (r) => items.map((item) => item.sample(r)),
      };
    }
    case 5: {
      // The array rule again: a Set's count is on the wire, so its element must cost a
      // byte. `new Set` folds duplicates, which is also what the decoder demands.
      const item = wrappable(rng, depth, inputBounded, (schema) => schema._minWidth === 0, rich);
      return {
        schema: m.set(item.schema),
        zeroWidth: false,
        sample: (r) => new Set(Array.from({ length: below(r, 6) }, () => item.sample(r))),
      };
    }
    case 6: {
      // Only the pair has to cost a byte, so one zero-width half is legal.
      const key = schemaGen(rng, depth - 1, inputBounded, rich);
      let value = schemaGen(rng, depth - 1, inputBounded, rich);
      if (key.zeroWidth && value.zeroWidth) value = UINT_GEN;
      return {
        schema: m.map(key.schema, value.schema),
        zeroWidth: false,
        sample: (r) =>
          new Map(
            Array.from({ length: below(r, 6) }, () => [key.sample(r), value.sample(r)] as const),
          ),
      };
    }
    default: {
      const keys = [...new Set(Array.from({ length: below(rng, 8) }, () => pick(rng, KEY_POOL)))];
      const fields = keys.map((key) => ({ key, gen: schemaGen(rng, depth - 1, inputBounded, rich) }));
      const shape: Record<string, Schema<unknown>> = Object.create(null);
      let optionals = 0;
      for (const field of fields) {
        // A field whose own schema already decodes to undefined cannot take a second
        // presence marker, for the same reason `optional()` refuses to stack one.
        const optional = rng() < 0.4 && !field.gen.schema._yieldsUndefined;
        if (optional) optionals++;
        shape[field.key] = optional ? field.gen.schema.optional() : field.gen.schema;
      }
      return {
        schema: m.object(shape),
        // Mirrors ObjectSchema: the bitmap is a byte, so any optional gives width.
        zeroWidth: optionals === 0 && fields.every((field) => field.gen.zeroWidth),
        sample: (r) => {
          const value: Record<string, unknown> = Object.create(null);
          for (const field of fields) {
            const declared = shape[field.key]!;
            const isOptional = declared !== field.gen.schema;
            if (isOptional && r() < 0.35) continue;
            value[field.key] = field.gen.sample(r);
          }
          return value;
        },
      };
    }
  }
}

/** NaN is the documented exemption: every bit pattern decodes to the one JS NaN. */
export function containsNaN(value: unknown): boolean {
  if (typeof value === "number") return Number.isNaN(value);
  if (Array.isArray(value)) return value.some(containsNaN);
  if (value instanceof Uint8Array || value instanceof Date) return false;
  if (value instanceof Set) return [...value].some(containsNaN);
  if (value instanceof Map) return [...value].some(([k, v]) => containsNaN(k) || containsNaN(v));
  if (value !== null && typeof value === "object") return Object.values(value).some(containsNaN);
  return false;
}

/** Counts a Set's elements and a Map's entries too: each costs a byte, like an array's. */
export function countArrayElements(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length + value.reduce<number>((sum, item) => sum + countArrayElements(item), 0);
  }
  if (value instanceof Set) {
    return value.size + [...value].reduce<number>((sum, item) => sum + countArrayElements(item), 0);
  }
  if (value instanceof Map) {
    return (
      value.size +
      [...value].reduce<number>((sum, [k, v]) => sum + countArrayElements(k) + countArrayElements(v), 0)
    );
  }
  if (value instanceof Uint8Array || value instanceof Date) return 0;
  if (value !== null && typeof value === "object") {
    return Object.values(value).reduce<number>((sum, item) => sum + countArrayElements(item), 0);
  }
  return 0;
}
