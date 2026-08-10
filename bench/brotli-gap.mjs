/**
 * Why does msgpackr's shared-record format end up smaller under Brotli than
 * shorn, while being 18% larger raw?
 *
 * The hypothesis under test is *alignment*, not redundancy. shorn writes varints,
 * so a field's width depends on its value and every record has a different length
 * — the same field lands at a different offset in each record. Brotli predicts a
 * byte from the ones just before it, so a stream whose records drift out of phase
 * gives it a context that never repeats. msgpackr spends bytes on a type tag per
 * value and a record marker per record, which is pure waste raw, but it makes the
 * stream periodic and the tags themselves a repeating pattern.
 *
 * The test: pad every shorn record to a fixed width. That is strictly *more* raw
 * bytes and exactly zero extra information. If alignment is what Brotli is paying
 * for, the padded stream compresses better than the dense one despite being bigger
 * — and there is nothing to fix, only a trade to name.
 *
 * Run: node bench/brotli-gap.mjs
 */
import process from "node:process";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { Packr } from "msgpackr";
import * as fixtures from "./fixtures.mjs";

const COUNT = 100_000;

function token(index, salt) {
  let value = Math.imul(index + salt, 0x9e3779b1) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  return value.toString(36).padStart(7, "0");
}

// Without this the counters are perfect arithmetic sequences, every gap is one
// constant, and delta encoding compresses them to nothing — a fixture artifact,
// not a result. `--jitter` gives the gaps a realistic spread.
const jitter = process.argv.includes("--jitter");
// `token`'s last XOR yields a signed int, so its base36 form can carry a leading
// "-". Taken through Math.abs, or the gaps go negative and the counters become a
// random walk rather than the monotonic thing the delta claim is about.
const gap = (index, salt, spread) =>
  jitter ? Math.abs(Number.parseInt(token(index, salt).slice(0, 5), 36)) % spread : 0;
let idCursor = 731_942;
let clock = 1_725_435_678;
let bytesUsed = 500_000;

const batch = Array.from({ length: COUNT }, (_, index) => ({
  id: (idCursor += 1 + gap(index, 3, 40)),
  timestamp: (clock += 1 + gap(index, 5, 900)),
  active: index % 7 !== 0,
  actor: {
    name: index % 3 === 0 ? "Rahul" : index % 3 === 1 ? "Ada" : "Linus",
    age: 20 + (index % 50),
    sex: index % 3 === 0 ? "M" : index % 3 === 1 ? "F" : "X",
  },
  metrics: { cpu: (index % 16) / 16, memory: (bytesUsed += 1_024 + gap(index, 7, 4_096)) },
  tags: index % 2 === 0 ? ["api", "edge", "paid"] : ["worker", "free"],
}));

const brotli = (bytes, lgwin) =>
  brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 6,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      ...(lgwin === undefined ? {} : { [constants.BROTLI_PARAM_LGWIN]: lgwin }),
    },
  }).length;

const concat = (chunks) => {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

// One shorn record per event, so they can be re-laid-out without touching the codec.
const records = batch.map((value) => fixtures.event.encode(value));
const width = records.reduce((widest, record) => Math.max(widest, record.length), 0);

const dense = concat(records);
const padded = concat(
  records.map((record) => {
    const slot = new Uint8Array(width);
    slot.set(record);
    return slot;
  }),
);

const msgpackr = new Packr({ structuredClone: false, bundleStrings: false }).pack(batch);

/**
 * Row layout untouched, counters stored as gaps.
 *
 * Simulated by pre-deltaing the three monotonic fields and encoding with the
 * shipped schema — the bytes are exactly what a `delta` uint would write. The
 * point is that this needs no reordering at all: unlike the columnar layout, it
 * leaves every record where it is, and it makes the payload smaller *raw* rather
 * than only after a compressor.
 */
const deltaBatch = batch.map((row, index) => {
  const previous = index === 0 ? undefined : batch[index - 1];
  return {
    ...row,
    id: previous === undefined ? row.id : row.id - previous.id,
    timestamp: previous === undefined ? row.timestamp : row.timestamp - previous.timestamp,
    metrics: {
      ...row.metrics,
      memory:
        previous === undefined ? row.metrics.memory : row.metrics.memory - previous.metrics.memory,
    },
  };
});

const rows = {
  "shorn (dense varints)": dense,
  [`shorn zero-padded to ${width}B`]: padded,
  "shorn + delta counters (row layout)": fixtures.batch.encode(deltaBatch),
  "msgpackr shared records": msgpackr,
};

console.log(`\n${COUNT.toLocaleString()} repetitive events, record width ${width} B\n`);
console.table(
  Object.fromEntries(
    Object.entries(rows).map(([name, bytes]) => [
      name,
      {
        raw: bytes.length.toLocaleString(),
        gzip: gzipSync(bytes).length.toLocaleString(),
        "brotli q6": brotli(bytes).toLocaleString(),
        "brotli lgwin24": brotli(bytes, 24).toLocaleString(),
        "brotli ratio": `${(bytes.length / brotli(bytes)).toFixed(2)}x`,
      },
    ]),
  ),
);

/**
 * Where the gap actually lives.
 *
 * One field at a time, same 100,000 rows, shorn against msgpackr. A whole-payload
 * ratio says shorn loses; it does not say on what. Splitting per field type turns
 * "Brotli likes their format better" into a specific claim about specific bytes.
 */
const { m } = await import("../dist/index.js");
const FIELDS = [
  ["monotonic uint (id)", m.uint(), (row) => row.id],
  ["monotonic uint (memory)", m.uint(), (row) => row.metrics.memory],
  ["repeating string (name)", m.string(), (row) => row.actor.name],
  ["enum (sex)", m.enum(["F", "M", "X"]), (row) => row.actor.sex],
  ["boolean (active)", m.boolean(), (row) => row.active],
  ["cycling float64 (cpu)", m.float64(), (row) => row.metrics.cpu],
  ["small uint (age)", m.uint(), (row) => row.actor.age],
];

console.log("Per field, 100,000 values, Brotli q6 — shorn against msgpackr\n");
console.table(
  Object.fromEntries(
    FIELDS.map(([name, schema, read]) => {
      const values = batch.map(read);
      const ours = fixtures.batch === undefined ? undefined : m.array(schema).encode(values);
      const theirs = new Packr({ structuredClone: false }).pack(values);
      const oursBrotli = brotli(ours);
      const theirsBrotli = brotli(theirs);
      return [
        name,
        {
          "shorn raw": ours.length.toLocaleString(),
          "shorn brotli": oursBrotli.toLocaleString(),
          "msgpackr raw": theirs.length.toLocaleString(),
          "msgpackr brotli": theirsBrotli.toLocaleString(),
          verdict:
            oursBrotli === theirsBrotli
              ? "tie"
              : oursBrotli < theirsBrotli
                ? `shorn -${(100 - (oursBrotli / theirsBrotli) * 100).toFixed(0)}%`
                : `LOSES +${((oursBrotli / theirsBrotli) * 100 - 100).toFixed(0)}%`,
        },
      ];
    }),
  ),
);
