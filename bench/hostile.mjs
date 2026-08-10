/**
 * What a hostile payload costs.
 *
 * The other benchmarks measure well-formed input, which is the case an attacker
 * does not send. Three things decide whether a decoder is safe to point at the
 * open internet, and none of them appear in a throughput table:
 *
 *   1. Amplification — how much heap N bytes of input can force before the decoder
 *      notices the input cannot satisfy what it declared.
 *   2. Rejection cost — how fast malformed input is refused. A decoder that is slow
 *      to say no is a DoS vector even though it never returns a wrong answer.
 *   3. Scaling — decode time per byte must stay flat. Anything super-linear turns a
 *      large-but-legal payload into an outage.
 *
 * Run: node --expose-gc bench/hostile.mjs
 */
import process from "node:process";
import { m, DecodeError } from "../dist/index.js";
import { nanosPerOp, opsPerSecond, readSink } from "./measure.mjs";

const varuint = (value) => m.uint().encode(value);

// ---------------------------------------------------------------------------
// 1. Amplification ceiling
// ---------------------------------------------------------------------------
// Each case is the smallest payload we can build that *declares* a huge structure.
// `retained` is what the decode actually managed to allocate before it gave up.

const AMPLIFICATION = [
  {
    name: "array of uint, 1M declared",
    schema: m.array(m.uint()),
    payload: () => Uint8Array.from(varuint(1_000_000)),
  },
  {
    name: "array of object, 1M declared",
    schema: m.array(m.object({ id: m.string(), tags: m.array(m.string()) })),
    payload: () => Uint8Array.from([...varuint(1_000_000), 0, ...varuint(1_000_000)]),
  },
  {
    name: "triple-nested array, 1M each",
    schema: m.array(m.array(m.array(m.uint()))),
    payload: () =>
      Uint8Array.from([...varuint(1_000_000), ...varuint(1_000_000), ...varuint(1_000_000)]),
  },
  {
    name: "string, 64MB declared",
    schema: m.string(),
    payload: () => Uint8Array.from(varuint(64 * 1024 * 1024)),
  },
  {
    name: "bytes, 64MB declared",
    schema: m.bytes(),
    payload: () => Uint8Array.from(varuint(64 * 1024 * 1024)),
  },
  {
    name: "deep object, every field a 1M array",
    schema: m.object({
      a: m.array(m.uint()),
      b: m.array(m.uint()),
      c: m.array(m.string()),
    }),
    payload: () => Uint8Array.from(varuint(1_000_000)),
  },
];

const amplification = AMPLIFICATION.map(({ name, schema, payload }) => {
  const bytes = payload();
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  let outcome = "accepted";
  const start = process.hrtime.bigint();
  try {
    schema.decode(bytes);
  } catch (error) {
    outcome = error instanceof DecodeError ? "rejected" : `ESCAPED ${error.constructor.name}`;
  }
  const nanos = Number(process.hrtime.bigint() - start);
  const retained = Math.max(0, process.memoryUsage().heapUsed - before);
  return {
    case: name,
    "input bytes": bytes.length,
    outcome,
    "heap delta": `${(retained / 1024).toFixed(0)} KB`,
    amplification: `${(retained / bytes.length).toFixed(0)}x`,
    "reject in": `${(nanos / 1000).toFixed(1)} us`,
  };
});
console.log("\nAmplification — smallest payload that declares the largest structure");
console.table(amplification);

// The comparison that gives the numbers above a scale: a schemaless parser has no
// declared-count to check against an input length, so its ceiling is its input.
const hostileJson = `[${"[]".repeat(1)}${",[]".repeat(200_000)}]`;
const jsonStart = process.hrtime.bigint();
const parsed = JSON.parse(hostileJson);
const jsonNanos = Number(process.hrtime.bigint() - jsonStart);
console.log(
  `\nFor scale — JSON.parse on ${(hostileJson.length / 1024).toFixed(0)} KB of nested empty ` +
    `arrays: ${parsed.length.toLocaleString()} objects allocated in ` +
    `${(jsonNanos / 1e6).toFixed(1)} ms. A schemaless parser has no declared count to ` +
    `check, so it allocates first and discovers the shape after.`,
);

// ---------------------------------------------------------------------------
// 2. Rejection throughput
// ---------------------------------------------------------------------------
// Refusing must be at least as cheap as accepting, or "invalid" becomes the fast
// path to burn a server's CPU.

