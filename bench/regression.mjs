/**
 * The regression gate for everything a test cannot assert exactly.
 *
 * Throughput, bundle size, startup cost, retained memory and hostile-input
 * behaviour are all numbers that drift rather than break. This measures them,
 * compares against the committed `bench/baseline.json`, and exits non-zero when
 * one moves the wrong way by more than its tolerance.
 *
 *   pnpm regress          run the gate
 *   pnpm regress:update   re-record the baseline (do this in its own commit)
 *
 * Tolerances are per-metric because the noise is: bundle bytes are deterministic
 * and gated at 1%, wall-clock throughput on a laptop with a browser open is not
 * and is gated at 25%. Improvements are reported, never failed — but a large one
 * is worth re-recording, or the next real regression hides inside the slack.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { z } from "zod";
import { compile, DecodeError, encodeInto, fingerprinted, m, unchecked } from "../dist/index.js";
import { documentValue } from "./document-value.mjs";
import * as fixtures from "./fixtures.mjs";
import { nanosPerOp, median, readSink } from "./measure.mjs";

const BASELINE_PATH = new URL("./baseline.json", import.meta.url);
const update = process.argv.includes("--update");
const only = process.argv.find((argument) => argument.startsWith("--only="))?.slice(7);

const metrics = [];
/**
 * @param direction "higher" when a bigger number is better (ops/s), "lower" when
 *   smaller is (nanoseconds, bytes). Decides which side of the tolerance fails.
 * @param floor Below this magnitude the percentage is meaningless and the metric
 *   passes. Retained heap after a clean run is a few KB of GC jitter that bounces
 *   between 2 and 6 — a ratio gate on that fails at random, and a gate that fails
 *   at random gets ignored, taking the real regressions with it. The signal worth
 *   catching is a leak, which is megabytes; the floor is where that starts.
 */
function record(group, name, measurement, unit, direction, tolerance, floor = 0) {
  // A function means "re-runnable": on a suspected regression the gate takes a
  // second reading before failing. Wall-clock rows get one because a single
  // contended run measured -36% on a metric that sits within +-5% across five
  // consecutive runs, and a gate that misfires occasionally is a gate people
  // learn to ignore. Deterministic rows (bytes) pass a plain number.
  const remeasure = typeof measurement === "function" ? measurement : undefined;
  const value = remeasure ? remeasure() : measurement;
  metrics.push({ key: `${group}/${name}`, group, name, value, unit, direction, tolerance, floor, remeasure });
}

const skip = (group) => only !== undefined && only !== group;

// ---------------------------------------------------------------------------
// Fixtures — the shapes the README and docs quote.
// ---------------------------------------------------------------------------

const { person, event, batch, document } = fixtures;
const personValue = { age: 25, name: "Rahul", sex: "M" };
const eventValue = {
  active: true,
  actor: personValue,
  id: 731_942,
  metrics: { cpu: 0.5, memory: 512_000 },
  tags: ["api", "edge"],
  timestamp: 1_725_435_678,
};
const batchValue = Array.from({ length: 100 }, (_, index) => ({
  ...eventValue,
  id: eventValue.id + index,
  timestamp: eventValue.timestamp + index,
}));
const unicode = m.string();
const unicodeValue = "Grüße 👋 राहुल".repeat(8);
const timestamps = m.array(m.uint());
const timestampValues = Array.from({ length: 500 }, (_, index) => 1_725_435_678_000 + index * 37);

const zodPerson = z.object({
  age: z.int().nonnegative(),
  name: z.string(),
  sex: z.enum(["F", "M", "X"]),
});
const zodCodec = compile(zodPerson);
const framed = fingerprinted(zodCodec);

// ---------------------------------------------------------------------------
// Throughput
// ---------------------------------------------------------------------------

