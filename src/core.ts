import type { StandardSchemaV1 } from "@standard-schema/spec";

const MAX_COLLECTION_LENGTH = 1_000_000;
const ASCII_FAST_PATH_LIMIT = 8;
/** Floats one `Reader` must read before a `DataView` over the input pays for itself. */
const FLOAT_VIEW_TRIP = 8;
const MAX_BYTE_LENGTH = 64 * 1024 * 1024;
const MAX_RETAINED_BUFFER_BYTES = 64 * 1024;
const SLICE_COPY_LIMIT = 16;

/**
 * The one total order behind every canonical wire decision. UTF-16 code-unit order,
 * identical to `Array.prototype.sort`'s default comparator — swapping in
 * `localeCompare`, `Intl.Collator`, code points or case folding changes the bytes of
 * every object and every string enum. Named members only; tuple and array elements
 * are positional.
 */
export function canonicalKeyOrder(keys: readonly string[]): string[] {
  return [...keys].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Every scalar an `enum` member may be. JSON Schema allows no others. */
export type EnumValue = string | number | boolean | null;

/**
 * Enum index order. All-string enums keep `canonicalKeyOrder`, which is the order
 * every payload ever written was indexed by. A mixed or non-string enum has no bytes
 * to preserve and no total order under `<`, so it orders by JSON text instead.
 */
export function canonicalEnumOrder(values: readonly EnumValue[]): EnumValue[] {
  if (values.every((value) => typeof value === "string")) return canonicalKeyOrder(values);
  for (const value of values) {
    // A member has to survive its own JSON text. `JSON.stringify` writes NaN and both
    // infinities as `null` and `-0` as `0`, so each would decode back as a different
    // value than was declared. Refused rather than reordered — JSON Schema cannot
    // express them either.
    if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
      throw new EncodeError(
        `Enum member ${Object.is(value, -0) ? "-0" : String(value)} has no JSON text of its own`,
      );
    }
  }
  return canonicalKeyOrder(values.map((value) => JSON.stringify(value))).map(
    (json) => JSON.parse(json) as EnumValue,
  );
}

/**
 * Realm-tolerant `Uint8Array` test — `instanceof` fails for bytes from a `node:vm`
 * context, an iframe, a worker or jsdom. Shared by `Schema.decode` and
 * `BytesSchema._encode`, which once disagreed: a payload could be read in one realm
 * and not written back.
 */
function isUint8Array(value: unknown): value is Uint8Array {
  return (
    value instanceof Uint8Array ||
    Object.prototype.toString.call(value) === "[object Uint8Array]"
  );
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/**
 * One eight-byte staging buffer for reading floats. A Reader is built per `decode()`,
 * so a DataView of its own could never be reused and constructing one profiled at 13%
 * of a float-carrying decode. DataView rather than Float64Array keeps little-endian
 * wire order on big-endian hosts. Safe to share: every use copies in and reads out
 * with no await between.
 */
const floatScratch = new ArrayBuffer(8);
const floatBytes = new Uint8Array(floatScratch);
const floatView = new DataView(floatScratch);

export class EncodeError extends Error {
  override readonly name = "EncodeError";

  /**
   * Field path to the value that failed — `user.address.zip`, `tags[3]`. Appended to
   * the message once, at the top, by `Schema.encode`, so throwing from a leaf costs
   * nothing.
   */
  path?: string | undefined;

  /**
   * The validator's own issues, when the failure came from one rather than the wire.
   * `message` holds these joined by `; `; this is the same information unflattened,
   * so a field-keyed 400 needs no second validator run.
   */
  issues?: readonly StandardSchemaV1.Issue[] | undefined;
}

// Exported so `StandardBackedSchema` and `FingerprintedSchema` can name it in their
// declaration files. Internal machinery, not re-exported from `index.ts`.
export interface FailingChild {
  readonly segment: string;
  readonly schema: Schema<unknown>;
  readonly value: unknown;
}

/**
 * Walks down to the value that failed, re-encoding into a throwaway Writer at each
 * step, after an encode has already thrown. This is why no `_encode` carries a
 * `try`/`catch`: wrapping `ArraySchema`'s element loop in one measured **-37%** on a
 * 500-element array with several schemas loaded, since a catch blocks optimization of
 * an already-megamorphic call site. Getters are evaluated more than once here.
 */
function encodePath(schema: Schema<unknown>, value: unknown): string | undefined {
  let path = "";
  let node = schema;
  let current = value;
  try {
    for (;;) {
      const child: FailingChild | undefined = node._failingChild(current);
      if (child === undefined) break;
      path =
        path === "" || child.segment.startsWith("[")
          ? path + child.segment
          : `${path}.${child.segment}`;
      node = child.schema;
      current = child.value;
    }
  } catch {
    // The walk is cosmetic and re-reads the caller's value, so a getter or a proxy
    // trap that throws only on the second read would otherwise escape from here and
    // replace the encode failure with its own — the caller would see the getter's
    // RangeError instead of the EncodeError that says which field is wrong. Keep
    // whatever path was found and let the real error through.
  }
  return path === "" ? undefined : path;
}

/**
 * Folds the path into the message. `path` doubles as the done-marker, so a re-entrant
 * encode cannot append a second, less precise path over the first.
 */
function withPath(error: unknown, schema: Schema<unknown>, value: unknown): unknown {
  if (!(error instanceof EncodeError) || error.path !== undefined) return error;
  const path = encodePath(schema, value);
  if (path === undefined) return error;
  error.path = path;
  error.message = `${error.message} at ${path}`;
  return error;
}

export class DecodeError extends Error {
  override readonly name = "DecodeError";

  /** Set only when the bytes decoded cleanly and the validator then rejected. */
  issues?: readonly StandardSchemaV1.Issue[] | undefined;

  constructor(message: string, readonly offset: number, options?: ErrorOptions) {
    super(`${message} at byte ${offset}`, options);
  }
}

export class Writer {
  private buffer = new Uint8Array(64);
  private offset = 0;

  /**
   * Built on first float, discarded when the buffer moves — a schema with no float
   * field would otherwise pay for a DataView on every encode.
   */
  private view: DataView | undefined;

  private ensure(size: number): void {
    const required = this.offset + size;
    if (required <= this.buffer.length) return;

    let capacity = this.buffer.length;
    while (capacity < required) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.buffer);
    this.buffer = next;
    this.view = undefined;
  }

  private floats(): DataView {
    return (this.view ??= new DataView(this.buffer.buffer));
  }

  byte(value: number): void {
    this.ensure(1);
    this.buffer[this.offset++] = value;
  }

  bytes(value: Uint8Array): void {
    this.ensure(value.length);
    this.buffer.set(value, this.offset);
    this.offset += value.length;
  }

  varuint(value: number): void {
    // Most varints on the wire are one byte, so take them before the guard and the
    // loop: skips Number.isSafeInteger, the 8-byte reserve and the shift loop.
    if (value >= 0 && value < 0x80 && Number.isInteger(value)) {
      this.ensure(1);
      this.buffer[this.offset++] = value;
      return;
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new EncodeError(`Expected an unsigned safe integer, received ${value}`);
    }
    this.ensure(8);
    if (value <= 0xffffffff) {
      // Shifts, not `% 0x80` and `Math.floor(x / 0x80)`: within 32 bits the bitwise
      // form stays on the integer unit. Above it the operands stop fitting.
      let word = value;
      while (word >= 0x80) {
        this.buffer[this.offset++] = (word & 0x7f) | 0x80;
        word >>>= 7;
      }
      this.buffer[this.offset++] = word;
      return;
    }
    // Two registers so every step stays on the integer unit: the float loop this
    // replaced cost 83ns for a millisecond timestamp against 7ns here. `high << 25`
    // discards bits at or above 32, which is exactly the seven atop the next `low`.
    // `test/property.test.ts` pins the bytes against the float reference.
    let low = value >>> 0;
    let high = (value - low) / 0x100000000;
    while (high > 0 || low >= 0x80) {
      this.buffer[this.offset++] = (low & 0x7f) | 0x80;
      low = ((low >>> 7) | (high << 25)) >>> 0;
      high >>>= 7;
    }
    this.buffer[this.offset++] = low;
  }

  varuintBigInt(value: bigint): void {
    if (value < 0n) throw new EncodeError(`Expected an unsigned integer, received ${value}`);

    this.ensure(10);
    let remaining = value;
    while (remaining >= 0x80n) {
      this.buffer[this.offset++] = Number((remaining & 0x7fn) | 0x80n);
      remaining >>= 7n;
    }
    this.buffer[this.offset++] = Number(remaining);
  }

  string(value: string): void {
    // Short ASCII in one pass, speculatively: under 128 code units the length varint is
    // one byte whatever the UTF-8 length turns out to be, so write it before it is
    // confirmed and rewind on the first unit at or above 0x80. Timings in
    // .changeset/tidy-hounds-smile.md.
    const units = value.length;
    if (units < 0x80) {
      this.ensure(units + 1);
      const buffer = this.buffer;
      const start = this.offset;
      let offset = start;
      buffer[offset++] = units;
      let index = 0;
      for (; index < units; index++) {
        const code = value.charCodeAt(index);
        if (code >= 0x80) break;
        buffer[offset++] = code;
      }
      if (index === units) {
        this.offset = offset;
        return;
      }
      this.offset = start;
    }

    // The surrogate scan touches every code unit anyway, so it also totals the UTF-8
    // length — which is what lets the varint go first and encodeInto land the bytes in
    // their final place instead of 5 bytes past it.
    let byteLength = 0;
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code < 0x80) {
        byteLength += 1;
      } else if (code < 0x800) {
        byteLength += 2;
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          throw new EncodeError("String contains an unpaired surrogate");
        }
        byteLength += 4;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw new EncodeError("String contains an unpaired surrogate");
      } else {
        byteLength += 3;
      }
    }

    if (byteLength > MAX_BYTE_LENGTH) throw new EncodeError("String is too large");
    this.varuint(byteLength);
    this.ensure(byteLength);

    // Only non-ASCII or 128+ code units reach here, so there is no short-ASCII charCode
    // loop left to beat encodeInto's native-boundary cost.
    textEncoder.encodeInto(value, this.buffer.subarray(this.offset, this.offset + byteLength));
    this.offset += byteLength;
  }

  float32(value: number): void {
    this.ensure(4);
    this.floats().setFloat32(this.offset, value, true);
    this.offset += 4;
  }

  float64(value: number): void {
    this.ensure(8);
    this.floats().setFloat64(this.offset, value, true);
    this.offset += 8;
  }

  /**
   * Always a copy, never a view: `Schema.encode` reuses one Writer, so a subarray
   * would alias a buffer the next encode overwrites. `slice` pays a fixed setup cost
   * whatever the length — 41.8ns against 24.8ns for allocate-and-copy at 4 bytes,
   * level at 16, 344ns against 140ns at 512 — so short payloads copy by hand.
   * `set()` from a subarray loses to both at every length.
   */
  finish(): Uint8Array {
    const length = this.offset;
    if (length >= SLICE_COPY_LIMIT) return this.buffer.slice(0, length);

    const copy = new Uint8Array(length);
    const buffer = this.buffer;
    for (let index = 0; index < length; index++) copy[index] = buffer[index]!;
    return copy;
  }

  /**
   * Called on release rather than on acquire, so a buffer grown by one oversized
   * payload is dropped now instead of staying pinned for as long as the process idles.
   */
  reset(): void {
    this.offset = 0;
    if (this.buffer.length > MAX_RETAINED_BUFFER_BYTES) {
      this.buffer = new Uint8Array(64);
      this.view = undefined;
    }
  }
}

