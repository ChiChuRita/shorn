import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DecodeError, EncodeError, compile, decode, decodeAsync, m, safeDecode, type Schema } from "../src/index.js";
import { countArrayElements } from "./generate.js";

interface Corpus {
  readonly name: string;
  readonly schema: Schema<unknown>;
  readonly values: readonly unknown[];
}

const recursiveTree = z.object({
  value: z.string(),
  get children() {
    return z.array(recursiveTree);
  },
});

const recursiveList = z.object({
  name: z.string(),
  get next() {
    return recursiveList.nullable();
  },
});

const corpus: readonly Corpus[] = [
  { name: "uint", schema: m.uint(), values: [0, 1, 127, 128, 300, 16384, Number.MAX_SAFE_INTEGER] },
  { name: "int", schema: m.int(), values: [0, -1, 1, -100, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] },
  { name: "string", schema: m.string(), values: ["", "hi", "hé", "\u{1F600}", "x".repeat(200)] },
  { name: "bytes", schema: m.bytes(), values: [new Uint8Array([]), new Uint8Array([0, 255, 127])] },
  { name: "boolean", schema: m.boolean(), values: [true, false] },
  { name: "float32", schema: m.float32(), values: [0, 1.5, -0, Infinity, -Infinity] },
  { name: "float64", schema: m.float64(), values: [0, 1.5, -0, Infinity, -Infinity, 5e-324] },
  { name: "enum-1", schema: m.enum(["only"]), values: ["only"] },
  { name: "enum-7", schema: m.enum(["a", "b", "c", "d", "e", "f", "g"]), values: ["a", "g"] },
  {
    name: "enum-129",
    schema: m.enum(
      Array.from({ length: 129 }, (_, index) => `v${String(index).padStart(3, "0")}`) as [
        string,
        ...string[],
      ],
    ),
    values: ["v000", "v128"],
  },
  { name: "literal", schema: m.literal("fixed"), values: ["fixed"] },
  { name: "nullable", schema: m.string().nullable(), values: [null, "x"] },
  { name: "optional-marker", schema: m.string().optional(), values: [undefined, "x"] },
  { name: "array-uint", schema: m.array(m.uint()), values: [[], [1], [1, 2, 3]] },
  { name: "array-string", schema: m.array(m.string()), values: [[], ["a", "bb"]] },
  {
    name: "array-object",
    schema: m.array(m.object({ a: m.uint(), b: m.string() })),
    values: [[], [{ a: 1, b: "x" }, { a: 2, b: "y" }]],
  },
  { name: "tuple", schema: m.tuple([m.string(), m.boolean(), m.int()]), values: [["hi", true, -1]] },
  {
    name: "object-all-required",
    schema: m.object({ name: m.string(), age: m.uint(), sex: m.enum(["M", "F", "X"]) }),
    values: [{ name: "Rahul", age: 25, sex: "M" }],
  },
  {
    name: "object-optional-1",
    schema: m.object({ a: m.uint(), b: m.uint().optional() }),
    values: [{ a: 1 }, { a: 1, b: 2 }],
  },
  {
    name: "object-optional-7",
    schema: m.object(
      Object.fromEntries("abcdefg".split("").map((key) => [key, m.uint().optional()])),
    ),
    values: [{}, { a: 1, g: 7 }],
  },
  {
    name: "object-optional-8",
    schema: m.object(
      Object.fromEntries("abcdefgh".split("").map((key) => [key, m.uint().optional()])),
    ),
    values: [{}, { h: 8 }],
  },
  {
    name: "object-optional-9",
    schema: m.object(
      Object.fromEntries("abcdefghi".split("").map((key) => [key, m.uint().optional()])),
    ),
    values: [{}, { i: 9 }],
  },
  {
    name: "object-optional-17",
    schema: m.object(
      Object.fromEntries(
        Array.from({ length: 17 }, (_, index) => [`k${String(index).padStart(2, "0")}`, m.uint().optional()]),
      ),
    ),
    values: [{}, { k16: 1 }],
  },
  {
    name: "object-proto-key",
    schema: m.object({ ["__proto__"]: m.string(), safe: m.uint() }),
    values: [Object.defineProperty({ safe: 1 }, "__proto__", { enumerable: true, value: "p" })],
  },
  {
    name: "object-nested",
    schema: m.object({ inner: m.object({ deep: m.array(m.uint()) }), flag: m.boolean() }),
    values: [{ inner: { deep: [1, 2] }, flag: true }],
  },
  // Reached through `compile`, because these three have no `m` builder — and they
  // are the shapes that most need to be here. A uuid reads a fixed 16 bytes, and
  // the other two are the only decoders that take a count, a key or a type tag
  // from the payload rather than from the schema.
  {
    name: "uuid",
    schema: compile(z.uuid()),
    values: ["0192e4c6-3c0e-7000-8000-0000000000ff"],
  },
  {
    name: "record",
    schema: compile(z.record(z.string(), z.int())),
    values: [{}, { a: 1 }, { a: 1, b: -2, c: 300 }],
  },
  {
    name: "dynamic",
    schema: compile(z.any()),
    values: [null, true, 0, -1, 1.5, "hi", [], [1, "a"], {}, { a: [1, { b: null }] }],
  },
  {
    name: "union",
    schema: compile(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("a"), v: z.string() }),
        z.object({ kind: z.literal("b"), n: z.int() }),
      ]),
    ),
    values: [
      { kind: "a", v: "x" },
      { kind: "b", n: -1 },
    ],
  },
  {
    name: "tuple-rest",
    schema: compile(z.tuple([z.string()], z.int())),
    values: [["a"], ["a", 1], ["a", 1, 2, 3]],
  },
  {
    name: "open-object",
    schema: compile(z.object({ a: z.string() }).catchall(z.int())),
    values: [{ a: "x" }, { a: "x", b: 1 }, { a: "x", b: 1, c: -2 }],
  },
  {
    name: "object-mixed",
    schema: m.object({
      req: m.string(),
      opt: m.uint().optional(),
      nul: m.boolean().nullable(),
      lit: m.literal(7),
    }),
    values: [{ req: "a", nul: null, lit: 7 }, { req: "a", opt: 1, nul: true, lit: 7 }],
  },
  {
    name: "type-union",
    schema: compile(z.union([z.string(), z.number(), z.null()])),
    values: ["", "hi", 0, 1.5, null],
  },
  {
    // The two shapes a cycle can take: an array that may be empty, and a nullable
    // back-edge. Both take their depth from the payload, so both belong here.
    name: "recursive-tree",
    schema: compile(recursiveTree),
    values: [
      { value: "", children: [] },
      { value: "r", children: [{ value: "a", children: [{ value: "b", children: [] }] }] },
    ],
  },
  {
    name: "recursive-list",
    schema: compile(recursiveList),
    values: [
      { name: "a", next: null },
      { name: "a", next: { name: "b", next: { name: "c", next: null } } },
    ],
  },
];

