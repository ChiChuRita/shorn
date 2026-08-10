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
