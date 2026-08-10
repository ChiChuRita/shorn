// A metrics agent shipping batches of points to a collector.
//
// Big repetitive arrays are where JSON's repeated field names hurt most — and also
// where gzip helps most, so this compares against gzipped JSON too, not just raw.
import assert from "node:assert/strict";
import { z } from "zod";
import { compile } from "../dist/index.js";
import { gzipSize, jsonSize, note, pain, row, title, win } from "./_kit.ts";

const METRICS = ["cpu.user", "cpu.sys", "mem.rss", "http.p99", "disk.io"] as const;

const Batch = z.object({
  host: z.string(),
  sentAt: z.int().nonnegative(),
  points: z.array(
    z.object({
      metric: z.enum(METRICS),
      at: z.int().nonnegative(),
      value: z.number(),
      instance: z.int().nonnegative(),
    }),
  ),
});

const batch = {
  host: "ip-10-2-41-88.eu-central-1.compute.internal",
  sentAt: 1_767_225_600,
  points: Array.from({ length: 1000 }, (_, i) => ({
    metric: METRICS[i % 5]!,
    at: 1_767_225_600 + (i >> 2),
    value: Math.round(Math.sin(i) * 10_000) / 100,
    instance: i % 16,
  })),
};

title("04 · Telemetry batches");

const codec = compile(Batch);
const bytes = codec.encode(batch);
assert.deepEqual(codec.decode(bytes), batch);

const json = JSON.stringify(batch);
row("1000 points, raw", bytes.length / 1024, jsonSize(batch) / 1024, "KiB");
row("1000 points, gzipped", gzipSize(bytes) / 1024, gzipSize(json) / 1024, "KiB");

// Per-point cost is what sets an agent's sampling rate.
note(`${(bytes.length / 1000).toFixed(1)} B/point vs ${(jsonSize(batch) / 1000).toFixed(1)} B/point of JSON`);

win(`raw, shorn is ${(jsonSize(batch) / bytes.length).toFixed(2)}× smaller — field names and quotes are most of the JSON`);
pain(`gzipped, the gap narrows to ~${(gzipSize(json) / gzipSize(bytes)).toFixed(1)}×: repeated keys are what DEFLATE eats`);
note("float64 is the floor — 8 B per value even for 12.34; fixed-point ints would halve the batch");