const encodings = corpus.flatMap((entry) =>
  entry.values.map((value) => ({
    name: entry.name,
    schema: entry.schema,
    value,
    bytes: entry.schema.encode(value),
  })),
);

/**
 * NaN is the one documented exemption from round-trip canonicality: every NaN
 * bit pattern decodes to the single JavaScript NaN, and DataView re-encodes it
 * as the canonical quiet NaN, so payload bits are not preserved. The wire format
 * does not specify a canonical NaN, so a mutated payload is accepted and
 * normalized rather than rejected.
 */
function containsNaN(value: unknown): boolean {
  if (typeof value === "number") return Number.isNaN(value);
  if (Array.isArray(value)) return value.some(containsNaN);
  if (value !== null && typeof value === "object") return Object.values(value).some(containsNaN);
  return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function expectDecodeError(run: () => unknown, inputLength: number): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(DecodeError);
  const offset = (thrown as DecodeError).offset;
  expect(Number.isSafeInteger(offset)).toBe(true);
  expect(offset).toBeGreaterThanOrEqual(0);
  expect(offset).toBeLessThanOrEqual(inputLength);
}

describe("fuzz: the decoder never escapes its contract", () => {
  it("rejects every truncated prefix of every encoding with a well-formed DecodeError", () => {
    for (const { schema, bytes } of encodings) {
      for (let length = 0; length < bytes.length; length++) {
        const prefix = bytes.slice(0, length);
        let decoded: unknown;
        let thrown: unknown;
        try {
          decoded = schema.decode(prefix);
        } catch (error) {
          thrown = error;
        }
        if (thrown === undefined) {
          // A shorter prefix may be a legal encoding of a different value only when
          // every remaining field is zero-width; assert it re-encodes to itself.
          expect([...schema.encode(decoded)]).toEqual([...prefix]);
          continue;
        }
        expect(thrown).toBeInstanceOf(DecodeError);
        expect(Number.isSafeInteger((thrown as DecodeError).offset)).toBe(true);
      }
    }
  });

  it("rejects trailing bytes after every encoding", () => {
    for (const { schema, bytes } of encodings) {
      for (const suffix of [[0], [255], [0, 0]]) {
        const extended = Uint8Array.from([...bytes, ...suffix]);
        expectDecodeError(() => schema.decode(extended), extended.length);
      }
    }
  });

  it("never throws a non-DecodeError for any single-byte mutation", () => {
    for (const { schema, bytes } of encodings) {
      for (let index = 0; index < bytes.length; index++) {
        for (const replacement of [0x00, 0x01, 0x02, 0x7f, 0x80, 0xff]) {
          if (bytes[index] === replacement) continue;
          const mutated = Uint8Array.from(bytes);
          mutated[index] = replacement;
          let decoded: unknown;
          let thrown: unknown;
          try {
            decoded = schema.decode(mutated);
          } catch (error) {
            thrown = error;
          }
          if (thrown !== undefined) {
            expect(thrown).toBeInstanceOf(DecodeError);
            continue;
          }
          if (containsNaN(decoded)) continue;
          // Accepted: canonicality demands it re-encode to exactly these bytes.
          expect([...schema.encode(decoded)]).toEqual([...mutated]);
        }
      }
    }
  });

  it("holds the round-trip canonicality invariant for every accepted input", () => {
    for (const { schema, value, bytes } of encodings) {
      const decoded = schema.decode(bytes);
      expect([...schema.encode(decoded)]).toEqual([...bytes]);
      expect(decoded).toEqual(value);
    }
  });
});

