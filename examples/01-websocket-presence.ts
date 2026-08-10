// Presence in a collaborative editor: join / leave / cursor / chat at 20 Hz.
//
// Best case for shorn: tiny, fixed-shape, very frequent messages.
// The catch: shorn has no unions, so we write the "which message is this" byte ourselves.
import assert from "node:assert/strict";
import { z } from "zod";
import { compile } from "../dist/index.js";
import { jsonSize, note, pain, row, title, win } from "./_kit.ts";

const schemas = {
  join: z.object({ id: z.int().nonnegative(), name: z.string(), color: z.int().nonnegative() }),
  leave: z.object({ id: z.int().nonnegative() }),
  cursor: z.object({
    id: z.int().nonnegative(),
    x: z.int().nonnegative(),
    y: z.int().nonnegative(),
    selecting: z.boolean(),
  }),
  chat: z.object({ id: z.int().nonnegative(), text: z.string() }),
};

type Kind = keyof typeof schemas;
const KINDS = Object.keys(schemas) as Kind[];

const codecs = {
  join: compile(schemas.join),
  leave: compile(schemas.leave),
  cursor: compile(schemas.cursor),
  chat: compile(schemas.chat),
};

/** Frame = 1 tag byte + the shorn payload. That tag is the whole union workaround. */
function frame<K extends Kind>(kind: K, body: z.infer<(typeof schemas)[K]>): Uint8Array {
  return Uint8Array.of(KINDS.indexOf(kind), ...codecs[kind].encode(body as never));
}

function unframe(bytes: Uint8Array): { kind: Kind; body: unknown } {
  const kind = KINDS[bytes[0]!];
  if (kind === undefined) throw new Error(`Unknown message kind ${bytes[0]}`);
  return { kind, body: codecs[kind].decode(bytes.subarray(1)) };
}

title("01 · WebSocket presence");

const messages = [
  ["join", { id: 42, name: "Grace", color: 0x33ccff }],
  ["leave", { id: 42 }],
  ["cursor", { id: 42, x: 1180, y: 640, selecting: true }],
  ["chat", { id: 42, text: "ship it" }],
] as const;

for (const [kind, body] of messages) {
  const bytes = frame(kind, body as never);
  row(kind, bytes.length, jsonSize({ kind, ...body }));
  assert.deepEqual(unframe(bytes), { kind, body });
}

// The number that decides whether this is worth doing: fan-out bandwidth.
const cursor = frame("cursor", { id: 42, x: 1180, y: 640, selecting: true });
const cursorJson = jsonSize({ kind: "cursor", id: 42, x: 1180, y: 640, selecting: true });
const framesPerSecond = 200 * 199 * 20; // 200 peers, each sending to the rest, 20 Hz
row("200 peers @ 20 Hz", (cursor.length * framesPerSecond) / 1e6, (cursorJson * framesPerSecond) / 1e6, "MB/s");

// A hostile client sends garbage: that has to be a caught error, not a crash.
assert.throws(() => unframe(new Uint8Array([9, 0, 0])), /Unknown message kind/);
assert.throws(() => unframe(new Uint8Array([2, 255, 255, 255])));

win(`a cursor frame is ${cursor.length} B (1 tag + ${cursor.length - 1} shorn) against ${cursorJson} B of JSON`);
pain("no unions: the tag byte and the dispatch table are hand-written");
note("decode reads a subarray, so the tag costs one byte and no copy");