const event = m.object({
  active: m.boolean(),
  actor: m.object({ age: m.uint(), name: m.string(), sex: m.enum(["F", "M", "X"]) }),
  id: m.uint(),
  tags: m.array(m.string()),
});
const validEvent = event.encode({
  active: true,
  actor: { age: 25, name: "Rahul", sex: "M" },
  id: 731_942,
  tags: ["api", "edge"],
});

const MALFORMED = [
  ["valid (baseline)", validEvent],
  ["empty", Uint8Array.from([])],
  ["truncated to half", validEvent.slice(0, validEvent.length >> 1)],
  ["one trailing byte", Uint8Array.from([...validEvent, 0])],
  ["invalid boolean marker", Uint8Array.from([2, ...validEvent.slice(1)])],
  ["overlong varint", Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00])],
  ["all 0xff", Uint8Array.from(Array(validEvent.length).fill(0xff))],
  ["all zero", Uint8Array.from(Array(validEvent.length).fill(0))],
];

const rejection = MALFORMED.map(([label, bytes]) => {
  const run = () => {
    try {
      return event.decode(bytes).id;
    } catch {
      return 1;
    }
  };
  return {
    payload: label,
    bytes: bytes.length,
    "ns/op": nanosPerOp(run).toFixed(1),
    "ops/s": Math.round(opsPerSecond(run)).toLocaleString(),
  };
});
console.log("\nRejection cost — refusing must not be dearer than accepting");
console.table(rejection);

// ---------------------------------------------------------------------------
// 3. Scaling
// ---------------------------------------------------------------------------
// ns per input byte must stay flat across four orders of magnitude. A rising column
// is a super-linear decoder, which a large legal payload turns into an outage.

const scaling = [10, 100, 1_000, 10_000, 100_000].flatMap((count) => {
  const cases = [
    ["array of uint", m.array(m.uint()), Array.from({ length: count }, (_, i) => i)],
    ["array of string", m.array(m.string()), Array.from({ length: count }, (_, i) => `id-${i}`)],
    [
      "nested objects",
      m.array(m.object({ a: m.uint(), b: m.string(), c: m.array(m.uint()) })),
      Array.from({ length: count }, (_, i) => ({ a: i, b: `n${i}`, c: [i, i + 1] })),
    ],
  ];
  return cases.map(([label, schema, value]) => {
    const bytes = schema.encode(value);
    const nanos = nanosPerOp(() => schema.decode(bytes).length);
    return {
      shape: label,
      elements: count.toLocaleString(),
      bytes: bytes.length.toLocaleString(),
      "ns/byte": (nanos / bytes.length).toFixed(3),
      "MB/s": ((bytes.length / nanos) * 1000).toFixed(0),
    };
  });
});
console.log("\nScaling — ns per input byte across four orders of magnitude");
console.table(scaling);

// ---------------------------------------------------------------------------
// 4. Pathological but legal content
// ---------------------------------------------------------------------------
// Input an attacker controls the *content* of, not just the framing: the shapes
// that push a decoder onto its slow paths.

const CONTENT = [
  ["ascii, 8 bytes (fast path)", m.string(), "abcdefgh"],
  ["ascii, 9 bytes (decoder path)", m.string(), "abcdefghi"],
  ["astral only, 1000 chars", m.string(), "\u{1F600}".repeat(1000)],
  ["worst-case UTF-8 mix", m.string(), "aé一\u{1F600}".repeat(250)],
  ["max-width varints", m.array(m.uint()), Array(1000).fill(Number.MAX_SAFE_INTEGER)],
  ["alternating sign ints", m.array(m.int()), Array.from({ length: 1000 }, (_, i) => (i % 2 ? -i : i))],
  ["1000 empty strings", m.array(m.string()), Array(1000).fill("")],
  ["17 optionals, none set", m.object(
    Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${String(i).padStart(2, "0")}`, m.uint().optional()])),
  ), {}],
];

const content = CONTENT.map(([label, schema, value]) => {
  const bytes = schema.encode(value);
  const decodeNanos = nanosPerOp(() => {
    const out = schema.decode(bytes);
    return typeof out === "string" ? out.length : 0;
  });
  const encodeNanos = nanosPerOp(() => schema.encode(value).length);
  return {
    content: label,
    bytes: bytes.length.toLocaleString(),
    "encode ns": encodeNanos.toFixed(0),
    "decode ns": decodeNanos.toFixed(0),
    "decode ns/byte": (decodeNanos / bytes.length).toFixed(2),
  };
});
console.log("\nAttacker-controlled content — the shapes that hit the slow paths");
console.table(content);

console.log(`\nBenchmark sink: ${readSink()}`);
