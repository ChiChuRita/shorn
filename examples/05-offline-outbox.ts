// An offline-first app queueing writes in localStorage.
//
// Two things bite here: the 5 MB quota is a *string* quota, so bytes have to survive
// base64, and an outbox entry holds a Date. z.date() encodes natively; a transform
// that revives a string into a Date does not.
import assert from "node:assert/strict";
import { z } from "zod";
import { compile, fingerprinted } from "../dist/index.js";
import { jsonSize, note, pain, row, threw, title, win } from "./_kit.ts";

title("05 · Offline outbox in localStorage");

// The tempting way to get a Date back: store text, revive on the way out. Refused. A
// transform has no reverse direction, so shorn could not encode the Date it produces.
const transformError = threw(() => compile(z.object({ at: z.iso.datetime().transform((s) => new Date(s)) })));
assert.match(transformError, /transform cannot be represented/);
pain(`.transform(s => new Date(s)) → ${transformError}`);

// What works: declare the Date. It travels as epoch milliseconds, 6 bytes, and comes
// back as a Date with no adapter on either side.
const Entry = z.object({
  op: z.enum(["create", "update", "delete"]),
  table: z.enum(["notes", "tags", "shares"]),
  rowId: z.int().nonnegative(),
  at: z.date(),
  body: z.string(),
});
type Entry = z.infer<typeof Entry>;
const Outbox = fingerprinted(compile(z.object({ entries: z.array(Entry) })), { bytes: 2 });

const entries: Entry[] = Array.from({ length: 500 }, (_, i) => ({
  op: i % 7 === 0 ? "delete" : "update",
  table: "notes",
  rowId: 100_000 + i,
  at: new Date(1_767_225_600_000 + i * 137),
  body: `edit ${i}: the quick brown fox jumped over the lazy dog`,
}));

const bytes = Outbox.encode({ entries });
const stored = Buffer.from(bytes).toString("base64"); // what localStorage actually holds
const storedJson = JSON.stringify({ entries });

// Round-trip through storage, not just through memory.
const reread = Outbox.decode(new Uint8Array(Buffer.from(stored, "base64")));
assert.equal(reread.entries.length, 500);
assert.ok(reread.entries[0]!.at instanceof Date);
assert.equal(reread.entries[0]!.at.getTime(), entries[0]!.at.getTime());

row("500 entries, raw", bytes.length / 1024, jsonSize({ entries }) / 1024, "KiB");
row("as stored (base64)", stored.length / 1024, storedJson.length / 1024, "KiB");

const entriesPer5MB = (size: number) => Math.floor((5 * 1024 * 1024) / (size / 500));
note(`a 5 MB quota holds ${entriesPer5MB(stored.length)} entries as base64 shorn, ${entriesPer5MB(storedJson.length)} as JSON`);

win(`base64 costs a third of the win: ${(storedJson.length / stored.length).toFixed(2)}× stored vs ${(jsonSize({ entries }) / bytes.length).toFixed(2)}× raw`);
win("z.date() is 6 bytes on the wire and a Date on both sides; JSON spends 26 characters and hands back a string");
note("2 fingerprint bytes cover the whole outbox, not each entry, so framing rounds to zero here");
