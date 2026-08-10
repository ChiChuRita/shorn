/**
 * Does a columnar wire layout compress better than the row layout shorn ships?
 *
 * Throwaway experiment, no library change: an object-of-arrays schema built from
 * `m` already emits exactly the bytes a columnar encoder would, so the question
 * is answered by transposing the fixture in JS and measuring.
 *
 * Variants, cheapest first:
 *   row       — what shorn encodes today
 *   column    — every leaf field its own array, nested structs shredded flat
 *   column+d  — same, with monotonic numeric columns stored as deltas
 *
 * The delta variant is a ceiling, not a proposal: it picks the delta columns by
 * hand, which a real encoder could only do from a schema hint or a heuristic.
 *
 * Run: node bench/columnar.mjs [--large] [--high-entropy]
 */
import assert from "node:assert/strict";
import process from "node:process";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { m } from "../dist/index.js";
import * as fixtures from "./fixtures.mjs";
import { nanosPerOp } from "./measure.mjs";

const args = new Set(process.argv.slice(2));
const large = args.has("--large");
const highEntropy = args.has("--high-entropy");
// run.mjs generates id/timestamp/memory as perfect arithmetic sequences, which
// flatters delta encoding beyond anything a real stream would: every gap is the
// same constant, so the whole column compresses to nothing. `--jitter` gives the
// gaps a spread, which is what an event stream actually looks like.
const jitter = args.has("--jitter");
const batchSize = large ? 100_000 : 100;

// Byte-identical to run.mjs's generator, so these numbers sit next to that table.
function token(index, salt) {
  let value = Math.imul(index + salt, 0x9e3779b1) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  return value.toString(36).padStart(7, "0");
}

// Math.abs because `token`'s last XOR yields a signed int, so its base36 form can
// lead with "-". Without it the gaps go negative and the counters are a random
// walk rather than the monotonic thing delta encoding is a claim about.
const gap = (index, salt, spread) =>
  jitter ? Math.abs(Number.parseInt(token(index, salt).slice(0, 5), 36)) % spread : 0;

let idCursor = 731_942;
let clock = 1_725_435_678;
let bytesUsed = 500_000;

const batch = Array.from({ length: batchSize }, (_, index) => ({
  id: (idCursor += 1 + gap(index, 3, 40)),
  timestamp: (clock += 1 + gap(index, 5, 900)),
  active: index % 7 !== 0,
  actor: {
    name: highEntropy
      ? `user-${index}-${token(index, 17)}`
      : index % 3 === 0
        ? "Rahul"
        : index % 3 === 1
          ? "Ada"
          : "Linus",
    age: 20 + (index % 50),
    sex: index % 3 === 0 ? "M" : index % 3 === 1 ? "F" : "X",
  },
  metrics: { cpu: (index % 16) / 16, memory: (bytesUsed += 1_024 + gap(index, 7, 4_096)) },
  tags: highEntropy
    ? [`trace-${token(index, 31)}`, `span-${token(index, 47)}`]
    : index % 2 === 0
      ? ["api", "edge", "paid"]
      : ["worker", "free"],
}));

/**
 * One column per leaf field. `tags` is a repeated field, so it shreds into a
 * per-row count plus one flat value column — the same trick Parquet plays, and
 * the reason the tag strings end up adjacent to each other rather than to a
 * float and two varints.
 */
const columnSchema = (deltas) =>
  m.object({
    active: m.array(m.boolean()),
    actorAge: m.array(m.uint()),
    actorName: m.array(m.string()),
    actorSex: m.array(m.enum(["F", "M", "X"])),
    cpu: m.array(m.float64()),
    id: m.array(deltas ? m.int() : m.uint()),
    memory: m.array(deltas ? m.int() : m.uint()),
    tagCounts: m.array(m.uint()),
    tagValues: m.array(m.string()),
    timestamp: m.array(deltas ? m.int() : m.uint()),
  });

const delta = (values) => values.map((value, index) => (index === 0 ? value : value - values[index - 1]));
const undelta = (values) => {
  let running = 0;
  return values.map((value) => (running += value));
};

function transpose(rows, deltas) {
  const columns = {
    active: [], actorAge: [], actorName: [], actorSex: [],
    cpu: [], id: [], memory: [], tagCounts: [], tagValues: [], timestamp: [],
  };
  for (const row of rows) {
    columns.active.push(row.active);
    columns.actorAge.push(row.actor.age);
    columns.actorName.push(row.actor.name);
    columns.actorSex.push(row.actor.sex);
    columns.cpu.push(row.metrics.cpu);
    columns.id.push(row.id);
    columns.memory.push(row.metrics.memory);
    columns.timestamp.push(row.timestamp);
    columns.tagCounts.push(row.tags.length);
    for (const tag of row.tags) columns.tagValues.push(tag);
  }
  if (!deltas) return columns;
  return {
    ...columns,
    id: delta(columns.id),
    memory: delta(columns.memory),
    timestamp: delta(columns.timestamp),
  };
}

