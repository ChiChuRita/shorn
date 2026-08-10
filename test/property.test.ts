import { describe, expect, it } from "vitest";
import { z } from "zod";
import { compile, decode, DecodeError, encode, m, type Schema } from "../src/index.js";
import {
  below,
  containsNaN,
  countArrayElements,
  mulberry32,
  pick,
  schemaGen,
} from "./generate.js";

/**
 * Cases per property. 400 keeps the suite under a second in CI; a deeper soak is
 * `SHORN_PROPERTY_CASES=50000 pnpm test property`, which is worth running before a
 * release and is how the `nullable()` aliasing bug was found.
 */
const CASES = Number(process.env.SHORN_PROPERTY_CASES ?? 400);
// Scales with the soak size, so a deep run reports real failures instead of timeouts.
const TIMEOUT = Math.max(10_000, CASES * 30);

/**
 * Hands the event loop back every so often, so a soak run can report progress.
 *
 * At 50,000 cases these loops run for the better part of a minute without
 * yielding, and Vitest's worker sends task updates to the reporter over an RPC
 * that a synchronous loop never lets through: the soak failed on `Timeout
 * calling "onTaskUpdate"` with all fourteen assertions passing, which reads as a
 * broken library and is not one.
 *
 * A real macrotask, not `await undefined`: the pending RPC is I/O, so only
 * draining past the microtask queue releases it. Returns undefined on the other
 * 499 iterations to keep this off the hot path — at the default 400 cases it
 * never fires at all.
 */
const breathe = (seed: number): Promise<void> | undefined =>
  seed % 500 === 0 ? new Promise<void>((resolve) => setTimeout(resolve, 0)) : undefined;

describe("property: generated schemas crossed with generated values", { timeout: TIMEOUT }, () => {
  it("round-trips, and encode after decode is a fixed point", async () => {
    for (let seed = 1; seed <= CASES; seed++) {
      await breathe(seed);
      const rng = mulberry32(seed);
      const gen = schemaGen(rng, 4);
      const value = gen.sample(rng);

      let bytes: Uint8Array;
      try {
        bytes = gen.schema.encode(value);
      } catch (error) {
        throw new Error(`seed ${seed}: encode threw ${String(error)}`);
      }
      const decoded = gen.schema.decode(bytes);
      expect(decoded, `seed ${seed}`).toEqual(value);
      if (!containsNaN(decoded)) {
        expect([...gen.schema.encode(decoded)], `seed ${seed}`).toEqual([...bytes]);
      }
    }
  });

  it("is deterministic: the same value encodes to the same bytes every time", async () => {
    for (let seed = 1; seed <= CASES; seed++) {
      await breathe(seed);
      const rng = mulberry32(seed * 7919);
      const gen = schemaGen(rng, 4);
      const value = gen.sample(rng);
      const first = gen.schema.encode(value);
      const second = gen.schema.encode(value);
      expect([...second], `seed ${seed}`).toEqual([...first]);
    }
  });

  it("ignores the order properties were inserted in", async () => {
    // The canonical field order is the schema's, not the value's. A payload built
    // from a reversed-insertion clone must be byte-identical, or two services that
    // construct the same record differently would produce different bytes.
    const reinsert = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reinsert);
      if (value instanceof Uint8Array) return value;
      if (value === null || typeof value !== "object") return value;
      const clone: Record<string, unknown> = {};
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record).reverse()) {
        if (key === "__proto__") {
          Object.defineProperty(clone, key, {
            configurable: true, enumerable: true, writable: true,
            value: reinsert(record[key]),
          });
        } else {
          clone[key] = reinsert(record[key]);
        }
      }
      return clone;
    };

    for (let seed = 1; seed <= CASES; seed++) {
      await breathe(seed);
      const rng = mulberry32(seed * 31);
      const gen = schemaGen(rng, 4);
      const value = gen.sample(rng);
      expect([...gen.schema.encode(reinsert(value))], `seed ${seed}`).toEqual([
        ...gen.schema.encode(value),
      ]);
    }
  });

  it("never lets a non-DecodeError escape any corruption of a valid payload", async () => {
    for (let seed = 1; seed <= CASES; seed++) {
      await breathe(seed);
      const rng = mulberry32(seed * 104_729);
      const gen = schemaGen(rng, 4);
      const bytes = gen.schema.encode(gen.sample(rng));

      const variants: Uint8Array[] = [];
      for (let index = 0; index < Math.min(bytes.length, 24); index++) {
        for (const replacement of [0x00, 0x01, 0x7f, 0x80, 0xff]) {
          const mutated = Uint8Array.from(bytes);
          mutated[index] = replacement;
          variants.push(mutated);
        }
      }
      variants.push(bytes.slice(0, Math.max(0, bytes.length - 1)));
      variants.push(Uint8Array.from([...bytes, 0]));
      variants.push(Uint8Array.from([...bytes].reverse()));

      for (const variant of variants) {
        let decoded: unknown;
        try {
          decoded = gen.schema.decode(variant);
        } catch (error) {
          expect(error, `seed ${seed}`).toBeInstanceOf(DecodeError);
          const offset = (error as DecodeError).offset;
          expect(Number.isSafeInteger(offset) && offset >= 0, `seed ${seed}`).toBe(true);
          continue;
        }
        // Accepted, so canonicality still binds: it must re-encode to itself.
        if (containsNaN(decoded)) continue;
        expect([...gen.schema.encode(decoded)], `seed ${seed}`).toEqual([...variant]);
      }
    }
  });

  it("never lets a non-DecodeError escape arbitrary bytes", async () => {
    for (let seed = 1; seed <= CASES; seed++) {
      await breathe(seed);
      const rng = mulberry32(seed * 65_537);
      const gen = schemaGen(rng, 4);
      for (let attempt = 0; attempt < 20; attempt++) {
        const length = below(rng, 64);
        const bytes = Uint8Array.from({ length }, () =>
          rng() < 0.4 ? pick(rng, [0x00, 0x01, 0x7f, 0x80, 0xff]) : below(rng, 256),
        );
        let decoded: unknown;
        try {
          decoded = gen.schema.decode(bytes);
        } catch (error) {
          expect(error, `seed ${seed}`).toBeInstanceOf(DecodeError);
          continue;
        }
        if (containsNaN(decoded)) continue;
        expect([...gen.schema.encode(decoded)], `seed ${seed}`).toEqual([...bytes]);
      }
    }
  });

  it("produces no more collection elements than the payload has bytes", async () => {
    // The `_minWidth` budget in one sentence: every array element costs at least a
    // byte, so a decoded value can never hold more elements than it was fed. This is
    // what stops seven bytes from becoming a million-slot allocation, and it has to
    // hold for generated shapes, not just the one reported payload.
    for (let seed = 1; seed <= CASES; seed++) {
      await breathe(seed);
      const rng = mulberry32(seed * 999_983);
      const gen = schemaGen(rng, 4, true);
      const bytes = gen.schema.encode(gen.sample(rng));
      expect(countArrayElements(gen.schema.decode(bytes)), `seed ${seed}`).toBeLessThanOrEqual(
        bytes.length,
      );
    }
  });
});