if (!skip("throughput")) {
  const cases = [
    ["person", person, personValue],
    ["nested event", event, eventValue],
    ["100-event batch", batch, batchValue],
    ["unicode string", unicode, unicodeValue],
    ["500 ms timestamps", timestamps, timestampValues],
    ["zod person (validated)", zodCodec, personValue],
    // The same codec with the validator removed. Sits beside the validated row so the
    // price of validation is read off one run rather than inferred from the hand-built
    // `person` row above, which is only the same shape by construction.
    ["zod person (unchecked)", unchecked(zodCodec), personValue],
    ["fingerprinted zod person", framed, personValue],
    // Document-shaped, and the only row here whose objects are not all on the
    // generated decode path: `documentSection` has optional fields, so it decodes
    // interpreted. Every other row above is a small all-required record, which is
    // why they could not see the 2.1x decode gap msgpackr's own fixture exposed.
    ["document", document, documentValue],
  ];
  for (const [name, schema, value] of cases) {
    const bytes = schema.encode(value);
    record("throughput", `${name} encode`, () => 1e9 / nanosPerOp(() => schema.encode(value).length), "ops/s", "higher", 0.25);
    record("throughput", `${name} decode`, () => 1e9 / nanosPerOp(() => (schema.decode(bytes), 1)), "ops/s", "higher", 0.25);
  }
  // The same bytes as `person encode`, into a frame the caller owns: what the row above
  // pays for the output array and the copy that follows it.
  const frame = new Uint8Array(64);
  record("throughput", "person encodeInto", () => 1e9 / nanosPerOp(() => encodeInto(person, personValue, frame, 0)), "ops/s", "higher", 0.25);
}

// ---------------------------------------------------------------------------
// Hostile input — rejection cost and the allocation ceiling
// ---------------------------------------------------------------------------

if (!skip("hostile")) {
  const valid = event.encode(eventValue);
  const malformed = [
    ["empty", Uint8Array.from([])],
    ["truncated", valid.slice(0, valid.length >> 1)],
    ["trailing byte", Uint8Array.from([...valid, 0])],
    ["all 0xff", Uint8Array.from(Array(valid.length).fill(0xff))],
  ];
  for (const [name, bytes] of malformed) {
    record(
      "hostile",
      `reject ${name}`,
      () =>
        nanosPerOp(() => {
          try {
            return event.decode(bytes), 0;
          } catch {
            return 1;
          }
        }),
      "ns",
      "lower",
      0.3,
    );
  }

  // The allocation ceiling: the smallest payloads that declare the largest
  // structures. A rise here means a budget guard stopped covering a shape.
  const amplification = [
    ["array of uint", m.array(m.uint()), [...m.uint().encode(1_000_000)]],
    [
      "array of object",
      m.array(m.object({ id: m.string(), tags: m.array(m.string()) })),
      [...m.uint().encode(1_000_000), 0, ...m.uint().encode(1_000_000)],
    ],
    ["64MB string", m.string(), [...m.uint().encode(64 * 1024 * 1024)]],
  ];
  for (const [name, schema, payload] of amplification) {
    const bytes = Uint8Array.from(payload);
    const samples = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      global.gc?.();
      const before = process.memoryUsage().heapUsed;
      let rejected = false;
      try {
        schema.decode(bytes);
      } catch (error) {
        rejected = error instanceof DecodeError;
      }
      if (!rejected) {
        console.error(`FATAL: ${name} was not rejected — the allocation budget is gone.`);
        process.exit(2);
      }
      samples.push(Math.max(0, process.memoryUsage().heapUsed - before));
    }
    record("hostile", `${name} heap ceiling`, Math.round(median(samples) / 1024), "KB", "lower", 0.5, 256);
  }
}

// ---------------------------------------------------------------------------
// Payload size — deterministic, so gated at zero tolerance
// ---------------------------------------------------------------------------

if (!skip("size")) {
  for (const [name, schema, value] of [
    ["person", person, personValue],
    ["nested event", event, eventValue],
    ["100-event batch", batch, batchValue],
    ["unicode string", unicode, unicodeValue],
    ["500 ms timestamps", timestamps, timestampValues],
    ["fingerprinted person", framed, personValue],
    ["document", document, documentValue],
  ]) {
    record("size", `${name} bytes`, schema.encode(value).length, "B", "lower", 0);
  }
}

