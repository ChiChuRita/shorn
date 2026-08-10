/**
 * Timing primitives shared by the benchmarks.
 *
 * Median of repeated samples rather than one timed run: a single sample picks up
 * whatever GC or frequency scaling happened to land inside it, and a regression
 * gate built on that cries wolf until people stop reading it.
 */

let sink = 0;

export function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Nanoseconds per operation, as the median of `samples` runs.
 *
 * Iterations are calibrated to `targetMs` so a 20ns operation and a 20µs one are
 * both measured over a window long enough to swamp timer granularity.
 */
export function nanosPerOp(run, { targetMs = 40, samples = 7, warmup = 200 } = {}) {
  for (let index = 0; index < warmup; index++) sink ^= Number(run()) || 0;

  let iterations = 64;
  for (;;) {
    const start = performance.now();
    for (let index = 0; index < iterations; index++) sink ^= Number(run()) || 0;
    const elapsed = performance.now() - start;
    if (elapsed >= targetMs || iterations >= 1 << 26) break;
    iterations = Math.max(iterations * 2, Math.ceil((iterations * targetMs) / Math.max(elapsed, 0.01)));
  }

  const measurements = [];
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    for (let index = 0; index < iterations; index++) sink ^= Number(run()) || 0;
    measurements.push(((performance.now() - start) * 1e6) / iterations);
  }
  return median(measurements);
}

export const opsPerSecond = (run, options) => 1e9 / nanosPerOp(run, options);

/** Kept live so a dead-code eliminator cannot delete the work being timed. */
export const readSink = () => sink;
