import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { scope, type } from "arktype";
import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { z } from "zod";
import {
  DecodeError,
  EncodeError,
  compile,
  decode,
  decodeAsync,
  encode,
  encodeAsync,
  fingerprinted,
  m,
  safeDecode,
  safeEncode,
  unchecked,
} from "../src/index.js";
import type { EncodableStandardSchema, Schema } from "../src/index.js";

describe("Standard Schema adapter", () => {
  const value = { name: "Rahul", age: 25, sex: "M" as const };

  const zodSchema = z.object({
    name: z.string(),
    age: z.int().nonnegative(),
    sex: z.enum(["M", "F", "X"]),
  });

  const arkSchema = type({
    name: "string",
    age: "number.integer >= 0",
    sex: "'M' | 'F' | 'X'",
  });

  const valibotSchema = toStandardJsonSchema(
    v.object({
      name: v.string(),
      age: v.pipe(v.number(), v.integer(), v.minValue(0)),
      sex: v.picklist(["M", "F", "X"]),
    }),
  );

  const nativeValibotSchema = v.object({
    name: v.string(),
    age: v.pipe(v.number(), v.integer(), v.minValue(0)),
    sex: v.picklist(["M", "F", "X"]),
  });

  it("accepts Zod, ArkType, and Valibot without vendor adapters", () => {
    for (const schema of [compile(zodSchema), compile(arkSchema), compile(valibotSchema)]) {
      expect(schema.decode(schema.encode(value))).toEqual(value);
    }
  });

  it("produces the same canonical bytes across schema vendors", () => {
    const encodings = [compile(zodSchema), compile(arkSchema), compile(valibotSchema)].map((schema) =>
      [...schema.encode(value)].join(","),
    );
    expect(new Set(encodings).size).toBe(1);
  });

  it("uses a functional API without replacing native validation APIs", () => {
    const zodBytes = encode(zodSchema, zodSchema.parse(value));
    expect(decode(zodSchema, zodBytes)).toEqual(value);

    const valibotValue = v.parse(nativeValibotSchema, value);
    const structure = toStandardJsonSchema(nativeValibotSchema);
    const valibotBytes = encode(nativeValibotSchema, valibotValue, structure);
    expect(decode(nativeValibotSchema, valibotBytes, structure)).toEqual(value);
    expect([...valibotBytes]).toEqual([...zodBytes]);
  });

  it("caches compiled wire plans by schema identity", () => {
    expect(compile(zodSchema)).toBe(compile(zodSchema));
  });

  describe("shapes read from the JSON Schema rather than from its type alone", () => {
    const uuid = "0192e4c6-3c0e-7000-8000-0000000000ff";

    it("stores a uuid format as its 16 bytes, not its 36 characters", () => {
      const Id = compile(z.uuid());
      expect(Id.encode(uuid)).toHaveLength(16);
      expect(Id.decode(Id.encode(uuid))).toBe(uuid);
      // The all-zero and all-f UUIDs are the two the pattern special-cases, and the
      // two most likely to expose a padding bug in either direction.
      for (const edge of ["00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"]) {
        expect(Id.decode(Id.encode(edge))).toBe(edge);
      }
    });

    it("refuses an uppercase uuid rather than returning a different string", () => {
      // Valid to the validator, which accepts either case, and still refused,
      // because 16 bytes cannot remember which case they were written in.
      expect(z.uuid().safeParse(uuid.toUpperCase()).success).toBe(true);
      expect(() => compile(z.uuid()).encode(uuid.toUpperCase())).toThrow(/Expected a lowercase UUID/);
    });

    it("decodes a digit and a letter at every hex position, in lowercase", () => {
      // Unchecked because neither value is an RFC 4122 UUID, and it is the wire decoder
      // under test here, not the validator behind it.
      const Id = unchecked(compile(z.uuid()));
      // Each of the 32 hex positions is a digit in one of these and a letter in the
      // other, so a lookup wrong for either nibble class shows up somewhere.
      const digitFirst = "9a9a9a9a-9a9a-9a9a-9a9a-9a9a9a9a9a9a";
      const letterFirst = "a9a9a9a9-a9a9-a9a9-a9a9-a9a9a9a9a9a9";
      expect(Id.decode(new Uint8Array(16).fill(0x9a))).toBe(digitFirst);
      expect(Id.decode(new Uint8Array(16).fill(0xa9))).toBe(letterFirst);
      for (const edge of [digitFirst, letterFirst]) expect(Id.decode(Id.encode(edge))).toBe(edge);
    });

    it("agrees with a plain hex formatter on every byte value and on random uuids", () => {
      // Unchecked for the same reason: most 16-byte runs are not valid UUIDs to zod.
      const Id = unchecked(compile(z.uuid()));
      const reference = (bytes: Uint8Array): string => {
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      };
      // Sixteen runs of sixteen consecutive values put all 256 bytes through the decoder.
      for (let first = 0; first < 256; first += 16) {
        const bytes = Uint8Array.from({ length: 16 }, (_, index) => first + index);
        expect(Id.decode(bytes)).toBe(reference(bytes));
      }
      for (let count = 0; count < 300; count++) {
        const random = randomUUID();
        const bytes = Id.encode(random);
        expect(Id.decode(bytes)).toBe(reference(bytes));
        expect(Id.decode(bytes)).toBe(random);
      }
    });

    it("refuses a truncated uuid with an offset inside the input", () => {
      const Id = compile(z.uuid());
      const bytes = Id.encode(uuid);
      for (const length of [0, 1, 4, 15]) {
        let thrown: unknown;
        try {
          Id.decode(bytes.subarray(0, length));
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(DecodeError);
        expect((thrown as DecodeError).offset).toBeGreaterThanOrEqual(0);
        expect((thrown as DecodeError).offset).toBeLessThanOrEqual(length);
      }
    });

    it("reads an exclusive lower bound as unsigned, like an inclusive one", () => {
      // `.positive()` emits `exclusiveMinimum: 0` where `.nonnegative()` emits
      // `minimum: 0`. Reading only the second sends the commonest non-negative integer
      // schema down the zigzag path, which crosses every varint boundary at half the
      // value: 100 costs one byte unsigned and two signed.
      for (const Count of [compile(z.int().positive()), compile(z.int().nonnegative())]) {
        expect(Count.encode(100)).toHaveLength(1);
        expect(Count.decode(Count.encode(100))).toBe(100);
      }

      // A bound that still admits negatives stays signed, which is what pays for them.
      expect(compile(z.int().gt(-5)).encode(100)).toHaveLength(2);
    });

    it("indexes a numeric enum instead of writing a float", () => {
      const Status = compile(z.enum({ Ok: 200, Missing: 404 }));
      expect(Status.encode(404)).toHaveLength(1);
      expect(Status.decode(Status.encode(404))).toBe(404);
      expect(Status.decode(Status.encode(200))).toBe(200);
    });

    it("drops the length varint when minItems fixes the count", () => {
      const Triple = compile(z.array(z.uint32()).length(3));
      expect(Triple.encode([1, 2, 3])).toHaveLength(3);
      expect(Triple.decode(Triple.encode([1, 2, 3]))).toEqual([1, 2, 3]);
      expect(compile(z.array(z.uint32())).encode([1, 2, 3])).toHaveLength(4);
    });

    it("encodes a record, whose keys are data rather than schema", () => {
      const Tags = compile(z.record(z.string(), z.int()));
      const tags = { alpha: 1, beta: 2 };
      expect(Tags.decode(Tags.encode(tags))).toEqual(tags);
      expect(Tags.encode({})).toHaveLength(1);
    });

    it("writes a record's keys in canonical order whatever order they were built in", () => {
      const Tags = compile(z.record(z.string(), z.int()));
      expect([...Tags.encode({ a: 1, b: 2 })]).toEqual([...Tags.encode({ b: 2, a: 1 })]);
    });

    it("refuses record keys that arrive out of canonical order", () => {
      // Sorting them on the way in instead would let two payloads decode to one
      // record, and a duplicate key would quietly win over the key it repeats.
      const Tags = compile(z.record(z.string(), z.int()));
      const bytes = Tags.encode({ a: 1, b: 2 });
      const swapped = Uint8Array.from(bytes);
      [swapped[2], swapped[5]] = [swapped[5]!, swapped[2]!];
      expect(() => Tags.decode(swapped)).toThrow(/out of canonical order/);
    });

    it("keeps a __proto__ key as a key", () => {
      const Tags = compile(z.record(z.string(), z.int()));
      const decoded = Tags.decode(Tags.encode({ ["__proto__"]: 1 }));
      expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("bounds a record's declared size against the input it would have to fill", () => {
      expect(() => compile(z.record(z.string(), z.string())).decode(new Uint8Array([200, 1, 2])))
        .toThrow(/exceeds the remaining input/);
    });

    it("carries a dynamic value's own type, since the schema declined to", () => {
      const Any = compile(z.any());
      for (const value of [null, true, false, 0, -1, 1.5, -0, NaN, "hi", [1, ["a"]], { b: 2 }]) {
        expect(Any.decode(Any.encode(value))).toEqual(value);
      }
      // A tag byte and nothing else for the values that are their own tag.
      expect(Any.encode(null)).toHaveLength(1);
      expect(Any.encode(true)).toHaveLength(1);
    });

    it("gives a dynamic value one encoding, not two", () => {
      const Any = compile(z.any());
      expect([...Any.encode({ b: 1, a: 2 })]).toEqual([...Any.encode({ a: 2, b: 1 })]);
      // An integer takes the int tag, so the same integer under the float tag is a
      // second spelling of a value that already had one.
      const float = new Uint8Array(9);
      float[0] = 4;
      new DataView(float.buffer).setFloat64(1, 5, true);
      expect(() => Any.decode(float)).toThrow(/Non-canonical dynamic number/);
    });

    it("bounds how deep a dynamic value may nest, on both sides", () => {
      const Any = compile(z.any());
      let deep: unknown = 1;
      for (let level = 0; level < 70; level++) deep = [deep];
      expect(() => Any.encode(deep)).toThrow(/nests deeper than/);

      // The payload, not the schema, chooses the depth here, which is what makes a
      // limit necessary at all, so a hostile one must land on a DecodeError rather
      // than on the engine's stack limit.
      expect(() => Any.decode(new Uint8Array(200).fill(6))).toThrow(DecodeError);

      // And a refused encode must not leave the depth count raised behind it.
      expect(Any.decode(Any.encode([[1]]))).toEqual([[1]]);
    });

    it("refuses a rich type wearing an object's shape rather than writing it empty", () => {
      const Any = compile(z.any());
      expect(() => Any.encode(new Date())).toThrow(/Cannot encode Date as a dynamic value/);
      expect(() => Any.encode(new Map())).toThrow(/dynamic value/);
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      expect(() => Any.encode(cyclic)).toThrow(/nests deeper than/);
    });

    it("encodes a plain object minted in another realm, as the byte path already did", () => {
      // `Object.prototype` is realm-scoped just as `instanceof` is, so a plain object from
      // a node:vm context, an iframe or a worker was refused as a rich type. A rich type
      // stays refused: its prototype *sits on* an `Object.prototype` rather than being one.
      const Any = compile(z.any());
      const foreign = runInNewContext("({ b: 2, a: [1, null] })") as Record<string, unknown>;
      expect(Object.getPrototypeOf(foreign)).not.toBe(Object.prototype);
      expect(Any.decode(Any.encode(foreign))).toEqual({ a: [1, null], b: 2 });
      // Byte-identical to the local twin, or the realm reached the wire.
      expect([...Any.encode(foreign)]).toEqual([...Any.encode({ b: 2, a: [1, null] })]);
      expect(() => Any.encode(runInNewContext("new Date()") as object)).toThrow(/dynamic value/);
      expect(() => Any.encode(runInNewContext("new Map()") as object)).toThrow(/dynamic value/);
      expect(() => Any.encode(runInNewContext("new (class Point {})()") as object))
        .toThrow(/dynamic value/);
    });

    it("takes an integer-like property name, which enumerates out of canonical order", () => {
      // `Object.keys` hoists "2" ahead of "10" while canonical order is the reverse, which
      // looks like it should need a special case and does not: a field is read by key, so
      // only the sorted order reaches the wire. A status-code map is an ordinary object.
      const Codes = compile(
        z.object({ "2": z.string(), "10": z.string(), "1": z.string().optional() }),
      );
      const value = { "1": "c", "2": "b", "10": "a" };
      expect(Codes.decode(Codes.encode(value))).toEqual(value);
      // Insertion order must not reach the bytes, with the optional present or absent.
      expect([...Codes.encode(value)]).toEqual([...Codes.encode({ "10": "a", "2": "b", "1": "c" })]);
      expect([...Codes.encode({ "2": "b", "10": "a" })])
        .toEqual([...Codes.encode({ "10": "a", "2": "b" })]);

      // And through the open-object path, where the extras record sorts separately from
      // the declared fields.
      const Open = compile(z.object({ "2": z.string(), "10": z.string() }).catchall(z.string()));
      const open = { "2": "b", "3": "y", "10": "a", zz: "x" };
      expect(Open.decode(Open.encode(open))).toEqual(open);
      expect([...Open.encode(open)])
        .toEqual([...Open.encode({ zz: "x", "10": "a", "3": "y", "2": "b" })]);
    });

    it("encodes a discriminated union as a branch index", () => {
      const Event = compile(
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("click"), x: z.int() }),
          z.object({ kind: z.literal("key"), code: z.string() }),
        ]),
      );
      for (const value of [{ kind: "click", x: 3 } as const, { kind: "key", code: "a" } as const]) {
        expect(Event.decode(Event.encode(value))).toEqual(value);
      }
      // One byte for the index, none for the discriminant: it is a literal inside
      // its branch, and a literal writes nothing.
      expect(Event.encode({ kind: "click", x: 3 })).toHaveLength(2);
    });

    it("orders union branches by discriminant, not by declaration", () => {
      const one = compile(
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("a"), v: z.int() }),
          z.object({ kind: z.literal("b"), v: z.int() }),
        ]),
      );
      const other = compile(
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("b"), v: z.int() }),
          z.object({ kind: z.literal("a"), v: z.int() }),
        ]),
      );
      expect([...one.encode({ kind: "a", v: 1 })]).toEqual([...other.encode({ kind: "a", v: 1 })]);
    });

    it("names an unmatched discriminant without serializing it", () => {
      // The message quotes the discriminant as JSON, and `JSON.stringify` throws on a
      // BigInt, on a cycle, and out of a `toJSON` the caller wrote, so a value no branch
      // declares was reported as that TypeError instead of as this EncodeError.
      // Through `unchecked`, because that is where the wire half answers for itself: with
      // the validator in front, zod refuses the discriminant before shorn sees it.
      const Event = unchecked(
        compile(
          z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("a"), v: z.int() }),
            z.object({ kind: z.literal("b"), v: z.int() }),
          ]),
        ),
      );
      const circular: Record<string, unknown> = { v: 1 };
      circular.kind = circular;
      for (const value of [
        { kind: 10n, v: 1 },
        circular,
        { kind: { toJSON() { throw new RangeError("no json"); } }, v: 1 },
      ]) {
        expect(() => Event.encode(value as never)).toThrow(EncodeError);
      }
      expect(() => Event.encode({ kind: 10n, v: 1 } as never)).toThrow(
        'No union branch has "kind" = bigint',
      );
      // An ordinary discriminant still reads back as its own JSON text.
      expect(() => Event.encode({ kind: "c", v: 1 } as never)).toThrow(
        'No union branch has "kind" = "c"',
      );
    });

    it("refuses a branch index no branch answers to", () => {
      const Event = compile(
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("a") }),
          z.object({ kind: z.literal("b") }),
        ]),
      );
      expect(() => Event.decode(new Uint8Array([9]))).toThrow(/Unknown union branch 9/);
    });

    it("encodes a tuple's rest elements after its fixed ones", () => {
      const Row = compile(z.tuple([z.string()], z.int()));
      const rows: [string, ...number[]][] = [["a"], ["a", 1, 2, 3]];
      for (const value of rows) {
        expect(Row.decode(Row.encode(value))).toEqual(value);
      }
      // Fixed part bare, then a count for the rest, so an empty rest costs one byte.
      expect(Row.encode(["a"])).toHaveLength(3);
      // And the rest's element budget is the array's, not a second copy of it.
      expect(() => Row.decode(new Uint8Array([1, 97, 200, 1]))).toThrow(/remaining input/);
    });

    it("names a rest element by its position in the whole tuple", () => {
      const Row = compile(z.tuple([z.string()], z.int()));
      // Not `[0]`, which is where it sits within the rest.
      expect(() => Row.encode(["a", 1, "no"] as never)).toThrow(/\[2\]/);
    });

    it("keeps an open object's declared fields as cheap as a closed one's", () => {
      // Only the open half pays for its keys, and an object with nothing extra pays
      // one byte for saying so.
      expect(compile(z.looseObject({ a: z.string() })).encode({ a: "x" })).toHaveLength(3);
      expect(compile(z.object({ a: z.string() })).encode({ a: "x" })).toHaveLength(2);
    });

    it("orders an open object's extras canonically, whatever order they were set in", () => {
      const Loose = compile(z.looseObject({ a: z.string() }));
      expect([...Loose.encode({ a: "x", z: 1, b: 2 })]).toEqual([
        ...Loose.encode({ a: "x", b: 2, z: 1 }),
      ]);
    });

    it("refuses an extra key that repeats a declared field", () => {
      // Otherwise it would overwrite the field decoded moments earlier, and the two
      // payloads, value in the field, value in the tail, would decode alike.
      const Loose = compile(z.looseObject({ a: z.string() }));
      expect(() => Loose.decode(Uint8Array.from([1, 120, 1, 1, 97, 1, 49]))).toThrow(
        /repeats a declared field/,
      );
    });

    it("keeps an open object's prototype when a __proto__ key arrives in the tail", () => {
      const Loose = compile(z.looseObject({ a: z.string() }));
      const decoded = Loose.decode(Loose.encode({ a: "x", ["__proto__"]: 1 }));
      expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("names the extras key holding a value the writer refuses", () => {
      // A lone surrogate, because the validator passes it and only the writer refuses it:
      // the one way to reach the walk at all, since a type error arrives with a validator
      // issue that already names the field.
      const Open = z.object({ id: z.string() }).catchall(z.string());
      const top = safeEncode(Open, { id: "ok", note: "bad\ud800" });
      expect(top.success).toBe(false);
      if (!top.success) {
        const error = top.error as EncodeError;
        expect(error.path).toBe("note");
        expect(error.message).toBe("String contains an unpaired surrogate at note");
      }

      // One level down this named `o`: the enclosing field, which points a caller at the
      // wrong value rather than at none. An extras key is a direct child of the object.
      const deep = safeEncode(z.object({ o: Open }), { o: { id: "ok", note: "bad\ud800" } });
      expect(deep.success).toBe(false);
      if (!deep.success) {
        const error = deep.error as EncodeError;
        expect(error.path).toBe("o.note");
        expect(error.message).toBe("String contains an unpaired surrogate at o.note");
      }
    });

    it("searches an open object's declared fields before its extras", () => {
      // The order encode writes them in. With both refused, the field wins.
      const Open = z.object({ id: z.string() }).catchall(z.string());
      const both = safeEncode(Open, { id: "bad\ud800", note: "bad\ud800" });
      expect(both.success).toBe(false);
      if (!both.success) expect((both.error as EncodeError).path).toBe("id");

      // A closed object of the same shape has no tail to walk, and reports what it always
      // did: the declared field, or nothing when the failure is the value's own type.
      const Closed = z.object({ id: z.string() });
      const closed = safeEncode(Closed, { id: "bad\ud800" });
      expect(closed.success).toBe(false);
      if (!closed.success) expect((closed.error as EncodeError).path).toBe("id");
      expect(() => compile(Open).encode("nope" as never)).toThrow(/received string$/);
    });

    it("does not re-type an overlapping union as a dynamic value", () => {
      // Reaches the same typeless node the `any` mapping reads, and keeps the refusal it
      // had: two object branches with no discriminant have nothing that says which one to
      // read, so a value would have to be tried against each in turn.
      expect(() => compile(z.union([z.object({ a: z.string() }), z.object({ b: z.int() })])))
        .toThrow(/Only nullable, discriminated and type-disjoint JSON Schema unions/);
    });

    it("names the combinator when one carries the refusal", () => {
      // "Unsupported Standard JSON Schema type undefined" named neither the schema
      // nor the reason; the keyword is the one thing the caller can act on.
      // Two strings rather than two objects, because Zod 4.5 (#6461) folds an
      // intersection of two objects into a single object and writes no `allOf` at all;
      // an intersection of non-objects still writes one on both 4.4 and 4.5.
      expect(() => compile(z.intersection(z.string(), z.string().min(2))))
        .toThrow(/Unsupported JSON Schema combinator allOf/);
      expect(() => compile(z.never())).toThrow(/Unsupported JSON Schema combinator not/);
    });

    it("compiles z.null() to the same wire shape as z.literal(null)", () => {
      // The same schema written two ways: `{ type: "null" }` and `{ const: null }`.
      const typed = compile(z.object({ error: z.null(), n: z.int() }));
      const literal = compile(z.object({ error: z.literal(null), n: z.int() }));
      const value = { error: null, n: 7 };
      expect([...typed.encode(value)]).toEqual([...literal.encode(value)]);
      expect(typed.decode(typed.encode(value))).toEqual(value);
      // And it inherits the null-literal rules: zero width, no second null marker.
      expect(compile(z.null()).encode(null)).toHaveLength(0);
      expect(() => compile(z.null()).nullable()).toThrow(/already decodes to null/);
    });

    it("drops a nullable marker over a shape that already holds null", () => {
      // Tag 0 of a dynamic value is already `null`, so the marker would be a byte meaning
      // nothing, and refusing to add it surfaced as "already decodes to null", which read
      // as an accusation about the caller's `.nullable()` rather than about this compiler's.
      const Any = compile(z.any().nullable());
      for (const value of [null, 1, "x", { a: 1 }]) {
        expect(Any.decode(Any.encode(value))).toEqual(value);
      }
      expect([...Any.encode(null)]).toEqual([...compile(z.any()).encode(null)]);

      // `z.null().nullable()` writes `anyOf: [{type:"null"}, {type:"null"}]` and
      // `z.literal(null).nullable()` writes the same with a `const`: every branch one value.
      for (const Nothing of [compile(z.null().nullable()), compile(z.literal(null).nullable())]) {
        expect(Nothing.encode(null)).toHaveLength(0);
        expect(Nothing.decode(Nothing.encode(null))).toBeNull();
      }

      // The nested case never threw, `Schema.nullable()` collapses a repeated marker, but
      // it collapsed below the signature, so these two wrote identical bytes under
      // different fingerprints and rejected each other's payloads.
      const nested = z.union([z.literal(null), z.literal("a")]).nullable();
      const flat = z.union([z.literal(null), z.literal("a")]);
      expect([...compile(nested).encode("a")]).toEqual([...compile(flat).encode("a")]);
      expect(fingerprinted(compile(nested)).fingerprintHex)
        .toBe(fingerprinted(compile(flat)).fingerprintHex);
    });

    it("still bounds a fixed count against the input it would have to fill", () => {
      // `minItems` may arrive from a fetched JSON Schema, so it buys no more trust
      // than a length the payload declared for itself.
      const Huge = compile(z.array(z.string()).length(1_000_000));
      expect(() => Huge.decode(new Uint8Array([1, 2, 3]))).toThrow(/remaining input/);
    });

    it("carries the slot bound when a compiled codec sits inside an m container", () => {
      // The codec copied every fact of its structural half but `_slots`, so an `m`
      // array around it saw zero slots and skipped the ceiling: this built, and turned
      // an empty payload into 2,000,000 slots. At a million a level it is the OOM the
      // bound exists for. `examples/02-rpc.ts` nests compiled codecs in `m` this way.
      const inner = compile(z.array(z.literal(true)).length(1000));
      expect(inner._slots).toBe(unchecked(inner)._slots);
      const refusal = /or a fixed count of them must stay under the collection limit/;
      expect(() => m.array(inner, 2000)).toThrow(refusal);
      expect(() => m.array(unchecked(inner), 2000)).toThrow(refusal);
      expect(m.array(inner, 900).decode(new Uint8Array(0))).toHaveLength(900);
    });
  });

  it("keeps the selected library's validation behavior", () => {
    const Positive = compile(z.int().positive());
    expect(() => Positive.encode(-1)).toThrow(/Too small/);
    expect(safeEncode(z.int().positive(), -1).success).toBe(false);
  });

  it("supports tuples and nullable values through the standard interface", () => {
    const Value = compile(z.tuple([z.string(), z.int(), z.string().nullable()]));
    const tuple: [string, number, string | null] = ["x", -2, null];
    expect(Value.decode(Value.encode(tuple))).toEqual(tuple);
  });

  it("explains why validation-only Standard Schemas are insufficient", () => {
    const validationOnly = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (input: unknown) => ({ value: input }),
      },
    };
    expect(() => compile(validationOnly as never)).toThrow(/provides validation but not structure/);
  });

  it("supports asynchronous Standard Schema validation explicitly", async () => {
    const asyncSchema = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: async (input: unknown) =>
          typeof input === "string" ? { value: input } : { issues: [{ message: "Expected string" }] },
        jsonSchema: {
          input: () => ({ type: "string" }),
          output: () => ({ type: "string" }),
        },
      },
    };
    const Value = compile(asyncSchema);
    await expect(decodeAsync(asyncSchema, await encodeAsync(asyncSchema, "hello"))).resolves.toBe(
      "hello",
    );
    expect(() => Value.encode("hello")).toThrow(/validates asynchronously/);
  });

  it("leaves no unhandled rejection when a sync entry point meets a promise", async () => {
    // Zod answers with a Promise whenever a refinement throws, and a sync encode that met
    // one threw here and dropped it, so its rejection went unhandled. By default that
    // ends a Node process: one value that tripped the refinement took a server down.
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      const Throwing = z.int().refine(() => {
        throw new RangeError("boom");
      });
      expect(() => compile(Throwing).encode(5)).toThrow(/validates asynchronously/);
      expect(safeEncode(Throwing, 5).success).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      // The async twin reaches the refinement's own error, which is the remedy the
      // message gives.
      await expect(encodeAsync(Throwing, 5)).rejects.toThrow("boom");
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("detects promise-like validators without relying on Promise identity", () => {
    const thenableSchema = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: () => ({ then: () => undefined }),
        jsonSchema: {
          input: () => ({ type: "string" }),
          output: () => ({ type: "string" }),
        },
      },
    };

    expect(() => compile(thenableSchema as never).encode("hello" as never)).toThrow(
      /validates asynchronously/,
    );
  });

  describe("Date, bigint, Set and Map from a vendor schema", () => {
    const when = new Date("2026-09-03T12:00:00.000Z");

    it("compiles the four types JSON Schema has no form for, and round-trips them", () => {
      const Rich = z.object({
        when: z.date(),
        id: z.bigint(),
        tags: z.set(z.string()),
        scores: z.map(z.string(), z.int()),
        maybe: z.date().nullable(),
        nested: z.set(z.set(z.int())),
      });
      const codec = compile(Rich);
      const value = {
        when,
        id: 12345678901234567890n,
        tags: new Set(["a", "b"]),
        scores: new Map([["k", -2]]),
        maybe: null,
        nested: new Set([new Set([1, 2])]),
      };
      const decoded = codec.decode(codec.encode(value));
      expect(decoded).toEqual(value);
      expect(decoded.when).toBeInstanceOf(Date);
      expect(decoded.tags).toBeInstanceOf(Set);
      expect(decoded.scores).toBeInstanceOf(Map);
      // Past Number.MAX_SAFE_INTEGER, so this fails if anything routes through a number.
      expect(decoded.id).toBe(12345678901234567890n);
    });

    it("writes the bytes the m builders write", () => {
      const standard = compile(z.object({ when: z.date(), id: z.bigint(), tags: z.set(z.string()) }));
      const wire = m.object({ when: m.date(), id: m.bigint(), tags: m.set(m.string()) });
      const value = { when, id: -5n, tags: new Set(["x"]) };
      expect([...standard.encode(value)]).toEqual([...wire.encode(value)]);
    });

    it("still validates, so the vendor refuses a string where a Date belongs", () => {
      const codec = compile(z.object({ when: z.date() }));
      expect(() => codec.encode({ when: "2026-09-03" as never })).toThrow(EncodeError);
      // Zod refuses an Invalid Date itself, before the wire ever sees it.
      expect(() => codec.encode({ when: new Date(NaN) })).toThrow(EncodeError);
    });

    it("packs a date-time string into the Date layout and refuses every other spelling", () => {
      const codec = compile(z.object({ at: z.iso.datetime({ offset: true }) }));
      const canonical = "2026-09-03T12:00:00.000Z";
      const bytes = codec.encode({ at: canonical });
      expect([...bytes]).toEqual([...m.object({ at: m.date() }).encode({ at: when })]);
      expect(codec.decode(bytes)).toEqual({ at: canonical });
      // All three are valid to the validator and name the same instant; none survives
      // the trip through epoch milliseconds as the string it was, so none is accepted.
      for (const spelling of [
        "2026-09-03T12:00:00Z",
        "2026-09-03T12:00:00.000000Z",
        "2026-09-03T14:00:00.000+02:00",
      ]) {
        expect(() => codec.encode({ at: spelling })).toThrow(/canonical ISO-8601 date-time/);
        expect(() => codec.encode({ at: spelling })).toThrow(/at at$/);
      }
    });

    it("gives a Set and an array of one element different fingerprints over identical bytes", () => {
      const set = compile(z.set(z.string()));
      const array = compile(z.array(z.string()));
      expect([...set.encode(new Set(["a"]))]).toEqual([...array.encode(["a"])]);
      expect(fingerprinted(set).fingerprintHex).not.toBe(fingerprinted(array).fingerprintHex);
      // A date-time is no longer a string on the wire, so its fingerprint moved with it.
      expect(fingerprinted(compile(z.iso.datetime())).fingerprintHex).not.toBe(
        fingerprinted(compile(z.string())).fingerprintHex,
      );
    });

    it("refuses a z.codec(), whose transform decode would run a second time", () => {
      // Encode writes what the validator returns and decode validates what it reads, so a
      // codec's forward transform ran twice per round trip: 1_700_000_000 seconds came
      // back as 1_700_000_000_000_000 and nothing threw. A trim codec came back right,
      // which is how it went unnoticed.
      const Seconds = z.codec(z.int(), z.int(), {
        decode: (seconds) => seconds * 1000,
        encode: (milliseconds) => milliseconds / 1000,
      });
      const refusal = /A z\.codec\(\) would transform twice/;
      expect(() => compile(Seconds)).toThrow(refusal);
      expect(() => compile(z.object({ at: Seconds }))).toThrow(refusal);

      // The documented route: compile the wire side and let Zod run both directions.
      const Rich = z.object({ at: Seconds });
      const Wire = compile(z.object({ at: z.int() }));
      const bytes = Wire.encode(z.encode(Rich, { at: 1_700_000_000_000 }));
      expect(z.decode(Rich, Wire.decode(bytes))).toEqual({ at: 1_700_000_000_000 });
      // A pipe without a way back is read as before.
      expect([...compile(z.string().pipe(z.string().min(1))).encode("a")]).toEqual([1, 97]);
    });

    it("keeps refusing what has no wire form at all, in the vendor's own words", () => {
      for (const [schema, reason] of [
        [z.object({ v: z.undefined() }), /undefined cannot be represented in JSON Schema/],
        [z.object({ v: z.nan() }), /nan cannot be represented/],
        [z.object({ v: z.symbol() }), /symbol cannot be represented/],
        [z.object({ v: z.string().transform(Number) }), /transform cannot be represented/],
        [z.object({ v: z.literal(10n) }), /literal undefined or bigint/],
      ] as const) {
        expect(() => compile(schema)).toThrow(EncodeError);
        expect(() => compile(schema)).toThrow(reason);
      }
      // A throw the vendor makes on its own, outside any shorn hook, still gets the remedy.
      expect(() => compile(type({ v: "undefined" }))).toThrow(/convert it at the edge/);
    });

    it("refuses a recursive type reached through a Set or Map element", () => {
      const Node = z.object({
        get kids() {
          return z.set(Node);
        },
      });
      expect(() => compile(Node)).toThrow(/recursive type inside a Set or Map/);
    });

    it("takes a plain JSON Schema document as the structure, x-shorn keyword included", () => {
      const structure = {
        type: "object",
        properties: {
          when: { "x-shorn": "date" },
          scores: { "x-shorn": "map", "x-shorn-key": { type: "string" }, items: { type: "integer" } },
        },
        required: ["when", "scores"],
        additionalProperties: false,
      };
      const validator = {
        "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) },
      } as unknown as StandardSchemaV1;
      const codec = compile(validator, structure);
      const value = { when, scores: new Map([["k", -1]]) };
      expect(codec.decode(codec.encode(value))).toEqual(value);
      expect([...codec.encode(value)]).toEqual([
        ...compile(z.object({ when: z.date(), scores: z.map(z.string(), z.int()) })).encode(value),
      ]);
    });

    it("still refuses a second argument that is neither form, and an unknown keyword value", () => {
      expect(() => compile(z.string(), { structure: z.string() } as never)).toThrow(
        /Standard JSON Schema implementation .* or a JSON Schema document/,
      );
      expect(() => compile(z.string(), 42 as never)).toThrow(EncodeError);
      expect(() => compile(z.string(), { "x-shorn": "url" })).toThrow(/Unsupported x-shorn kind url/);
    });
  });

  it("refuses an extra property only where the schema left nowhere to put it", () => {
    // An open object has somewhere: `additionalProperties` names the value type, so
    // the extras are written after the declared fields. ArkType emits no
    // `additionalProperties` at all, which is a closed object with no tail: the one
    // case where an extra can only be dropped, so it is refused instead.
    expect(() => compile(arkSchema).encode({ ...value, extra: true } as never)).toThrow(
      /Unknown object property "extra"/,
    );
  });

  // ArkType objects and Valibot's `v.object()` both compile to this check, and it runs
  // ahead of the generated encoder rather than in place of it: the bytes are the ones a
  // Zod object produces, and an unknown key is reported before any field is encoded.
  it("checks for unknown properties ahead of the generated encoder, not instead of it", () => {
    const codec = unchecked(compile(arkSchema));
    expect([...codec.encode(value)]).toEqual([25, 5, 82, 97, 104, 117, 108, 1]);
    expect([...codec.encode(value)]).toEqual([...unchecked(compile(zodSchema)).encode(value)]);
    expect(() => codec.encode({ ...value, age: "old", extra: true } as never)).toThrow(
      /^Unknown object property "extra"/,
    );
  });

  it("round-trips optional fields on an object that rejects unknown properties", () => {
    const Profile = type({ id: "number.integer >= 0", "email?": "string", "nickname?": "string" });
    const codec = compile(Profile);
    const hand = m.object({
      id: m.uint(),
      email: m.string().optional(),
      nickname: m.string().optional(),
    });
    for (const input of [
      { id: 7 },
      { id: 7, email: "a@b.co" },
      { id: 7, email: "a@b.co", nickname: "r" },
    ]) {
      const bytes = codec.encode(input as never);
      expect([...bytes]).toEqual([...hand.encode(input as never)]);
      expect(codec.decode(bytes)).toEqual(input);
    }
    expect(() => codec.encode({ id: 7, extra: 1 } as never)).toThrow(
      /Unknown object property "extra"/,
    );
  });

  // Who polices extra properties depends on what the vendor emits, which is not
  // obvious from either side alone: zod says `additionalProperties: false` for both
  // `object` and `strictObject` and handles extras itself, so shorn stands back;
  // arktype emits nothing, so shorn refuses (above). This pins both halves, because
  // the encoder's own check reads as inverted until you know which is which.
  it("leaves extra properties to the validator when the vendor declares the object closed", () => {
    const Stripping = z.object({ name: z.string() });
    const Strict = z.strictObject({ name: z.string() });
    const extra = { name: "x", extra: true };

    expect(decode(Stripping, encode(Stripping, extra as never))).toEqual({ name: "x" });
    expect(() => encode(Strict, extra as never)).toThrow(/Unrecognized key/);
  });

  it("refuses a Zod field named __proto__, which Zod's own validator drops", () => {
    // Zod 4.6 lists the field in `properties` as an own key, so the codec built, but every
    // value Zod returns lacks the key: every encode failed with a bare "Expected a
    // string". Refused by name now, as Valibot's spelling and Zod 4.5's already were. A
    // hand-written document with a validator that keeps the key still works, below.
    const Proto = z.object({ ["__proto__"]: z.string(), a: z.string() });
    expect(() => compile(Proto)).toThrow(/"__proto__" property does not survive/);
  });

  it("preserves a declared __proto__ field without mutating the decoded prototype", () => {
    const jsonSchema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"],"additionalProperties":false}',
    );
    const Proto = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
        jsonSchema: {
          input: () => jsonSchema,
          output: () => jsonSchema,
        },
      },
    };
    const input = Object.defineProperty({}, "__proto__", {
      enumerable: true,
      value: "safe",
    }) as { __proto__: string };

    const Value = compile(Proto as never);
    const decoded = Value.decode(Value.encode(input as never)) as { __proto__: string };
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.hasOwn(decoded, "__proto__")).toBe(true);
    expect(decoded.__proto__).toBe("safe");
  });

  describe("defaults", () => {
    // Zod and ArkType describe a defaulted field as optional going in and required coming
    // out. That pair was refused as two wire shapes, while Valibot's one-document spelling
    // of the same schema compiled, so the promise of one schema, one set of bytes from
    // every validator broke on one of Zod's commonest idioms. The field now compiles as
    // the input side has it: optional, which is the shape Valibot's document already has.
    const vint = v.pipe(v.number(), v.integer());
    const flat: Record<string, EncodableStandardSchema> = {
      zod: z.object({ a: z.string().default("x"), b: z.int() }),
      arktype: type({ a: "string = 'x'", b: "number.integer" }),
      valibot: toStandardJsonSchema(
        v.object({ a: v.optional(v.string(), "x"), b: vint }),
      ) as EncodableStandardSchema,
    };

    it("compiles a Zod or ArkType default to Valibot's bytes and fingerprint", () => {
      const hex = fingerprinted(compile(flat.valibot!)).fingerprintHex;
      for (const [vendor, schema] of Object.entries(flat)) {
        // The validator fills the field before a byte is written, so its bit is set.
        const bytes = [...compile(schema).encode({ b: 1 } as never)];
        expect({ vendor, bytes }).toEqual({ vendor, bytes: [1, 1, 120, 2] });
        expect({ vendor, hex: fingerprinted(compile(schema)).fingerprintHex }).toEqual({
          vendor,
          hex,
        });
      }
    });

    it("fills a default nested in an object, an array element, and an optional or nullable field", () => {
      const nested: Record<string, EncodableStandardSchema> = {
        zod: z.object({
          inner: z.object({ a: z.string().default("x") }),
          list: z.array(z.object({ a: z.string().default("x") })),
          opt: z.object({ n: z.int().default(7) }).optional(),
          nul: z.object({ f: z.boolean().default(true) }).nullable(),
        }),
        arktype: type({
          inner: { a: "string = 'x'" },
          list: type({ a: "string = 'x'" }).array(),
          "opt?": { n: "number.integer = 7" },
          nul: type({ f: "boolean = true" }).or("null"),
        }),
        valibot: toStandardJsonSchema(
          v.object({
            inner: v.object({ a: v.optional(v.string(), "x") }),
            list: v.array(v.object({ a: v.optional(v.string(), "x") })),
            opt: v.optional(v.object({ n: v.optional(vint, 7) })),
            nul: v.nullable(v.object({ f: v.optional(v.boolean(), true) })),
          }),
        ) as EncodableStandardSchema,
      };
      const input = { inner: {}, list: [{}, { a: "y" }], opt: {}, nul: {} };
      const filled = { inner: { a: "x" }, list: [{ a: "x" }, { a: "y" }], opt: { n: 7 }, nul: { f: true } };
      const reference = compile(nested.valibot!);
      for (const [vendor, schema] of Object.entries(nested)) {
        const codec = compile(schema);
        const bytes = codec.encode(input as never);
        expect({ vendor, decoded: codec.decode(bytes) }).toEqual({ vendor, decoded: filled });
        expect({ vendor, bytes: [...bytes] }).toEqual({
          vendor,
          bytes: [...reference.encode(input as never)],
        });
        expect(codec.signature).toBe(reference.signature);
      }
    });

    it("decodes a payload with the bit clear to the default, through the validator", () => {
      // No validated encoder writes one, since the field is always filled by then, but
      // `unchecked()` does: it runs no validator, so an absent field goes out absent.
      for (const [vendor, schema] of Object.entries(flat)) {
        const bytes = unchecked(schema).encode({ b: 1 } as never);
        expect({ vendor, bytes: [...bytes] }).toEqual({ vendor, bytes: [0, 2] });
        expect({ vendor, decoded: decode(schema, bytes) }).toEqual({
          vendor,
          decoded: { a: "x", b: 1 },
        });
      }
    });

    it("keeps refusing a difference between the two sides that is not a default", () => {
      // What makes a default safe to encode is that the output fits the input's wire
      // shape with one presence bit to spare. Nothing below fits: a narrower wire type on
      // the way out, the same under a default, an ArkType morph from a numeric string to
      // a number, and a field optional only on the way out, written by hand because no
      // vendor's types let a schema say it.
      const uuid = "0192e4c6-3c0e-7000-8000-0000000000ff";
      const field = { type: "object", properties: { a: { type: "string" } } };
      const optionalOnTheWayOut = {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: (value: unknown) => ({ value }),
          jsonSchema: { input: () => ({ ...field, required: ["a"] }), output: () => field },
        },
      } as unknown as EncodableStandardSchema;
      for (const schema of [
        z.object({ a: z.string().pipe(z.uuid()) }),
        z.object({ a: z.string().pipe(z.uuid()).default(uuid) }),
        type({ a: "string.numeric.parse" }),
        optionalOnTheWayOut,
      ]) {
        expect(() => compile(schema)).toThrow(EncodeError);
        expect(() => compile(schema)).toThrow(
          "Schemas with different input and output wire shapes require a bidirectional codec and are not yet supported",
        );
      }
      // A `z.codec()` keeps the refusal of its own, with a default beside it or without.
      const Seconds = z.codec(z.int(), z.int(), {
        decode: (seconds) => seconds * 1000,
        encode: (milliseconds) => milliseconds / 1000,
      });
      expect(() => compile(z.object({ a: z.string().default("x"), at: Seconds }))).toThrow(
        /A z\.codec\(\) would transform twice/,
      );
    });
  });

  describe("unions with no discriminant", () => {
    it("dispatches on the JSON type when no two branches share one", () => {
      const Value = compile(z.union([z.string(), z.number()]));
      // Ordered by type name, so `number` is index 0 and `string` is index 1 whichever
      // way the schema listed them.
      expect([...Value.encode("hi")]).toEqual([1, 2, 104, 105]);
      expect(Value.decode(Value.encode("hi"))).toBe("hi");
      expect(Value.decode(Value.encode(42))).toBe(42);
    });

    it("reads a type array as the union it abbreviates, with the same bytes and fingerprint", () => {
      // Zod 4.5 writes a union of bare types as `type: [...]` where 4.4 wrote `anyOf`,
      // so the two spellings have to be one shape or a `pnpm update zod` moves every
      // fingerprint that holds such a union. Both are handed in as plain documents, so
      // the test says the same thing whichever version is installed.
      const validator = z.union([z.string(), z.number(), z.boolean(), z.null()]);
      const long = fingerprinted(
        compile(validator, {
          anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }],
        }),
      );
      const short = fingerprinted(
        compile(validator, { type: ["string", "number", "boolean", "null"] }),
      );
      expect(short.fingerprintHex).toBe(long.fingerprintHex);
      // Ordered by type name, so `string` is index 3 of ["boolean","null","number","string"].
      const bare = compile(validator, { type: ["string", "number", "boolean", "null"] });
      expect([...bare.encode("x")]).toEqual([3, 1, 120]);
      for (const value of ["x", 1.5, true, null]) {
        expect([...short.encode(value)]).toEqual([...long.encode(value)]);
        expect(short.decode(short.encode(value))).toEqual(value);
      }
      // Two members with one null is a nullable, as it always was for a type array.
      const nullable = compile(z.string().nullable(), { type: ["string", "null"] });
      expect([...nullable.encode(null)]).toEqual([...compile(z.string().nullable()).encode(null)]);
      // A pair no value tells apart is refused with the union message, not a type-array one.
      expect(() =>
        compile(z.union([z.int(), z.number()]), { type: ["integer", "number"] }),
      ).toThrow(/type-disjoint JSON Schema unions/);
    });

    it("reads a union of literals as the enum it is, not as a union of types", () => {
      // Every branch is a set of values, so the union is their merged set: one index, in
      // the enum's own order, which for a mixed set is JSON text. This compiled as a
      // type-disjoint union until the branches were read by their values, `{"types":
      // ["number","string"],…}`, with "a" at index 1 and 3 at index 0, while
      // `z.literal(["a", 3])` and arktype's `"'a' | 3"` wrote the enum: one type, two
      // payloads that decoded each other's bytes to the wrong member.
      const Value = compile(z.union([z.literal("a"), z.literal(3)]));
      expect(Value.signature).toBe('{"enum":["a",3]}');
      expect([...Value.encode("a")]).toEqual([0]);
      expect([...Value.encode(3)]).toEqual([1]);
      expect(Value.decode(Value.encode(3))).toBe(3);
      expect(compile(z.literal(["a", 3])).signature).toBe(Value.signature);
    });

    it("takes null, arrays and objects as types of their own", () => {
      const Value = compile(z.union([z.string(), z.array(z.string()), z.null()]));
      for (const value of ["x", ["a", "b"], null]) {
        expect(Value.decode(Value.encode(value as never))).toEqual(value);
      }
    });

    it("does not let branch order reach the wire", () => {
      const forward = fingerprinted(compile(z.union([z.string(), z.number()])));
      const backward = fingerprinted(compile(z.union([z.number(), z.string()])));
      expect(forward.fingerprintHex).toBe(backward.fingerprintHex);
      expect([...forward.encode("x")]).toEqual([...backward.encode("x")]);
    });

    it("refuses branches that a value cannot tell apart", () => {
      // Nothing about `5` says which of the two number types it was declared as, so this
      // is the ambiguity the refusal exists for rather than a shape shorn declines to try.
      expect(() => compile(z.union([z.int(), z.number()]))).toThrow(
        /type-disjoint JSON Schema unions/,
      );
      // `z.any()` overlaps whatever sits beside it.
      expect(() => compile(z.union([z.string(), z.any()]))).toThrow(EncodeError);
    });

    it("names the type it could not place", () => {
      // Through `unchecked`, because a validated codec rejects the value first: with the
      // branches disjoint, no value the vendor accepts can reach this message.
      const Value = unchecked(z.union([z.string(), z.number()]));
      expect(() => Value.encode(true as never)).toThrow(/No union branch holds boolean/);
    });

    it("refuses a payload naming a branch that does not exist", () => {
      const Value = compile(z.union([z.string(), z.number()]));
      expect(() => Value.decode(Uint8Array.from([2, 0]))).toThrow(DecodeError);
    });

    it("tells absent from null over a nullable type union", () => {
      // The union already holds null, so `.nullable()` on top would give null two
      // spellings: `.optional()` is the wrapper that still says something new.
      const Value = compile(z.object({ v: z.union([z.string(), z.number(), z.null()]).optional() }));
      expect(Value.decode(Value.encode({ v: null }))).toEqual({ v: null });
      expect(Value.decode(Value.encode({}))).toEqual({});
      expect(() => compile(z.union([z.string(), z.number(), z.null()])).nullable()).toThrow(
        /already decodes to null/,
      );
    });
  });

  describe("one wire shape per union type, however it is spelled", () => {
    const val = (schema: v.GenericSchema) => toStandardJsonSchema(schema) as EncodableStandardSchema;
    const du = z.discriminatedUnion("k", [
      z.object({ k: z.literal("a"), n: z.int() }),
      z.object({ k: z.literal("b") }),
    ]);
    const vdu = v.variant("k", [
      v.object({ k: v.literal("a"), n: v.pipe(v.number(), v.integer()) }),
      v.object({ k: v.literal("b") }),
    ]);

    // Each type in every spelling a vendor writes for it. Zod alone has three: a `type`
    // array over bare types from 4.5, a nested `anyOf` once a branch carries a keyword,
    // and a nested `anyOf` for everything up to 4.4. The installed zod no longer writes
    // the 4.4 form, so those documents are written out as 4.4.3 emits them.
    //
    // Before the branches were flattened, these 32 spellings of six types compiled to 11
    // signatures and refused 7 times. The first type split between the two null forms,
    // so `"s"` wrote `02 01 73` from one spelling and `01 01 01 73` from the other, and
    // neither payload decoded with the other's codec.
    const types: ReadonlyArray<{
      readonly name: string;
      readonly signature: string;
      readonly values: readonly unknown[];
      readonly spellings: ReadonlyArray<readonly [string, () => Schema<unknown>]>;
    }> = [
      {
        name: "string | number | null",
        signature:
          '{"types":["null","number","string"],"union":[{"literal":null},"float64","string"]}',
        values: ["s", 1.5, null],
        spellings: [
          ["zod, type array", () => compile(z.union([z.string(), z.number()]).nullable())],
          ["zod, refined branch", () => compile(z.union([z.string().min(1), z.number()]).nullable())],
          ["zod, null branch", () => compile(z.union([z.string(), z.number(), z.null()]))],
          [
            "zod 4.4",
            () =>
              compile(z.union([z.string(), z.number()]).nullable(), {
                anyOf: [{ anyOf: [{ type: "string" }, { type: "number" }] }, { type: "null" }],
              }),
          ],
          ["valibot", () => compile(val(v.nullable(v.union([v.string(), v.number()]))))],
          ["arktype", () => compile(type("string | number | null"))],
        ],
      },
      {
        name: "'a' | 'b' | null",
        signature: '{"nullable":{"enum":["a","b"]}}',
        values: ["a", "b", null],
        spellings: [
          ["zod, enum", () => compile(z.enum(["a", "b"]).nullable())],
          ["zod, literals", () => compile(z.union([z.literal("a"), z.literal("b")]).nullable())],
          ["zod, literal list", () => compile(z.literal(["a", "b", null]))],
          ["valibot, picklist", () => compile(val(v.nullable(v.picklist(["a", "b"]))))],
          ["valibot, literals", () => compile(val(v.union([v.literal("a"), v.literal("b"), v.null()])))],
          ["arktype", () => compile(type("'a' | 'b' | null"))],
        ],
      },
      {
        name: "'a' | 1",
        signature: '{"enum":["a",1]}',
        values: ["a", 1],
        spellings: [
          ["zod, literals", () => compile(z.union([z.literal("a"), z.literal(1)]))],
          ["zod, literal list", () => compile(z.literal(["a", 1]))],
          ["valibot, picklist", () => compile(val(v.picklist(["a", 1])))],
          ["valibot, literals", () => compile(val(v.union([v.literal("a"), v.literal(1)])))],
          ["arktype", () => compile(type("'a' | 1"))],
        ],
      },
      {
        name: "a discriminated union or null",
        signature:
          '{"nullable":{"on":"k","cases":["a","b"],"union":[{"object":[{"key":"k","optional":false,"value":{"literal":"a"}},{"key":"n","optional":false,"value":"int"}]},{"object":[{"key":"k","optional":false,"value":{"literal":"b"}}]}]}}',
        values: [null, { k: "a", n: 1 }, { k: "b" }],
        spellings: [
          ["zod, nullable", () => compile(du.nullable())],
          ["zod, null branch", () => compile(z.union([du, z.null()]))],
          ["valibot", () => compile(val(v.nullable(vdu)))],
          [
            "arktype",
            () => compile(type({ k: "'a'", n: "number.integer" }).or({ k: "'b'" }).or("null")),
          ],
        ],
      },
      {
        // The control: the common spellings already agreed, and still do. The union of
        // one inside a nullable did not: `{"nullable":{"types":["string"],…}}`, with an
        // index byte for the only branch there was.
        name: "string | null",
        signature: '{"nullable":"string"}',
        values: ["s", null],
        spellings: [
          ["zod, type array", () => compile(z.string().nullable())],
          ["zod, refined", () => compile(z.string().min(1).nullable())],
          [
            "zod 4.4",
            () => compile(z.string().nullable(), { anyOf: [{ type: "string" }, { type: "null" }] }),
          ],
          ["valibot", () => compile(val(v.nullable(v.string())))],
          ["valibot, union of one", () => compile(val(v.nullable(v.union([v.string()]))))],
          ["arktype", () => compile(type("string | null"))],
        ],
      },
      {
        name: "'a' | 'b' | number",
        signature: '{"types":["number","string"],"union":["float64",{"enum":["a","b"]}]}',
        values: ["a", "b", 1.5],
        spellings: [
          ["zod, enum", () => compile(z.union([z.enum(["a", "b"]), z.number()]))],
          ["zod, literals", () => compile(z.union([z.literal("a"), z.literal("b"), z.number()]))],
          ["valibot, picklist", () => compile(val(v.union([v.picklist(["a", "b"]), v.number()])))],
          [
            "valibot, literals",
            () => compile(val(v.union([v.literal("a"), v.literal("b"), v.number()]))),
          ],
          ["arktype", () => compile(type("'a' | 'b' | number"))],
        ],
      },
    ];

    for (const { name, signature, values, spellings } of types) {
      it(`gives ${name} one signature, one fingerprint and one payload`, () => {
        const codecs = spellings.map(([spelling, build]) => [spelling, build()] as const);
        for (const [spelling, codec] of codecs) {
          expect({ spelling, signature: codec.signature }).toEqual({ spelling, signature });
        }
        const prints = codecs.map(([, codec]) => fingerprinted(codec).fingerprintHex);
        expect(new Set(prints).size).toBe(1);
        for (const value of values) {
          const bytes = codecs[0]![1].encode(value);
          for (const [spelling, codec] of codecs) {
            expect({ spelling, bytes: [...codec.encode(value)] }).toEqual({ spelling, bytes: [...bytes] });
            expect(codec.decode(bytes)).toEqual(value);
          }
        }
      });
    }

    it("keeps the six types apart, and null a type of its own in the first", () => {
      const prints = types.map(({ spellings }) => fingerprinted(spellings[0]![1]()).fingerprintHex);
      expect(new Set(prints).size).toBe(types.length);
      // Null as one of the types, rather than a marker in front of a two-type union: the
      // bytes zod 4.5 and arktype already wrote, and a byte cheaper than the marker.
      const refined = compile(z.union([z.string().min(1), z.number()]).nullable());
      expect([...refined.encode("s")]).toEqual([0x02, 0x01, 0x73]);
      expect([...refined.encode(null)]).toEqual([0x00]);
    });

    it("reads a set of values by its values, not by the keyword beside it", () => {
      // `{ enum: [x] }` and `{ const: x }` are the same JSON Schema, and one wrote an
      // index byte where the other wrote nothing: `z.enum(["a"])` was `{"enum":["a"]}`.
      expect(compile(z.literal("a"), { enum: ["a"] }).signature).toBe('{"literal":"a"}');
      expect(compile(z.literal("a"), { const: "a" }).signature).toBe('{"literal":"a"}');
      expect(compile(z.enum(["a"])).encode("a")).toHaveLength(0);
      expect(compile(z.null(), { enum: [null] }).signature).toBe('{"literal":null}');
      // A one-member enum is therefore refused as an array element, as an array of the
      // literal it names always was: a count of zero-width elements is not bounded by
      // the input. `z.array(z.enum(["a"]))` compiled, one byte per element, until now.
      expect(() => compile(z.array(z.enum(["a"])))).toThrow(
        /Array elements must occupy at least one byte/,
      );
      // `true | false` is `boolean`, and writes the same byte for each value.
      for (const both of [
        compile(z.literal([true, false])),
        compile(val(v.union([v.literal(true), v.literal(false)]))),
      ]) {
        expect(both.signature).toBe('"boolean"');
      }
    });

    it("costs no index for a union of one branch", () => {
      // Zod 4.5 unwraps `z.union([z.string()])` and 4.4 wrote `{ anyOf: [{ type:
      // "string" }] }`, so a zod upgrade used to move this from `00 01 73` to `01 73`.
      const one = compile(z.union([z.string()]), { anyOf: [{ type: "string" }] });
      expect(one.signature).toBe('"string"');
      expect([...one.encode("s")]).toEqual([0x01, 0x73]);
      expect(compile(val(v.union([v.string()]))).signature).toBe('"string"');
    });

    it("opens a union nested inside another, which used to be refused", () => {
      const nested = compile(z.union([z.union([z.string().min(1), z.number()]), z.boolean()]));
      expect(nested.signature).toBe(
        '{"types":["boolean","number","string"],"union":["boolean","float64","string"]}',
      );
      const inner = compile(z.union([z.string().nullable(), z.number()]));
      expect(inner.signature).toBe(types[0]!.signature);
      // Opening the inner union is not a way around the overlap rule: two strings are two
      // strings at any depth.
      expect(() =>
        compile(z.union([z.union([z.string(), z.number()]), z.string().max(2)])),
      ).toThrow(/Only nullable, discriminated and type-disjoint JSON Schema unions/);
    });
  });

  describe("a validator that throws instead of returning issues", () => {
    // `z.int().refine((v) => { … })` whose body throws is all it takes, and the raw error
    // escaped all four entry points: a `RangeError` out of functions documented to throw
    // only `EncodeError` or `DecodeError`, so narrowing on the class fell through it.
    const thrower = (thrown: unknown, async = false): EncodableStandardSchema<number, number> =>
      ({
        "~standard": {
          version: 1,
          vendor: "test",
          validate: async
            ? () => Promise.reject(thrown)
            : () => {
                throw thrown;
              },
          jsonSchema: {
            input: () => ({ type: "integer", minimum: 0 }),
            output: () => ({ type: "integer", minimum: 0 }),
          },
        },
      }) as unknown as EncodableStandardSchema<number, number>;

    const boom = new RangeError("the refinement blew up");

    it("reports it as an EncodeError on the way in", () => {
      expect(() => encode(thrower(boom), 5)).toThrow(EncodeError);
      expect(() => encode(thrower(boom), 5)).toThrow("the refinement blew up");
      // `cause` keeps the original, so nothing is lost by changing the class.
      try {
        encode(thrower(boom), 5);
      } catch (error) {
        expect((error as Error).cause).toBe(boom);
      }
      const result = safeEncode(thrower(boom), 5);
      expect(result.success).toBe(false);
      expect(result.success === false && result.error).toBeInstanceOf(EncodeError);
    });

    it("reports it as a DecodeError on the way out", () => {
      const bytes = Uint8Array.of(5);
      expect(() => decode(thrower(boom), bytes)).toThrow(DecodeError);
      const result = safeDecode(thrower(boom), bytes);
      expect(result.success).toBe(false);
      expect(result.success === false && result.error).toBeInstanceOf(DecodeError);
    });

    it("holds for the async entry points, which is where a real vendor reaches it", async () => {
      await expect(encodeAsync(thrower(boom, true), 5)).rejects.toBeInstanceOf(EncodeError);
      await expect(decodeAsync(thrower(boom, true), Uint8Array.of(5))).rejects.toBeInstanceOf(
        DecodeError,
      );
      // `z.object({ n: z.int().refine(async (v) => { throw … }) })` reaches this same path
      // and was how it was found, but it is not asserted here: zod leaves a *second*
      // rejected promise floating that nobody can await: reproducible by calling its
      // `~standard.validate` directly with no shorn in the picture, so the case would add
      // a permanent unhandled rejection to the suite to test code the stub above covers.
    });

    it("survives a thrown value that is not an Error at all", async () => {
      // `message` would be `undefined` and `cause` unreadable, so the class is what has
      // to hold: a caller narrowing on it must not meet a bare string instead.
      for (const thrown of ["a string", 42, null, undefined, Object.create(null)]) {
        expect(() => encode(thrower(thrown), 5)).toThrow(EncodeError);
      }
      await expect(encodeAsync(thrower("a string", true), 5)).rejects.toThrow(
        "The validator threw a value that is not an Error",
      );
    });
  });

  describe("recursive schemas", () => {
    const Node = z.object({
      value: z.string(),
      get children() {
        return z.array(Node);
      },
    });

    it("round-trips a tree through a $ref back to the root", () => {
      const Tree = compile(Node);
      const tree = {
        value: "r",
        children: [
          { value: "a", children: [] },
          { value: "b", children: [{ value: "c", children: [] }] },
        ],
      };
      expect(Tree.decode(Tree.encode(tree))).toEqual(tree);
    });

    it("round-trips a linked list built from a nullable back-edge", () => {
      const Cell = z.object({
        name: z.string(),
        get next() {
          return Cell.nullable();
        },
      });
      const List = compile(Cell);
      let list: unknown = null;
      for (let index = 0; index < 200; index++) list = { name: `n${index}`, next: list };
      expect(List.decode(List.encode(list as never))).toEqual(list);
    });

    it("bounds nesting on both sides rather than the stack", () => {
      const Cell = z.object({
        name: z.string(),
        get next() {
          return Cell.nullable();
        },
      });
      const List = compile(Cell);
      let list: unknown = null;
      for (let index = 0; index < 400; index++) list = { name: "n", next: list };
      expect(() => List.encode(list as never)).toThrow(/nests deeper than 256/);
      // A payload claiming the same depth is refused before it can exhaust the stack.
      const deep = Uint8Array.from([...Array.from({ length: 400 }, () => [1, 0, 1]).flat(), 0]);
      expect(() => List.decode(deep)).toThrow(DecodeError);
    });

    it("still refuses an array of a zero-width element through the cycle", () => {
      // The definition's own width answers this, and one byte is a true lower bound for
      // any cycle a value can actually escape.
      const Tree = compile(Node);
      expect(Tree.encode({ value: "", children: [] })).toHaveLength(2);
    });

    it("compiles a nullable marker over a definition that already holds null", () => {
      // `R | null` where `R` is itself a recursive `R | null`: legal, and a `.nullable()`
      // the caller really did write. It did not compile at all: `nullableOf` cannot see
      // through a back-edge while the cycle is open, so it wrapped a marker that
      // `Schema.nullable()` then refused, blaming the caller for this compiler's byte.
      // The redundant marker comes off where the definition table exists, which is also
      // where the signature is taken, so the fingerprint still matches the bytes.
      const R: z.ZodType = z.lazy(() => z.union([z.null(), z.object({ next: R })]));
      const Wrapped = compile(z.object({ head: R.nullable() }));

      for (const value of [{ head: null }, { head: { next: null } }, { head: { next: { next: null } } }]) {
        expect(Wrapped.decode(Wrapped.encode(value as never))).toEqual(value);
      }
      // One spelling of null, not two: the marker really is gone rather than defaulted.
      const bare = compile(z.object({ head: R }));
      expect([...Wrapped.encode({ head: null } as never)]).toEqual([
        ...bare.encode({ head: null } as never),
      ]);
      expect(fingerprinted(Wrapped).fingerprintHex).toBe(fingerprinted(bare).fingerprintHex);
    });

    it("derives one fingerprint whichever validator wrote the schema", () => {
      // zod points the cycle at the root; valibot inlines the root and emits an identical
      // copy under `$defs`. The two forms differ by an unrolling and must not differ by a
      // fingerprint: validator choice is outside the wire shape.
      const VNode: v.GenericSchema<{ value: string; children: unknown[] }> = v.object({
        value: v.string(),
        children: v.array(v.lazy(() => VNode)),
      });
      const zod = fingerprinted(compile(Node));
      const valibot = fingerprinted(compile(VNode, toStandardJsonSchema(VNode)));
      expect(zod.fingerprintHex).toBe(valibot.fingerprintHex);
      const tree = { value: "r", children: [{ value: "a", children: [] }] };
      expect([...zod.encode(tree)]).toEqual([...valibot.encode(tree as never)]);
    });

    describe("whichever type heads the cycle", () => {
      // Two types referring to each other. The walk numbered a definition wherever it
      // first closed the cycle, and zod's declaration order or valibot's unrolling decides
      // where that is: the same cycle entered at the other type, the same bytes, and a
      // different signature, so a `fingerprinted()` codec refused payloads it could read.
      type TA = { name: string; b?: TB | undefined };
      type TB = { id: number; a?: TA | undefined };
      const A: z.ZodType<TA> = z.object({ name: z.string(), get b() { return B.optional(); } });
      const B: z.ZodType<TB> = z.object({ id: z.int(), get a() { return A.optional(); } });
      const VA: v.GenericSchema<TA> = v.object({ name: v.string(), b: v.optional(v.lazy(() => VB)) });
      const VB: v.GenericSchema<TB> = v.object({
        id: v.pipe(v.number(), v.integer()),
        a: v.optional(v.lazy(() => VA)),
      });
      const pair = { x: { name: "n", b: { id: 1 } }, y: { id: 2, a: { name: "m" } } };

      it("derives one signature whichever field a zod object declares first", () => {
        const xy = compile(z.object({ x: A, y: B }));
        const yx = compile(z.object({ y: B, x: A }));
        expect(yx.signature).toBe(xy.signature);
        expect(fingerprinted(yx).fingerprintHex).toBe(fingerprinted(xy).fingerprintHex);
        // One definition, emitted where a walk from the root in signature order first
        // closes the cycle: at A, reached through `x` before `y` reaches B.
        expect(xy.signature).toBe(
          '{"defs":[{"object":[{"key":"b","optional":true,"value":{"object":[{"key":"a","optional":true,"value":{"ref":0}},{"key":"id","optional":false,"value":"int"}]}},{"key":"name","optional":false,"value":"string"}]}],"root":{"object":[{"key":"x","optional":false,"value":{"ref":0}},{"key":"y","optional":false,"value":{"object":[{"key":"a","optional":true,"value":{"ref":0}},{"key":"id","optional":false,"value":"int"}]}}]}}',
        );
        // The bytes never moved: these are the ones both spellings always wrote.
        expect([...xy.encode(pair)]).toEqual([1, 0, 2, 1, 110, 1, 0, 1, 109, 4]);
        expect([...yx.encode(pair)]).toEqual([...xy.encode(pair)]);
      });

      it("derives one signature whichever validator wrote a mutual recursion", () => {
        type Expr = { op: string; args: Arg[] };
        type Arg = number | { expr: Expr };
        const Expr: z.ZodType<Expr> = z.object({ op: z.string(), get args() { return z.array(Arg); } });
        const Arg: z.ZodType<Arg> = z.union([z.number(), z.object({ get expr() { return Expr; } })]);
        const VExpr: v.GenericSchema<Expr> = v.object({ op: v.string(), args: v.array(v.lazy(() => VArg)) });
        const VArg: v.GenericSchema<Arg> = v.union([v.number(), v.object({ expr: v.lazy(() => VExpr) })]);

        type Employee = { name: string; team: Team | null };
        type Team = { title: string; members: Employee[] };
        const Employee: z.ZodType<Employee> = z.object({ name: z.string(), get team() { return Team.nullable(); } });
        const Team: z.ZodType<Team> = z.object({ title: z.string(), get members() { return z.array(Employee); } });
        const VEmployee: v.GenericSchema<Employee> = v.object({
          name: v.string(),
          team: v.nullable(v.lazy(() => VTeam)),
        });
        const VTeam: v.GenericSchema<Team> = v.object({
          title: v.string(),
          members: v.array(v.lazy(() => VEmployee)),
        });
        const arkAB = scope({ a: { name: "string", "b?": "b" }, b: { id: "number.integer", "a?": "a" } }).export();

        const spellings: ReadonlyArray<readonly [Schema<unknown>[], unknown]> = [
          [
            [
              compile(A),
              compile(VA, toStandardJsonSchema(VA)),
              compile(arkAB.a as unknown as EncodableStandardSchema),
            ],
            pair.x,
          ],
          [[compile(B), compile(VB, toStandardJsonSchema(VB))], pair.y],
          [
            [
              compile(z.object({ x: A, y: B })),
              compile(v.object({ x: VA, y: VB }), toStandardJsonSchema(v.object({ x: VA, y: VB }))),
            ],
            pair,
          ],
          [
            [compile(Expr), compile(VExpr, toStandardJsonSchema(VExpr))],
            { op: "+", args: [1, { expr: { op: "-", args: [2] } }] },
          ],
          [
            [compile(Employee), compile(VEmployee, toStandardJsonSchema(VEmployee))],
            { name: "a", team: { title: "t", members: [{ name: "b", team: null }] } },
          ],
          [
            [compile(Team), compile(VTeam, toStandardJsonSchema(VTeam))],
            { title: "t", members: [{ name: "b", team: null }] },
          ],
        ];
        for (const [codecs, value] of spellings) {
          for (const codec of codecs) {
            expect(codec.signature).toBe(codecs[0]!.signature);
            expect([...codec.encode(value)]).toEqual([...codecs[0]!.encode(value)]);
          }
        }
      });

      it("still compiles a long cycle and a large enum quickly", () => {
        // The refinement's worst case: n links alike but for the last, so a difference
        // travels one link per round. Reading every node every round made this quadratic,
        // as the fold before it was: 400 links took 210 ms here, and 650 ran out of stack.
        const n = 400;
        const chain = {
          $ref: "#/$defs/d0",
          $defs: Object.fromEntries(
            Array.from({ length: n }, (_, i) => [
              `d${i}`,
              {
                type: "object",
                properties:
                  i === n - 1
                    ? { next: { $ref: "#/$defs/d0" }, end: { type: "string" } }
                    : { next: { $ref: `#/$defs/d${i + 1}` } },
              },
            ]),
          ),
        };
        const members = Array.from({ length: 20_000 }, (_, i) => `v${i}`);
        const tagged = {
          type: "object",
          properties: { tag: { enum: members }, children: { type: "array", items: { $ref: "#" } } },
          required: ["tag", "children"],
        };
        const started = performance.now();
        compile(z.unknown(), chain);
        expect(performance.now() - started).toBeLessThan(150);
        const Tagged = compile(z.unknown(), tagged);
        expect(performance.now() - started).toBeLessThan(400);
        expect(Tagged.decode(Tagged.encode({ tag: "v19999", children: [] }))).toEqual({
          tag: "v19999",
          children: [],
        });
      });

      it("refuses references that lead only to each other", () => {
        // `{ "$ref": "#" }` names no schema at all. It compiled to a codec that failed the
        // first time it was used, and it has no node for the minimized graph to hold.
        expect(() => compile(z.unknown(), { $ref: "#" })).toThrow(
          "Unsupported Standard JSON Schema node",
        );
        expect(() =>
          compile(z.unknown(), {
            $ref: "#/$defs/a",
            $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } },
          }),
        ).toThrow("Unsupported Standard JSON Schema node");
      });
    });

    it("leaves a non-recursive schema's signature exactly as it was", () => {
      // The definition table is emitted only when a cycle is found, so a schema without
      // one keeps the signature it always had. This pins the plain two-field shape, and
      // the fingerprint that signature hashes to.
      const Person = compile(z.object({ age: z.int(), name: z.string() }));
      expect(Person.signature).toBe(
        '{"object":[{"key":"age","optional":false,"value":"int"},{"key":"name","optional":false,"value":"string"}]}',
      );
      expect(fingerprinted(Person).fingerprintHex).toBe("e6682f");
    });

    it("inlines a shared subtree instead of making it a definition", () => {
      // Reached twice but never through itself: not recursive, so it keeps the shape and
      // the fingerprint it would have had written out longhand.
      const Leaf = z.object({ x: z.string() });
      const shared = fingerprinted(compile(z.object({ a: Leaf, b: Leaf })));
      const written = fingerprinted(
        compile(z.object({ a: z.object({ x: z.string() }), b: z.object({ x: z.string() }) })),
      );
      expect(shared.fingerprintHex).toBe(written.fingerprintHex);
    });

    it("refuses a $ref that leaves the document, or that points at nothing in it", () => {
      // A document handed in as the structure may have been fetched, and vendors only ever
      // point within the document they wrote, so these two are reachable from a caller's
      // own JSON alone. Following the first would mean fetching mid-build; the second
      // would otherwise fail somewhere deeper, naming neither the pointer nor the fix.
      const structure = (ref: string) => ({
        type: "object",
        properties: { name: { $ref: ref } },
        required: ["name"],
        $defs: { name: { type: "string" } },
      });
      const remote = () => compile(z.any(), structure("https://example.com/name.json"));
      expect(remote).toThrow(EncodeError);
      expect(remote).toThrow(
        'Unsupported JSON Schema reference "https://example.com/name.json"; only same-document references are supported',
      );
      const dangling = () => compile(z.any(), structure("#/$defs/missing"));
      expect(dangling).toThrow(EncodeError);
      expect(dangling).toThrow('JSON Schema reference "#/$defs/missing" does not resolve');
      // The same document with a pointer that resolves compiles, so each refusal above is
      // its pointer's alone.
      expect([...compile(z.any(), structure("#/$defs/name")).encode({ name: "x" })]).toEqual([1, 120]);
    });

    it("composes with a type-disjoint union, including a bare $ref branch", () => {
      // The canonical recursive union: a JSON value. zod types the array and object
      // branches, so their `$ref`s sit inside `items` rather than being the branch.
      const Json: z.ZodType = z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.null(),
        z.array(z.lazy(() => Json)),
        z.record(z.string(), z.lazy(() => Json)),
      ]);
      const Value = compile(Json);
      const value = { a: [1, "x", true, null], b: { c: 2.5 } };
      expect(Value.decode(Value.encode(value))).toEqual(value);

      // And the other spelling, where a branch *is* the whole definition: the type is at
      // the far end of the pointer, so it still names its branch.
      const Cell = z.object({
        v: z.string(),
        get next() {
          return z.union([Cell, z.number(), z.null()]);
        },
      });
      const List = compile(Cell);
      const list = { v: "a", next: { v: "b", next: 3 } };
      expect(List.decode(List.encode(list))).toEqual(list);
    });

    it("does not hang on a value that refers to itself", () => {
      // The path walk descends one level per step, and a cyclic value gives it no bottom.
      // Bounded, so this is an error rather than a hang. `unchecked` because zod's own
      // validator exhausts the stack on a cyclic value before shorn sees it.
      const Cyclic = z.object({
        n: z.string(),
        get self() {
          return Cyclic;
        },
      });
      const value: Record<string, unknown> = { n: "x" };
      value.self = value;
      expect(() => unchecked(Cyclic).encode(value as never)).toThrow(/nests deeper than 256/);
    });

    it("keeps the field path through the recursion", () => {
      // A type error, so this covers the path a validator issue takes; the case below
      // covers the one only the writer refuses. The regex matches the suffix the walk
      // appends rather than the vendor's own issue path, which shorn dot-joins: zod
      // writes `children.0.value` there, which this deliberately does not match.
      const error = safeEncode(Node, {
        value: "r",
        children: [{ value: 1 as never, children: [] }],
      });
      expect(error.success).toBe(false);
      if (!error.success) expect(error.error.message).toMatch(/children\[0\]\.value/);
    });

    it("names every level of the recursion, not only the first", () => {
      // The back-edge is the one walk that runs once per level of the payload, so a drift
      // here truncates rather than vanishes: stubbing its delegation out after one step
      // reported `children[1]`, which reads like an answer. A lone surrogate is the value
      // that reaches the writer at all: a type error carries a validator issue that
      // already names the field, so the message would say `value` either way.
      const result = safeEncode(Node, {
        value: "r",
        children: [
          { value: "a", children: [] },
          {
            value: "b",
            children: [{ value: "c", children: [{ value: "bad\ud800", children: [] }] }],
          },
        ],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const error = result.error as EncodeError;
        expect(error.path).toBe("children[1].children[0].children[0].value");
        expect(error.issues).toBeUndefined();
      }
    });
  });

  describe("error detail", () => {
    const thrown = (act: () => unknown): Error => {
      try {
        act();
      } catch (error) {
        return error as Error;
      }
      throw new Error("expected a throw");
    };

    it("names the failing field through a compiled codec", () => {
      // A lone surrogate is a well-formed JS string, so the validator passes it and
      // only the writer refuses it. Without the delegation this wrapper swallowed
      // the walk and every compiled codec, nearly every codec, lost its path.
      const Note = compile(z.object({ user: z.object({ note: z.string() }) }));
      const error = thrown(() => Note.encode({ user: { note: "\ud800" } })) as EncodeError;
      expect(error.message).toBe("String contains an unpaired surrogate at user.note");
      expect(error.path).toBe("user.note");
    });

    it("takes a validator failure's path from the validator, not from a walk", async () => {
      // The walk re-encoded the value the validator was handed, before it coerced
      // anything, so here it found `a` still a number and blamed it for the error `b`
      // raised: "b: Too big … at a". The issue already knows where it is.
      const Row = z.object({ a: z.coerce.string(), b: z.int().max(3) });
      const coerced = thrown(() => compile(Row).encode({ a: 123, b: 9 } as never)) as EncodeError;
      expect(coerced.path).toBe("b");
      expect(coerced.message).toBe("b: Too big: expected number to be <=3");

      // A refusal of the whole value names no field, where the walk named the first one.
      const Person = z.object({ name: z.string(), age: z.int() });
      const whole = thrown(() => compile(Person).encode([] as never)) as EncodeError;
      expect(whole.path).toBeUndefined();
      expect(whole.message).toBe("Invalid input: expected object, received array");

      // Indexes read as they do for the wire, from every vendor, and async agrees.
      const Tags = z.object({ tags: z.array(z.string()) });
      const sync = thrown(() => compile(Tags).encode({ tags: ["a", 2 as never] })) as EncodeError;
      expect(sync.path).toBe("tags[1]");
      expect(sync.message).toMatch(/^tags\[1\]: /);
      const later = await encodeAsync(Tags, { tags: ["a", 2 as never] }).catch((error) => error);
      expect([later.message, later.path]).toEqual([sync.message, sync.path]);
      const ValibotTags = v.object({ tags: v.array(v.string()) });
      const valibot = thrown(() =>
        compile(ValibotTags, toStandardJsonSchema(ValibotTags)).encode({ tags: ["a", 2 as never] }),
      ) as EncodeError;
      expect(valibot.path).toBe("tags[1]");
      expect(valibot.message).toMatch(/^tags\[1\]: /);
    });

    it("carries the validator's issues alongside the joined message", () => {
      const Person = compile(z.object({ age: z.int().min(18), name: z.string().min(2) }));
      const error = thrown(() => Person.encode({ age: 3, name: "x" })) as EncodeError;
      expect(error.message).toMatch(/^age: .*; name: /);
      expect(error.issues?.map((issue) => issue.path?.join("."))).toEqual(["age", "name"]);
      expect(error.issues).toHaveLength(2);
    });

    it("keeps the issues when validation fails on the way out", () => {
      const Age = compile(z.object({ age: z.int().min(18) }));
      // Encoded by a shape that agrees on the wire and disagrees on the refinement,
      // which is the only way to get bytes a validator will refuse.
      const bytes = m.object({ age: m.int() }).encode({ age: 3 });
      const error = thrown(() => Age.decode(bytes)) as DecodeError;
      expect(error).toBeInstanceOf(DecodeError);
      expect(error.issues?.map((issue) => issue.path?.join("."))).toEqual(["age"]);
      expect(error.cause).toBeInstanceOf(EncodeError);
    });

    it("keeps the vendor's own error reachable behind a type with no wire form", () => {
      // ArkType throws its own error for `undefined`, outside any hook shorn installs.
      const error = thrown(() => compile(type({ when: "undefined" }) as never));
      expect(error.message).toMatch(/convert it at the edge/);
      expect(error.cause).toBeInstanceOf(Error);
    });
  });

  describe("rejects an argument that is not a Standard Schema", () => {
    // Every public entry point funnels through the same guard, so `compile` stands
    // in for all of them; the last case checks one other entry really does share it.
    it("names a raw JSON Schema as the mistake it is", () => {
      expect(() => compile({ type: "object", properties: {} } as never)).toThrow(
        /received a raw JSON Schema/,
      );
      expect(() => compile({ $schema: "https://json-schema.org/draft/2020-12/schema" } as never))
        .toThrow(/received a raw JSON Schema/);
    });

    it("tells an `m` schema to skip the adapter", () => {
      expect(() => compile(m.object({ age: m.uint() }) as never)).toThrow(/already a codec/);
    });

    it("still admits a callable schema, which is how arktype ships one", () => {
      expect(() => compile(arkSchema)).not.toThrow();
    });

    it("reports the type for anything else, without reading ~standard", () => {
      expect(() => compile(null as never)).toThrow(/received null/);
      expect(() => compile("nope" as never)).toThrow(/received string/);
      expect(() => compile(undefined as never)).toThrow(/received undefined/);
      expect(() => compile({} as never)).toThrow(/received object/);
    });

    it("throws EncodeError, not a TypeError, and does so from every entry point", () => {
      expect(() => compile(null as never)).toThrow(EncodeError);
      expect(() => encode({ type: "object" } as never, 1 as never)).toThrow(/raw JSON Schema/);
      // The safe variants too, below: a wrong schema is the program's bug, not a value's.
      expect(() => safeEncode(null as never, 1 as never)).toThrow(EncodeError);
    });

    it("throws a schema error from the safe variants and keeps value errors as results", () => {
      // Compiled lazily, so an unsupported schema first failed inside a request, came back
      // as `{ success: false }`, and the quick start's pattern answered every request
      // with a 400 for what is a bug in the program.
      const Unsupported = z.object({ a: z.undefined() });
      expect(() => safeEncode(Unsupported, { a: undefined })).toThrow(/cannot be represented/);
      expect(() => safeDecode(Unsupported, new Uint8Array([0]))).toThrow(/cannot be represented/);
      // What a caller cannot control stays a result: a bad value, bad bytes, a wrong type.
      const Person = z.object({ name: z.string() });
      expect(safeEncode(Person, { name: 1 as never }).success).toBe(false);
      expect(safeDecode(Person, new Uint8Array([9])).success).toBe(false);
      expect(safeDecode(Person, "nope" as never).success).toBe(false);
    });

    it("takes a codec in the safe variants, as the async ones do", () => {
      // The docs pair `safeDecode` for untrusted input with `fingerprinted(compile(...))`
      // for stored data, and the two could not be combined: a good payload came back
      // `success: false`, "received a shorn schema".
      const Person = z.object({ name: z.string(), age: z.int().nonnegative() });
      const stored = fingerprinted(compile(Person), { bytes: 4 });
      const bytes = stored.encode({ name: "Ada", age: 36 });
      expect(safeDecode(stored, bytes)).toEqual({ success: true, data: { name: "Ada", age: 36 } });
      expect(safeEncode(stored, { name: "Ada", age: 36 })).toEqual({ success: true, data: bytes });
      const other = fingerprinted(compile(z.object({ name: z.string() })), { bytes: 4 });
      const mismatch = safeDecode(other, bytes);
      expect(mismatch.success).toBe(false);
      if (!mismatch.success) expect(mismatch.error).toBeInstanceOf(DecodeError);
    });

    it("gates the structure argument too, naming the remedy rather than a TypeError", () => {
      // The structure wrapped in an options object, a `~standard` with no JSON Schema
      // half, a number: each used to surface as "Cannot read properties of undefined
      // (reading 'jsonSchema')" wrapped in a remedy that pointed away from the fix. A
      // plain JSON Schema is no longer among them, since it is now a form the argument
      // takes.
      const valibotSchema = v.object({ n: v.pipe(v.number(), v.integer()) });
      const structure = toStandardJsonSchema(valibotSchema);
      for (const wrong of [{ structure }, { "~standard": {} }, 42, null]) {
        expect(() => compile(valibotSchema, wrong as never)).toThrow(
          /second argument must be a Standard JSON Schema implementation/,
        );
      }
      expect(() => compile(valibotSchema, structure)).not.toThrow();
      expect(() => compile(valibotSchema, { type: "object" })).not.toThrow();
    });
  });

  describe("unchecked", () => {
    it("writes the bytes the validating codec writes", () => {
      expect([...unchecked(zodSchema).encode(value)]).toEqual([...encode(zodSchema, value)]);
      expect(unchecked(zodSchema).decode(encode(zodSchema, value))).toEqual(value);
    });

    it("runs no refinement, on either side", () => {
      const Age = z.object({ age: z.int().nonnegative() });
      expect(() => encode(Age, { age: -1 })).toThrow(EncodeError);

      // Uint would refuse a negative, so the refinement being skipped has to be one the
      // wire can carry: a bound the validator holds and the byte layout does not.
      const bytes = unchecked(z.object({ age: z.int().max(3) })).encode({ age: 250 });
      expect(unchecked(z.object({ age: z.int().max(3) })).decode(bytes)).toEqual({ age: 250 });
      expect(() => decode(z.object({ age: z.int().max(3) }), bytes)).toThrow(DecodeError);
    });

    it("skips the validator's transforms too, not only its checks", () => {
      const Name = z.object({ name: z.string().trim() });
      expect(decode(Name, encode(Name, { name: " x " }))).toEqual({ name: "x" });
      expect(unchecked(Name).decode(unchecked(Name).encode({ name: " x " }))).toEqual({
        name: " x ",
      });
    });

    it("still refuses malformed bytes, since the structural half does that", () => {
      const bytes = encode(zodSchema, value);
      expect(() => unchecked(zodSchema).decode(bytes.subarray(0, 3))).toThrow(DecodeError);
    });

    it("keeps a fingerprint envelope, and its mismatch check", () => {
      const framed = fingerprinted(compile(zodSchema));
      const bare = unchecked(framed);
      expect([...bare.encode(value)]).toEqual([...framed.encode(value)]);
      expect(() => bare.decode(encode(zodSchema, value))).toThrow(/different schema/);
    });

    it("is cached with the codec, so a per-message call is a lookup", () => {
      expect(unchecked(zodSchema)).toBe(unchecked(zodSchema));
    });

    it("refuses a codec that has no validator to remove", () => {
      expect(() => unchecked(m.string())).toThrow(/already unvalidated/);
      // Handing this one back unchanged would keep validating under a name that
      // promises it does not.
      expect(() => unchecked(compile(zodSchema).nullable())).toThrow(/validator to remove/);
    });
  });
});
