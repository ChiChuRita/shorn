/**
 * The shorn schemas every benchmark measures.
 *
 * One definition, because a number is only comparable across benches if the shape
 * behind it is literally the same. `run.mjs`, `memory.mjs` and `regression.mjs` each
 * held a byte-identical copy of these four.
 *
 * Values stay with each bench: they vary deliberately by size and entropy.
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
 * A document, as opposed to a record — the shape class every fixture above misses.
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
