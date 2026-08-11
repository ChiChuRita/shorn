import { runInNewContext } from "node:vm";
import { type } from "arktype";
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
  safeEncode,
  unchecked,
} from "../src/index.js";

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
      // Valid to the validator, which accepts either case — and still refused,
      // because 16 bytes cannot remember which case they were written in.
      expect(z.uuid().safeParse(uuid.toUpperCase()).success).toBe(true);
      expect(() => compile(z.uuid()).encode(uuid.toUpperCase())).toThrow(/Expected a lowercase UUID/);
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

      // The payload, not the schema, chooses the depth here — which is what makes a
      // limit necessary at all — so a hostile one must land on a DecodeError rather
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
      // Fixed part bare, then a count for the rest — so an empty rest costs one byte.
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
      // payloads — value in the field, value in the tail — would decode alike.
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
      expect(() => compile(z.intersection(z.object({ a: z.string() }), z.object({ b: z.int() }))))
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
      // nothing — and refusing to add it surfaced as "already decodes to null", which read
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

      // The nested case never threw — `Schema.nullable()` collapses a repeated marker — but
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

  // Rich types are the validator's job; shorn encodes the wire shape.
  // What is pinned here is that the caller is told so, rather than being handed the
  // vendor's bare "cannot be represented in JSON Schema" with no way forward.
  it("keeps the vendor's reason and names the remedy for types JSON Schema lacks", () => {
    for (const schema of [
      z.object({ v: z.date() }),
      z.object({ v: z.bigint() }),
      z.object({ v: z.map(z.string(), z.number()) }),
      z.object({ v: z.set(z.string()) }),
    ]) {
      expect(() => compile(schema)).toThrow(EncodeError);
      expect(() => compile(schema)).toThrow(/cannot be represented in JSON Schema/);
      expect(() => compile(schema)).toThrow(/convert rich types at the edge/);
    }
  });

  // The pairing the error points at, proven end to end: zod owns rich <-> wire via
  // z.codec, shorn owns wire <-> bytes. Nothing in shorn knows about Date or bigint.
  it("round-trips rich types when the validator converts at the edge", () => {
    const Rich = z.object({
      when: z.codec(z.iso.datetime(), z.date(), {
        decode: (text) => new Date(text),
        encode: (date) => date.toISOString(),
      }),
      id: z.codec(z.string(), z.bigint(), {
        decode: (text) => BigInt(text),
        encode: (big) => big.toString(),
      }),
    });
    const Wire = z.object({ when: z.iso.datetime(), id: z.string() });
    const wire = compile(Wire);

    const original = { when: new Date("2026-08-07T10:00:00.000Z"), id: 9007199254740993n };
    const restored = z.decode(Rich, wire.decode(wire.encode(z.encode(Rich, original))));

    expect(restored.when).toBeInstanceOf(Date);
    expect(restored.when.toISOString()).toBe(original.when.toISOString());
    // Past Number.MAX_SAFE_INTEGER, so this fails if anything routes through a number.
    expect(restored.id).toBe(9007199254740993n);
  });

  it("refuses an extra property only where the schema left nowhere to put it", () => {
    // An open object has somewhere: `additionalProperties` names the value type, so
    // the extras are written after the declared fields. ArkType emits no
    // `additionalProperties` at all, which is a closed object with no tail — the one
    // case where an extra can only be dropped, so it is refused instead.
    expect(() => compile(arkSchema).encode({ ...value, extra: true } as never)).toThrow(
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

  describe("unions with no discriminant", () => {
    it("dispatches on the JSON type when no two branches share one", () => {
      const Value = compile(z.union([z.string(), z.number()]));
      // Ordered by type name, so `number` is index 0 and `string` is index 1 whichever
      // way the schema listed them.
      expect([...Value.encode("hi")]).toEqual([1, 2, 104, 105]);
      expect(Value.decode(Value.encode("hi"))).toBe("hi");
      expect(Value.decode(Value.encode(42))).toBe(42);
    });

    it("costs the one index byte a discriminated union costs", () => {
      const Value = compile(z.union([z.literal("a"), z.literal(3)]));
      // Both branches are literals, so the index is the entire payload.
      expect([...Value.encode("a")]).toEqual([1]);
      expect([...Value.encode(3)]).toEqual([0]);
      expect(Value.decode(Value.encode(3))).toBe(3);
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
      // spellings — `.optional()` is the wrapper that still says something new.
      const Value = compile(z.object({ v: z.union([z.string(), z.number(), z.null()]).optional() }));
      expect(Value.decode(Value.encode({ v: null }))).toEqual({ v: null });
      expect(Value.decode(Value.encode({}))).toEqual({});
      expect(() => compile(z.union([z.string(), z.number(), z.null()])).nullable()).toThrow(
        /already decodes to null/,
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

    it("derives one fingerprint whichever validator wrote the schema", () => {
      // zod points the cycle at the root; valibot inlines the root and emits an identical
      // copy under `$defs`. The two forms differ by an unrolling and must not differ by a
      // fingerprint — validator choice is outside the wire shape.
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

    it("leaves a non-recursive schema's signature exactly as it was", () => {
      // The definition table is emitted only when a cycle is found, so no existing
      // fingerprint moves. This pins the plain three-field shape.
      const Person = fingerprinted(compile(z.object({ age: z.int(), name: z.string() })));
      expect(Person.fingerprintHex).toBe("fee99f");
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
      const Tree = compile(Node);
      const error = safeEncode(Node, {
        value: "r",
        children: [{ value: 1 as never, children: [] }],
      });
      expect(error.success).toBe(false);
      expect(Tree).toBeDefined();
      if (!error.success) expect(error.error.message).toMatch(/children\[0\]\.value/);
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
      // the walk and every compiled codec — nearly every codec — lost its path.
      const Note = compile(z.object({ user: z.object({ note: z.string() }) }));
      const error = thrown(() => Note.encode({ user: { note: "\ud800" } })) as EncodeError;
      expect(error.message).toBe("String contains an unpaired surrogate at user.note");
      expect(error.path).toBe("user.note");
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

    it("keeps the vendor's own error reachable behind a rich type", () => {
      const error = thrown(() => compile(z.object({ when: z.date() }) as never));
      expect(error.message).toMatch(/convert rich types at the edge/);
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
      expect(safeEncode(null as never, 1 as never)).toMatchObject({ success: false });
    });

    it("gates the structure argument too, naming the remedy rather than a TypeError", () => {
      // A raw JSON Schema, or the structure wrapped in an options object — either
      // used to surface as "Cannot read properties of undefined (reading
      // 'jsonSchema')" wrapped in the rich-types remedy, which points away from
      // the fix.
      const valibotSchema = v.object({ n: v.pipe(v.number(), v.integer()) });
      const structure = toStandardJsonSchema(valibotSchema);
      for (const wrong of [{ structure }, { type: "object" }, 42]) {
        expect(() => compile(valibotSchema, wrong as never)).toThrow(
          /second argument must be a Standard JSON Schema implementation/,
        );
      }
      expect(() => compile(valibotSchema, structure)).not.toThrow();
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