/**
 * The Writer `Schema.encode` reuses: its buffer and DataView were the two allocations
 * a small encode spent most of its time on — the DataView alone profiled at 29% of a
 * nested-event encode. An encode reached from inside another sees the flag set and
 * allocates its own Writer. The flag is a boolean rather than clearing the slot to
 * `undefined`, which costs a write barrier each way — 12.5ns of a 68ns Person encode.
 */
const pooledWriter = new Writer();
let pooledWriterBusy = false;

export class Reader {
  private offset = 0;

  /**
   * Built once a decode has read `FLOAT_VIEW_TRIP` floats, never before: a DataView
   * costs more to allocate than the scratch copy below saves on a record holding one
   * or two of them — a 38-byte nested event decodes 34% slower if this is built eagerly
   * — while an array of floats amortizes the one allocation to nothing.
   */
  private view: DataView | undefined;
  private floatsRead = 0;

  constructor(private readonly buffer: Uint8Array) {}

  get position(): number {
    return this.offset;
  }

  get done(): boolean {
    return this.offset === this.buffer.length;
  }

  get remaining(): number {
    return this.buffer.length - this.offset;
  }

  byte(): number {
    if (this.offset >= this.buffer.length) {
      throw new DecodeError("Unexpected end of input", this.offset);
    }
    return this.buffer[this.offset++]!;
  }

  bytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BYTE_LENGTH) {
      throw new DecodeError(`Invalid byte length ${length}`, this.offset);
    }
    if (this.offset + length > this.buffer.length) {
      throw new DecodeError("Unexpected end of input", this.offset);
    }

    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  string(): string {
    const length = this.varuint();
    // TextDecoder costs a flat ~40ns whatever the length. A charCode loop beats it
    // below roughly eight bytes and loses badly above: a gate of 12 is a 22% regression
    // at exactly 12 bytes and buys nothing over 8, so ASCII_FAST_PATH_LIMIT is a
    // pessimization to raise, not a tuning knob. Pure ASCII is well-formed UTF-8, so
    // skipping the decoder accepts nothing it would have rejected. Indexed off
    // `this.buffer`: `bytes()` allocates a view costing more than the decode it feeds.
    if (length <= ASCII_FAST_PATH_LIMIT) {
      const start = this.offset;
      if (start + length > this.buffer.length) {
        throw new DecodeError("Unexpected end of input", start);
      }
      const bytes = this.buffer;
      let ascii = true;
      for (let index = start; index < start + length; index++) {
        if (bytes[index]! > 0x7f) {
          ascii = false;
          break;
        }
      }
      // Positional arguments, never a spread, `.apply`, a concat loop or TextDecoder:
      // all four were measured and lost, and collapsing this switch to save its ~480
      // minified bytes costs 5x.
      if (ascii) {
        this.offset = start + length;
        switch (length) {
          case 0:
            return "";
          case 1:
            return String.fromCharCode(bytes[start]!);
          case 2:
            return String.fromCharCode(bytes[start]!, bytes[start + 1]!);
          case 3:
            return String.fromCharCode(bytes[start]!, bytes[start + 1]!, bytes[start + 2]!);
          case 4:
            return String.fromCharCode(
              bytes[start]!, bytes[start + 1]!, bytes[start + 2]!, bytes[start + 3]!,
            );
          case 5:
            return String.fromCharCode(
              bytes[start]!, bytes[start + 1]!, bytes[start + 2]!, bytes[start + 3]!,
              bytes[start + 4]!,
            );
          case 6:
            return String.fromCharCode(
              bytes[start]!, bytes[start + 1]!, bytes[start + 2]!, bytes[start + 3]!,
              bytes[start + 4]!, bytes[start + 5]!,
            );
          case 7:
            return String.fromCharCode(
              bytes[start]!, bytes[start + 1]!, bytes[start + 2]!, bytes[start + 3]!,
              bytes[start + 4]!, bytes[start + 5]!, bytes[start + 6]!,
            );
          default:
            return String.fromCharCode(
              bytes[start]!, bytes[start + 1]!, bytes[start + 2]!, bytes[start + 3]!,
              bytes[start + 4]!, bytes[start + 5]!, bytes[start + 6]!, bytes[start + 7]!,
            );
        }
      }
    }
    const bytes = this.bytes(length);
    try {
      return textDecoder.decode(bytes);
    } catch (error) {
      throw new DecodeError("Invalid UTF-8", this.offset - bytes.length, { cause: error });
    }
  }

  varuint(): number {
    // One byte covers every value below 128. Out of range reads `undefined` and falls
    // through to the loop, which raises the end-of-input error.
    const first = this.buffer[this.offset];
    if (first !== undefined && first < 0x80) {
      this.offset++;
      return first;
    }
    return this.varuintSlow();
  }

  private varuintSlow(): number {
    let result = 0;
    let factor = 1;

    for (let index = 0; index < 8; index++) {
      const byte = this.byte();
      result += (byte & 0x7f) * factor;
      if (!Number.isSafeInteger(result)) {
        throw new DecodeError("Integer exceeds JavaScript's safe range", this.offset);
      }
      if ((byte & 0x80) === 0) {
        if (index > 0 && byte === 0) {
          throw new DecodeError("Non-canonical variable-length integer", this.offset);
        }
        return result;
      }
      factor *= 0x80;
    }

    throw new DecodeError("Invalid or unsafe variable-length integer", this.offset);
  }

  /**
   * Stays a `number` while the value is representable as one, widening to `bigint`
   * only when it is not. The unconditional `bigint` reader this replaced cost the
   * signed-integer decoder three BigInt allocations per value in the range where none
   * were needed.
   */
  varuintWide(): number | bigint {
    let result = 0;
    let factor = 1;

    for (let index = 0; index < 10; index++) {
      const byte = this.byte();
      const digit = byte & 0x7f;
      const next = result + digit * factor;
      if (!Number.isSafeInteger(next)) {
        let large = BigInt(result) + (BigInt(digit) << BigInt(index * 7));
        if ((byte & 0x80) === 0) return large;

        for (let largeIndex = index + 1; largeIndex < 10; largeIndex++) {
          const largeByte = this.byte();
          large |= BigInt(largeByte & 0x7f) << BigInt(largeIndex * 7);
          if ((largeByte & 0x80) === 0) {
            if (largeByte === 0) {
              throw new DecodeError("Non-canonical variable-length integer", this.offset);
            }
            return large;
          }
        }
        throw new DecodeError("Invalid variable-length integer", this.offset);
      }
      result = next;
      if ((byte & 0x80) === 0) {
        if (index > 0 && byte === 0) {
          throw new DecodeError("Non-canonical variable-length integer", this.offset);
        }
        return result;
      }
      factor *= 0x80;
    }

    throw new DecodeError("Invalid variable-length integer", this.offset);
  }

  float32(): number {
    const start = this.offset;
    if (start + 4 > this.buffer.length) {
      throw new DecodeError("Unexpected end of input", start);
    }
    const buffer = this.buffer;
    for (let index = 0; index < 4; index++) floatBytes[index] = buffer[start + index]!;
    this.offset = start + 4;
    return floatView.getFloat32(0, true);
  }

  float64(): number {
    const start = this.offset;
    if (start + 8 > this.buffer.length) {
      throw new DecodeError("Unexpected end of input", start);
    }
    const view = this.view;
    // Split like `varuint`/`varuintSlow`: folding the scratch path and the DataView
    // construction into this body costs it V8's inlining budget, and an uninlined
    // `getFloat64` is no faster than the copy it replaced.
    if (view === undefined) return this.float64Slow(start);
    this.offset = start + 8;
    return view.getFloat64(start, true);
  }

  private float64Slow(start: number): number {
    const buffer = this.buffer;
    this.offset = start + 8;
    if (this.floatsRead++ >= FLOAT_VIEW_TRIP) {
      const view = (this.view = new DataView(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength,
      ));
      return view.getFloat64(start, true);
    }
    for (let index = 0; index < 8; index++) floatBytes[index] = buffer[start + index]!;
    return floatView.getFloat64(0, true);
  }
}

export abstract class Schema<T> {
  declare readonly _output: T;

  /** Set only by codecs built from a Standard JSON Schema; `m` leaves wire unframed. */
  declare readonly signature?: string;

  /**
   * The two halves a validating codec fuses, kept apart so `encodeAsync`/`decodeAsync`
   * can `await` the validator between them. Set together or not at all — a wrapper
   * opts in by assigning both, so neither async function needs to know
   * `FingerprintedSchema` exists. Undefined on `m` schemas, which the async entry
   * points refuse.
   */
  declare _source?: StandardSchemaV1<unknown, unknown>;
  declare _structural?: Schema<unknown>;

  /**
   * Fewest bytes any value of this schema can occupy on the wire, computed once at
   * construction. `ArraySchema` multiplies it by a declared count and refuses to
   * allocate when the remaining input is too short — without it seven bytes buy a
   * million-slot allocation, and each nesting level multiplies the ceiling again.
   */
  _minWidth = 1;

  /**
   * Whether a value of this schema can itself be `null` or `undefined`. Read by
   * `nullable()` and `optional()` to refuse a marker whose absent case would duplicate
   * a value the inner schema can already produce. Both propagate through the other
   * wrapper, so a stack three deep is caught as readily as one.
   */
  _yieldsNull = false;
  _yieldsUndefined = false;

  abstract _encode(writer: Writer, value: T): void;
  abstract _decode(reader: Reader): T;

  /**
   * The first child whose encode fails, for `encodePath` to descend through.
   * Containers override it; a leaf ends the walk here.
   */
  _failingChild(_value: unknown): FailingChild | undefined {
    return undefined;
  }

  encode(value: T): Uint8Array {
    if (pooledWriterBusy) {
      const writer = new Writer();
      try {
        this._encode(writer, value);
      } catch (error) {
        throw withPath(error, this, value);
      }
      return writer.finish();
    }
    pooledWriterBusy = true;
    try {
      this._encode(pooledWriter, value);
      return pooledWriter.finish();
    } catch (error) {
      throw withPath(error, this, value);
    } finally {
      // On the way out, so a throw leaves a clean Writer behind.
      pooledWriter.reset();
      pooledWriterBusy = false;
    }
  }

  decode(value: Uint8Array): T {
    if (!isUint8Array(value)) {
      throw new DecodeError(`Expected a Uint8Array, received ${typeof value}`, 0);
    }
    const reader = new Reader(value);
    const decoded = this._decode(reader);
    if (!reader.done) {
      throw new DecodeError("Unexpected trailing data", reader.position);
    }
    return decoded;
  }

  /**
   * Collapses a repeated `optional()`: a second presence marker would make `[0]` and
   * `[1, 0]` both mean absent, so `decode` would stop being injective.
   */
  optional(): OptionalSchema<T> {
    if (this instanceof OptionalSchema) return this as unknown as OptionalSchema<T>;
    if (this._yieldsUndefined) {
      throw new EncodeError(
        "This schema already decodes to undefined; wrapping it in optional() would give undefined two encodings",
      );
    }
    return new OptionalSchema(this);
  }

