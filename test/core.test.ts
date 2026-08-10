import { describe, expect, it } from "vitest";
import { DecodeError, EncodeError, m } from "../src/index.js";

describe("shorn core", () => {
  const Person = m.object({
    name: m.string(),
    age: m.uint(),
    sex: m.enum(["M", "F", "X"]),
  });

  it("encodes a record without keys or type tags", () => {
    const value = { name: "Rahul", age: 25, sex: "M" as const };
    const encoded = Person.encode(value);

    expect([...encoded]).toEqual([25, 5, 82, 97, 104, 117, 108, 1]);
    expect(encoded).toHaveLength(8);
    expect(Person.decode(encoded)).toEqual(value);
  });

  it("uses a presence bitmap for optional fields", () => {
    const User = m.object({
      id: m.uint(),
      nickname: m.string().optional(),
      email: m.string().optional(),
    });

    const encoded = User.encode({ id: 7, email: "a@b.co" });
    expect(encoded[0]).toBe(0b01);
    expect(User.decode(encoded)).toEqual({ id: 7, email: "a@b.co" });
  });

  it("reads each optional property only once", () => {
    const Value = m.object({ name: m.string().optional() });
    let reads = 0;
    const input = Object.defineProperty({}, "name", {
      enumerable: true,
      get: () => {
        reads++;
        return "Rahul";
      },
    }) as { name?: string };

    expect(Value.decode(Value.encode(input))).toEqual({ name: "Rahul" });
    expect(reads).toBe(1);
  });

  it("round-trips nested collections and signed integers", () => {
    const Payload = m.object({
      values: m.array(m.int()),
      point: m.tuple([m.float32(), m.float32()]),
      note: m.string().nullable(),
    });
    const value = { values: [-2, 0, 42], point: [1.5, -2.25] as [number, number], note: null };

    expect(Payload.decode(Payload.encode(value))).toEqual(value);
  });

  it("supports the full JavaScript safe-integer range", () => {
    const Integer = m.int();
    for (const value of [
      Number.MIN_SAFE_INTEGER,
      -4_503_599_627_370_497,
      -4_503_599_627_370_496,
      -1,
      0,
      1,
      4_503_599_627_370_495,
      4_503_599_627_370_496,
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(Integer.decode(Integer.encode(value))).toBe(value);
    }
  });

  it("supports unsigned safe integers and Unicode strings", () => {
    const Value = m.object({ count: m.uint(), text: m.string() });
    const value = { count: Number.MAX_SAFE_INTEGER, text: "Grüße 👋 राहुल" };

    expect(Value.decode(Value.encode(value))).toEqual(value);
  });

  // The encoder switches from a charCode loop to encodeInto partway up, and the
  // decoder from fromCharCode to TextDecoder. Both crossovers are tuning constants,
  // so every length either side of both is walked rather than sampled.
  it("round-trips ASCII across the encoder and decoder length crossovers", () => {
    for (let length = 0; length <= 24; length++) {
      const value = "abcdefghij".repeat(3).slice(0, length);
      const encoded = m.string().encode(value);
      expect(encoded).toHaveLength(length + 1);
      expect(m.string().decode(encoded)).toBe(value);
    }
  });

  it("rejects malformed UTF-8 rather than substituting a replacement character", () => {
    // The decode path prefers Node's `utf8Slice`, which substitutes U+FFFD where
    // `TextDecoder` throws. A malformed payload must still throw, so the substitution
    // has to be caught and re-decided by the fatal decoder rather than returned.
    for (const bad of [
      [0xff],
      [0xfe, 0xfe],
      [0x61, 0xff, 0x62],
      [0xc3], // truncated two-byte sequence
      [0xe2, 0x82], // truncated three-byte sequence
      [0xed, 0xa0, 0x80], // surrogate half encoded as UTF-8
    ]) {
      const payload = new Uint8Array([bad.length, ...bad]);
      expect(() => m.string().decode(payload)).toThrow(/Invalid UTF-8/);
    }
  });

  it("returns a legitimately encoded replacement character instead of rejecting it", () => {
    // The mirror of the case above, and the reason the guard re-decodes rather than
    // throwing on sight: U+FFFD is a perfectly ordinary character, and a payload that
    // really contains one is well formed.
    for (const value of ["�", `a�b`, "�".repeat(40), `${"x".repeat(50)}�`]) {
      expect(m.string().decode(m.string().encode(value))).toBe(value);
    }
  });

  it("rejects unpaired UTF-16 surrogates instead of changing the string", () => {
    expect(() => m.string().encode("\ud800")).toThrow(/unpaired surrogate/);
    expect(() => m.string().encode("\udc00")).toThrow(/unpaired surrogate/);
    // After an ASCII prefix the one-pass writer has already copied bytes and has to
    // rewind into the general path, which is what still raises this.
    expect(() => m.string().encode(`${"a".repeat(100)}\ud800`)).toThrow(/unpaired surrogate/);
  });

  it("writes the same bytes either side of the one-pass ASCII gate", () => {
    const encoder = new TextEncoder();
    // 127 is the last length whose UTF-8 size varint is one byte, so it is the last
    // one the speculative path can write before confirming the string is ASCII.
    for (const length of [0, 1, 126, 127, 128, 129, 200]) {
      const value = "x".repeat(length);
      const encoded = m.string().encode(value);
      expect([...encoded.subarray(length < 128 ? 1 : 2)]).toEqual([...encoder.encode(value)]);
      expect(m.string().decode(encoded)).toBe(value);
    }
    // Non-ASCII in the last position: the speculative walk gets all the way to the
    // end before it has to rewind.
    for (const length of [0, 126, 127]) {
      const value = `${"x".repeat(length)}ü`;
      expect(m.string().decode(m.string().encode(value))).toBe(value);
    }
  });

  it("returns decoded byte arrays independently from the encoded input", () => {
    const Bytes = m.bytes();
    const encoded = Bytes.encode(Uint8Array.of(1, 2, 3));
    const decoded = Bytes.decode(encoded);
    encoded[1] = 9;
    expect([...decoded]).toEqual([1, 2, 3]);
  });

  it("uses an array's declared length rather than a custom iterator", () => {
    const value = [1, 2] as number[] & { [Symbol.iterator](): Iterator<number> };
    value[Symbol.iterator] = function* () {
      yield 9;
    } as never;
    const Values = m.array(m.uint());

    expect(Values.decode(Values.encode(value))).toEqual([1, 2]);
  });

  it("rejects truncated and trailing data", () => {
    const encoded = Person.encode({ name: "Rahul", age: 25, sex: "M" });
    for (let length = 0; length < encoded.length; length++) {
      expect(() => Person.decode(encoded.slice(0, length))).toThrow(DecodeError);
    }
    expect(() => Person.decode(Uint8Array.from([...encoded, 0]))).toThrow(/trailing data/);
  });

  it("rejects malformed primitive and collection encodings", () => {
    expect(() => m.boolean().decode(Uint8Array.of(2))).toThrow(/Invalid boolean/);
    expect(() => m.enum(["A", "B"]).decode(Uint8Array.of(2))).toThrow(/Unknown enum index/);

    const oversizedLength = m.uint().encode(1_000_001);
    expect(() => m.array(m.uint()).decode(oversizedLength)).toThrow(/Array length .* exceeds/);
    expect(() => m.string().decode(Uint8Array.of(2, 0xc3, 0x28))).toThrow(DecodeError);
    expect(() => m.uint().decode(Uint8Array.of(0x80, 0))).toThrow(/Non-canonical/);
    expect(() => m.int().decode(Uint8Array.of(0x80, 0))).toThrow(/Non-canonical/);
  });

  it("refuses enum members JSON cannot tell apart", () => {
    // NaN and both infinities stringify to `null`, so ordering a mixed enum by JSON
    // text would collapse them onto each other and onto a real null member.
    expect(() => m.enum([NaN, null])).toThrow(/no JSON text of its own/);
    expect(() => m.enum([Infinity, -Infinity, null])).toThrow(/no JSON text of its own/);
    expect(() => m.enum([1, Infinity])).toThrow(/no JSON text of its own/);

    // `-0` is the quiet one: it survives the trip as `0`, so the member that comes
    // back is not the member that was declared.
    expect(() => m.enum([-0, 1])).toThrow(/Enum member -0/);

    // Finite mixed members are unaffected, and each still round-trips to itself.
    const members = [200, "ok", null, false] as const;
    const Mixed = m.enum(members);
    for (const value of members) {
      expect(Mixed.decode(Mixed.encode(value))).toBe(value);
    }
  });

  it("matches a literal by identity, so NaN and -0 literals survive their own decode", () => {
    // `===` here refused the only value a NaN literal decodes to, and let a `-0`
    // literal accept the `+0` it could never give back.
    const nan = m.literal(NaN);
    expect(nan.encode(NaN)).toHaveLength(0);
    expect(Number.isNaN(nan.decode(new Uint8Array(0)))).toBe(true);

    const negativeZero = m.literal(-0);
    expect(Object.is(negativeZero.decode(negativeZero.encode(-0)), -0)).toBe(true);
    expect(() => negativeZero.encode(0)).toThrow(EncodeError);
    expect(() => m.literal(0).encode(-0)).toThrow(EncodeError);
  });

  it("snapshots mutable enum and tuple declarations", () => {
    const enumValues: [string, string] = ["A", "B"];
    const tupleItems = [m.string(), m.uint()] as const as unknown as [
      ReturnType<typeof m.string>,
      ReturnType<typeof m.uint>,
    ];
    const Enum = m.enum(enumValues);
    const Tuple = m.tuple(tupleItems);

    enumValues[0] = "B";
    tupleItems.reverse();

    expect(Enum.decode(Enum.encode("A"))).toBe("A");
    expect(Tuple.decode(Tuple.encode(["x", 1]))).toEqual(["x", 1]);
  });

  it("decodes __proto__ as an own data property", () => {
    const shape = { ["__proto__"]: m.string() };
    const Value = m.object(shape);
    const input = Object.defineProperty({}, "__proto__", {
      enumerable: true,
      value: "safe",
    }) as { __proto__: string };

    const decoded = Value.decode(Value.encode(input));
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.hasOwn(decoded, "__proto__")).toBe(true);
    expect(decoded.__proto__).toBe("safe");
  });

  // An absent optional named like an `Object.prototype` member has to read back as
  // undefined rather than the inherited function, without the decoded value turning
  // into something a caller cannot use.
  it("keeps a decoded record usable when an inheritable optional is absent", () => {
    const Value = m.object({ hasOwnProperty: m.string().optional(), id: m.uint() });
    const decoded = Value.decode(Value.encode({ id: 1 } as never)) as Record<string, unknown>;

    expect(decoded.hasOwnProperty).toBeUndefined();
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(decoded instanceof Object).toBe(true);
    expect(String(decoded)).toBe("[object Object]");
    expect(Object.keys(decoded)).toEqual(["id"]);
    expect(JSON.stringify(decoded)).toBe('{"id":1}');
    expect(decoded).toEqual({ id: 1 });
  });

  // A field named `toString` is the one case no shadowing can rescue: the schema
  // declares it a string, so an absent optional has to read as undefined, and an
  // undefined `toString` is not callable whatever the prototype is. The rest of
  // `Object.prototype` still survives, which is the part that used to be lost.
  it("keeps the rest of the prototype when the absent optional is toString itself", () => {
    const Value = m.object({ toString: m.string().optional(), id: m.uint() });
    const decoded = Value.decode(Value.encode({ id: 1 } as never)) as Record<string, unknown>;

    expect(decoded.toString).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(decoded, "id")).toBe(true);
    expect(decoded instanceof Object).toBe(true);
    expect(() => String(decoded)).toThrow(TypeError);
  });

  it("keeps an inheritable optional a fixed point when it is present", () => {
    const Value = m.object({ toString: m.string().optional(), id: m.uint() });
    for (const input of [{ id: 1 }, { toString: "given", id: 2 }]) {
      const once = Value.encode(input as never);
      expect([...Value.encode(Value.decode(once) as never)]).toEqual([...once]);
      expect(Value.decode(once)).toEqual(input);
    }
  });

  it("does not return oversized backing buffers", () => {
    const encoded = m.bytes().encode(new Uint8Array(1_100_000));
    expect(encoded.buffer.byteLength).toBe(encoded.byteLength);
  });

  // `encode` reuses one Writer across calls, so everything below is about the
  // buffer that reuse shares: aliasing between payloads, a nested encode taking
  // the slot, a dirty offset left by a throw, and a grown buffer never released.
  // All four are free with a fresh Writer per call and have to be paid for here.
  describe("the shared encode buffer", () => {
    it("does not let one encoded payload alias the next", () => {
      const first = Person.encode({ name: "Rahul", age: 25, sex: "M" });
      const second = Person.encode({ name: "Ada", age: 36, sex: "F" });

      expect([...first]).toEqual([25, 5, 82, 97, 104, 117, 108, 1]);
      expect(first.buffer).not.toBe(second.buffer);
    });

    it("survives an encode reached from inside another encode", () => {
      const Wrapper = m.object({ inner: m.bytes(), tag: m.string() });
      // A getter is the realistic way this happens: the caller's object computes a
      // field, and computing it encodes something else with the Writer already held.
      const value = {
        tag: "outer",
        get inner() {
          return Person.encode({ name: "Ada", age: 36, sex: "F" });
        },
      };

      expect(Wrapper.decode(Wrapper.encode(value))).toEqual({
        inner: Person.encode({ name: "Ada", age: 36, sex: "F" }),
        tag: "outer",
      });
    });

    it("keeps encoding correctly after an encode throws", () => {
      expect(() => Person.encode({ name: 1 as never, age: 25, sex: "M" })).toThrow();
      expect([...Person.encode({ name: "Rahul", age: 25, sex: "M" })]).toEqual([
        25, 5, 82, 97, 104, 117, 108, 1,
      ]);
    });

    it("releases a buffer grown by one oversized payload", () => {
      m.bytes().encode(new Uint8Array(1_100_000));
      // The next small encode must not still be sitting on the megabyte buffer.
      expect(m.bytes().encode(new Uint8Array(4)).byteLength).toBe(5);
      expect(Person.encode({ name: "Rahul", age: 25, sex: "M" })).toHaveLength(8);
    });
  });

  // An object schema with no optionals compiles its record decoder with
  // `new Function`, so a Content Security Policy without `unsafe-eval` sends
  // every such schema down the interpreted path instead. That path is now
  // unreachable in a normal run and would rot silently without this.
  describe("without new Function, as under a strict CSP", () => {
    function buildUnderCsp<T>(build: () => T): T {
      const realFunction = globalThis.Function;
      globalThis.Function = new Proxy(realFunction, {
        construct() {
          throw new EvalError("Refused to evaluate a string as JavaScript");
        },
      }) as FunctionConstructor;
      try {
        return build();
      } finally {
        globalThis.Function = realFunction;
      }
    }

    const shape = () =>
      m.object({
        active: m.boolean(),
        actor: m.object({ age: m.uint(), name: m.string() }),
        tags: m.array(m.string()),
      });
    const value = { active: true, actor: { age: 25, name: "Rahul" }, tags: ["api", "edge"] };

    it("agrees with the generated path on the wire, in both directions", () => {
      const interpreted = buildUnderCsp(shape);
      const generated = shape();

      expect([...interpreted.encode(value)]).toEqual([...generated.encode(value)]);
      expect(interpreted.decode(generated.encode(value))).toEqual(value);
      expect(generated.decode(interpreted.encode(value))).toEqual(value);
    });

    it("names the failing field on both paths", () => {
      const bad = { ...value, actor: { age: "old" as never, name: "Rahul" } };
      expect(() => buildUnderCsp(shape).encode(bad)).toThrow("at actor.age");
      expect(() => shape().encode(bad)).toThrow("at actor.age");
    });
  });

  describe("error paths", () => {
    it("names a missing required field rather than only its type", () => {
      const schema = m.object({ age: m.uint(), name: m.string() });
      expect(() => schema.encode({ name: "Ada" } as never)).toThrow(
        "Expected an unsigned safe integer, received undefined at age",
      );
    });

    it("walks into nested objects", () => {
      const schema = m.object({ user: m.object({ address: m.object({ zip: m.uint() }) }) });
      expect(() => schema.encode({ user: { address: { zip: "90210" as never } } })).toThrow(
        "at user.address.zip",
      );
    });

    it("indexes arrays and tuples, and joins an index to the key before it", () => {
      expect(() => m.array(m.uint()).encode([1, "x" as never, 3])).toThrow("at [1]");
      expect(() => m.tuple([m.uint(), m.string()]).encode([1, 2 as never])).toThrow("at [1]");
      expect(() =>
        m.object({ tags: m.array(m.object({ id: m.uint() })) }).encode({
          tags: [{ id: 1 }, { id: "x" as never }],
        }),
      ).toThrow("at tags[1].id");
    });

    it("locates a field behind a presence bitmap", () => {
      const schema = m.object({ note: m.string().optional(), zip: m.uint() });
      expect(() => schema.encode({ note: 5 as never, zip: 1 })).toThrow("at note");
    });

    it("leaves the message unqualified when no single field is at fault", () => {
      const error = (() => {
        try {
          m.object({ a: m.uint() }).encode("nope" as never);
        } catch (thrown) {
          return thrown as EncodeError;
        }
        throw new Error("expected a throw");
      })();
      expect(error.message).toBe("Expected an object");
      expect(error.path).toBeUndefined();
    });

    it("reads an absent optional back as undefined even when named like a prototype member", () => {
      // Found by the generated corpus in `compile-property.test.ts`. The decoder built
      // its record as `{}`, so an optional the payload does not carry was inherited
      // from `Object.prototype` instead of absent: `toString` came back as a function.
      // `toEqual` cannot see it — an inherited member is not an own key — which is why
      // the existing round-trip properties passed straight through it.
      const schema = m.object({
        toString: m.string().optional(),
        constructor: m.uint().optional(),
        zip: m.uint(),
      });
      // The casts are the same hazard one level up: in an object literal type
      // `toString` resolves to the inherited `() => string`, so TypeScript refuses
      // the very shape the schema declares.
      const decoded = schema.decode(schema.encode({ zip: 1 } as never)) as Record<string, unknown>;
      expect(decoded.toString).toBeUndefined();
      expect(decoded.constructor).toBeUndefined();
      // `in` walks the whole chain, so it can only report false if nothing in that
      // chain carries the key — which is to say, only if the record has a null
      // prototype. That is what this used to assert, and the prototype it cost made
      // the decoded value throw on `String()`, lose `hasOwnProperty` and fail
      // `instanceof Object`. Shadowing with an own `undefined` keeps the record
      // usable and gives up this one reading; see the test below for what it buys.
      expect("toString" in decoded).toBe(true);
      expect(Object.keys(decoded)).toEqual(["zip"]);
      // Present values still shadow correctly, and the round trip stays canonical.
      const full = { constructor: 2, toString: "t", zip: 1 };
      expect(schema.decode(schema.encode(full))).toEqual(full);
    });

    it("appends the path exactly once through a re-entrant encode", () => {
      const inner = m.object({ zip: m.uint() });
      const outer = m.object({ tag: m.string(), user: m.object({ zip: m.uint() }) });
      expect(() =>
        outer.encode({
          get tag(): string {
            return String(inner.encode({ zip: 1 }).length);
          },
          user: { zip: "90210" as never },
        }),
      ).toThrow(/at user\.zip$/);
    });
  });
});