describe("fuzz: length, count and index gates", () => {
  /** One value at every varint width, one to eight bytes. */
  const varintWidths = [1, 128, 16384, 2097152, 2 ** 28, 2 ** 35, 2 ** 42, 2 ** 49];

  it("rejects every non-minimal varint encoding through both readers", () => {
    // The signed reader takes the same bytes as a zigzag, so it must refuse the same
    // padding. Past eight bytes the padding runs into the ten-byte cap as well.
    for (const value of [0, 300, ...varintWidths]) {
      const minimal = m.uint().encode(value);
      for (let extra = 1; extra <= 3; extra++) {
        const padded = Uint8Array.from([
          ...minimal.slice(0, -1),
          minimal[minimal.length - 1]! | 0x80,
          ...Array.from({ length: extra - 1 }, () => 0x80),
          0x00,
        ]);
        for (const schema of [m.uint(), m.int()]) {
          expectDecodeError(() => schema.decode(padded), padded.length);
        }
      }
    }
  });

  it("rejects a truncated varint at every width through both readers", () => {
    for (const value of varintWidths) {
      const bytes = m.uint().encode(value);
      for (let length = 0; length < bytes.length; length++) {
        for (const schema of [m.uint(), m.int()]) {
          expectDecodeError(() => schema.decode(bytes.slice(0, length)), length);
        }
      }
    }
    // Cut inside the BigInt tail, which the eighth byte of all-ones reaches.
    for (const schema of [m.uint(), m.int()]) {
      expectDecodeError(() => schema.decode(Uint8Array.from(Array(8).fill(0xff))), 8);
    }
  });

  it("rejects varints wider than their cap and beyond the safe range", () => {
    expectDecodeError(() => m.uint().decode(Uint8Array.from(Array(8).fill(0x80))), 8);
    expectDecodeError(() => m.uint().decode(Uint8Array.from([...Array(8).fill(0xff), 0x01])), 9);
    expectDecodeError(() => m.int().decode(Uint8Array.from(Array(10).fill(0x80))), 10);
    // 2^56 in nine bytes is past 2^53 for the unsigned reader, and its zigzag halves to
    // a value that still is; eleven continuation bytes are past both readers' cap.
    for (const schema of [m.uint(), m.int()]) {
      expectDecodeError(() => schema.decode(Uint8Array.from([...Array(8).fill(0x80), 0x01])), 9);
      expectDecodeError(() => schema.decode(Uint8Array.from(Array(11).fill(0x80))), 11);
    }
  });

  it("rejects declared byte lengths that are invalid or exceed the input", () => {
    for (const length of [0xff, 0x80]) {
      expectDecodeError(() => m.string().decode(Uint8Array.from([length, 97])), 2);
    }
    expectDecodeError(() => m.bytes().decode(Uint8Array.from([200, 1, 2])), 3);
  });

  it("rejects out-of-range enum indexes at every varint width boundary", () => {
    for (const size of [1, 7, 8, 9, 127, 128, 129]) {
      const values = Array.from({ length: size }, (_, index) => `v${String(index).padStart(3, "0")}`);
      const schema = m.enum(values as [string, ...string[]]);
      for (const index of [size, size + 1, 1000, Number.MAX_SAFE_INTEGER]) {
        const encoded = m.uint().encode(index);
        expectDecodeError(() => schema.decode(encoded), encoded.length);
      }
      for (let index = 0; index < size; index++) {
        const encoded = m.uint().encode(index);
        expect(typeof schema.decode(encoded)).toBe("string");
      }
    }
  });

  it("rejects array counts that exceed the collection limit", () => {
    const oversized = m.uint().encode(1_000_001);
    expectDecodeError(() => m.array(m.uint()).decode(oversized), oversized.length);
  });

  it("rejects every invalid marker byte for boolean, nullable and optional", () => {
    for (let marker = 2; marker < 256; marker++) {
      const input = Uint8Array.from([marker]);
      expectDecodeError(() => m.boolean().decode(input), 1);
      expectDecodeError(() => m.string().nullable().decode(input), 1);
      expectDecodeError(() => m.string().optional().decode(input), 1);
    }
  });

  it("rejects non-zero padding bits in a presence bitmap", () => {
    const schema = m.object({ a: m.uint().optional(), b: m.uint().optional() });
    expect([...schema.encode({ a: 1, b: 2 })]).toEqual([0b11, 1, 2]);
    for (const bitmap of [0b100, 0b1000, 0xfc]) {
      const input = Uint8Array.from([bitmap]);
      expectDecodeError(() => schema.decode(input), input.length);
    }
  });

  it("rejects padding bits in a multi-byte bitmap and accepts every legal one", () => {
    for (const count of [1, 2, 7, 8, 9, 15, 16, 17]) {
      const keys = Array.from({ length: count }, (_, index) => `k${String(index).padStart(2, "0")}`);
      const schema = m.object(Object.fromEntries(keys.map((key) => [key, m.uint().optional()])));
      const width = Math.ceil(count / 8);

      for (const present of [[], keys, keys.slice(0, 1), keys.slice(-1)]) {
        const value = Object.fromEntries(present.map((key, index) => [key, index + 1]));
        const encoded = schema.encode(value);
        expect(encoded.length).toBeGreaterThanOrEqual(width);
        expect(schema.decode(encoded)).toEqual(value);
      }

      if (count % 8 === 0) continue;
      const empty = schema.encode({});
      const corrupted = Uint8Array.from(empty);
      corrupted[width - 1] = 1 << count % 8;
      expectDecodeError(() => schema.decode(corrupted), corrupted.length);
    }
  });

  it("round-trips non-ASCII strings at every length-varint width", () => {
    // The non-ASCII encode path reserves 5 bytes for the length, writes the text
    // with encodeInto, then memmoves it back over the unused reserve. The shift
    // distance depends on the varint width, so each width is a distinct path.
    for (const repeat of [1, 20, 60, 3000]) {
      const value = "Grüße 👋 ".repeat(repeat);
      const encoded = m.string().encode(value);
      const utf8Length = new TextEncoder().encode(value).length;
      const widthOfLength = m.uint().encode(utf8Length).length;
      expect(encoded.length).toBe(widthOfLength + utf8Length);
      expect(m.string().decode(encoded)).toBe(value);
    }
  });

  it("keeps a non-ASCII string intact when it follows other fields", () => {
    const schema = m.object({ a: m.uint(), z: m.string() });
    for (const repeat of [1, 40, 200]) {
      const value = { a: 300, z: "héllo 😀 ".repeat(repeat) };
      expect(schema.decode(schema.encode(value))).toEqual(value);
    }
  });

  it("rejects ill-formed UTF-8 in every category", () => {
    const sequences: readonly number[][] = [
      [0x80],
      [0xbf],
      [0xc3],
      [0xe0, 0x80],
      [0xf0, 0x9f, 0x98],
      [0xc0, 0x80],
      [0xe0, 0x80, 0x80],
      [0xf0, 0x80, 0x80, 0x80],
      [0xed, 0xa0, 0x80],
      [0xf5, 0x80, 0x80, 0x80],
      [0xfe],
      [0xff],
    ];
    for (const sequence of sequences) {
      const input = Uint8Array.from([sequence.length, ...sequence]);
      expectDecodeError(() => m.string().decode(input), input.length);
    }
  });
});