  /**
   * Collapses a repeated `nullable()` for the reason `optional()` does, and refuses
   * `m.literal(null).nullable()`, where collapsing would change the width to zero.
   */
  nullable(): NullableSchema<T> {
    if (this instanceof NullableSchema) return this as unknown as NullableSchema<T>;
    if (this._yieldsNull) {
      throw new EncodeError(
        "This schema already decodes to null; wrapping it in nullable() would give null two encodings",
      );
    }
    return new NullableSchema(this);
  }
}

export type Infer<S extends Schema<unknown>> = S["_output"];

// Exported for `standard.ts`, which builds wire schemas straight from these rather
// than through `m`: referencing `m` there retained the whole object — and with it
// `BytesSchema` and `Float32Schema` — in every bundle importing only `codec`.
export class StringSchema extends Schema<string> {
  _encode(writer: Writer, value: string): void {
    if (typeof value !== "string") throw new EncodeError("Expected a string");
    writer.string(value);
  }

  _decode(reader: Reader): string {
    return reader.string();
  }
}

class BytesSchema extends Schema<Uint8Array> {
  _encode(writer: Writer, value: Uint8Array): void {
    if (!isUint8Array(value)) throw new EncodeError("Expected a Uint8Array");
    if (value.length > MAX_BYTE_LENGTH) throw new EncodeError("Byte array is too large");
    writer.varuint(value.length);
    writer.bytes(value);
  }

  _decode(reader: Reader): Uint8Array {
    // Not `.slice()`: on a Node Buffer that is a non-copying alias of `subarray`, so
    // the defensive copy would alias the caller's bytes and pin Node's buffer pool.
    return new Uint8Array(reader.bytes(reader.varuint()));
  }
}

export class BooleanSchema extends Schema<boolean> {
  _encode(writer: Writer, value: boolean): void {
    if (typeof value !== "boolean") throw new EncodeError("Expected a boolean");
    writer.byte(value ? 1 : 0);
  }

  _decode(reader: Reader): boolean {
    const value = reader.byte();
    if (value > 1) throw new DecodeError(`Invalid boolean ${value}`, reader.position - 1);
    return value === 1;
  }
}

export class UintSchema extends Schema<number> {
  _encode(writer: Writer, value: number): void {
    writer.varuint(value);
  }

  _decode(reader: Reader): number {
    return reader.varuint();
  }
}

export class IntSchema extends Schema<number> {
  _encode(writer: Writer, value: number): void {
    if (!Number.isSafeInteger(value)) {
      throw new EncodeError(`Expected a safe integer, received ${value}`);
    }
    const zigzag = value >= 0 ? value * 2 : -value * 2 - 1;
    if (Number.isSafeInteger(zigzag)) {
      writer.varuint(zigzag);
      return;
    }

    const integer = BigInt(value);
    writer.varuintBigInt(integer >= 0n ? integer * 2n : -integer * 2n - 1n);
  }

  _decode(reader: Reader): number {
    const zigzag = reader.varuintWide();
    if (typeof zigzag === "number") {
      // `& 1` keeps the low bit for any integer, since ToInt32 is modulo 2^32. Halving
      // is exact both ways, so the result cannot leave the safe range: an even zigzag
      // divides cleanly, and an odd one is at most MAX_SAFE_INTEGER.
      return (zigzag & 1) === 0 ? zigzag / 2 : -(zigzag + 1) / 2;
    }
    const value = (zigzag & 1n) === 0n ? zigzag >> 1n : -((zigzag + 1n) >> 1n);
    const number = Number(value);
    if (!Number.isSafeInteger(number)) {
      throw new DecodeError("Integer exceeds JavaScript's safe range", reader.position);
    }
    return number;
  }
}

class Float32Schema extends Schema<number> {
  override _minWidth = 4;

  _encode(writer: Writer, value: number): void {
    if (typeof value !== "number") throw new EncodeError("Expected a number");
    writer.float32(value);
  }

  _decode(reader: Reader): number {
    return reader.float32();
  }
}

export class Float64Schema extends Schema<number> {
  override _minWidth = 8;

  _encode(writer: Writer, value: number): void {
    if (typeof value !== "number") throw new EncodeError("Expected a number");
    writer.float64(value);
  }

  _decode(reader: Reader): number {
    return reader.float64();
  }
}

export class OptionalSchema<T> extends Schema<T | undefined> {
  /**
   * Type-only brand, `declare` so it costs no runtime bytes. TS compares classes
   * structurally, so without it `NullableSchema<string>` matched `OptionalKeys` and a
   * nullable field inferred as an optional *key*. Nothing else tells the two classes
   * apart, so `NullableSchema` must not be folded into a shared base with this one.
   */
  declare readonly _optionalBrand: true;

  constructor(readonly inner: Schema<T>) {
    super();
    this._yieldsUndefined = true;
    this._yieldsNull = inner._yieldsNull;
  }

  _encode(writer: Writer, value: T | undefined): void {
    writer.byte(value === undefined ? 0 : 1);
    if (value !== undefined) this.inner._encode(writer, value);
  }

  _decode(reader: Reader): T | undefined {
    const present = reader.byte();
    if (present > 1) throw new DecodeError("Invalid optional marker", reader.position - 1);
    return present === 0 ? undefined : this.inner._decode(reader);
  }
}

export class NullableSchema<T> extends Schema<T | null> {
  constructor(readonly inner: Schema<T>) {
    super();
    this._yieldsNull = true;
    this._yieldsUndefined = inner._yieldsUndefined;
  }

  _encode(writer: Writer, value: T | null): void {
    writer.byte(value === null ? 0 : 1);
    if (value !== null) this.inner._encode(writer, value);
  }

  _decode(reader: Reader): T | null {
    const present = reader.byte();
    if (present > 1) throw new DecodeError("Invalid nullable marker", reader.position - 1);
    return present === 0 ? null : this.inner._decode(reader);
  }
}

export class LiteralSchema<T extends string | number | boolean | null> extends Schema<T> {
  constructor(private readonly value: T) {
    super();
    // The schema fixes the value, so it writes nothing at all.
    this._minWidth = 0;
    this._yieldsNull = value === null;
  }

  // `Object.is`, not `===`: a NaN literal would otherwise refuse the only value it
  // decodes to, and a `-0` literal would accept the `+0` it cannot give back.
  _encode(_writer: Writer, value: T): void {
    if (!Object.is(value, this.value)) {
      throw new EncodeError(`Expected literal ${String(this.value)}`);
    }
  }

  _decode(_reader: Reader): T {
    return this.value;
  }
}

export class EnumSchema<T extends readonly [EnumValue, ...EnumValue[]]> extends Schema<T[number]> {
  private readonly values: T;
  private readonly indexes: Map<EnumValue, number>;

  constructor(values: T) {
    super();
    if (new Set(values).size !== values.length) {
      throw new EncodeError("Enum values must be unique");
    }
    this.values = canonicalEnumOrder(values) as unknown as T;
    this.indexes = new Map(this.values.map((value, index) => [value, index]));
    // An enum that lists null decodes to null, so `nullable()` over it would give null
    // two encodings.
    this._yieldsNull = this.values.includes(null);
  }

  _encode(writer: Writer, value: T[number]): void {
    const index = this.indexes.get(value);
    if (index === undefined) throw new EncodeError(`Unknown enum value ${String(value)}`);
    writer.varuint(index);
  }

  _decode(reader: Reader): T[number] {
    const index = reader.varuint();
    const value = this.values[index];
    if (value === undefined) throw new DecodeError(`Unknown enum index ${index}`, reader.position);
    return value;
  }
}

