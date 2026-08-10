// A job queue whose producer and consumer deploy independently.
//
// Yesterday's API wrote jobs that today's worker has to drain. Adding one optional
// field changes the wire shape, so the fix is a fingerprint → decoder registry.
import assert from "node:assert/strict";
import { z } from "zod";
import { compile, fingerprinted } from "../dist/index.js";
import { jsonSize, note, pain, row, title, win } from "./_kit.ts";

const PREFIX = 4; // fingerprint bytes in front of every job

const ThumbnailV1 = z.object({
  assetId: z.int().nonnegative(),
  width: z.int().nonnegative(),
  format: z.enum(["jpeg", "webp"]),
});

// v2 adds an optional field: a non-event in JSON, a different shape on a tagless wire.
const ThumbnailV2 = ThumbnailV1.extend({ stripExif: z.boolean().optional() });
type Job = z.infer<typeof ThumbnailV2>;

const v1 = fingerprinted(compile(ThumbnailV1), { bytes: PREFIX });
const v2 = fingerprinted(compile(ThumbnailV2), { bytes: PREFIX });

title("06 · Job queue across an independent deploy");

const job = { assetId: 91_004, width: 480, format: "webp" } as const;
const queued = v1.encode(job); // written by the old API, still in flight
row("one job", queued.length, jsonSize(job));

// A worker that only knows the new shape drops everything already in the queue.
assert.throws(() => v2.decode(queued));
pain("adding one optional field changes the fingerprint — every in-flight v1 job dead-letters");

// The fix: keep the old codec, dispatch on the prefix, upgrade to today's type.
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const decoders = new Map<string, (wire: Uint8Array) => Job>([
  [v1.fingerprintHex, (wire) => ({ ...(v1.decode(wire) as z.infer<typeof ThumbnailV1>), stripExif: false })],
  [v2.fingerprintHex, (wire) => v2.decode(wire) as Job],
]);
assert.equal(decoders.size, 2, "duplicate fingerprints would silently overwrite each other");

function consume(wire: Uint8Array): Job {
  const id = hex(wire.subarray(0, PREFIX));
  const decode = decoders.get(id);
  if (!decode) throw new Error(`No codec for wire ${id}`);
  return decode(wire);
}

assert.deepEqual(consume(queued), { ...job, stripExif: false });
assert.deepEqual(consume(v2.encode({ ...job, stripExif: true })), { ...job, stripExif: true });
win(`the registry drains both shapes (${v1.fingerprintHex} → v1, ${v2.fingerprintHex} → v2)`);

// An unregistered shape is rejected by name rather than misread.
const v3 = fingerprinted(compile(ThumbnailV1.extend({ quality: z.int().nonnegative() })), { bytes: PREFIX });
assert.throws(() => consume(v3.encode({ ...job, quality: 80 })), /No codec for wire/);

// Corruption inside the payload is a different problem: a flipped byte in a varint is
// still a valid varint, so the job decodes — as a different job.
const corrupt = Uint8Array.from(queued);
corrupt[corrupt.length - 1] = 0x7f;
const misread = consume(corrupt);
assert.notDeepEqual(misread, consume(queued));
pain(`a single flipped byte turns width ${job.width} into ${misread.width} and nothing throws`);

note("a fingerprint is a shape check, not a version: v2 must keep v1's codec to drain the queue");
note("put the 4 bytes in a queue header instead and the payload stays bare — .fingerprint exposes them");
pain("no automatic evolution: each wire change is a registry entry plus an upgrade function, by hand");
