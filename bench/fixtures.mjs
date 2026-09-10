/**
 * The shorn schemas every benchmark measures.
 *
 * One definition, because a number is only comparable across benches if the shape
 * behind it is literally the same. `run.mjs`, `memory.mjs` and `regression.mjs` each
 * held a byte-identical copy of these four.
 *
 * Generated and large-batch values still belong to each bench: those vary deliberately
 * by size and entropy, and nothing outside the bench quotes them. The two small values
 * below are the exception, for the reason given above them.
 */
import { m } from "../dist/index.js";

export const person = m.object({
  age: m.uint(),
  name: m.string(),
  sex: m.enum(["F", "M", "X"]),
});
export const metrics = m.object({ cpu: m.float64(), memory: m.uint() });
export const event = m.object({
  active: m.boolean(),
  actor: person,
  id: m.uint(),
  metrics,
  tags: m.array(m.string()),
  timestamp: m.uint(),
});
export const batch = m.array(event);

/**
 * The two small values every published number is measured on.
 *
 * These live here, against the rule above, because two benches have to agree on them:
 * `run.mjs` prints them and the docs quote the result, while `regression.mjs` gates it
 * with `tolerance: 0`. They drifted. `regression.mjs` held `tags: ["api", "edge"]`
 * against the three tags here, so the zero-tolerance size gate guarded 38 bytes for one
 * event and 3,801 for a batch of 100, neither of which appears on any page, while the
 * published 43 and 4,135 were guarded by nothing.
 */
export const personValue = Object.freeze({ name: "Rahul", age: 25, sex: "M" });
export const eventValue = Object.freeze({
  active: true,
  actor: personValue,
  id: 731_942,
  timestamp: 1_725_435_678,
  metrics: Object.freeze({ cpu: 0.625, memory: 786_432 }),
  tags: Object.freeze(["api", "edge", "paid"]),
});

function token(index, salt) {
  let value = Math.imul(index + salt, 0x9e3779b1) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  return value.toString(36).padStart(7, "0");
}

/**
 * A monotonic counter with a realistic gap between readings.
 *
 * `id`, `timestamp` and `memory` used to step by exactly 1, 1 and 1,024, and that
 * is not a neutral choice: a perfectly constant stride is close to the best case a
 * fixed-width big-endian integer can be handed, because the high bytes then stay
 * identical across thousands of consecutive records and LZ77 matches those runs
 * for free. shorn's LEB128 varints are 40% smaller raw and get no such gift, so
 * the fixture was quietly deciding a compressed-size comparison that the formats
 * should have decided. Measured: under Brotli the constant-stride fixture puts
 * msgpackr's shared records ahead, and a jittered one puts shorn ahead, with no
 * change to any codec, so the jitter is the honest fixture, not a thumb on the
 * scale. Measured 2026-08-09.
 *
 * `Math.abs` because `token`'s final XOR yields a signed int, so its base36 form
 * can lead with "-"; without it the gaps go negative and the counter becomes a
 * random walk rather than a counter.
 */
const gap = (index, salt, spread) =>
  Math.abs(Number.parseInt(token(index, salt).slice(0, 5), 36)) % spread;

/**
 * The batch value both `run.mjs` and `regression.mjs` measure.
 *
 * It lives here because the two disagreed. `regression.mjs` built its own batch by
 * spreading one event 100 times, which came to 4,301 bytes, while `run.mjs` generated
 * this one at 4,135 and the docs published that. A zero-tolerance size gate pointed at
 * the wrong number guards nothing.
 *
 * The cursors are function-local so repeated calls are deterministic. At module scope a
 * second call continued where the first left off.
 */
export function makeBatchValue(count, { highEntropy = false } = {}) {
  let idCursor = eventValue.id;
  let clock = eventValue.timestamp;
  let bytesUsed = 500_000;

  return Array.from({ length: count }, (_, index) => ({
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
}

/**
 * A document, as opposed to a record: the shape class every fixture above misses.
 *
 * The four above are small, flat, all-required and short-stringed, which is exactly
 * what the generated record codecs are best at. Running shorn through msgpackr's own
 * benchmark (a 7.6 KB clinical-trial document) found decode 2.1x behind their shared
 * records on data of this shape while our suite showed decode leading everything, and
 * the suite could not see it because no fixture here had:
 *
 *   - **optional fields**, which make the field set dynamic. When this fixture was added
 *     that kept an object off the generated decoder entirely; decoding is generated for
 *     them now, since each optional's bitmap bit is fixed by the schema and compiles to
 *     a constant mask test. Encoding is still interpreted here;
 *   - **heterogeneous array elements**, where the same array holds objects with four
 *     different key sets, which is normal in real documents and absent above;
 *   - **string-dominated content**: three quarters of that payload was string bytes,
 *     one `TextDecoder` call each, a cost shorn cannot shrink and does not win;
 *   - **always-null fields**, which cost a marker byte and no value.
 *
 * Modeled rather than copied, so the fixture is ours to license and to keep stable,
 * with the same four properties. `nullable(string)` and not `literal(null)` for the
 * always-empty fields: a real schema author writes the nullable, and the literal would
 * cost zero bytes and hand us a size win the data does not support.
 */
const nullableString = m.string().nullable();
export const documentMetadata = m.object({
  abstract: m.string(),
  authors: m.array(m.string()),
  canonicalUrl: nullableString,
  created: m.string(),
  digitized: m.boolean(),
  doi: nullableString,
  edition: nullableString,
  identifier: m.string(),
  issn: nullableString,
  issue: nullableString,
  keywords: m.array(m.string()),
  language: m.string(),
  license: nullableString,
  pages: nullableString,
  publisher: m.string(),
  retracted: m.boolean(),
  revision: m.uint(),
  series: nullableString,
  summary: m.string(),
  title: m.string(),
  volume: nullableString,
  year: m.uint(),
});

/** Four key sets over one array: only `id` and `terms` are always present. */
export const documentSection = m.object({
  anchor: m.string().optional(),
  body: m.string().optional(),
  depth: m.uint().optional(),
  id: m.string(),
  ordinal: m.uint().optional(),
  score: m.float64().optional(),
  terms: m.array(m.array(m.string())),
  title: m.string().optional(),
});

export const documentMeasure = m.object({
  count: m.uint(),
  label: m.string(),
  mean: m.float64(),
  stddev: m.float64(),
  unit: m.string(),
});

export const document = m.object({
  metadata: documentMetadata,
  id: m.uint(),
  measures: m.array(documentMeasure),
  name: m.string(),
  references: m.array(m.string()),
  score: m.float64(),
  sections: m.array(documentSection),
  tags: m.array(m.string()),
});