/** `0-9` and `a-f` to their value, everything else to -1. Uppercase: see `UuidSchema`. */
function hexNibble(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  return -1;
}

/**
 * One message for a wrong length, a misplaced dash and an out-of-alphabet character
 * alike. The case worth naming is uppercase, the spelling a validator lets through.
 */
function rejectUuid(value: unknown): never {
  throw new EncodeError(`Expected a lowercase UUID, received ${String(value)}`);
}

/** Four bytes as eight hex characters, the largest chunk one `toString` can do. */
function hexWord(reader: Reader): string {
  const a = reader.byte();
  const b = reader.byte();
  const c = reader.byte();
  const d = reader.byte();
  return (((a << 24) | (b << 16) | (c << 8) | d) >>> 0).toString(16).padStart(8, "0");
}

/**
 * A UUID as the 16 bytes it stands for rather than the 36 characters it is written as.
 *
 * Lowercase only, refused rather than normalized: RFC 4122 accepts either case, but
 * two spellings cannot both survive a 16-byte round trip, and returning the lowercase
 * one would mean `decode(encode(x))` differed from `x`.
 */
export class UuidSchema extends Schema<string> {
  override _minWidth = 16;

  _encode(writer: Writer, value: string): void {
    if (typeof value !== "string" || value.length !== 36) rejectUuid(value);
    // Each dash falls between two byte pairs, never inside one, so skipping the four of
    // them in place keeps every pair aligned.
    for (let index = 0; index < 36; ) {
      if (index === 8 || index === 13 || index === 18 || index === 23) {
        if (value.charCodeAt(index) !== 0x2d) rejectUuid(value);
        index++;
        continue;
      }
      const high = hexNibble(value.charCodeAt(index));
      const low = hexNibble(value.charCodeAt(index + 1));
      if (high < 0 || low < 0) rejectUuid(value);
      writer.byte((high << 4) | low);
      index += 2;
    }
  }

  _decode(reader: Reader): string {
    const first = hexWord(reader);
    const second = hexWord(reader);
    const third = hexWord(reader);
    const fourth = hexWord(reader);
    return `${first}-${second.slice(0, 4)}-${second.slice(4)}-${third.slice(0, 4)}-${third.slice(4)}${fourth}`;
  }
}

export class ArraySchema<T> extends Schema<T[]> {
  /**
   * `length` is the element count when the schema fixes it — `minItems` equal to
   * `maxItems`. A fixed count is not written, and its element may be zero-width.
   */
  constructor(private readonly item: Schema<T>, private readonly length?: number) {
    super();
    if (length !== undefined) {
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_COLLECTION_LENGTH) {
        throw new EncodeError(`Invalid fixed array length ${length}`);
      }
      this._minWidth = length * item._minWidth;
      return;
    }
    if (item._minWidth === 0) {
      // A zero-width element decouples the count from the input length, so no budget
      // can bound it: three bytes would ask for a million literals.
      throw new EncodeError(
        "Array elements must occupy at least one byte; a literal, empty tuple or empty object element leaves the element count unbounded",
      );
    }
  }

  _encode(writer: Writer, value: T[]): void {
    if (!Array.isArray(value)) throw new EncodeError("Expected an array");
    if (this.length === undefined) {
      if (value.length > MAX_COLLECTION_LENGTH) throw new EncodeError("Array is too large");
      writer.varuint(value.length);
    } else if (value.length !== this.length) {
      throw new EncodeError(`Expected an array with ${this.length} items`);
    }
    for (let index = 0; index < value.length; index++) {
      this.item._encode(writer, value[index]!);
    }
  }

  override _failingChild(value: unknown): FailingChild | undefined {
    if (!Array.isArray(value)) return undefined;
    const scratch = new Writer();
    for (let index = 0; index < value.length; index++) {
      try {
        this.item._encode(scratch, value[index]);
      } catch {
        return { schema: this.item, segment: `[${index}]`, value: value[index] };
      }
    }
    return undefined;
  }

  _decode(reader: Reader): T[] {
    // A fixed length still faces the budget check below: `minItems` may come from a
    // fetched JSON Schema, so it is no more trusted than a length varint.
    const length = this.length ?? reader.varuint();
    if (length > MAX_COLLECTION_LENGTH) {
      throw new DecodeError(`Array length ${length} exceeds the limit`, reader.position);
    }
    // Before allocating a slot: `length` elements need at least `length *
    // item._minWidth` bytes, so a larger count is unsatisfiable.
    if (length * this.item._minWidth > reader.remaining) {
      throw new DecodeError(
        `Array length ${length} exceeds the remaining input`,
        reader.position,
      );
    }
    const values = new Array<T>(length);
    for (let index = 0; index < length; index++) values[index] = this.item._decode(reader);
    return values;
  }
}

/**
 * Keys the schema does not name, each holding a value of one declared type. The one
 * shape that writes its keys, since a record's keys are data rather than schema.
 *
 * On decode, out-of-order keys are refused rather than sorted — which also refuses a
 * duplicate key. Sorting instead would let two payloads decode to the same record.
 */
export class RecordSchema<T> extends Schema<Record<string, T>> {
  constructor(private readonly value: Schema<T>) {
    super();
  }

  /**
   * The per-encode sort is unavoidable: `Object.keys` is insertion-ordered, so two
   * records equal as values would otherwise write different bytes.
   */
  _encode(writer: Writer, value: Record<string, T>): void {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new EncodeError("Expected an object");
    }
    const keys = canonicalKeyOrder(Object.keys(value));
    if (keys.length > MAX_COLLECTION_LENGTH) throw new EncodeError("Record is too large");
    writer.varuint(keys.length);
    for (const key of keys) {
      writer.string(key);
      this.value._encode(writer, value[key] as T);
    }
  }

  override _failingChild(value: unknown): FailingChild | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    const scratch = new Writer();
    for (const key of canonicalKeyOrder(Object.keys(record))) {
      try {
        this.value._encode(scratch, record[key] as T);
      } catch {
        return { schema: this.value, segment: key, value: record[key] };
      }
    }
    return undefined;
  }

  _decode(reader: Reader): Record<string, T> {
    const count = reader.varuint();
    if (count > MAX_COLLECTION_LENGTH) {
      throw new DecodeError(`Record size ${count} exceeds the limit`, reader.position);
    }
    // One byte for the shortest key length varint, plus the value's own minimum.
    if (count * (1 + this.value._minWidth) > reader.remaining) {
      throw new DecodeError(`Record size ${count} exceeds the remaining input`, reader.position);
    }
    const result: Record<string, T> = {};
    let previous: string | undefined;
    for (let index = 0; index < count; index++) {
      const key = reader.string();
      if (previous !== undefined && previous >= key) {
        throw new DecodeError("Record keys are out of canonical order", reader.position);
      }
      previous = key;
      const decoded = this.value._decode(reader);
      // `__proto__` is a setter on Object.prototype, so a plain store would reassign
      // the prototype instead of adding a key.
      if (key === "__proto__") {
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          value: decoded,
          writable: true,
        });
      } else {
        result[key] = decoded;
      }
    }
    return result;
  }
}

/**
 * `z.discriminatedUnion`: a varint branch index, then that branch's own encoding. The
 * index usually replaces a byte rather than adding one, since the discriminant is a
 * literal inside its branch and a literal writes nothing.
 *
 * Branches are ordered by discriminant, so declaration order does not reach the wire.
 * A general union has no such property to read, so it stays refused — choosing a
 * branch would mean guessing, and guessing wrong decodes silently.
 */
export class UnionSchema<T> extends Schema<T> {
  private readonly indexes: Map<EnumValue, number>;

