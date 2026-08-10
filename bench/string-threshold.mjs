// Where should Writer.string switch between a manual loop and TextEncoder?
//
// src/core.ts sends every non-ASCII string through encodeInto with a 3x reserve and
// a copyWithin, and every ASCII string through a charCodeAt loop with no upper gate.
// Five other codecs gate the two strategies by length — avsc's own comment puts the
// crossover at 64 chars: "roughly 50% faster than the manual implementation below
// for long strings". This finds shorn's crossover, on shorn's fixtures.
//
// Every variant is checked byte-identical against the real Writer before it is timed.
import process from "node:process";
import { Writer } from "../dist/index.js";
import { median } from "./measure.mjs";

const args = new Set(process.argv.slice(2));
const quick = args.has("--quick");
const targetSampleMs = quick ? 40 : 120;
const sampleCount = quick ? 3 : 7;
let sink = 0;

const textEncoder = new TextEncoder();

// ---------------------------------------------------------------- shared writer
// Every variant runs against the REAL Writer from dist, with only the string
// strategy swapped — a hand-written replica of the class measured 6x slower than
// the shipped one, so the replica was what got benchmarked, not the code. TypeScript
// `private` is erased at runtime, so buffer/offset/ensure/varuint are all reachable.
// `offset = 0` between operations keeps the grown buffer, removing allocation noise
// that is identical across variants anyway.
const reset = (writer) => {
  writer.offset = 0;
  return writer;
};

// One scan that answers everything the strategies need: is it ASCII, is it well
// formed, and how many UTF-8 bytes will it take. The current implementation already
// walks every code unit for the surrogate check; this adds one accumulator to it,
// and knowing the length up front is what removes the reserve and the copyWithin.
function scan(value) {
  let ascii = true;
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
      continue;
    }
    ascii = false;
    if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("unpaired surrogate");
      bytes += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("unpaired surrogate");
    } else {
      bytes += 3;
    }
  }
  return { ascii, bytes };
}

// ------------------------------------------------------------------- strategies

// The shipped implementation itself, not a copy of it.
function current(writer, value) {
  writer.string(value);
}

// encodeInto, but with the byte length known from the scan: no 3x reserve, no
// copyWithin. Isolates whether the memmove is the cost or encodeInto itself.
function exactEncodeInto(writer, value) {
  const { ascii, bytes } = scan(value);
  writer.varuint(bytes);
  writer.ensure(bytes);
  if (ascii) {
    for (let index = 0; index < value.length; index++) {
      writer.buffer[writer.offset++] = value.charCodeAt(index);
    }
    return;
  }
  textEncoder.encodeInto(value, writer.buffer.subarray(writer.offset));
  writer.offset += bytes;
}

// Manual UTF-8, length from the scan. No TextEncoder on any path.
function manualUtf8(writer, value) {
  const { bytes } = scan(value);
  writer.varuint(bytes);
  writer.ensure(bytes);
  const buffer = writer.buffer;
  let offset = writer.offset;
  for (let index = 0; index < value.length; index++) {
    let code = value.charCodeAt(index);
    if (code < 0x80) {
      buffer[offset++] = code;
    } else if (code < 0x800) {
      buffer[offset++] = 0xc0 | (code >> 6);
      buffer[offset++] = 0x80 | (code & 0x3f);
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      code = 0x10000 + ((code & 0x3ff) << 10) + (next & 0x3ff);
      buffer[offset++] = 0xf0 | (code >> 18);
      buffer[offset++] = 0x80 | ((code >> 12) & 0x3f);
      buffer[offset++] = 0x80 | ((code >> 6) & 0x3f);
      buffer[offset++] = 0x80 | (code & 0x3f);
    } else {
      buffer[offset++] = 0xe0 | (code >> 12);
      buffer[offset++] = 0x80 | ((code >> 6) & 0x3f);
      buffer[offset++] = 0x80 | (code & 0x3f);
    }
  }
  writer.offset = offset;
}

// encodeInto for ASCII too, replacing the charCodeAt loop. ASCII byte length is the
// code-unit length, so this needs no scan beyond the surrogate check the format
// requires anyway — for pure ASCII that check cannot fail, so it is skipped here
// and this is therefore the most generous possible reading of the native path.
function asciiEncodeInto(writer, value) {
  writer.varuint(value.length);
  writer.ensure(value.length);
  textEncoder.encodeInto(value, writer.buffer.subarray(writer.offset));
  writer.offset += value.length;
}

