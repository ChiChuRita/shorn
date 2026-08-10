// A signed, stateless session cookie.
//
// Cookies ride on every request and share a 4 KB budget, so these are the most
// expensive bytes an app has. A JWT spends most of them on field names and base64.
import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { compile, fingerprinted } from "../dist/index.js";
import { note, row, title, win } from "./_kit.ts";

const SECRET = Buffer.from("toy-secret-not-for-production");
const TAG_BYTES = 16; // truncated HMAC-SHA256; 128 bits is the usual cookie tradeoff

const Session = z.object({
  uid: z.int().nonnegative(),
  org: z.int().nonnegative(),
  roles: z.array(z.enum(["viewer", "editor", "admin", "billing"])),
  exp: z.int().nonnegative(),
});
type Session = z.infer<typeof Session>;

const codec = fingerprinted(compile(Session), { bytes: 1 });
const b64url = (buffer: Buffer) => buffer.toString("base64url");
const tagFor = (payload: Buffer) => createHmac("sha256", SECRET).update(payload).digest().subarray(0, TAG_BYTES);

/** Cookie = base64url(tag ‖ shorn payload). */
function sign(session: Session): string {
  const payload = Buffer.from(codec.encode(session));
  return b64url(Buffer.concat([tagFor(payload), payload]));
}

function verify(cookie: string): Session | null {
  const raw = Buffer.from(cookie, "base64url");
  if (raw.length <= TAG_BYTES) return null; // timingSafeEqual throws on length mismatch
  const tag = raw.subarray(0, TAG_BYTES);
  const payload = raw.subarray(TAG_BYTES);
  if (!timingSafeEqual(tag, tagFor(payload))) return null;
  try {
    return codec.decode(new Uint8Array(payload)) as Session;
  } catch {
    return null; // signed by us, but written by a schema we no longer run
  }
}

const session: Session = { uid: 918_244, org: 41, roles: ["editor", "billing"], exp: 1_767_225_600 };

title("07 · Stateless session cookie");

const cookie = sign(session);
assert.deepEqual(verify(cookie), session);

// The JWT an app would otherwise ship: same claims, HS256, compact serialization.
const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
const body = b64url(Buffer.from(JSON.stringify(session)));
const jwt = `${header}.${body}.${b64url(createHmac("sha256", SECRET).update(`${header}.${body}`).digest())}`;

row("cookie value", cookie.length, jwt.length, "chars");
row("payload only (pre-b64)", codec.encode(session).length, Buffer.byteLength(JSON.stringify(session)), "B");
row("per 1000 requests", (cookie.length * 1000) / 1024, (jwt.length * 1000) / 1024, "KiB");

// Tampering: flipped byte, truncation, empty, and a payload from a foreign schema.
const flipped = Buffer.from(cookie, "base64url");
flipped[flipped.length - 1] ^= 0x01;
assert.equal(verify(b64url(flipped)), null);
assert.equal(verify(cookie.slice(0, 8)), null);
assert.equal(verify(""), null);

const foreign = Buffer.from(fingerprinted(compile(Session.extend({ imp: z.int().nonnegative() })), { bytes: 1 }).encode({ ...session, imp: 3 }));
assert.equal(verify(b64url(Buffer.concat([tagFor(foreign), foreign]))), null);

win(`${cookie.length} chars against ${jwt.length} for a JWT carrying the same four claims`);
win("decode() validates on the way in, so the handler gets a checked session, not a parsed one");
note(`the tag dominates now: ${codec.encode(session).length} B of claims under a ${TAG_BYTES} B HMAC`);
note("no `alg` field means no alg-confusion bug — the shape is fixed at compile time");
