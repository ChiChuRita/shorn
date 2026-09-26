import { describe, expect, it } from "vitest";
import { z } from "zod";
import { decode, encode } from "../src/index.js";
import {
  compare,
  DEFAULT_PAYLOAD,
  DEFAULT_SCHEMA,
  evaluate,
  measure,
  tokenize,
} from "../docs/src/components/toy.js";

// The landing-page playground evaluates pasted text and reports two byte counts. Both
// halves can silently lie: a stripped declaration that drops a character still parses,
// and a size comparison is unfalsifiable by eye, so it gets one check here.
describe("landing playground", () => {
  const codec = { encode, decode };

  it("accepts a bare expression and a const declaration alike", () => {
    const bare = encode(evaluate(z, 'z.enum(["M", "F"])') as never, "F" as never);
    const declared = encode(
      evaluate(z, 'export const Sex = z.enum(["M", "F"]);') as never,
      "F" as never,
    );
    expect(bare).toEqual(declared);
    expect(bare.length).toBe(1);
  });

  it("reports shorn's bytes, JSON's bytes, and the round trip", () => {
    const result = measure(
      z,
      codec,
      "z.object({ name: z.string(), age: z.int().nonnegative() })",
      '{ "name": "Ada", "age": 36 }',
    );

    expect(result.bytes.length).toBe(5);
    expect(result.json).toBe('{"name":"Ada","age":36}');
    expect(result.jsonSize).toBe(23);
    expect(result.roundTrips).toBe(true);
  });

  it("backs the default playground comparison with the real encoder", () => {
    const result = measure(z, codec, DEFAULT_SCHEMA, DEFAULT_PAYLOAD);

    expect(result.bytes.length).toBe(6);
    expect(result.jsonSize).toBe(98);
    expect(result.roundTrips).toBe(true);
    expect(compare(result.bytes.length, result.jsonSize)).toEqual({
      ratio: "16.33×",
      unit: "smaller than JSON",
      delta: "92 bytes saved",
    });
  });

  it("states the direction instead of printing a fraction of an ×", () => {
    expect(compare(18, 74)).toEqual({
      ratio: "4.11×",
      unit: "smaller than JSON",
      delta: "56 bytes saved",
    });
    // shorn loses here: float64 spends 8 bytes on a number JSON writes as one character.
    expect(compare(26, 15)).toEqual({
      ratio: "1.73×",
      unit: "larger than JSON",
      delta: "11 bytes more",
    });
    expect(compare(8, 8).unit).toBe("the size of JSON");
  });

  it("throws rather than reporting a number it cannot back up", () => {
    expect(() => measure(z, codec, "", "{}")).toThrow(SyntaxError);
    expect(() => measure(z, codec, "z.object({ n: z.int() })", '{ "n": "nope" }')).toThrow();
  });

  // The highlight sits under the text box glyph for glyph, so a dropped or doubled
  // character misaligns every one after it. The expected kinds are what Shiki's
  // github-dark, the docs' theme, gives the same text.
  it("highlights losslessly, in the docs' colours", () => {
    const pick = (src: string, lang: "ts" | "json") => {
      const runs = tokenize(src, lang);
      expect(runs.map((r) => r.text).join("")).toBe(src);
      return runs.filter((r) => r.kind !== "plain").map((r) => `${r.kind}:${r.text.trim()}`);
    };
    for (const src of [DEFAULT_SCHEMA, '"unterminated', "/* open", "a\n\n  b"]) pick(src, "ts");
    for (const src of [DEFAULT_PAYLOAD, '{ "k": "v', "{ bare: 1 }"]) pick(src, "json");

    expect(pick('// c\nconst P = z.enum(["a"]).min(0.5); z.null() || true', "ts")).toEqual([
      "comment:// c",
      "keyword:const",
      "constant:P",
      "keyword:=",
      "function:enum",
      'string:"a"',
      "function:min",
      "constant:0.5",
      "function:null",
      "keyword:||",
      "constant:true",
    ]);
    expect(pick('{ "n": -2.5e3, "s": "v", "b": false, "z": null }', "json")).toEqual([
      'constant:"n"',
      "constant:-2.5e3",
      'constant:"s"',
      'string:"v"',
      'constant:"b"',
      "constant:false",
      'constant:"z"',
      "constant:null",
    ]);
  });
});