function untranspose(columns, deltas) {
  const id = deltas ? undelta(columns.id) : columns.id;
  const memory = deltas ? undelta(columns.memory) : columns.memory;
  const timestamp = deltas ? undelta(columns.timestamp) : columns.timestamp;
  const rows = [];
  let tagOffset = 0;
  for (let index = 0; index < columns.tagCounts.length; index++) {
    const count = columns.tagCounts[index];
    rows.push({
      id: id[index],
      timestamp: timestamp[index],
      active: columns.active[index],
      actor: {
        name: columns.actorName[index],
        age: columns.actorAge[index],
        sex: columns.actorSex[index],
      },
      metrics: { cpu: columns.cpu[index], memory: memory[index] },
      tags: columns.tagValues.slice(tagOffset, tagOffset + count),
    });
    tagOffset += count;
  }
  return rows;
}

const sizes = (bytes) => ({
  raw: bytes.length,
  gzip: gzipSync(bytes).length,
  brotli: brotliCompressSync(bytes, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 6, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length },
  }).length,
});

/**
 * Timed end to end, from the caller's row-shaped objects and back to them: the
 * transpose is not free and hiding it behind the encode call would measure a
 * codec nobody can actually use. `targetMs` is generous because one op here is a
 * whole 100,000-event batch.
 */
function timings(encode, decode) {
  const bytes = encode();
  return {
    encodeMs: nanosPerOp(encode, { targetMs: 400, warmup: 3, samples: 5 }) / 1e6,
    decodeMs: nanosPerOp(() => decode(bytes), { targetMs: 400, warmup: 3, samples: 5 }) / 1e6,
  };
}

const rows = [];
rows.push([
  "JSON",
  sizes(Buffer.from(JSON.stringify(batch))),
  timings(() => Buffer.from(JSON.stringify(batch)), (bytes) => JSON.parse(bytes.toString())),
]);
rows.push([
  "shorn row",
  sizes(fixtures.batch.encode(batch)),
  timings(() => fixtures.batch.encode(batch), (bytes) => fixtures.batch.decode(bytes)),
]);

for (const deltas of [false, true]) {
  const schema = columnSchema(deltas);
  const encode = () => schema.encode(transpose(batch, deltas));
  const decode = (bytes) => untranspose(schema.decode(bytes), deltas);
  const encoded = encode();
  // The layout is only interesting if it is lossless: decode, rebuild the rows,
  // and compare against the fixture the row encoder was handed.
  assert.deepStrictEqual(decode(encoded), batch);
  rows.push([
    deltas ? "shorn column+delta" : "shorn column",
    sizes(encoded),
    timings(encode, decode),
  ]);
}

const json = rows[0][1];
const rowTimes = rows[1][2];
const pct = (value, base) => `${(100 - (value / base) * 100).toFixed(1)}%`;
const ratio = (value, base) => `${(value / base).toFixed(2)}x`;

console.log(
  `\n${batchSize.toLocaleString()} events, ${highEntropy ? "high-entropy" : "repetitive"}` +
    `${jitter ? ", jittered counters" : ""}\n`,
);
console.table(
  Object.fromEntries(
    rows.map(([name, size]) => [
      name,
      {
        raw: size.raw.toLocaleString(),
        "vs JSON": pct(size.raw, json.raw),
        gzip: size.gzip.toLocaleString(),
        "vs JSON gzip": pct(size.gzip, json.gzip),
        "brotli q6": size.brotli.toLocaleString(),
        "vs JSON brotli": pct(size.brotli, json.brotli),
      },
    ]),
  ),
);
// Splits the columnar decode into the part shorn does and the part the caller's
// transpose does. If the reshape dominates, an in-codec columnar layout — which
// writes rows straight out of the reader and never materializes a column array —
// gets that time back, and the table above is a floor rather than a verdict.
{
  const schema = columnSchema(true);
  const encoded = schema.encode(transpose(batch, true));
  const columns = schema.decode(encoded);
  const codecMs = nanosPerOp(() => schema.decode(encoded), { targetMs: 400, warmup: 3, samples: 5 }) / 1e6;
  const reshapeMs =
    nanosPerOp(() => untranspose(columns, true), { targetMs: 400, warmup: 3, samples: 5 }) / 1e6;
  console.log(
    `column+delta decode split: shorn ${codecMs.toFixed(2)} ms, caller-side reshape ` +
      `${reshapeMs.toFixed(2)} ms (row decode: ${rowTimes.decodeMs.toFixed(2)} ms)\n`,
  );
}

console.table(
  Object.fromEntries(
    rows.map(([name, , time]) => [
      name,
      {
        "encode ms": time.encodeMs.toFixed(2),
        "vs shorn row": ratio(time.encodeMs, rowTimes.encodeMs),
        "decode ms": time.decodeMs.toFixed(2),
        "vs shorn row ": ratio(time.decodeMs, rowTimes.decodeMs),
      },
    ]),
  ),
);