// ---------------------------------------------------------------------------
// Bundle cost — what a browser actually downloads
// ---------------------------------------------------------------------------

if (!skip("bundle")) {
  const entries = [
    ["m only", 'import { m } from "../dist/index.js"; globalThis.k = m;'],
    ["compile + m", 'import { compile, m } from "../dist/index.js"; globalThis.k = [compile, m];'],
    [
      "full surface",
      'import * as shorn from "../dist/index.js"; globalThis.k = shorn;',
    ],
  ];
  for (const [name, contents] of entries) {
    const result = await build({
      stdin: { contents, resolveDir: import.meta.dirname, loader: "js" },
      bundle: true,
      minify: true,
      treeShaking: true,
      write: false,
      platform: "browser",
      format: "esm",
      logLevel: "silent",
    });
    const bytes = result.outputFiles[0].contents;
    record("bundle", `${name} minified`, bytes.length, "B", "lower", 0.01);
    record("bundle", `${name} gzip`, gzipSync(bytes).length, "B", "lower", 0.01);
  }
}

// ---------------------------------------------------------------------------
// Startup — import through first encode, in a cold process
// ---------------------------------------------------------------------------

if (!skip("startup")) {
  const script = `
    const start = process.hrtime.bigint();
    const { compile, m } = await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});
    const imported = process.hrtime.bigint();
    const schema = m.object({ age: m.uint(), name: m.string(), sex: m.enum(["F","M","X"]) });
    schema.encode({ age: 25, name: "Rahul", sex: "M" });
    const ready = process.hrtime.bigint();
    console.log(JSON.stringify({
      import: Number(imported - start) / 1e6,
      firstEncode: Number(ready - imported) / 1e6,
    }));
  `;
  const runs = [];
  for (let attempt = 0; attempt < 7; attempt++) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      console.error(`FATAL: startup probe failed\n${result.stderr}`);
      process.exit(2);
    }
    runs.push(JSON.parse(result.stdout));
  }
  record("startup", "import", median(runs.map((run) => run.import)), "ms", "lower", 0.4);
  record("startup", "first encode", median(runs.map((run) => run.firstEncode)), "ms", "lower", 0.4);
}

// ---------------------------------------------------------------------------
// Memory — heap retained across a sustained encode/decode loop
// ---------------------------------------------------------------------------

if (!skip("memory")) {
  const samples = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let index = 0; index < 50_000; index++) {
      const bytes = event.encode(eventValue);
      if (event.decode(bytes).id !== eventValue.id) throw new Error("decode mismatch");
    }
    global.gc?.();
    samples.push(Math.max(0, process.memoryUsage().heapUsed - before));
  }
  record("memory", "retained after 50k round trips", Math.round(median(samples) / 1024), "KB", "lower", 0.6, 512);

  // The pooled writer must hand its oversized buffer back rather than pin it.
  const big = m.array(m.string());
  const bigValue = Array.from({ length: 20_000 }, (_, index) => `entry-${index}`);
  big.encode(bigValue);
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  for (let index = 0; index < 1000; index++) person.encode(personValue);
  global.gc?.();
  record(
    "memory",
    "retained after oversized encode",
    Math.round(Math.max(0, process.memoryUsage().heapUsed - before) / 1024),
    "KB",
    "lower",
    1.0,
    512,
  );
}

// ---------------------------------------------------------------------------
// Compare, report, gate
// ---------------------------------------------------------------------------