// ---------------------------------------------------------------------- corpus
// Built with join, never slice: a SlicedString costs 1.69 ns/char under charCodeAt
// against 0.94 for a flat one, measured here, which would bias every manual-loop
// variant against every TextEncoder one for reasons that have nothing to do with
// the strategies.
// Cycles whole code points, so an astral pattern never gets cut into lone
// surrogates, and joins once so the result is a flat string.
const repeat = (unit, target) => {
  const points = [...unit];
  const out = [];
  let units = 0;
  for (let index = 0; units + points[index % points.length].length <= target; index++) {
    const point = points[index % points.length];
    out.push(point);
    units += point.length;
  }
  return out.join("");
};
const ASCII_LENGTHS = [1, 2, 4, 8, 16, 24, 32, 48, 64, 96, 128, 256, 512, 1024];
const WIDE_LENGTHS = [2, 4, 8, 16, 24, 32, 48, 64, 96, 128, 256];

const profiles = {
  ascii: { unit: "abcdefghij0123456789", lengths: ASCII_LENGTHS },
  // one accent in otherwise-ASCII text: the common European case, ~1.05 bytes/unit
  accent: { unit: "café and cream, ", lengths: WIDE_LENGTHS },
  // 3 bytes per code unit
  cjk: { unit: "こんにちは世界", lengths: WIDE_LENGTHS },
  // surrogate pairs: 2 code units, 4 bytes
  emoji: { unit: "\u{1f600}\u{1f44b}\u{1f680}", lengths: WIDE_LENGTHS },
};

// ------------------------------------------------------------------- validation
// A variant that does not produce the real Writer's bytes is not a candidate.
function reference(value) {
  const writer = new Writer();
  writer.string(value);
  return writer.finish();
}

function validate(forProfile) {
  const writer = new Writer();
  let checked = 0;
  for (const [profile, { unit, lengths }] of Object.entries(profiles)) {
    const strategies = forProfile(profile);
    for (const length of lengths) {
      const value = repeat(unit, length);
      const expected = reference(value);
      for (const [name, strategy] of Object.entries(strategies)) {
        strategy(reset(writer), value);
        const actual = writer.buffer.subarray(0, writer.offset);
        if (actual.length !== expected.length || actual.some((b, i) => b !== expected[i])) {
          throw new Error(
            `${name} disagrees with Writer.string on ${JSON.stringify(value.slice(0, 12))} (len ${length})`,
          );
        }
        checked++;
      }
    }
  }
  return checked;
}

// ---------------------------------------------------------------------- timing
// Own calibration, not `nanosPerOp`: this sweep compares strategies at a fixed
// sample budget, so the iteration count has to come from `targetSampleMs`.
function measure(operation) {
  for (let index = 0; index < 2_000; index++) sink ^= operation();

  let iterations = 200;
  while (true) {
    const start = performance.now();
    for (let index = 0; index < iterations; index++) sink ^= operation();
    const elapsed = performance.now() - start;
    if (elapsed >= targetSampleMs / 3 || iterations >= 2_000_000) {
      iterations = Math.max(1, Math.min(2_000_000, Math.round(iterations * (targetSampleMs / elapsed))));
      break;
    }
    iterations *= 4;
  }

  const samples = [];
  for (let sample = 0; sample < sampleCount; sample++) {
    const start = performance.now();
    for (let index = 0; index < iterations; index++) sink ^= operation();
    samples.push(((performance.now() - start) * 1_000_000) / iterations);
  }
  return median(samples);
}

function nanos(strategy, value) {
  const writer = new Writer();
  return measure(() => {
    strategy(reset(writer), value);
    return writer.offset;
  });
}

// ------------------------------------------------------------------------ main
const asciiStrategies = { current, asciiEncodeInto, exactEncodeInto, manualUtf8 };
const wideStrategies = { current, exactEncodeInto, manualUtf8 };
const strategiesFor = (profile) => (profile === "ascii" ? asciiStrategies : wideStrategies);

console.log(`validated ${validate(strategiesFor)} variant outputs against Writer.string\n`);

for (const [profile, { unit, lengths }] of Object.entries(profiles)) {
  const strategies = strategiesFor(profile);
  const names = Object.keys(strategies);
  console.log(`## ${profile}`);
  console.log(["chars".padStart(6), "bytes".padStart(6), ...names.map((n) => n.padStart(17))].join(""));

  for (const length of lengths) {
    const value = repeat(unit, length);
    const encoded = reference(value).length;
    const timings = names.map((name) => nanos(strategies[name], value));
    const best = Math.min(...timings);
    const cells = timings.map((ns, index) => {
      const mark = ns === best ? "*" : " ";
      const delta = index === 0 ? "" : ` ${(((ns - timings[0]) / timings[0]) * 100).toFixed(0)}%`;
      return `${mark}${ns.toFixed(1)}${delta}`.padStart(17);
    });
    console.log([String(length).padStart(6), String(encoded).padStart(6), ...cells].join(""));
  }
  console.log("");
}
console.log("ns/op, median of", sampleCount, "samples; * marks the fastest; % is versus current");
if (sink === 42) console.log("");
