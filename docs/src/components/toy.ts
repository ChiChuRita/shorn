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