describe("fuzz: input and entry-point contracts", () => {
  it("throws DecodeError, never TypeError, for non-Uint8Array input", () => {
    for (const input of [null, undefined, 42, "bytes", {}, [1, 2, 3], new ArrayBuffer(4)]) {
      expectDecodeError(() => m.uint().decode(input as never), 0);
    }
  });

  it("accepts every structurally valid byte view, whatever realm or subclass minted it", () => {
    const schema = m.string();
    const payload = [2, 104, 105];

    expect(schema.decode(Uint8Array.from(payload))).toBe("hi");
    expect(schema.decode(Buffer.from(payload) as unknown as Uint8Array)).toBe("hi");

    class Branded extends Uint8Array {}
    expect(schema.decode(Branded.from(payload))).toBe("hi");

    const backing = new ArrayBuffer(16);
    const offsetView = new Uint8Array(backing, 4, payload.length);
    offsetView.set(payload);
    expect(schema.decode(offsetView)).toBe("hi");

    const foreign = runInNewContext("Uint8Array.from([2, 104, 105])") as Uint8Array;
    expect(foreign instanceof Uint8Array).toBe(false);
    expect(schema.decode(foreign)).toBe("hi");
  });

  it("returns decoded bytes that own their storage, including from a Buffer", () => {
    const payload = Buffer.from([3, 10, 20, 30]);
    const decoded = m.bytes().decode(payload as unknown as Uint8Array);
    expect([...decoded]).toEqual([10, 20, 30]);
    payload[1] = 99;
    expect([...decoded]).toEqual([10, 20, 30]);

    const plain = Uint8Array.from([3, 10, 20, 30]);
    const fromPlain = m.bytes().decode(plain);
    plain[1] = 99;
    expect([...fromPlain]).toEqual([10, 20, 30]);
  });

  it("never pollutes Object.prototype and always returns a clean prototype", () => {
    const before = Object.getOwnPropertyNames(Object.prototype).length;
    for (const { name, schema, bytes } of encodings) {
      const decoded = schema.decode(bytes);
      if (name.startsWith("object")) {
        expect(isPlainRecord(decoded)).toBe(true);
      }
    }
    expect(Object.getOwnPropertyNames(Object.prototype).length).toBe(before);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("agrees across the sync, safe and async decode entry points", async () => {
    const schema = z.object({ a: z.string(), b: z.int().nonnegative() });
    const valid = Uint8Array.from([1, 120, 7]);
    expect(decode(schema, valid)).toEqual({ a: "x", b: 7 });
    expect(safeDecode(schema, valid)).toEqual({ success: true, data: { a: "x", b: 7 } });
    await expect(decodeAsync(schema, valid)).resolves.toEqual({ a: "x", b: 7 });

    for (const broken of [Uint8Array.from([]), Uint8Array.from([1, 120]), Uint8Array.from([1, 120, 7, 0])]) {
      expect(() => decode(schema, broken)).toThrow(DecodeError);
      const safe = safeDecode(schema, broken);
      expect(safe.success).toBe(false);
      expect(safe.success === false && safe.error).toBeInstanceOf(DecodeError);
      await expect(decodeAsync(schema, broken)).rejects.toBeInstanceOf(DecodeError);
    }

    // The non-Uint8Array contract pinned above for the sync entry point, applied to
    // every entry point. `decodeAsync` built its own Reader and skipped the brand
    // check, so these leaked a raw TypeError from the DataView constructor. Parity
    // across entry points is the assertion — a case-by-case test would not have
    // caught a second path drifting from the first.
    for (const wrongType of [null, undefined, 42, "bytes", {}, [1, 2, 3], new ArrayBuffer(4)]) {
      expect(() => decode(schema, wrongType as never)).toThrow(DecodeError);
      const safe = safeDecode(schema, wrongType as never);
      expect(safe.success).toBe(false);
      expect(safe.success === false && safe.error).toBeInstanceOf(DecodeError);
      await expect(decodeAsync(schema, wrongType as never)).rejects.toBeInstanceOf(DecodeError);
    }
  });

  // Named for what it can prove. The async offset cannot differ from the payload
  // length: validation is only reached once the reader is exhausted, so no fixture
  // discriminates them. It can still prove both paths report the same offset.
  it("reports the same byte offset as the sync path", async () => {
    const schema = z.object({ a: z.string().min(5) });
    const bytes = Uint8Array.from([1, 120]);
    const sync = safeDecode(schema, bytes);
    expect(sync.success).toBe(false);
    const asyncError = await decodeAsync(schema, bytes).catch((error: unknown) => error);
    expect(asyncError).toBeInstanceOf(DecodeError);
    expect((asyncError as DecodeError).offset).toBe(
      sync.success === false ? (sync.error as DecodeError).offset : -1,
    );
  });
});

describe("fuzz: the encoder never escapes its contract", () => {
  // Everything above feeds the decoder bytes it did not write. These feed the
  // encoder values it did not build: a getter, a proxy trap and a subclass all
  // reach `_encode` through the same property reads an ordinary object does, and
  // any of them can run caller code in the middle of an encode.

  it("keeps the encode failure when the path walk re-reads a value that throws", () => {
    // `encodePath` re-reads the caller's value to name the field that failed, so a
    // getter throwing only on the second read used to escape from the walk and
    // replace the EncodeError with its own — the caller was told "second read"
    // instead of which field was wrong.
    let reads = 0;
    const schema = m.object({ a: m.string(), b: m.string() });
    const value = {
      a: "x",
      get b(): string {
        reads++;
        if (reads > 1) throw new RangeError("second read");
        return 42 as unknown as string;
      },
    };
    expect(() => schema.encode(value)).toThrow(EncodeError);
    expect(reads).toBeGreaterThan(1);
  });

  it("keeps the encode failure when a proxy trap throws during the path walk", () => {
    let reads = 0;
    const schema = m.object({ a: m.string(), b: m.string() });
    const value = new Proxy({ a: "x", b: 42 } as Record<string, unknown>, {
      get(target, key) {
        if (key === "b" && ++reads > 1) throw new TypeError("trap");
        return target[key as string];
      },
    }) as unknown as { a: string; b: string };
    expect(() => schema.encode(value)).toThrow(EncodeError);
  });

  it("encodes through a proxy and an Array subclass as it would the plain values", () => {
    const object = m.object({ a: m.string() });
    expect([...object.encode(new Proxy({ a: "x" }, {}))]).toEqual([...object.encode({ a: "x" })]);

    class Branded extends Array<number> {}
    const array = m.array(m.uint());
    expect([...array.encode(Branded.from([1, 2]) as number[])]).toEqual([...array.encode([1, 2])]);
  });

  it("refuses a value whose getter throws, without claiming to have encoded it", () => {
    const schema = m.object({ a: m.string() });
    const value = {
      get a(): string {
        throw new RangeError("boom");
      },
    };
    // The caller's own error, unwrapped: shorn did not fail, the value did.
    expect(() => schema.encode(value)).toThrow(RangeError);
    // And the pooled Writer is left clean for the next encode.
    expect([...schema.encode({ a: "x" })]).toEqual([1, 120]);
  });

  it("holds the __proto__ rule on every path that writes keys, not just declared ones", () => {
    // Three schemas take a key from the payload rather than from the schema, and
    // each stores it differently: a record, an open object's tail, and a dynamic
    // object. All three must land the key as an own property and leave
    // `Object.prototype` alone.
    const value = Object.defineProperty({ a: 2 }, "__proto__", {
      configurable: true,
      enumerable: true,
      value: 1,
      writable: true,
    });

    for (const schema of [
      compile(z.record(z.string(), z.int())),
      compile(z.object({ a: z.int() }).catchall(z.int())),
      compile(z.any()),
    ]) {
      const decoded = schema.decode(schema.encode(value as never)) as Record<string, unknown>;
      expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
      expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    }

    // Only the dynamic path is shorn's own here: zod strips an own `__proto__` key
    // in `validate()` before the record and open-object encoders ever see it, so
    // those two round-trip without the key at all. `z.any()` has no such filter in
    // front of it, and that is the path where shorn's own `defineProperty` store is
    // the only thing between a hostile payload and the prototype.
    const any = compile(z.any());
    const dynamic = any.decode(any.encode(value)) as Record<string, unknown>;
    expect(Object.hasOwn(dynamic, "__proto__")).toBe(true);
    expect(dynamic["__proto__"]).toBe(1);
    expect(Object.getPrototypeOf(dynamic)).toBe(Object.prototype);
  });

  it("refuses every value a dynamic schema cannot spell, rather than writing it empty", () => {
    const any = compile(z.any());
    for (const value of [1n, Symbol("s"), undefined, new Uint8Array(2), /x/, () => 0]) {
      expect(() => any.encode(value)).toThrow(EncodeError);
    }
    // A null-prototype object is a plain object with no prototype, not a rich type,
    // so it is written as the object its keys make it.
    expect([...any.encode(Object.assign(Object.create(null), { a: 1 }) as object)]).toEqual([
      ...any.encode({ a: 1 }),
    ]);
  });
});

describe("fuzz: allocation is bounded by input length, not by schema shape", () => {
  // Both of these ran as `it.skip` while the decoder had no allocation budget: the
  // first would have killed the runner outright. `Schema._minWidth` closed them.
  it("rejects a nested array count no remaining input could satisfy", () => {
    const schema = m.array(m.array(m.array(m.uint())));
    const count = m.uint().encode(1_000_000);
    expectDecodeError(() => schema.decode(Uint8Array.from([...count, ...count, ...count])), 9);
  });

  it("rejects zero-width element schemas when the array is declared", () => {
    // A literal, an empty tuple and an empty object all encode to nothing, so an
    // array of them decouples the element count from the input length entirely.
    // No decode-time budget can bound that, so the schema itself is refused.
    expect(() => m.array(m.literal("x"))).toThrow(EncodeError);
    expect(() => m.array(m.tuple([]))).toThrow(EncodeError);
    expect(() => m.array(m.object({}))).toThrow(EncodeError);
    // A tuple's count is fixed by the schema, so zero-width members stay legal.
    expect(m.tuple([m.literal("x"), m.uint()]).decode(Uint8Array.from([7]))).toEqual(["x", 7]);
  });

  it("rejects the amplification payload before allocating for it", () => {
    // The confirmed report: seven bytes against an ordinary schema forced 16 MB of
    // heap and a 2,287,431:1 amplification before the truncation was discovered.
    const schema = m.object({
      items: m.array(m.object({ id: m.string(), tags: m.array(m.string()) })),
    });
    const count = m.uint().encode(1_000_000);
    const payload = Uint8Array.from([...count, 0, ...count]);
    expect(payload.length).toBe(7);
    expectDecodeError(() => schema.decode(payload), payload.length);
  });

  it("allocates from the schema, not the input, for a fixed-count zero-width array", () => {
    // The one hole in the budget above, pinned rather than claimed shut. A fixed
    // count is exempt from the zero-width refusal because it comes from the schema —
    // but `_minWidth` is then 0, so a *variable* container repeats that free
    // allocation once per byte and the "never more elements than bytes" invariant
    // stops holding. 101 bytes below yield 100,000 elements; the same schema with
    // `.length(1_000_000)` yields 100,000,000 from the same 101 bytes.
    //
    // ponytail: known ceiling, reachable only from a schema that declares a large
    // fixed array of a constant. The fix is a per-decode slot budget on Reader,
    // starting at max(MAX_COLLECTION_LENGTH, input length) and charged by every
    // array and record — not taken here because it touches the hot decode path.
    const schema = compile(
      z.array(z.object({ n: z.int(), pad: z.array(z.literal("x")).length(1000) })),
    );
    const payload = Uint8Array.from([100, ...Array<number>(100).fill(0)]);
    const decoded = schema.decode(payload) as { pad: string[] }[];
    expect(decoded).toHaveLength(100);
    expect(countArrayElements(decoded)).toBeGreaterThan(payload.length);
  });

  it("still accepts every array whose declared count the input can satisfy", () => {
    // The guard must reject only the unsatisfiable. A valid encoding always carries
    // at least `length * _minWidth` bytes, so none of these may regress.
    for (const [schema, value] of [
      [m.array(m.uint()), []],
      [m.array(m.uint()), [0, 1, 127, 128, 300]],
      [m.array(m.string()), ["", "", ""]],
      [m.array(m.float64()), [1.5, -0, Infinity]],
      [m.array(m.array(m.uint())), [[], [1], [1, 2, 3]]],
      [m.array(m.object({ a: m.uint(), b: m.string().optional() })), [{ a: 1 }, { a: 2, b: "x" }]],
      [m.array(m.tuple([m.literal("k"), m.uint()])), [["k", 1], ["k", 2]]],
    ] as const) {
      expect(schema.decode(schema.encode(value as never))).toEqual(value);
    }
  });
});
