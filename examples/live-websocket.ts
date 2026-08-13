// The demo: one Zod schema, a real WebSocket, three codecs, bytes counted at the socket.
//
// Not in the `pnpm examples` loop on purpose — it opens listening sockets and takes a
// few seconds. Run it on its own with `pnpm demo`.
//
// Why bytes are read off the socket instead of from `encode().length`: an encoder can
// report whatever it likes, and WebSocket adds a frame header plus a 4-byte mask to
// every client message. Counting `socket.bytesRead` on the server means the numbers
// below are the bytes that actually crossed the connection, framing tax included.
// The deltas start after the HTTP upgrade, so the handshake is not in them.
import assert from "node:assert/strict";
import { z } from "zod";
import { decode as decodeMsgpack, encode as encodeMsgpack } from "@msgpack/msgpack";
import { WebSocketServer } from "ws";
import { compile } from "../dist/index.js";
import { jsonSize, note, title, win } from "./_kit.ts";

const MESSAGES = 300;
const SEND_INTERVAL_MS = 4;

// A presence stream in a collaborative editor. The discriminator is in the schema, so
// shorn spends one varint on "which message is this" instead of the caller framing it.
const Message = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cursor"),
    id: z.int().nonnegative(),
    x: z.int().nonnegative(),
    y: z.int().nonnegative(),
    selecting: z.boolean(),
  }),
  z.object({ kind: z.literal("chat"), id: z.int().nonnegative(), text: z.string() }),
  z.object({
    kind: z.literal("join"),
    id: z.int().nonnegative(),
    name: z.string(),
    color: z.int().nonnegative(),
  }),
  z.object({ kind: z.literal("leave"), id: z.int().nonnegative() }),
]);

type Message = z.infer<typeof Message>;

const codec = compile(Message);

// Deterministic, so the server can regenerate message `i` and prove the value that came
// out of the wire is the value that went in. Same stream on every run and every codec,
// which is also what makes the three byte counts comparable.
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ["Grace", "Ada", "Alan", "Edsger", "Barbara", "Ken"];
const CHATS = ["ship it", "one sec", "look at line 40", "lgtm", "rebasing now"];

/** The message mix a real presence channel sees: mostly cursors, some talking. */
function messageAt(index: number): Message {
  const next = random(index + 1);
  const id = 1 + Math.floor(next() * 200);
  const roll = next();
  if (roll < 0.85) {
    return {
      kind: "cursor",
      id,
      x: Math.floor(next() * 1920),
      y: Math.floor(next() * 1080),
      selecting: next() < 0.2,
    };
  }
  if (roll < 0.93) return { kind: "chat", id, text: CHATS[Math.floor(next() * CHATS.length)]! };
  if (roll < 0.98) {
    return {
      kind: "join",
      id,
      name: NAMES[Math.floor(next() * NAMES.length)]!,
      color: Math.floor(next() * 0xffffff),
    };
  }
  return { kind: "leave", id };
}

interface Wire {
  readonly label: string;
  /** What the client puts on the socket. */
  readonly send: (message: Message) => string | Uint8Array;
  /** What the server gets back out, validated. Anything unvalidated is not comparable. */
  readonly receive: (frame: string | Uint8Array) => Message;
}

const WIRES: readonly Wire[] = [
  {
    label: "json",
    send: (message) => JSON.stringify(message),
    receive: (frame) => Message.parse(JSON.parse(frame as string)),
  },
  {
    label: "msgpack",
    send: (message) => encodeMsgpack(message),
    receive: (frame) => Message.parse(decodeMsgpack(frame as Uint8Array)),
  },
  {
    // decode validates on the way out, so this line is doing the same work as the two above.
    label: "shorn",
    send: (message) => codec.encode(message),
    receive: (frame) => codec.decode(frame as Uint8Array),
  },
];

interface Result {
  readonly label: string;
  /** What the socket carried. */
  readonly bytes: number;
  /** What the codec produced, before WebSocket wrapped it. The difference is framing. */
  readonly payload: number;
  readonly received: number;
}

/** One connection, `MESSAGES` messages, and the socket bytes they cost. */
async function stream(wire: Wire): Promise<Result> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise((ready) => server.once("listening", ready));
  const { port } = server.address() as { port: number };

  let received = 0;
  const reported = new Promise<number>((resolve, reject) => {
    server.on("connection", (socket, request) => {
      // Read now, after the upgrade: the delta is message traffic only.
      const raw = request.socket;
      const before = raw.bytesRead;

      socket.on("message", (data, isBinary) => {
        try {
          const frame = isBinary ? new Uint8Array(data as Buffer) : String(data);
          assert.deepEqual(wire.receive(frame), messageAt(received));
          received += 1;
        } catch (error) {
          reject(error);
        }
      });

      socket.on("close", () => resolve(raw.bytesRead - before));
    });
  });

  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((open) => client.addEventListener("open", open, { once: true }));

  let payload = 0;
  for (let index = 0; index < MESSAGES; index += 1) {
    const frame = wire.send(messageAt(index));
    payload += typeof frame === "string" ? Buffer.byteLength(frame) : frame.length;
    client.send(frame);
    if (process.stdout.isTTY) {
      process.stdout.write(`\r  ${wire.label.padEnd(9)} ${index + 1}/${MESSAGES} sent`);
    }
    await new Promise((tick) => setTimeout(tick, SEND_INTERVAL_MS));
  }
  client.close();

  const bytes = await reported;
  server.close();
  if (process.stdout.isTTY) process.stdout.write("\r".padEnd(40) + "\r");
  return { label: wire.label, bytes, payload, received };
}

title("live WebSocket · one schema, three codecs");
note("z.discriminatedUnion(\"kind\", [cursor, chat, join, leave]) — your validator's schema, unchanged");
note(`${MESSAGES} messages per codec over a real ws:// connection, validated on arrival`);
console.log();

const results: Result[] = [];
for (const wire of WIRES) results.push(await stream(wire));

const widest = Math.max(...results.map((result) => result.bytes));
const json = results.find((result) => result.label === "json")!;

for (const result of results) {
  const bar = "█".repeat(Math.max(1, Math.round((result.bytes / widest) * 32)));
  const verdict = result === json ? "" : `  ${(json.bytes / result.bytes).toFixed(2)}× smaller than json`;
  console.log(
    `  ${result.label.padEnd(9)} ${bar.padEnd(33)} ${result.bytes.toLocaleString().padStart(8)} B on the wire${verdict}`,
  );
}

console.log();
for (const result of results) assert.equal(result.received, MESSAGES);
win(`${MESSAGES * WIRES.length} messages decoded and validated, every one deep-equal to what was sent`);

// Framing is a fixed per-message tax, so it is the floor shorn cannot go under. Saying so
// is better than hiding it: it is also the reason to batch, and the reason nobody should
// expect the byte counts above to match the encoder's own numbers.
const shorn = results.find((result) => result.label === "shorn")!;
const framing = shorn.bytes - shorn.payload;
note(
  `of shorn's ${shorn.bytes.toLocaleString()} B, ${framing.toLocaleString()} B is WebSocket framing — ` +
    `${(framing / MESSAGES).toFixed(1)} B per message, paid by every codec here`,
);

// The single number people screenshot. Keep it next to its JSON twin so it is checkable.
const cursor: Message = { kind: "cursor", id: 42, x: 1180, y: 640, selecting: true };
note(`one cursor update: ${jsonSize(cursor)} B of JSON → ${codec.encode(cursor).length} B of shorn`);
note("socket.bytesRead deltas, so WebSocket framing and the client mask are counted against shorn too");
