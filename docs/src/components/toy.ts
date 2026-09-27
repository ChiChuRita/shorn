// Dependencies are passed in so the browser can load them lazily and tests can use
// the real validator and codec.

export interface Codec {
  encode(schema: any, value: any, structure?: any): Uint8Array;
  decode(schema: any, bytes: Uint8Array, structure?: any): unknown;
}

export type Validator = "zod" | "arktype" | "valibot";

/** A loaded validator: what the schema text calls it, and how shorn reads its structure. */
export interface Lib {
  /** The one name the typed schema can refer to: `z`, `type`, or `v`. */
  binding: string;
  ns: unknown;
  /** Valibot's JSON Schema conversion is a separate package, so shorn takes its output
      as a third argument. Zod and ArkType carry it on the schema and need nothing. */
  structure?: (schema: any) => unknown;
}

/**
 * What the playground knows about each validator. The three default schemas describe
 * the same record, so switching shows the same bytes: that is the claim the docs make
 * for all three, and the test file checks it rather than trusting this comment.
 *
 * `builders` is what completion offers after `z.` or `v.`, and for ArkType, inside a
 * definition string. Only shapes shorn can encode, as listed on Supported types, so a
 * suggestion never leads to a refusal. Not the validators' whole API on purpose.
 */
export const VALIDATORS: Record<
  Validator,
  { label: string; binding: string; schema: string; builders: string[]; chain?: string[] }
> = {
  zod: {
    label: "Zod",
    binding: "z",
    schema: `z.object({
  memberId: z.int().nonnegative(),
  role: z.enum(["viewer", "editor", "admin"]),
  canRead: z.boolean(),
  canWrite: z.boolean(),
  canDelete: z.boolean(),
  suspended: z.boolean(),
})`,
    builders: [
      "object", "strictObject", "looseObject", "string", "boolean", "int", "number",
      "literal", "null", "enum", "uuid", "iso.datetime", "date", "bigint", "array",
      "tuple", "set", "map", "record", "union", "discriminatedUnion", "optional",
      "nullable", "lazy", "any", "unknown",
    ],
    // After `).`: the refinements that change the bytes, and the two wrappers.
    chain: ["nonnegative", "length", "optional", "nullable", "catchall"],
  },
  arktype: {
    label: "ArkType",
    binding: "type",
    schema: `type({
  memberId: "number.integer >= 0",
  role: "'viewer' | 'editor' | 'admin'",
  canRead: "boolean",
  canWrite: "boolean",
  canDelete: "boolean",
  suspended: "boolean",
})`,
    builders: [
      "string", "boolean", "number", "number.integer", "null", "string.uuid", "Date",
      "bigint", "unknown",
    ],
  },
  valibot: {
    label: "Valibot",
    binding: "v",
    schema: `v.object({
  memberId: v.pipe(v.number(), v.integer(), v.minValue(0)),
  role: v.picklist(["viewer", "editor", "admin"]),
  canRead: v.boolean(),
  canWrite: v.boolean(),
  canDelete: v.boolean(),
  suspended: v.boolean(),
})`,
    builders: [
      "object", "strictObject", "looseObject", "string", "boolean", "number", "integer",
      "minValue", "literal", "null", "picklist", "uuid", "isoTimestamp", "date",
      "bigint", "array", "length", "tuple", "tupleWithRest", "set", "map", "record",
      "union", "variant", "optional", "nullable", "pipe", "lazy", "any", "unknown",
    ],
  },
};

export const DEFAULT_PAYLOAD = `{
  "memberId": 42,
  "role": "editor",
  "canRead": true,
  "canWrite": true,
  "canDelete": false,
  "suspended": false
}`;