  constructor(
    private readonly key: string,
    cases: readonly EnumValue[],
    private readonly branches: readonly Schema<T>[],
  ) {
    super();
    this.indexes = new Map(cases.map((value, index) => [value, index]));
    let narrowest = Infinity;
    for (const branch of branches) narrowest = Math.min(narrowest, branch._minWidth);
    // The index byte plus the cheapest branch: the budget is fixed before the decoder
    // knows which branch is coming.
    this._minWidth = 1 + narrowest;
  }

  private branchOf(value: unknown): number | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    return this.indexes.get((value as Record<string, unknown>)[this.key] as EnumValue);
  }

  _encode(writer: Writer, value: T): void {
    const index = this.branchOf(value);
    if (index === undefined) {
      throw new EncodeError(
        `No union branch has ${JSON.stringify(this.key)} = ${JSON.stringify(
          (value as Record<string, unknown> | null)?.[this.key],
        )}`,
      );
    }
    writer.varuint(index);
    this.branches[index]!._encode(writer, value);
  }

  /**
   * Descends into the branch the value selected, not every branch: a path through one
   * of the others would name a field the caller never wrote.
   */
  override _failingChild(value: unknown): FailingChild | undefined {
    const index = this.branchOf(value);
    if (index === undefined) return undefined;
    return this.branches[index]!._failingChild(value);
  }

  _decode(reader: Reader): T {
    const index = reader.varuint();
    const branch = this.branches[index];
    if (branch === undefined) {
      throw new DecodeError(`Unknown union branch ${index}`, reader.position);
    }
    return branch._decode(reader);
  }
}

/**
 * How deep a dynamic value may nest, on either side. Everywhere else nesting depth
 * comes from the schema; here it comes from the payload, where `[[[[…]]]]` buys a
 * stack frame for two bytes. The same counter catches an object that holds itself.
 */
const MAX_DYNAMIC_DEPTH = 64;

/**
 * The escape hatch for a schema that declines to describe something — `z.any()`,
 * `z.unknown()`, an empty JSON Schema node. The one shape that writes type tags,
 * because it is the one shape whose type is not in the schema.
 *
 * | Tag | Value | Payload |
 * | --- | --- | --- |
 * | 0 | null | — |
 * | 1 | false | — |
 * | 2 | true | — |
 * | 3 | safe integer | ZigZag varint |
 * | 4 | other number | 8 bytes |
 * | 5 | string | varint length + UTF-8 |
 * | 6 | array | varint count + values |
 * | 7 | object | varint count + canonically ordered key/value pairs |
 *
 * One value, one encoding: an integer never takes the float tag, and a float payload
 * holding an integer is refused on the way back.
 */
export class DynamicSchema extends Schema<unknown> {
  // Self-referential for the two container tags, so the element budget, collection
  // ceiling, canonical key order and `__proto__` store all come from the schemas that
  // already have them.
  private readonly integers = new IntSchema();
  private readonly floats = new Float64Schema();
  private readonly strings = new StringSchema();
  private readonly values: ArraySchema<unknown> = new ArraySchema(this);
  private readonly entries: RecordSchema<unknown> = new RecordSchema(this);
  private depth = 0;

  constructor() {
    super();
    // Tag 0 decodes to null, so a nullable() over it would give null two encodings.
    this._yieldsNull = true;
  }

  /**
   * Depth lives on the schema rather than a parameter, because the recursion runs
   * through `ArraySchema` and `RecordSchema`, which know nothing about it. The
   * `finally` keeps a thrown encode from leaving the count raised on a reused codec.
   */
  private nested<R>(run: () => R, reader?: Reader): R {
    if (this.depth >= MAX_DYNAMIC_DEPTH) {
      const message = `Dynamic value nests deeper than ${MAX_DYNAMIC_DEPTH}`;
      throw reader === undefined
        ? new EncodeError(message)
        : new DecodeError(message, reader.position);
    }
    this.depth++;
    try {
      return run();
    } finally {
      this.depth--;
    }
  }

  _encode(writer: Writer, value: unknown): void {
    if (value === null) return writer.byte(0);
    switch (typeof value) {
      case "boolean":
        return writer.byte(value ? 2 : 1);
      case "number":
        // `-0` takes the float tag despite being a safe integer: the int tag has no
        // way to hold the sign, so it would come back as `0`.
        if (Number.isSafeInteger(value) && !Object.is(value, -0)) {
          writer.byte(3);
          return this.integers._encode(writer, value);
        }
        writer.byte(4);
        return this.floats._encode(writer, value);
      case "string":
        writer.byte(5);
        return this.strings._encode(writer, value);
      case "object": {
        if (Array.isArray(value)) {
          writer.byte(6);
          return this.nested(() => this.values._encode(writer, value));
        }
        // Anything with a prototype of its own is a rich type wearing an object's shape
        // — a Date, a Map, a class instance — and would go on the wire as `{}`.
        const prototype = Object.getPrototypeOf(value) as unknown;
        if (prototype !== Object.prototype && prototype !== null) break;
        writer.byte(7);
        return this.nested(() => this.entries._encode(writer, value as Record<string, unknown>));
      }
    }
    throw new EncodeError(
      `Cannot encode ${value instanceof Object ? (value.constructor?.name ?? "this value") : typeof value} as a dynamic value; a dynamic value holds null, a boolean, a number, a string, an array, or a plain object`,
    );
  }

  _decode(reader: Reader): unknown {
    const tag = reader.byte();
    switch (tag) {
      case 0:
        return null;
      case 1:
        return false;
      case 2:
        return true;
      case 3:
        return this.integers._decode(reader);
      case 4: {
        const value = this.floats._decode(reader);
        if (Number.isSafeInteger(value) && !Object.is(value, -0)) {
          throw new DecodeError("Non-canonical dynamic number", reader.position);
        }
        return value;
      }
      case 5:
        return this.strings._decode(reader);
      case 6:
        return this.nested(() => this.values._decode(reader), reader);
      case 7:
        return this.nested(() => this.entries._decode(reader), reader);
    }
    throw new DecodeError(`Unknown dynamic tag ${tag}`, reader.position - 1);
  }
}

type TupleOutput<S extends readonly Schema<unknown>[]> = {
  -readonly [K in keyof S]: S[K] extends Schema<unknown> ? Infer<S[K]> : never;
};

export class TupleSchema<S extends readonly Schema<unknown>[]> extends Schema<TupleOutput<S>> {
  private readonly items: S;

  /**
   * Fixed items are positional and counted by the schema, so they are written bare. A
   * rest element is only counted per value, so the tail is an `ArraySchema` and gets
   * its count varint, element budget and collection ceiling from there.
   */
  private readonly tail: ArraySchema<unknown> | undefined;

  constructor(items: S, private readonly rest?: Schema<unknown>) {
    super();
    this.items = [...items] as unknown as S;
    this.tail = rest === undefined ? undefined : new ArraySchema(rest);
    let width = this.tail?._minWidth ?? 0;
    for (const item of this.items) width += item._minWidth;
    this._minWidth = width;
  }

  _encode(writer: Writer, value: TupleOutput<S>): void {
    const fixed = this.items.length;
    if (!Array.isArray(value) || (this.tail === undefined ? value.length !== fixed : value.length < fixed)) {
      throw new EncodeError(
        this.tail === undefined
          ? `Expected a tuple with ${fixed} items`
          : `Expected a tuple with at least ${fixed} items`,
      );
    }
    for (let index = 0; index < fixed; index++) {
      this.items[index]!._encode(writer, value[index]);
    }
    this.tail?._encode(writer, value.slice(fixed));
  }

