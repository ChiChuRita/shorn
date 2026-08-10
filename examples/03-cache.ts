// A Redis-shaped byte cache, read across a deploy.
//
// The bug worth seeing isn't size: shorn's wire carries no type tags, so v2 happily
// decodes v1's bytes into a *different, valid* value. A fingerprint turns that into
// a cache miss instead.
import assert from "node:assert/strict";
import { z } from "zod";
import { compile, fingerprinted } from "../dist/index.js";
import { jsonSize, note, pain, row, title, win } from "./_kit.ts";

const AccountV1 = z.object({
  plan: z.enum(["free", "pro"]),
  seats: z.int().nonnegative(),
  trialEndsAt: z.int().nonnegative(),
});

// One line of product work: a new tier. No field added, no type changed.
const AccountV2 = AccountV1.extend({ plan: z.enum(["free", "pro", "enterprise"]) });
type Account = z.infer<typeof AccountV2>;

const account = { plan: "pro", seats: 12, trialEndsAt: 1_767_225_600 } as const;

title("03 · Cache across a deploy");

const bare1 = compile(AccountV1);
const bare2 = compile(AccountV2);
row("one account entry", bare1.encode(account).length, jsonSize(account));

// Enum members are stored in sorted order, so adding "enterprise" renumbers the rest.
// Old bytes still decode — into the wrong account.
const misread = bare2.decode(bare1.encode(account)) as Account;
assert.deepEqual(misread, { plan: "free", seats: 12, trialEndsAt: 1_767_225_600 });
pain(`unfingerprinted, every cached "pro" account reads back as "${misread.plan}" after the deploy`);

// Same two schemas, now with a 4-byte shape marker in front.
const wire1 = fingerprinted(bare1, { bytes: 4 });
const wire2 = fingerprinted(bare2, { bytes: 4 });
assert.notEqual(wire1.fingerprintHex, wire2.fingerprintHex);

const cache = new Map<string, Uint8Array>([["acct:8123", wire1.encode(account)]]);
let refills = 0;

function read(key: string): Account {
  const cached = cache.get(key);
  if (cached) {
    try {
      return wire2.decode(cached) as Account;
    } catch {
      cache.delete(key); // written by an older shape — a miss, not data
    }
  }
  refills++;
  const fresh: Account = { ...account, plan: "enterprise" };
  cache.set(key, wire2.encode(fresh));
  return fresh;
}

assert.equal(read("acct:8123").plan, "enterprise");
assert.equal(read("acct:8123").plan, "enterprise");
assert.equal(refills, 1);
win(`fingerprinted, the same deploy costs one refill (${wire1.fingerprintHex} → ${wire2.fingerprintHex})`);

// What the cache holds at scale.
const accounts = Array.from({ length: 10_000 }, (_, i) => ({
  plan: (["free", "pro", "enterprise"] as const)[i % 3]!,
  seats: (i % 400) + 1,
  trialEndsAt: 1_767_225_600 + i,
}));
const shornBytes = accounts.reduce((total, a) => total + wire2.encode(a).length, 0);
const jsonBytes = accounts.reduce((total, a) => total + jsonSize(a), 0);
row("10 000 entries", shornBytes / 1024, jsonBytes / 1024, "KiB");

const entry = wire2.encode(account).length;
note(`4 fingerprint bytes are ${Math.round((4 / entry) * 100)}% of a ${entry}-byte entry — the price of not serving wrong data`);
note("values are already Uint8Array, so node-redis/ioredis take them without a Buffer.from copy");
