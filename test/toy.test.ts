import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type } from "arktype";
import * as v from "valibot";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { decode, encode } from "../src/index.js";
import {
  compare,
  completePayload,
  completeSchema,
  DEFAULT_PAYLOAD,
  evaluate,
  fieldsOf,
  type Lib,
  measure,
  tokenize,
  type Validator,
  VALIDATORS,
} from "../docs/src/components/toy.js";

// The same three the page loads, bound the same way.
const LIBS: Record<Validator, Lib> = {
  zod: { binding: "z", ns: z },
  arktype: { binding: "type", ns: type },
  valibot: { binding: "v", ns: v, structure: (s) => toStandardJsonSchema(s) },
};
const DEFAULT_SCHEMA = VALIDATORS.zod.schema;

// The landing-page playground evaluates pasted text and reports two byte counts. Both
// halves can silently lie: a stripped declaration that drops a character still parses,
// and a size comparison is unfalsifiable by eye, so it gets one check here.
describe("landing playground", () => {
  const codec = { encode, decode };

  it("accepts a bare expression and a const declaration alike", () => {
    const bare = encode(evaluate(LIBS.zod, 'z.enum(["M", "F"])') as never, "F" as never);
    const declared = encode(
      evaluate(LIBS.zod, 'export const Sex = z.enum(["M", "F"]);') as never,
      "F" as never,
    );
    expect(bare).toEqual(declared);
    expect(bare.length).toBe(1);
  });

  it("reports shorn's bytes, JSON's bytes, and the round trip", () => {
    const result = measure(
      LIBS.zod,
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
    const result = measure(LIBS.zod, codec, DEFAULT_SCHEMA, DEFAULT_PAYLOAD);

    expect(result.bytes.length).toBe(6);
    expect(result.jsonSize).toBe(98);
    expect(result.roundTrips).toBe(true);
    expect(compare(result.bytes.length, result.jsonSize)).toEqual({
      ratio: "16.33×",
      unit: "smaller than JSON",
      delta: "92 bytes saved",
    });
  });

  // The switcher's claim: the same record through any of the three is the same bytes.
  it("encodes the three default schemas to the same bytes", () => {
    const results = (Object.keys(VALIDATORS) as Validator[]).map((name) =>
      measure(LIBS[name], codec, VALIDATORS[name].schema, DEFAULT_PAYLOAD),
    );
    const first = results[0]!;
    expect(results).toHaveLength(3);
    expect(first.bytes.length).toBe(6);
    for (const result of results) {
      expect(result.bytes).toEqual(first.bytes);
      expect(result.roundTrips).toBe(true);
    }
  });

  it("reads each default schema's fields and enum members the same way", () => {
    for (const name of Object.keys(VALIDATORS) as Validator[]) {
      const fields = fieldsOf(LIBS[name], VALIDATORS[name].schema);
      expect([...fields.keys()].sort(), name).toEqual(
        ["canDelete", "canRead", "canWrite", "memberId", "role", "suspended"],
      );
      expect(fields.get("role")?.sort(), name).toEqual(["admin", "editor", "viewer"]);
    }
    expect(fieldsOf(LIBS.zod, "z.object({").size).toBe(0);
  });

  // The last `|` marks the caret; any earlier one is an ArkType union.
  const at = (text: string) => {
    const caret = text.lastIndexOf("|");
    return [text.slice(0, caret) + text.slice(caret + 1), caret] as const;
  };
  const schema = (text: string, validator: Validator) => completeSchema(...at(text), validator);

  it("completes builders, refinements, and ArkType keywords, and nothing in strings", () => {
    expect(schema("z.object({ a: z.st|", "zod")).toEqual({
      from: 16,
      items: ["strictObject", "string"],
      call: true,
    });
    expect(schema("z.int().non|", "zod")?.items).toEqual(["nonnegative"]);
    expect(schema("v.pic|", "valibot")?.items).toEqual(["picklist"]);
    expect(schema("v.|", "valibot")?.items).toEqual(VALIDATORS.valibot.builders);
    expect(schema('type({ a: "number.in|', "arktype")).toEqual({
      from: 11,
      items: ["number.integer"],
      call: false,
    });
    expect(schema("type({ a: \"string | nu|", "arktype")?.items).toEqual(["number", "number.integer", "null"]);

    expect(schema('z.enum(["z.st|', "zod")).toBeNull();
    expect(schema("// z.st|", "zod")).toBeNull();
    expect(schema('type({ a: "string" }|', "arktype")).toBeNull();
    expect(schema("zz.st|", "zod")).toBeNull();
    expect(schema("z.string|", "zod")).toBeNull();
  });

  it("completes the payload's missing keys and its enum members", () => {
    const fields = fieldsOf(LIBS.zod, DEFAULT_SCHEMA);
    const payload = (text: string) => completePayload(...at(text), fields);

    expect(payload('{ "memberId": 1, "can|')).toEqual({
      from: 18,
      items: ["canRead", "canWrite", "canDelete"],
      call: false,
    });
    expect(payload('{ "role": "ed|" }')?.items).toEqual(["editor"]);
    expect(payload('{ "role": "|" }')?.items).toEqual(["viewer", "editor", "admin"]);
    expect(payload('{ "memberId": "|')).toBeNull();
    expect(payload('{ "role": "editor", "ro|')).toBeNull();
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
    expect(() => measure(LIBS.zod, codec, "", "{}")).toThrow(SyntaxError);
    expect(() => measure(LIBS.zod, codec, "z.object({ n: z.int() })", '{ "n": "nope" }')).toThrow();
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
