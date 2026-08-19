import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DecodeError,
  EncodeError,
  compile,
  decodeAsync,
  encode,
  encodeAsync,
  fingerprinted,
  m,
} from "../src/index.js";

const Person = z.object({
  name: z.string(),
  age: z.int().nonnegative(),
  sex: z.enum(["M", "F", "X"]),
});
const person = { name: "Rahul", age: 25, sex: "M" as const };

describe("fingerprint envelope", () => {
  // The fingerprint hashes `wireSignature`, which is JSON.stringify over object
  // literals — so property *insertion order* in wireShape() silently decides these
  // bytes. A cosmetic refactor there would reissue every fingerprint in existence
  // and invalidate stored data. This vector is what makes that a failing test
  // rather than a support ticket.
  it("pins the canonical fingerprint bytes", () => {
    expect([...fingerprinted(compile(Person)).fingerprint]).toEqual([114, 54, 209]);
  });

  it("prefixes the fingerprint and leaves the payload byte-identical", () => {
    const bare = encode(Person, person);
    expect([...bare]).toEqual([25, 5, 82, 97, 104, 117, 108, 1]);
    for (const bytes of [1, 2, 3, 4] as const) {
      const codec = fingerprinted(compile(Person), { bytes });
      const framed = codec.encode(person);
      expect(framed.length).toBe(bare.length + bytes);
      expect([...framed.subarray(0, bytes)]).toEqual([...codec.fingerprint]);
      expect([...framed.subarray(bytes)]).toEqual([...bare]);
      expect(codec.decode(framed)).toEqual(person);
    }
  });

  // Each of these decodes to a WRONG VALUE with no error at all when bare. That is
  // the entire reason the envelope exists; positional decoding has no redundancy
  // left to notice.
  it.each([
    [
      "a renamed field pair swaps its values",
      z.object({ alpha: z.int().nonnegative(), beta: z.int().nonnegative() }),
      z.object({ gamma: z.int().nonnegative(), delta: z.int().nonnegative() }),
      { alpha: 10, beta: 20 },
      { gamma: 20, delta: 10 },
    ],
    [
      "a widened integer halves it",
      z.object({ n: z.int().nonnegative() }),
      z.object({ n: z.int() }),
      { n: 8 },
      { n: 4 },
    ],
    [
      "an enum that gained a member shifts every case",
      z.object({ role: z.enum(["admin", "user"]) }),
      z.object({ role: z.enum(["admin", "auditor", "user"]) }),
      { role: "user" },
      { role: "auditor" },
    ],
  ])("rejects what bare decoding corrupts silently: %s", (_name, before, after, value, corrupted) => {
    expect(encode(after, corrupted as never)).toEqual(encode(before, value as never));

    const written = fingerprinted(compile(before)).encode(value as never);
    expect(() => fingerprinted(compile(after)).decode(written)).toThrow(DecodeError);
  });

  it("does not reissue the fingerprint for a change that cannot move a byte", () => {
    const base = [...fingerprinted(compile(Person)).fingerprint];
    const equivalent = [
      z.object({ sex: z.enum(["M", "F", "X"]), age: z.int().nonnegative(), name: z.string() }),
      z.object({ name: z.string(), age: z.int().nonnegative().max(300), sex: z.enum(["M", "F", "X"]) }),
      z.strictObject({ name: z.string(), age: z.int().nonnegative(), sex: z.enum(["M", "F", "X"]) }),
    ];
    for (const schema of equivalent) {
      expect([...fingerprinted(compile(schema)).fingerprint]).toEqual(base);
    }
  });

  it("keeps each retained width distinct, so K is not silently interchangeable", () => {
    // Regression guard for the seed: FNV-1a is a congruence chain mod 2^32, so a
    // `retain` folded into bits 8 and above cannot reach the low output byte and
    // every width would agree there.
    const prefixes = ([1, 2, 3, 4] as const).map((bytes) =>
      [...fingerprinted(compile(Person), { bytes }).fingerprint].join(","),
    );
    expect(new Set(prefixes).size).toBe(4);
    const lowByte = ([1, 2, 3, 4] as const).map((bytes) => {
      const fp = fingerprinted(compile(Person), { bytes }).fingerprint;
      return fp[fp.length - 1];
    });
    expect(new Set(lowByte).size).toBe(4);
  });

  it("refuses to mix framed and bare payloads in either direction", () => {
    const codec = fingerprinted(compile(Person));
    expect(() => codec.decode(encode(Person, person))).toThrow(DecodeError);
    expect(() => compile(Person).decode(codec.encode(person))).toThrow(DecodeError);
  });

  it("rejects a truncated envelope rather than reading past it", () => {
    const codec = fingerprinted(compile(Person));
    const framed = codec.encode(person);
    for (let length = 0; length < framed.length; length++) {
      expect(() => codec.decode(framed.subarray(0, length))).toThrow(DecodeError);
    }
  });

  it("names the expected fingerprint so a mismatch is diagnosable", () => {
    const codec = fingerprinted(compile(Person));
    expect(() => codec.decode(encode(Person, person))).toThrow(/7236d1/);
  });

  // The evolution story is dispatch: shorn detects a mismatch and never resolves one,
  // so an application keeps a codec per schema version it has written. That needs a
  // stable string key, which `fingerprint` cannot be — it is a fresh array per read.
  it("exposes a hex key a dispatch map can actually use", () => {
    const codec = fingerprinted(compile(Person));
    expect(codec.fingerprintHex).toBe("7236d1");
    expect(codec.fingerprintHex).toBe(codec.fingerprintHex);

    const written = codec.encode(person);
    const byVersion = new Map([[codec.fingerprintHex, codec]]);
    const key = [...written.subarray(0, 3)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(byVersion.get(key)?.decode(written)).toEqual(person);
  });

  it("hands out a copy, so a stray write cannot make the encoder non-canonical", () => {
    const codec = fingerprinted(compile(Person));
    const before = codec.encode(person);
    const stolen = codec.fingerprint;
    stolen[0] = 0;
    stolen[1] = 0;
    expect([...codec.encode(person)]).toEqual([...before]);
    expect([...codec.fingerprint]).toEqual([114, 54, 209]);
  });

  // `fingerprinted(compile(asyncSchema))`, the combination that was once unusable in
  // every direction: encoding said to use encodeAsync, and no async entry point took
  // a codec, so the advice could not be followed. A sync encode still refuses, because
  // the validator still returns a promise — what changed is that the remedy it names
  // now exists for this codec.
  describe("asynchronous validation through the envelope", () => {
    const Async = z.object({ name: z.string() }).refine(async () => true);

    it("round-trips, and still refuses the sync entry point", async () => {
      const codec = fingerprinted(compile(Async));
      expect(() => codec.encode({ name: "x" })).toThrow(/validates asynchronously/);

      const bytes = await encodeAsync(codec, { name: "x" });
      await expect(decodeAsync(codec, bytes)).resolves.toEqual({ name: "x" });
    });

    // The whole point of the envelope, and the half most easily lost by handing async
    // a codec that skips validation: the prefix has to be written on the way out and
    // checked on the way back, or async payloads are silently unframed.
    it("writes and checks the prefix on the async path", async () => {
      const codec = fingerprinted(compile(Async), { bytes: 4 });
      const bytes = await encodeAsync(codec, { name: "x" });
      const bare = await encodeAsync(compile(Async), { name: "x" });

      expect(bytes.length).toBe(bare.length + 4);
      expect([...bytes.subarray(0, 4)]).toEqual([...codec.fingerprint]);
      expect([...bytes.subarray(4)]).toEqual([...bare]);

      await expect(decodeAsync(codec, bare)).rejects.toThrow(
        /written by a different schema/,
      );
    });

    // A codec with nothing to await is a caller mistake, not a codec to run
    // synchronously behind their back. `m` has no validator at all; the marker
    // wrappers hide the one their inner codec has.
    it("refuses a codec that carries no validator", async () => {
      await expect(encodeAsync(m.string(), "x")).rejects.toThrow(/no validator to await/);
      await expect(encodeAsync(compile(Async).nullable(), { name: "x" })).rejects.toThrow(
        /no validator to await/,
      );
    });
  });

  // Two wrappers deep — the envelope over the compiled codec — and the path still
  // has to survive both. Either one failing to delegate ends the walk at the top.
  it("names the failing field through the envelope", () => {
    const codec = fingerprinted(compile(Person));
    expect(() => codec.encode({ ...person, name: "\ud800" })).toThrow(
      "String contains an unpaired surrogate at name",
    );
  });

  it("refuses codecs with no structural signature, and invalid widths", () => {
    expect(() => fingerprinted(m.object({ a: m.uint() }))).toThrow(EncodeError);
    expect(() => fingerprinted(compile(Person), { bytes: 0 as 1 })).toThrow(EncodeError);
    expect(() => fingerprinted(compile(Person), { bytes: 5 as 4 })).toThrow(EncodeError);
    // And it says so without stringifying whatever arrived: an object with no prototype
    // replaced the refusal with a TypeError out of the message explaining it.
    expect(() => fingerprinted(compile(Person), { bytes: Object.create(null) as 4 })).toThrow(
      "Fingerprint bytes must be 1, 2, 3 or 4, received object",
    );
  });
});