  override _failingChild(value: unknown): FailingChild | undefined {
    if (!Array.isArray(value)) return undefined;
    const scratch = new Writer();
    for (let index = 0; index < this.items.length; index++) {
      try {
        this.items[index]!._encode(scratch, value[index]);
      } catch {
        return { schema: this.items[index]!, segment: `[${index}]`, value: value[index] };
      }
    }
    // Walked here rather than handed to the tail, which would report a rest element's
    // position within the rest — `[0]` for what the caller wrote at `[3]`.
    if (this.rest !== undefined) {
      for (let index = this.items.length; index < value.length; index++) {
        try {
          this.rest._encode(scratch, value[index]);
        } catch {
          return { schema: this.rest, segment: `[${index}]`, value: value[index] };
        }
      }
    }
    return undefined;
  }

  _decode(reader: Reader): TupleOutput<S> {
    const values = new Array<unknown>(this.items.length);
    for (let index = 0; index < this.items.length; index++) {
      values[index] = this.items[index]!._decode(reader);
    }
    if (this.tail === undefined) return values as TupleOutput<S>;
    return values.concat(this.tail._decode(reader)) as TupleOutput<S>;
  }
}

export type Shape = Record<string, Schema<unknown>>;
// Matches on the brand, not on `OptionalSchema<unknown>`: the class comparison is
// structural, and `NullableSchema` satisfies it.
type OptionalKeys<S extends Shape> = {
  [K in keyof S]-?: S[K] extends { readonly _optionalBrand: true } ? K : never;
}[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;
export type ObjectOutput<S extends Shape> = {
  [K in RequiredKeys<S>]: Infer<S[K]>;
} & {
  [K in OptionalKeys<S>]?: Exclude<Infer<S[K]>, undefined>;
};

interface ObjectField {
  readonly key: string;
  readonly schema: Schema<unknown>;
  readonly optionalIndex: number;
}

/**
 * One `k`/`s` pair per field, after whatever `extra` values bind as `x0`, `x1`, … —
 * which is what keeps every key a runtime argument rather than interpolated source.
 */
function recordParts(fields: readonly ObjectField[], extra: readonly unknown[] = []) {
  const parameters = extra.map((_, index) => `x${index}`);
  const args = [...extra];
  for (let index = 0; index < fields.length; index++) {
    parameters.push(`k${index}`, `s${index}`);
    args.push(fields[index]!.key, fields[index]!.schema);
  }
  return { parameters, args };
}

/**
 * One generated record decoder per object schema. Three times the interpreted loop,
 * and no shared helper recovers it: V8 allocates one feedback vector per closure
 * *creation site*, so a shared `fields[i].schema._decode(r)` collects every object
 * schema's maps and goes megamorphic (2.7x with one schema loaded, 0.3x with a dozen).
 *
 * Keys are arguments, never interpolated: `compile()` may take a key from a fetched
 * JSON Schema, and 5% is cheap for never parsing one as code. Returns undefined under
 * a CSP without `unsafe-eval`, where the interpreted path below is complete.
 */
function buildRecordDecoder(
  fields: readonly ObjectField[],
): ((reader: Reader) => Record<string, unknown>) | undefined {
  try {
    const { parameters, args } = recordParts(fields);
    const properties = fields.map((_, index) => `[k${index}]:s${index}._decode(r)`);
    const make = new Function(
      ...parameters,
      `return function(r){return{${properties.join(",")}}}`,
    ) as (...args: unknown[]) => (reader: Reader) => Record<string, unknown>;
    return make(...args);
  } catch {
    return undefined;
  }
}

/**
 * The encode-side twin of `buildRecordDecoder`, for its reasons and under its rules.
 * Here the shared loop that goes megamorphic is `for (const field of this.fields)`.
 */
function buildRecordEncoder(
  fields: readonly ObjectField[],
): ((writer: Writer, value: Record<string, unknown>) => void) | undefined {
  try {
    // `EncodeError` arrives as argument `x0` rather than a capture: a wrapper closure
    // would be one creation site shared by every schema — the megamorphism this exists
    // to avoid.
    const { parameters, args } = recordParts(fields, [EncodeError]);
    const statements = fields.map((_, index) => `s${index}._encode(w,v[k${index}])`);
    const make = new Function(
      ...parameters,
      `return function(w,v){if(typeof v!=="object"||v===null||Array.isArray(v))throw new x0("Expected an object");${statements.join(";")}}`,
    ) as (...args: unknown[]) => (writer: Writer, value: Record<string, unknown>) => void;
    return make(...args);
  } catch {
    return undefined;
  }
}

class ObjectSchema<S extends Shape> extends Schema<ObjectOutput<S>> {
  private readonly fields: ObjectField[];
  private readonly fieldNames: Set<string> | undefined;
  private readonly hasProtoField: boolean;
  private readonly inheritableField: boolean;
  private readonly optionalCount: number;
  /** Bytes the presence bitmap occupies, and 0 when the shape has no optionals. */
  private readonly bitmapWidth: number;
  private readonly generatedEncode:
    | ((writer: Writer, value: Record<string, unknown>) => void)
    | undefined;

  constructor(
    shape: S,
    private readonly rejectUnknownProperties: boolean,
    /**
     * The open half of an open object: undeclared keys follow the declared fields
     * through here, a `RecordSchema` in practice.
     *
     * Handed in already built rather than constructed here, which is the only reason
     * `m` still tree-shakes `RecordSchema` away: one `new RecordSchema(...)` in this
     * constructor cost every `m`-only bundle 491 gzip bytes for a shape it cannot
     * express. Undefined for a closed object, which is also what keeps the generated
     * encoder and decoder — both of which would drop the tail — off an open shape.
     */
    private readonly tail?: Schema<Record<string, unknown>>,
  ) {
    super();
    const keys = canonicalKeyOrder(Object.keys(shape));
    const numericKey = keys.find((key) => /^(0|[1-9]\d*)$/.test(key));
    if (numericKey !== undefined) {
      throw new EncodeError(`Numeric object key ${numericKey} is not supported`);
    }
    let optionalIndex = 0;
    this.fields = keys.map((key) => {
      const declared = shape[key]!;
      if (declared instanceof OptionalSchema) {
        return { key, schema: declared.inner, optionalIndex: optionalIndex++ };
      }
      return { key, schema: declared, optionalIndex: -1 };
    });
    // Also built for an open object, which needs the same set to find undeclared keys
    // rather than to refuse them.
    this.fieldNames = rejectUnknownProperties || tail !== undefined ? new Set(keys) : undefined;
    this.hasProtoField = keys.includes("__proto__");
    this.inheritableField = keys.some((key) => key in Object.prototype);
    this.optionalCount = optionalIndex;
    this.bitmapWidth = Math.ceil(optionalIndex / 8);
    // The bitmap is always emitted; an absent optional adds nothing beyond it.
    let width = this.bitmapWidth + (this.tail?._minWidth ?? 0);
    for (const field of this.fields) {
      if (field.optionalIndex < 0) width += field.schema._minWidth;
    }
    this._minWidth = width;

    // Own property, shadowing the prototype method, so the generated function is the
    // whole decoder rather than a branch inside one. Gated as the interpreted fast path
    // below is: a bitmap makes the field set dynamic, and `__proto__` needs
    // defineProperty.
    if (optionalIndex === 0 && !this.hasProtoField && this.tail === undefined) {
      const generated = buildRecordDecoder(this.fields);
      if (generated !== undefined) {
        this._decode = generated as (reader: Reader) => ObjectOutput<S>;
      }
    }

    // Held in a field and dispatched from the prototype method, *not* shadowed onto the
    // instance the way the decoder is: a distinct `_encode` per schema tips
    // `ArraySchema`'s shared `this.item._encode(...)` site megamorphic, measured at
    // -25% on an array of plain uints — a shape holding no object schema at all.
    if (
      optionalIndex === 0 &&
      !this.inheritableField &&
      !rejectUnknownProperties &&
      this.tail === undefined
    ) {
      this.generatedEncode = buildRecordEncoder(this.fields);
    }
  }

  _encode(writer: Writer, value: ObjectOutput<S>): void {
    if (this.generatedEncode !== undefined) {
      this.generatedEncode(writer, value as Record<string, unknown>);
      return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new EncodeError("Expected an object");
    }

    const record = value as Record<string, unknown>;
    if (this.rejectUnknownProperties) {
      const unknownKey = Object.keys(record).find((key) => !this.fieldNames!.has(key));
      if (unknownKey !== undefined) {
        throw new EncodeError(`Unknown object property ${JSON.stringify(unknownKey)}`);
      }
    }

    // A field named like an `Object.prototype` member would otherwise be found on every
    // plain object and missing from every null-prototype one, so the same own data
    // would encode to different bytes. Staging through a null-prototype record restores
    // canonical form; schemas without such a field read the caller's object directly.
    const source = this.inheritableField ? this.ownFields(record) : record;

    if (this.optionalCount === 0) {
      for (const field of this.fields) {
        field.schema._encode(writer, source[field.key]);
      }
      this.writeExtras(writer, record);
      return;
    }

    const bitmap = new Uint8Array(this.bitmapWidth);
    const optionalValues = new Array<unknown>(this.optionalCount);
    for (const field of this.fields) {
      if (field.optionalIndex >= 0) {
        const fieldValue = source[field.key];
        optionalValues[field.optionalIndex] = fieldValue;
        if (fieldValue !== undefined) {
          bitmap[field.optionalIndex >> 3]! |= 1 << (field.optionalIndex & 7);
        }
      }
    }
    writer.bytes(bitmap);

    for (const field of this.fields) {
      if (field.optionalIndex >= 0) {
        const present =
          (bitmap[field.optionalIndex >> 3]! & (1 << (field.optionalIndex & 7))) !== 0;
        if (present) {
          field.schema._encode(writer, optionalValues[field.optionalIndex]);
        }
      } else {
        field.schema._encode(writer, source[field.key]);
      }
    }
    this.writeExtras(writer, record);
  }

  /**
   * The keys the schema did not name, written as a record after the declared fields.
   * A closed object returns on the first line.
   */
  private writeExtras(writer: Writer, record: Record<string, unknown>): void {
    if (this.tail === undefined) return;
    const extras = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!this.fieldNames!.has(key)) extras[key] = record[key];
    }
    this.tail._encode(writer, extras);
  }

  /**
   * `defineProperty` throughout, not `Object.assign`: assignment goes through
   * `[[Set]]`, and a decoded `__proto__` key would reassign the prototype.
   *
   * A key repeating a declared field is refused rather than merged — it would
   * overwrite the field decoded moments earlier, so two payloads would decode alike.
   */
  private readExtras(reader: Reader, result: Record<string, unknown>): void {
    if (this.tail === undefined) return;
    const extras = this.tail._decode(reader);
    for (const key of Object.keys(extras)) {
      if (this.fieldNames!.has(key)) {
        throw new DecodeError(
          `Extra property ${JSON.stringify(key)} repeats a declared field`,
          reader.position,
        );
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: extras[key],
        writable: true,
      });
    }
  }

  /**
   * Absent optionals are skipped: the field's schema here is the unwrapped inner one,
   * which would reject the `undefined` that only means the field is not there.
   */
  override _failingChild(value: unknown): FailingChild | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    const scratch = new Writer();
    for (const field of this.fields) {
      const fieldValue = record[field.key];
      if (field.optionalIndex >= 0 && fieldValue === undefined) continue;
      try {
        field.schema._encode(scratch, fieldValue);
      } catch {
        return { schema: field.schema, segment: field.key, value: fieldValue };
      }
    }
    return undefined;
  }

  private ownFields(record: Record<string, unknown>): Record<string, unknown> {
    const own = Object.create(null) as Record<string, unknown>;
    for (const field of this.fields) {
      if (Object.hasOwn(record, field.key)) own[field.key] = record[field.key];
    }
    return own;
  }

  _decode(reader: Reader): ObjectOutput<S> {
    const result: Record<string, unknown> = {};
    if (this.optionalCount === 0 && !this.hasProtoField) {
      for (const field of this.fields) result[field.key] = field.schema._decode(reader);
      this.readExtras(reader, result);
      return result as ObjectOutput<S>;
    }

    const bitmap = this.optionalCount === 0 ? undefined : reader.bytes(this.bitmapWidth);
    if (bitmap !== undefined && this.optionalCount % 8 !== 0) {
      const padding = bitmap[bitmap.length - 1]! >>> (this.optionalCount % 8);
      if (padding !== 0) {
        throw new DecodeError("Non-canonical presence bitmap padding", reader.position);
      }
    }
    for (const field of this.fields) {
      if (
        field.optionalIndex >= 0 &&
        (bitmap![field.optionalIndex >> 3]! & (1 << (field.optionalIndex & 7))) === 0
      ) {
        // An absent optional named like an `Object.prototype` member would read back as
        // the inherited member — an optional `toString` decoding to a function, which
        // the vendor's validate() then rejects. A non-enumerable own `undefined`
        // shadows it. A null-prototype record was tried and handed back objects that
        // failed `String()` and `instanceof Object`.
        if (this.inheritableField && field.key in Object.prototype) {
          Object.defineProperty(result, field.key, {
            configurable: true,
            enumerable: false,
            value: undefined,
            writable: true,
          });
        }
        continue;
      }
      const decoded = field.schema._decode(reader);
      if (field.key === "__proto__") {
        Object.defineProperty(result, field.key, {
          configurable: true,
          enumerable: true,
          value: decoded,
          writable: true,
        });
      } else {
        result[field.key] = decoded;
      }
    }
    this.readExtras(reader, result);
    return result as ObjectOutput<S>;
  }
}

