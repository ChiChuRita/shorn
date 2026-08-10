// Binary RPC over a socket: request id, method, and either a result or an error.
//
// Shows that the envelope needs no second serializer — `m.tuple` takes a compiled
// codec as an element, so id and payload share one byte stream.
import assert from "node:assert/strict";
import { z } from "zod";
import { compile, m } from "../dist/index.js";
import { jsonSize, note, pain, row, title, win } from "./_kit.ts";

const methods = {
  "user.get": {
    params: z.object({ id: z.int().nonnegative() }),
    result: z.object({ id: z.int().nonnegative(), email: z.string(), verified: z.boolean() }),
    handle: ({ id }: { id: number }) => {
      if (id !== 7) throw new Error("not_found");
      return { id, email: "grace@example.com", verified: true };
    },
  },
  "order.list": {
    params: z.object({ userId: z.int().nonnegative(), limit: z.int().nonnegative() }),
    result: z.object({
      orders: z.array(z.tuple([z.int().nonnegative(), z.number(), z.enum(["paid", "shipped", "refunded"])])),
    }),
    handle: ({ userId, limit }: { userId: number; limit: number }) => ({
      orders: Array.from({ length: limit }, (_, i) => [userId * 1000 + i, 19.99, "paid"] as const),
    }),
  },
} as const;

type Method = keyof typeof methods;
const NAMES = Object.keys(methods) as Method[];
const FAIL = 0xff; // method index reserved for the error frame

// One codec pair per method: [callId, params] in, [callId, result] out.
const codecs = NAMES.map((name) => ({
  request: m.tuple([m.uint(), compile(methods[name].params)]),
  ok: m.tuple([m.uint(), compile(methods[name].result)]),
}));
const failure = m.tuple([m.uint(), m.enum(["not_found", "denied", "internal"]), m.string()]);

/** Frame = 1 byte of method index (or FAIL) + one shorn payload. */
const frame = (index: number, payload: Uint8Array): Uint8Array => Uint8Array.of(index, ...payload);

/** The whole server. One byte tells it which codec to use; shorn does the rest. */
function serve(wire: Uint8Array): Uint8Array {
  const index = wire[0]!;
  const name = NAMES[index];
  if (name === undefined) return frame(FAIL, failure.encode([0, "internal", "unknown method"]));

  const [callId, params] = codecs[index]!.request.decode(wire.subarray(1));
  try {
    const result = (methods[name].handle as (p: unknown) => unknown)(params);
    return frame(index, codecs[index]!.ok.encode([callId, result as never]));
  } catch (error) {
    const code = (error as Error).message as "not_found";
    return frame(FAIL, failure.encode([callId, code, name]));
  }
}

function call<K extends Method>(callId: number, name: K, params: z.infer<(typeof methods)[K]["params"]>) {
  const index = NAMES.indexOf(name);
  const request = frame(index, codecs[index]!.request.encode([callId, params as never]));
  const reply = serve(request);
  if (reply[0] === FAIL) {
    const [id, code, detail] = failure.decode(reply.subarray(1));
    return { request, reply, id, error: { code, detail } };
  }
  const [id, result] = codecs[reply[0]!]!.ok.decode(reply.subarray(1));
  return { request, reply, id, result };
}

title("02 · RPC over a socket");

const hit = call(1, "user.get", { id: 7 });
assert.equal(hit.id, 1);
assert.deepEqual(hit.result, { id: 7, email: "grace@example.com", verified: true });
row("user.get request", hit.request.length, jsonSize({ jsonrpc: "2.0", id: 1, method: "user.get", params: { id: 7 } }));
row("user.get response", hit.reply.length, jsonSize({ jsonrpc: "2.0", id: 1, result: hit.result }));

const miss = call(2, "user.get", { id: 8 });
assert.deepEqual(miss.error, { code: "not_found", detail: "user.get" });
row("error response", miss.reply.length, jsonSize({ jsonrpc: "2.0", id: 2, error: { code: -32004, message: "not_found" } }));

const list = call(3, "order.list", { userId: 5, limit: 50 });
assert.equal((list.result as { orders: unknown[] }).orders.length, 50);
const listJson = jsonSize({ jsonrpc: "2.0", id: 3, result: list.result });
row("order.list (50 rows)", list.reply.length, listJson);

// A truncated frame must not decode as a short-but-valid message.
assert.throws(() => serve(hit.request.subarray(0, 2)));

win(`m.tuple([m.uint(), compile(Schema)]) carries id + payload in one stream, no glue serializer`);
win(`small calls pay best: a request is ${hit.request.length} B against 62 B of JSON-RPC`);
pain("errors need their own codec, because shorn has no union to hold result-or-error");
pain(`only ${(listJson / list.reply.length).toFixed(2)}× on 50 rows — every 19.99 costs 8 float64 bytes, 5 JSON chars`);
note("tuple element types infer end to end: `list.result.orders[0][2]` is the enum, not string");
