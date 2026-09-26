// Dependencies are passed in so the browser can load them lazily and tests can use
// the real validator and codec.

export interface Codec {
  encode(schema: any, value: any): Uint8Array;
  decode(schema: any, bytes: Uint8Array): unknown;
}

export const DEFAULT_SCHEMA = `z.object({
  memberId: z.int().nonnegative(),
  role: z.enum(["viewer", "editor", "admin"]),
  canRead: z.boolean(),
  canWrite: z.boolean(),
  canDelete: z.boolean(),
  suspended: z.boolean(),
})`;

export const DEFAULT_PAYLOAD = `{
  "memberId": 42,
  "role": "editor",
  "canRead": true,
  "canWrite": true,
  "canDelete": false,
  "suspended": false
}`;

// Accept either an expression or a pasted `const Name = expression` declaration.
export function evaluate(z: unknown, src: string): unknown {
  const expression = src
    .trim()
    .replace(/^(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*=\s*/, "")
    .replace(/;+$/, "");
  if (expression === "") throw new SyntaxError("Nothing to evaluate.");
  return new Function("z", `return (${expression})`)(z);
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

export function measure(z: unknown, codec: Codec, schemaSrc: string, payloadSrc: string) {
  const schema = evaluate(z, schemaSrc);
  const value = evaluate(z, payloadSrc);
  const bytes = codec.encode(schema, value);
  // Byte equality rather than a deep compare: shorn decodes keys in canonical order,
  // so comparing JSON strings would report a false mismatch on key order alone.
  const again = codec.encode(schema, codec.decode(schema, bytes));
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