describe("varuint bytes are pinned across the 32-bit split", () => {
  /**
   * The encoder splits a value above 32 bits into two registers and shifts the pair,
   * because the float modulo and float divide it replaced cost 83ns for a
   * millisecond timestamp against 7ns to decode the same value back. The split is
   * invisible on the wire and must stay that way, so this pins the bytes against an
   * independent implementation rather than against the encoder's own output.
   */
  function reference(value: number): number[] {
    const out: number[] = [];
    let remaining = value;
    while (remaining >= 0x80) {
      out.push((remaining % 0x80) | 0x80);
      remaining = Math.floor(remaining / 0x80);
    }
    out.push(remaining);
    return out;
  }

  it("matches a float-arithmetic reference at every bit-width boundary", () => {
    const uint = m.uint();
    for (let bit = 0; bit <= 53; bit++) {
      for (const delta of [-2, -1, 0, 1, 2]) {
        const value = 2 ** bit + delta;
        if (value < 0 || !Number.isSafeInteger(value)) continue;
        expect([...uint.encode(value)], `2^${bit} ${delta >= 0 ? "+" : ""}${delta}`).toEqual(
          reference(value),
        );
        expect(uint.decode(uint.encode(value))).toBe(value);
      }
    }
  });

  it("matches the reference across a seeded sweep of the whole safe range", () => {
    const uint = m.uint();
    const rng = mulberry32(20_260_808);
    for (let attempt = 0; attempt < 20_000; attempt++) {
      const value = Math.floor(rng() * Number.MAX_SAFE_INTEGER);
      expect([...uint.encode(value)], String(value)).toEqual(reference(value));
      expect(uint.decode(uint.encode(value))).toBe(value);
    }
  });

  it("round-trips signed integers across the same boundary", () => {
    const int = m.int();
    for (let bit = 0; bit <= 52; bit++) {
      for (const value of [2 ** bit, -(2 ** bit), 2 ** bit - 1, -(2 ** bit) + 1]) {
        if (!Number.isSafeInteger(value)) continue;
        expect(int.decode(int.encode(value)), String(value)).toBe(value);
      }
    }
    for (const value of [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
      expect(int.decode(int.encode(value))).toBe(value);
    }
  });
});

describe("decode is injective: one value never has two encodings", () => {
  // Found by the generated corpus above, which produced `m.literal(null).nullable()`
  // and hit a payload that decoded successfully and re-encoded to different bytes.
  // A second presence marker over a schema that already admits the marker's own
  // sentinel makes `[0]` and `[1, ...]` synonyms — canonical bytes stop being
  // canonical, so content addressing, dedup by hash and byte equality all break.

  /**
   * Exhaustive over a byte alphabet chosen to hit every marker and every short
   * length, to a depth that covers the wrapper stacking that caused this. Returns
   * the collisions, so a failure names both payloads rather than just failing.
   */
  function collisions(schema: Schema<unknown>, maxLength = 4): string[] {
    const alphabet = [0x00, 0x01, 0x02, 0x78, 0x80, 0xff];
    const seen = new Map<string, string>();
    const found: string[] = [];
    const identity = (value: unknown): string =>
      JSON.stringify([value], (_key, item) => (item === undefined ? " undefined" : item));

    const walk = (prefix: number[]): void => {
      if (prefix.length > 0) {
        let value: unknown;
        try {
          value = schema.decode(Uint8Array.from(prefix));
        } catch {
          if (prefix.length < maxLength) for (const byte of alphabet) walk([...prefix, byte]);
          return;
        }
        const key = identity(value);
        const previous = seen.get(key);
        if (previous !== undefined) found.push(`[${previous}] and [${prefix}] both decode to ${key}`);
        else seen.set(key, prefix.join(","));
      }
      if (prefix.length < maxLength) for (const byte of alphabet) walk([...prefix, byte]);
    };
    walk([]);
    return found;
  }

  it("collapses a repeated optional() instead of stacking two presence markers", () => {
    const once = m.string().optional();
    const twice = m.string().optional().optional();
    expect([...twice.encode(undefined)]).toEqual([...once.encode(undefined)]);
    expect([...twice.encode("x")]).toEqual([...once.encode("x")]);
    expect(collisions(twice)).toEqual([]);
  });

  it("collapses a repeated nullable() instead of stacking two null markers", () => {
    const once = m.string().nullable();
    const twice = m.string().nullable().nullable();
    expect([...twice.encode(null)]).toEqual([...once.encode(null)]);
    expect([...twice.encode("x")]).toEqual([...once.encode("x")]);
    expect(collisions(twice)).toEqual([]);
  });

  it("has no two payloads decoding alike, across every wrapper combination", () => {
    const inners = [m.string(), m.uint(), m.boolean(), m.literal(null), m.enum(["a", "b"])];
    for (const inner of inners) {
      for (const build of [
        (s: Schema<unknown>) => s.optional(),
        (s: Schema<unknown>) => s.optional().optional(),
        (s: Schema<unknown>) => s.optional().nullable(),
        (s: Schema<unknown>) => s.optional().nullable().optional(),
        (s: Schema<unknown>) => s.optional().nullable().nullable(),
        (s: Schema<unknown>) => m.array(s.optional()),
        (s: Schema<unknown>) => m.object({ a: s.optional() }),
      ]) {
        // Some stacks are refused outright rather than collapsed; a refusal is a
        // pass, since the point is that no schema you can build has an alias.
        let schema: Schema<unknown>;
        try {
          schema = build(inner as Schema<unknown>);
        } catch {
          continue;
        }
        expect(collisions(schema), `${schema.constructor.name} over ${inner.constructor.name}`)
          .toEqual([]);
      }
    }
  });

  it("refuses nullable() over a schema that already decodes to null", () => {
    // Not collapsible: `m.literal(null)` is zero-width, so returning it would change
    // the schema's width and silently make it illegal as an array element.
    expect(() => m.literal(null).nullable()).toThrow(/already decodes to null/);
    // The dual is legal and stays legal: optional-of-null-literal has two distinct
    // values, `undefined` and `null`, so both markers carry information.
    const optionalNull = m.literal(null).optional();
    expect([...optionalNull.encode(undefined)]).toEqual([0]);
    expect([...optionalNull.encode(null)]).toEqual([1]);
    expect(m.string().optional().nullable().decode(Uint8Array.from([1, 0]))).toBeUndefined();
  });

  it("holds through the compile seam, where a vendor can nest the wrappers", () => {
    // zod emits `anyOf: [anyOf: [string, null], null]` for a doubled `.nullable()`,
    // which built a nested wire nullable and gave null two encodings.
    const schema = z.string().nullable().nullable();
    expect([...encode(schema, null)]).toEqual([0]);
    expect(decode(schema, Uint8Array.from([1, 0]))).toBe("");
    expect(collisions(compile(schema))).toEqual([]);
    expect(() => compile(z.string().nullable()).nullable()).toThrow(/already decodes to null/);
  });
});
