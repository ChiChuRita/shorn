// An offline-first app queueing writes in localStorage.
//
// Two things bite here: the 5 MB quota is *string*, so bytes have to survive base64,
// and an outbox entry naturally holds a Date — which shorn refuses, twice.
import assert from "node:assert/strict";
import { z } from "zod";
import { compile, fingerprinted } from "../dist/index.js";
import { jsonSize, note, pain, row, threw, title, win } from "./_kit.ts";

title("05 · Offline outbox in localStorage");

// The schema you would actually write. Refused: rich types belong at the edge.
const dateError = threw(() => compile(z.object({ at: z.date() })));
assert.match(dateError, /convert rich types at the edge/);
pain(`z.date() → ${dateError.slice(0, 96)}…`);

// Reviving on the way out is refused one layer earlier: a transform has no JSON
// Schema at all, so shorn never sees a structure to compile.
const transformError = threw(() => compile(z.object({ at: z.iso.datetime().transform((s) => new Date(s)) })));
assert.match(transformError, /Transforms cannot be represented/);
pain(`.transform(s => new Date(s)) → ${transformError.slice(0, 96)}…`);

// What works: epoch milliseconds on the wire, Date at the edges. Two small functions.
const Entry = z.object({
  op: z.enum(["create", "update", "delete"]),
  table: z.enum(["notes", "tags", "shares"]),
  rowId: z.int().nonnegative(),
  at: z.int().nonnegative(),
  body: z.string(),
});
const Outbox = fingerprinted(compile(z.object({ entries: z.array(Entry) })), { bytes: 2 });

type Draft = Omit<z.infer<typeof Entry>, "at"> & { at: Date };
const toWire = (draft: Draft) => ({ ...draft, at: draft.at.getTime() });
const fromWire = (entry: z.infer<typeof Entry>) => ({ ...entry, at: new Date(entry.at) });

const drafts: Draft[] = Array.from({ length: 500 }, (_, i) => ({
  op: i % 7 === 0 ? "delete" : "update",
  table: "notes",
  rowId: 100_000 + i,
  at: new Date(1_767_225_600_000 + i * 137),
  body: `edit ${i} — the quick brown fox jumped over the lazy dog`,
}));

const entries = drafts.map(toWire);
const bytes = Outbox.encode({ entries });
const stored = Buffer.from(bytes).toString("base64"); // what localStorage actually holds
const storedJson = JSON.stringify({ entries: drafts });

// Round-trip through storage, not just through memory.
const reread = Outbox.decode(new Uint8Array(Buffer.from(stored, "base64"))) as { entries: z.infer<typeof Entry>[] };
const back = reread.entries.map(fromWire);
assert.equal(back.length, 500);
assert.equal(back[0]!.at.getTime(), drafts[0]!.at.getTime());

row("500 entries, raw", bytes.length / 1024, jsonSize({ entries: drafts }) / 1024, "KiB");
row("as stored (base64)", stored.length / 1024, storedJson.length / 1024, "KiB");

const entriesPer5MB = (size: number) => Math.floor((5 * 1024 * 1024) / (size / 500));
note(`a 5 MB quota holds ${entriesPer5MB(stored.length)} entries as base64 shorn, ${entriesPer5MB(storedJson.length)} as JSON`);

win(`base64 costs a third of the win: ${(storedJson.length / stored.length).toFixed(2)}× stored vs ${(jsonSize({ entries: drafts }) / bytes.length).toFixed(2)}× raw`);
pain("Date needs two hand-written adapters; neither z.date() nor .transform() compiles");
note("2 fingerprint bytes cover the whole outbox, not each entry — framing rounds to zero here");