export function createObjectSchema<S extends Shape>(
  shape: S,
  rejectUnknownProperties = false,
  tail?: Schema<Record<string, unknown>>,
): Schema<ObjectOutput<S>> {
  return new ObjectSchema(shape, rejectUnknownProperties, tail);
}

export const m = {
  string: (): Schema<string> => new StringSchema(),
  bytes: (): Schema<Uint8Array> => new BytesSchema(),
  boolean: (): Schema<boolean> => new BooleanSchema(),
  uint: (): Schema<number> => new UintSchema(),
  int: (): Schema<number> => new IntSchema(),
  float32: (): Schema<number> => new Float32Schema(),
  float64: (): Schema<number> => new Float64Schema(),
  literal: <const T extends string | number | boolean | null>(value: T): Schema<T> =>
    new LiteralSchema(value),
  enum: <const T extends readonly [EnumValue, ...EnumValue[]]>(values: T): Schema<T[number]> =>
    new EnumSchema(values),
  array: <T>(item: Schema<T>, length?: number): Schema<T[]> => new ArraySchema(item, length),
  // No rest parameter, deliberately: `TupleSchema` takes one and `compile` uses it, but
  // typing it on `m` means a variadic return type and two casts to reach it.
  // `RecordSchema`, `UnionSchema` and `DynamicSchema` are absent for the same reason.
  tuple: <const S extends readonly Schema<unknown>[]>(items: S): Schema<TupleOutput<S>> =>
    new TupleSchema(items),
  object: <S extends Shape>(shape: S): Schema<ObjectOutput<S>> => createObjectSchema(shape),
};