// Accept either an expression or a pasted `const Name = expression` declaration.
export function evaluate(lib: Lib, src: string): unknown {
  const expression = src
    .trim()
    .replace(/^(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*=\s*/, "")
    .replace(/;+$/, "");
  if (expression === "") throw new SyntaxError("Nothing to evaluate.");
  return new Function(lib.binding, `return (${expression})`)(lib.ns);
}

/**
 * The top-level fields of the schema in `src`, each with its enum members if it is an
 * enum, for the payload box to complete. Read from the same JSON Schema shorn reads, so
 * it is one path for all three validators. Empty rather than throwing: while the schema
 * is half-typed there is simply nothing to suggest.
 */
export function fieldsOf(lib: Lib, src: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  try {
    const schema = evaluate(lib, src) as any;
    const std = ((lib.structure ? lib.structure(schema) : schema) as any)["~standard"];
    const doc = std.jsonSchema.input({ target: "draft-2020-12" });
    for (const [key, prop] of Object.entries<any>(doc.properties ?? {})) {
      // Zod and Valibot write an enum as `enum`, ArkType as an `anyOf` of `const`s.
      const members: unknown[] = prop.enum ?? (prop.anyOf ?? prop.oneOf ?? []).map((b: any) => b.const);
      fields.set(key, members.filter((m): m is string => typeof m === "string"));
    }
  } catch {
    // Unparseable or unconvertible: no suggestions, and `run()` reports the real error.
  }
  return fields;
}

export function compare(shornSize: number, jsonSize: number) {
  if (shornSize === jsonSize) {
    return { ratio: "1.00×", unit: "the size of JSON", delta: "no bytes either way" };
  }
  const larger = shornSize > jsonSize;
  const [big, small] = larger ? [shornSize, jsonSize] : [jsonSize, shornSize];
  return {
    ratio: `${(big / small).toFixed(2)}×`,
    unit: larger ? "larger than JSON" : "smaller than JSON",
    delta: `${big - small} bytes ${larger ? "more" : "saved"}`,
  };
}

export interface JsonLine {
  /** One level in, the way a formatter would set a member of the top-level object. */
  indent: boolean;
  runs: { text: string; lift: boolean }[];
}

/**
 * The JSON broken into the lines a formatter would print, and each line into
 * key-and-punctuation runs and value runs so the strip can ink the values differently.
 *
 * The line breaks and the indent are layout: concatenating every `text` reproduces
 * `JSON.stringify(value)` exactly, so the strip stays one cell per byte and no
 * whitespace is smuggled into the byte count. That is asserted below rather than
 * assumed, because a value `JSON.stringify` drops (a function, a symbol, an
 * `undefined`) would silently shift every later run.
 *
 * Only the top level is broken up. A nested object or array stays on its field's line
 * as one value run, which is all the strip can ink it as anyway.
 */
export function jsonLines(value: unknown, json: string): JsonLine[] {
  const whole = [{ indent: false, runs: [{ text: json, lift: false }] }];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return whole;

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return whole;

  const lines: JsonLine[] = [{ indent: false, runs: [{ text: "{", lift: false }] }];
  for (const [i, [key, v]] of entries.entries()) {
    const runs = [
      { text: `${JSON.stringify(key)}:`, lift: false },
      { text: JSON.stringify(v), lift: true },
    ];
    // Trailing, so the comma sits on the line of the field it closes.
    if (i < entries.length - 1) runs.push({ text: ",", lift: false });
    lines.push({ indent: true, runs });
  }
  lines.push({ indent: false, runs: [{ text: "}", lift: false }] });

  const flat = lines.flatMap((l) => l.runs.map((r) => r.text)).join("");
  return flat === json ? lines : whole;
}

export function measure(lib: Lib, codec: Codec, schemaSrc: string, payloadSrc: string) {
  const schema = evaluate(lib, schemaSrc);
  const value = evaluate(lib, payloadSrc);
  // Converted once per run and passed to both calls: shorn caches the plan by the
  // identity of the structure object, so converting twice would build it twice.
  const structure = lib.structure?.(schema);
  const bytes = codec.encode(schema, value, structure);
  // Byte equality rather than a deep compare: shorn decodes keys in canonical order,
  // so comparing JSON strings would report a false mismatch on key order alone.
  const again = codec.encode(schema, codec.decode(schema, bytes, structure), structure);
  const json = JSON.stringify(value);
  return {
    bytes,
    json,
    lines: jsonLines(value, json),
    jsonSize: new TextEncoder().encode(json).byteLength,
    /** Re-encoding the decoded value reproduces the same bytes. */
    roundTrips: again.length === bytes.length && again.every((b, i) => b === bytes[i]),
  };
}

/**
 * What a highlighted run is inked as. Named for the colour role rather than the grammar,
 * because the docs' theme (github-dark) collapses many grammar scopes onto one colour:
 * numbers, `true`, a `const` binding, and a JSON key are all the same blue there.
 */
export type TokenKind = "plain" | "keyword" | "string" | "constant" | "function" | "comment";
export interface Token {
  text: string;
  kind: TokenKind;
}

// One alternation per language, tried in order at each position. Groups, for TS: comment,
// string, number, keyword, call (an identifier followed by `(`), literal, identifier,
// operator. A call is tested before a literal because Shiki inks `z.null()` as a call.
const TS_RULES =
  /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\[\s\S])*`?)|(\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?\b)|\b(const|let|var|export|import|from|as|new|return|typeof|function)\b|([A-Za-z_$][\w$]*)(?=\s*\()|\b(true|false|null|undefined)\b|([A-Za-z_$][\w$]*)|(=>|\.\.\.|[=!<>|&?+\-*%]+)/g;

// For JSON: a string, then whether a colon follows it (which makes it a key), a number,
// a literal.
const JSON_RULES =
  /("(?:[^"\\\n]|\\.)*"?)(\s*:)?|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false|null)\b/g;

/**
 * Split source into coloured runs for the playground's editors, matching the colours
 * Shiki's github-dark gives the same text in the docs.
 *
 * Not Shiki itself: the TypeScript grammar alone is several hundred KB, for two small
 * text boxes that only ever hold a Zod schema and a record. This covers what those hold
 * and degrades to plain text for anything it does not. Lossless: the runs concatenate
 * back to `src` exactly, which is what lets them sit under the text box glyph for glyph.
 */
export function tokenize(src: string, lang: "ts" | "json"): Token[] {
  const out: Token[] = [];
  const push = (text: string, kind: TokenKind) => {
    if (text === "") return;
    const last = out[out.length - 1];
    if (last?.kind === kind) last.text += text;
    else out.push({ text, kind });
  };

  const rules = lang === "ts" ? TS_RULES : JSON_RULES;
  rules.lastIndex = 0;
  let at = 0;
  // The last keyword seen, so the name after `const` can be inked as a binding.
  let binding = false;
  for (let m = rules.exec(src); m; m = rules.exec(src)) {
    push(src.slice(at, m.index), "plain");
    at = m.index + m[0].length;
    if (lang === "json") {
      if (m[1] !== undefined) {
        push(m[1], m[2] === undefined ? "string" : "constant");
        push(m[2] ?? "", "plain");
      } else push(m[0], "constant");
      continue;
    }
    const [, comment, string, number, keyword, call, literal, ident] = m;
    const kind: TokenKind =
      comment !== undefined
        ? "comment"
        : string !== undefined
          ? "string"
          : number !== undefined || literal !== undefined
            ? "constant"
            : keyword !== undefined
              ? "keyword"
              : call !== undefined
                ? "function"
                : ident !== undefined
                  ? binding
                    ? "constant"
                    : "plain"
                  : "keyword";
    binding = keyword === "const" || keyword === "let" || keyword === "var";
    push(m[0], kind);
  }
  push(src.slice(at), "plain");
  return out;
}

/** What to offer at the caret: replace `from..caret` with one of `items`. */
export interface Completion {
  from: number;
  items: string[];
  /** A builder: insert `()` after it and leave the caret between the two. */
  call: boolean;
}

/** Keep the ones the typed prefix starts, minus an exact match, which is already done. */
const narrow = (items: Iterable<string>, prefix: string) => {
  const p = prefix.toLowerCase();
  return [...items].filter((item) => item.toLowerCase().startsWith(p) && item !== prefix);
};

/**
 * Suggestions for the schema box at `caret`, or null for none.
 *
 * Deliberately a few patterns rather than a parser: after `z.` or `v.`, the builders;
 * after `).` in Zod, the refinements; and for ArkType, inside a definition string,
 * the keywords. The tokenizer decides whether the caret sits in a string or a comment,
 * so a `z.` inside `"..."` offers nothing, and an ArkType keyword is offered only there.
 */
export function completeSchema(src: string, caret: number, validator: Validator): Completion | null {
  const before = src.slice(0, caret);
  const { binding, builders, chain } = VALIDATORS[validator];
  const last = tokenize(before, "ts").at(-1);
  const inString = last?.kind === "string" && isOpen(last.text);
  if (last?.kind === "comment") return null;

  if (validator === "arktype") {
    if (!inString) return null;
    // `.` is part of the word here: `number.in` is a prefix of `number.integer`.
    const prefix = /[\w$.]*$/.exec(before)![0];
    const items = narrow(builders, prefix);
    return items.length ? { from: caret - prefix.length, items, call: false } : null;
  }
  if (inString) return null;

  const builder = new RegExp(`(?:^|[^\\w$.])${binding}\\.([\\w$.]*)$`).exec(before);
  const chained = chain && /\)\s*\.([\w$]*)$/.exec(before);
  const match = builder ?? chained;
  if (!match) return null;
  const [, prefix = ""] = match;
  const items = narrow(builder ? builders : chain!, prefix);
  return items.length ? { from: caret - prefix.length, items, call: true } : null;
}

/**
 * Suggestions for the payload box: a field name when the caret is in a key the payload
 * does not have yet, and an enum member when it is in the value of an enum field.
 * `fields` comes from `fieldsOf`.
 */
export function completePayload(
  src: string,
  caret: number,
  fields: Map<string, string[]>,
): Completion | null {
  const before = src.slice(0, caret);
  const key = /[{,]\s*"([^"\\\n]*)$/.exec(before);
  if (key) {
    const [, prefix = ""] = key;
    const present = new Set([...src.matchAll(/"([^"\\\n]*)"\s*:/g)].map((m) => m[1]));
    const items = narrow(fields.keys(), prefix).filter((k) => !present.has(k));
    return items.length ? { from: caret - prefix.length, items, call: false } : null;
  }
  const value = /"([^"\\\n]*)"\s*:\s*"([^"\\\n]*)$/.exec(before);
  if (value) {
    const [, name = "", prefix = ""] = value;
    const items = narrow(fields.get(name) ?? [], prefix);
    return items.length ? { from: caret - prefix.length, items, call: false } : null;
  }
  return null;
}

/** A string token the caret is still inside: its closing quote has not been typed. */
function isOpen(text: string) {
  const quote = text.charAt(0);
  if (text.length === 1) return true;
  // An escaped final quote does not close it: count the backslashes before it.
  const tail = /\\*$/.exec(text.slice(0, -1))![0].length;
  return !(text.endsWith(quote) && tail % 2 === 0);
}