if (update) {
  const measured = Object.fromEntries(
    metrics.map((metric) => [
      metric.key,
      {
        value: Number(metric.value.toFixed(metric.unit === "ops/s" ? 0 : 3)),
        unit: metric.unit,
        direction: metric.direction,
        tolerance: metric.tolerance,
        floor: metric.floor,
      },
    ]),
  );
  // The machine is recorded because the wall-clock numbers only mean anything
  // relative to it: a baseline taken on an M-series laptop compared against a
  // shared CI runner is a false alarm generator, and this says which is which.
  const recordedOn = {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpus: `${(await import("node:os")).cpus().length} cores`,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify({ recordedOn, metrics: measured }, null, 2)}\n`);
  console.log(`Baseline updated: ${metrics.length} metrics written to bench/baseline.json`);
  console.log("Commit this on its own, so the numbers are reviewable as a change.");
  process.exit(0);
}

let baseline;
let recordedOn;
try {
  ({ metrics: baseline, recordedOn } = JSON.parse(readFileSync(BASELINE_PATH, "utf8")));
} catch {
  console.error("No bench/baseline.json — record one with `pnpm regress:update`.");
  process.exit(2);
}
const here = `${process.platform}-${process.arch}`;
if (recordedOn?.platform && recordedOn.platform !== here) {
  console.log(
    `Baseline was recorded on ${recordedOn.platform} (${recordedOn.node}); running on ${here}. ` +
      `Wall-clock rows are advisory across machines — size and bundle rows are not.`,
  );
}

const regressions = [];
const improvements = [];
const missing = [];
const rows = metrics.map((metric) => {
  const previous = baseline[metric.key];
  if (previous === undefined) {
    missing.push(metric.key);
    return { metric: metric.key, baseline: "new", current: metric.value, delta: "—", status: "NEW" };
  }
  const score = (value) => {
    const ratio = previous.value === 0 ? 1 : value / previous.value;
    return metric.direction === "higher" ? ratio - 1 : 1 - ratio;
  };
  let better = score(metric.value);
  if (better < -metric.tolerance && metric.remeasure !== undefined) {
    // Take the better of the two readings. A false alarm disappears; a real
    // regression reproduces, because both readings measure the same slow code.
    const second = metric.remeasure();
    metric.value =
      metric.direction === "higher" ? Math.max(metric.value, second) : Math.min(metric.value, second);
    better = score(metric.value);
  }
  const percent = better * 100;
  const belowFloor = metric.floor > 0 && metric.value < metric.floor && previous.value < metric.floor;
  let status = belowFloor ? "noise" : "ok";
  if (!belowFloor && better < -metric.tolerance) {
    status = "REGRESSED";
    regressions.push({ ...metric, previous: previous.value, percent });
  } else if (!belowFloor && better > Math.max(metric.tolerance, 0.1)) {
    status = "improved";
    improvements.push({ ...metric, previous: previous.value, percent });
  }
  return {
    metric: metric.key,
    baseline: previous.value,
    current: Number(metric.value.toFixed(metric.unit === "ops/s" ? 0 : 3)),
    unit: metric.unit,
    delta: `${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%`,
    tolerance: `${(metric.tolerance * 100).toFixed(0)}%`,
    status,
  };
});

console.table(rows);
console.log(`sink ${readSink()}`);

if (missing.length > 0) {
  console.log(`\n${missing.length} metric(s) have no baseline entry: ${missing.join(", ")}`);
  console.log("Run `pnpm regress:update` to record them.");
}
if (improvements.length > 0) {
  console.log(`\n${improvements.length} improvement(s):`);
  for (const item of improvements) {
    console.log(`  ${item.key}: ${item.previous} -> ${item.value.toFixed(0)} ${item.unit} (${item.percent.toFixed(1)}% better)`);
  }
  console.log("Re-record the baseline so the slack does not hide the next regression.");
}
if (regressions.length > 0) {
  console.error(`\n${regressions.length} REGRESSION(S):`);
  for (const item of regressions) {
    console.error(
      `  ${item.key}: ${item.previous} -> ${item.value.toFixed(0)} ${item.unit} ` +
        `(${item.percent.toFixed(1)}%, tolerance ${(item.tolerance * 100).toFixed(0)}%)`,
    );
  }
  process.exit(1);
}
console.log("\nNo regressions.");
