import type { StandardSchemaV1 } from "@standard-schema/spec";

const MAX_COLLECTION_LENGTH = 1_000_000;
const ASCII_FAST_PATH_LIMIT = 8;
/**
 * Code units below which `Writer.string` copies them by hand rather than calling
 * `encodeInto`. The native call costs a flat ~45ns whatever the length while the loop
 * costs about 0.9ns per unit, so the crossover is where they meet — `bench/string-threshold.mjs`
 * sweeps it. It sat at 128 only because the one-byte length varint is valid up to there,
 * which bounds the *speculation*, not the strategy.
 */
const ASCII_WRITE_LIMIT = 48;
/** Floats one `Reader` must read before a `DataView` over the input pays for itself. */
const FLOAT_VIEW_TRIP = 8;
const MAX_BYTE_LENGTH = 64 * 1024 * 1024;
const MAX_RETAINED_BUFFER_BYTES = 64 * 1024;
const SLICE_COPY_LIMIT = 16;

/**
 * The one total order behind every canonical wire decision. UTF-16 code-unit order,
 * which is `Array.prototype.sort`'s default and the reason no comparator is passed —
 * every caller sorts strings, where the default's string coercion is a no-op. Swapping
 * in `localeCompare`, `Intl.Collator`, code points or case folding changes the bytes of
 * every object and every string enum. Named members only; tuple and array elements
 * are positional.
 */
export function canonicalKeyOrder(keys: readonly string[]): string[] {
  return [...keys].sort();
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
  return value instanceof Uint8Array || hasTag(value, "[object Uint8Array]");
}

/**
 * The realm-tolerant half of a type test, for the reason above: a Date, Set or Map
 * from another realm fails `instanceof` too. Callers try `instanceof` first, so a
 * same-realm value never reaches the `toString` call.
 */
function hasTag(value: unknown, tag: string): boolean {
  return Object.prototype.toString.call(value) === tag;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Node's own UTF-8 decoder, when there is one — 45% cheaper than `TextDecoder` at every
 * length measured, and the difference is the whole cost of decoding a document.
 *
 * `Buffer.prototype.utf8Slice` rather than a `Buffer`: it runs on any `Uint8Array`, so
 * no view is allocated per call. Wrapping the input in `Buffer.from` per call measured
 * *slower than doing nothing* (67ns against TextDecoder's 59ns on four bytes), and
 * caching one view per `Reader` would only move that cost onto single-string payloads.
 *
 * A global lookup, never an import: shorn ships no Node built-in, and a browser, a
 * worker, or a Deno without the Node shim simply finds nothing here and keeps using
 * `TextDecoder`. Bun and Deno's Node compatibility both provide it.
 *
 * Guarded, because it does not share `TextDecoder`'s contract: it substitutes U+FFFD
 * where the fatal decoder throws. See `Reader.string`.
 */
const nodeUtf8Slice: ((this: Uint8Array, start: number, end: number) => string) | undefined =
  typeof Buffer === "function" && typeof Buffer.prototype?.utf8Slice === "function"
    ? Buffer.prototype.utf8Slice
    : undefined;

/**
 * The character Node substitutes for every malformed sequence, and therefore the one
 * that has to send a string back to the fatal decoder for a second opinion.
 */
const REPLACEMENT_CHARACTER = "�";

/**
 * Whether a string is free of unpaired surrogates, which is the one thing `encodeInto`
 * will not report: it substitutes U+FFFD where shorn refuses, so a lone surrogate would
 * round-trip as a different string.
 *
 * `String.prototype.isWellFormed` where there is one, and it is not merely a tidier
 * spelling of the loop below — V8 answers in constant time for a one-byte string, which
 * cannot hold a surrogate at all, and scans about seven times faster than JS when it has
 * to. That is what lets `Writer.string` stop counting UTF-8 bytes by hand.
 *
 * The regex is for runtimes older than the method (Node 20 has it; Safari below 16.4 and
 * Firefox below 119 do not). It is the same question asked another way: under `u`, a
 * well-formed pair is one astral code point and never matches `\p{Surrogate}`, while a
 * lone one is a surrogate code point and always does. Checked against the native method
 * over 300k random strings before it was written down.
 */
const LONE_SURROGATE = /\p{Surrogate}/u;
const isWellFormed: (value: string) => boolean =
  // Typed here rather than by raising `lib` to ES2024, which would also let
  // `Object.groupBy` and `Promise.withResolvers` typecheck — neither of which Node 20,
  // the supported floor, has.
  typeof (String.prototype as { isWellFormed?: unknown }).isWellFormed === "function"
    ? (value) => (value as unknown as { isWellFormed(): boolean }).isWellFormed()
    : (value) => !LONE_SURROGATE.test(value);

/**
 * A value in a message, or its type when naming it is what would fail. `String` on an
 * object throws when it has no `toString` — one with a null prototype — and when the
 * caller's own throws or a proxy trap does, and `JSON.stringify` adds a BigInt and a
 * cycle to that list. So the sentence meant to explain a refusal replaced it with an
 * error of its own, and the caller was told about their getter instead of about their
 * field. The rule `IntSchema` follows on its leaf, said once for the shapes whose
 * message quotes a value the schema does not constrain to a primitive.
 *
 * A `typeof` gate rather than a `try`: every remaining case is a primitive, and a
 * primitive stringifies both ways without running anything — Symbol and `undefined`
 * included, which `JSON.stringify` reports as `undefined` exactly as it always did.
 * The catch this replaced cost 28 gzip bytes and bought nothing over the gate.
 */
function text(value: unknown, json?: boolean): string {
  const kind = typeof value;
  if (value !== null && (kind === "object" || kind === "bigint")) return kind;
  return json === true ? `${JSON.stringify(value)}` : String(value);
}

/** Bytes `varuint` will spend on a value, for a length written before it is known. */
function varuintWidth(value: number): number {
  return value < 0x80 ? 1 : value < 0x4000 ? 2 : value < 0x200000 ? 3 : 4;
}

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
    // Bounded, because a recursive schema holding a value that refers to itself gives the
    // walk no bottom to reach: each step finds another failing child, forever. No encode
    // that got as far as producing a path nests deeper than this — `LazySchema` refuses
    // past it — so the bound truncates nothing a caller could otherwise have been told.
    for (let step = 0; step < MAX_RECURSION_DEPTH; step++) {
      const child: FailingChild | undefined = node._failingChild(current);
      if (child === undefined) break;
      // ponytail: a record or extras key is data, so a key of `a.b`, `[0]` or `""` joins
      // into a path indistinguishable from nesting. Quoting the segment — `a["a.b"]` — is
      // the upgrade, and it changes the documented `user.address.zip` shape for every
      // caller who parses a path, so it waits for someone the ambiguity hurts.
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
 * The first child whose encode throws, into a throwaway Writer. Every container's
 * `_failingChild` is this loop; only the children differ. Reached solely from
 * `encodePath`, after an encode has already failed, so the array each caller builds
 * costs nothing on any live path.
 */
function firstFailing(children: Iterable<FailingChild>): FailingChild | undefined {
  const scratch = new Writer();
  for (const child of children) {
    try {
      child.schema._encode(scratch, child.value);
    } catch {
      return child;
    }
  }
  return undefined;
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
  private buffer: Uint8Array = new Uint8Array(64);
  private offset = 0;

  /**
   * Built on first float, discarded when the buffer moves — a schema with no float
   * field would otherwise pay for a DataView on every encode.
   */
  private view: DataView | undefined;

  private ensure(size: number): void {
    const required = this.offset + size;
    if (required <= this.buffer.length) return;

    // `|| 64`: an `encodeInto` target may be empty, and doubling zero never arrives.
    let capacity = this.buffer.length || 64;
    while (capacity < required) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.buffer);
    this.buffer = next;
    this.view = undefined;
  }

  private floats(): DataView {
    // Over the view's own window, not the whole ArrayBuffer: an `encodeInto` target is
    // usually a subarray of a frame, and `setFloat64(this.offset)` is relative to it.
    return (this.view ??= new DataView(
      this.buffer.buffer,
      this.buffer.byteOffset,
      this.buffer.byteLength,
    ));
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
    // loop: skips Number.isSafeInteger, the 8-byte reserve and the shift loop. The
    // comparison leads and `Number.isInteger` trails, so a multi-byte value never pays
    // for the predicate — hoisting it measured -4% on a 500-element array of millisecond
    // timestamps. That order also means a value JavaScript declines to coerce throws out
    // of `value >= 0` before anything here could refuse it politely, which is why
    // `UintSchema` refuses one before the call.
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
    // Short ASCII in one pass, speculatively: below the gate an ASCII string's UTF-8
    // length is its code-unit count, so the length byte can be written before that is
    // confirmed and rewound on the first unit at or above 0x80.
    // `bench/string-threshold.mjs` is what measures the gate.
    const units = value.length;
    if (units < ASCII_WRITE_LIMIT) {
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
      // Not ASCII after all: rewind and let the general path below write the whole
      // string, `encodeInto`'s flat ~45ns included. Finishing it here with a hand-written
      // UTF-8 loop instead measured 2x on a short accented string and cost 238 gzip
      // bytes — the worst byte-per-benefit on this path, for 25 lines reimplementing
      // `TextEncoder`. Worth revisiting only if short non-ASCII encode becomes the
      // complaint, and the flush-against-the-buffer-end case it needs is already pinned
      // in `test/core.test.ts`.
      this.offset = start;
    }

    // Nothing counts UTF-8 bytes by hand any more. `encodeInto` already knows the total
    // and reports it, so the only question left for JS is well-formedness — and that is
    // free on a one-byte string. The hand-written scan this replaced was 85% of an ASCII
    // encode at 256 units and 99% at 64K; `bench/string-threshold.mjs` measures both.
    if (!isWellFormed(value)) throw new EncodeError("String contains an unpaired surrogate");
    if (units > MAX_BYTE_LENGTH) throw new EncodeError("String is too large");

    // Written before the length is known, so the length varint has to be reserved. The
    // width of `units` is the right guess: UTF-8 is never shorter than the code-unit
    // count, so the real width is this or wider — never narrower — and for ASCII, which
    // is most strings, it is exactly this and nothing moves afterwards.
    const reserved = varuintWidth(units);
    // Capped rather than the plain 3x bound: a 30M-unit string of 3-byte characters is
    // over the ceiling and must be refused *without* first growing the buffer to 90MB.
    // `encodeInto` stops on a character boundary when the destination fills, and a short
    // `read` is how that is detected.
    //
    // ponytail: reserving 3x means a 60MB ASCII string peaks at a 128MB buffer where the
    // scan this replaced sized it exactly at 64MB — traded for not walking 60M code units
    // to learn a length `encodeInto` reports for free. `Writer.reset` drops the buffer
    // straight after, so it is a peak and not a leak. Size it exactly for strings past a
    // megabyte if that peak ever matters.
    const capacity = Math.min(units * 3, MAX_BYTE_LENGTH + 1);
    // Room for the *widest* varint the payload could need, not the one guessed above.
    // The backfill shifts the payload up by a byte when the guess is short, and that
    // shift has to land inside the buffer: reserving only the guess truncated the last
    // byte of, say, a 48-character CJK string whenever the reserve ended flush on the
    // end of the buffer — silently, since a store past a Uint8Array is dropped, not
    // thrown. `varuintWidth` is monotonic and `written <= capacity`, so this bounds it.
    this.ensure(varuintWidth(capacity) + capacity);
    const start = this.offset + reserved;
    const { read, written } = textEncoder.encodeInto(
      value,
      this.buffer.subarray(start, start + capacity),
    );
    if (read < units || written > MAX_BYTE_LENGTH) throw new EncodeError("String is too large");

    // The move comes first: a wider varint than was reserved reaches into the payload's
    // first byte, so writing it before the bytes are out of the way corrupts them.
    // A native memmove, and only when the guess was a byte short — never for ASCII.
    const width = varuintWidth(written);
    if (width !== reserved) this.buffer.copyWithin(this.offset + width, start, start + written);
    this.putVaruint(this.offset, written, width);
    this.offset += width + written;
  }

  /** A varint of a known width at a known offset, for a length reserved before it was known. */
  private putVaruint(at: number, value: number, width: number): void {
    const buffer = this.buffer;
    let word = value;
    for (let index = at; index < at + width - 1; index++) {
      buffer[index] = (word & 0x7f) | 0x80;
      word >>>= 7;
    }
    buffer[at + width - 1] = word;
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

/**
 * The Writer `encodeInto` reuses, created by the first call so a bundle that never
 * imports the function never holds one. Pooled and guarded as `pooledWriter` is, for
 * the same re-entrancy: an `encodeInto` reached from a getter inside another gets a
 * fresh Writer rather than the one already pointed at the outer frame.
 */
let targetWriter: Writer | undefined;
let targetWriterBusy = false;

/**
 * `Writer`'s private fields, reached from `encodeInto` by cast. Two small methods on
 * the class would be the tidy way, and a class method is never tree-shaken: measured at
 * +348 minified and +91 gzip on every `m`-only bundle, past the 1% gate, for a function
 * none of them import. The test suite reaches the same fields the same way.
 */
interface OpenWriter {
  buffer: Uint8Array;
  offset: number;
  view: DataView | undefined;
}

/**
 * Encodes into a buffer the caller owns and returns the offset just past the last byte
 * written, so consecutive calls pack a frame: `end = encodeInto(codec, next, frame, end)`.
 * The bytes are exactly `codec.encode(value)`'s. What is saved is the output array and
 * the copy into the frame that follows it, which together were about half of a small
 * encode: 48 ns to 23 ns on the Person fixture, and a 100-message frame in 40% of the
 * time. A free function rather than a method on `Schema`, for `encodeAsync`'s reason:
 * a method is never tree-shaken, and most callers hand `encode()`'s array straight to
 * a send.
 *
 * Throws `EncodeError` when the value does not fit, and `target` may then hold a
 * partial write from `offset` on. Decoding needs no counterpart: `decode` takes any
 * `Uint8Array` view, so a reader hands it `frame.subarray(start, end)`.
 */
export function encodeInto<T>(codec: Schema<T>, value: T, target: Uint8Array, offset = 0): number {
  if (!isUint8Array(target)) {
    throw new EncodeError(`Expected a Uint8Array target, received ${typeof target}`);
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > target.length) {
    throw new EncodeError(`Target offset ${text(offset)} is outside the target`);
  }
  const pooled = !targetWriterBusy;
  const writer = pooled ? (targetWriter ??= new Writer()) : new Writer();
  if (pooled) targetWriterBusy = true;
  const open = writer as unknown as OpenWriter;
  // The DataView survives while the same frame keeps coming back, which is what a
  // reused frame buffer does; a new target drops it.
  if (open.buffer !== target) {
    open.buffer = target;
    open.view = undefined;
  }
  open.offset = offset;
  try {
    codec._encode(writer, value);
    // A value that did not fit made `ensure` grow into a buffer of its own: the target
    // holds a partial write and the grown copy is garbage. Detected here rather than
    // refused inside `ensure`, where a flag and a message would sit in every bundle.
    if (open.buffer !== target) {
      throw new EncodeError("Target buffer is too small for this value");
    }
    return open.offset;
  } catch (error) {
    throw withPath(error, codec, value);
  } finally {
    // A target larger than the pool keeps, or a buffer grown past one, is let go for
    // `reset`'s reason: a one-off frame must not stay pinned to a module-level Writer.
    if (open.buffer !== target || target.length > MAX_RETAINED_BUFFER_BYTES) {
      open.buffer = new Uint8Array(0);
      open.view = undefined;
    }
    if (pooled) targetWriterBusy = false;
  }
}

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
    // `bytes()` inlined rather than called, for the view it would allocate: both decoders
    // below can read a range of the input directly, so the only string that needs one is
    // the malformed one on the way to being refused.
    if (length > MAX_BYTE_LENGTH) {
      throw new DecodeError(`Invalid byte length ${length}`, this.offset);
    }
    const from = this.offset;
    const to = from + length;
    if (to > this.buffer.length) throw new DecodeError("Unexpected end of input", from);
    this.offset = to;

    // Node's decoder first, and it keeps the fatal contract rather than weakening it.
    // `utf8Slice` substitutes U+FFFD for every malformed sequence, so a result with no
    // U+FFFD in it *proves* the input was well formed — that is the whole check, and
    // `String.prototype.indexOf` is a native scan rather than a byte loop in JS, which
    // is why an explicit ASCII pre-scan lost past 64 bytes and this does not.
    //
    // A hit sends the string to `textDecoder` for the definitive answer, so malformed
    // input throws exactly as before, and a legitimately encoded U+FFFD comes back
    // intact instead of being mistaken for corruption. Both cases are rare and pay one
    // extra pass; nothing is accepted that the fatal decoder would have refused.
    if (nodeUtf8Slice !== undefined) {
      const decoded = nodeUtf8Slice.call(this.buffer, from, to);
      if (decoded.indexOf(REPLACEMENT_CHARACTER) < 0) return decoded;
    }
    try {
      return textDecoder.decode(this.buffer.subarray(from, to));
    } catch (error) {
      throw new DecodeError("Invalid UTF-8", from, { cause: error });
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

  /**
   * The unsigned reader past one byte: the multi-byte body `varuintWide` shares,
   * refusing a result that body had to widen. Both readers have the same shape, an
   * inline one-byte path in front of one small slow body, and two shapes that look
   * equivalent are cliffs, measured on 500-element arrays:
   *
   *   - delegating this to a `varuintWide` that still held its BigInt tail inline
   *     measured 3x slower on 2- and 3-byte uints;
   *   - rewriting `varuintWide` on the integer unit without the inline one-byte path
   *     measured 2x slower on one- and two-byte ints.
   *
   * Both are the inlining-budget behaviour `float64`/`float64Slow` documents: the hot
   * body has to stay small and BigInt-free, so the tail lives in `varuintBig`.
   */
  private varuintSlow(): number {
    const value = this.varuintWideSlow();
    if (typeof value !== "number") {
      throw new DecodeError("Integer exceeds JavaScript's safe range", this.offset);
    }
    return value;
  }

  /**
   * Stays a `number` while the value is representable as one, widening to `bigint`
   * only when it is not. The unconditional `bigint` reader this replaced cost the
   * signed-integer decoder three BigInt allocations per value in the range where none
   * were needed. The same inline one-byte path as `varuint`, then the same slow body;
   * `varuintSlow` names the two shapes that measured as cliffs.
   */
  varuintWide(): number | bigint {
    const first = this.buffer[this.offset];
    if (first !== undefined && first < 0x80) {
      this.offset++;
      return first;
    }
    return this.varuintWideSlow();
  }

  /**
   * Two registers so every byte stays on the integer unit, as `Writer.varuint` does on
   * the way out: bytes one to four fill `low`, five to eight fill `high`, and 28 bits of
   * payload cannot overflow int32 in either. The float loop this replaced, a multiply,
   * an add and a `Number.isSafeInteger` per byte from the fifth, measured 4% slower on
   * 500 millisecond timestamps, head to head over five processes. A value past 2^53 is
   * read again in `varuintBig`, from the start `offset` still marks since it is only
   * committed on success; so is anything that reaches a ninth byte. Entered only past
   * the one-byte path, so the first byte here is never terminal and a terminal zero is
   * non-canonical at any position.
   */
  private varuintWideSlow(): number | bigint {
    const buffer = this.buffer;
    let at = this.offset;
    let low = 0;
    for (let shift = 0; shift < 28; shift += 7) {
      if (at >= buffer.length) throw new DecodeError("Unexpected end of input", at);
      const byte = buffer[at++]!;
      low |= (byte & 0x7f) << shift;
      if (byte < 0x80) {
        if (byte === 0) throw new DecodeError("Non-canonical variable-length integer", at);
        this.offset = at;
        return low;
      }
    }
    let high = 0;
    for (let shift = 0; shift < 28; shift += 7) {
      if (at >= buffer.length) throw new DecodeError("Unexpected end of input", at);
      const byte = buffer[at++]!;
      high |= (byte & 0x7f) << shift;
      if (byte < 0x80) {
        if (byte === 0) throw new DecodeError("Non-canonical variable-length integer", at);
        // 2^25 in the high register is 2^53 in the value.
        if (high >= 0x2000000) return this.varuintBig();
        this.offset = at;
        return low + high * 0x10000000;
      }
    }
    // A ninth byte means a value past 2^56 or a malformed encoding; the tail tells which.
    return this.varuintBig();
  }

  /**
   * A value past 2^53, or an encoding past eight bytes, read again from its first byte
   * in BigInt: rare, so cold, and the one place the ten-byte cap is enforced.
   */
  private varuintBig(): bigint {
    let large = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = this.byte();
      large |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) {
        if (byte === 0) {
          throw new DecodeError("Non-canonical variable-length integer", this.offset);
        }
        return large;
      }
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
   * Array slots a decode of this schema materializes before reading a byte. Zero for
   * everything the `_minWidth` budget already bounds: the one shape that allocates for
   * free is a fixed-count array of a zero-width element, whose count comes from the
   * schema rather than the input. Nesting those multiplies, so `ArraySchema` holds the
   * product to the same collection ceiling a length varint answers to — without it three
   * levels of a million turn an empty payload into 10^18 slots and a fatal OOM. Summed
   * by the two containers that can be zero-width themselves; every other shape costs at
   * least a byte, which makes its slots the input's problem and not this counter's.
   */
  _slots = 0;

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
    const pooled = !pooledWriterBusy;
    const writer = pooled ? pooledWriter : new Writer();
    if (pooled) pooledWriterBusy = true;
    try {
      this._encode(writer, value);
      return writer.finish();
    } catch (error) {
      throw withPath(error, this, value);
    } finally {
      if (pooled) {
        // On the way out, so a throw leaves a clean Writer behind.
        writer.reset();
        pooledWriterBusy = false;
      }
    }
  }

  decode(value: Uint8Array): T {
    if (!isUint8Array(value)) {
      throw new DecodeError(`Expected a Uint8Array, received ${typeof value}`, 0);
    }
    // Not pooled, though `Writer` is. Reusing one Reader across decodes was measured at
    // -35% on a person decode: the `try`/`finally` a pool needs to return it blocks V8
    // from optimizing this function, whose `this._decode(reader)` is megamorphic, and a
    // nursery allocation is cheaper than that. Same finding as `encodePath`'s.
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
    // On the leaf and not in `varuint`, because every other caller of that hands it a
    // number it computed itself — an array length, a record count, an enum or union
    // index — so a check there charges all of them for a case only a caller's value can
    // reach. Measured on 500 millisecond timestamps, every value multi-byte: this 1%, the
    // same check inside `varuint` 2%, hoisting `Number.isInteger` there 4%, against a
    // byte-identical control at 0.1%. `Float64Schema` guards its leaf the same way, and
    // the type is all the message can report: interpolating the value throws on a Symbol.
    if (typeof value !== "number") {
      throw new EncodeError(`Expected an unsigned safe integer, received ${typeof value}`);
    }
    writer.varuint(value);
  }

  _decode(reader: Reader): number {
    return reader.varuint();
  }
}

export class IntSchema extends Schema<number> {
  _encode(writer: Writer, value: number): void {
    if (!Number.isSafeInteger(value)) {
      // The type, not the value, for anything that is not a number: `${value}` throws on a
      // Symbol and on an object whose `valueOf` throws, so the message meant to explain
      // the refusal would replace it with an error of its own. This leaf needs no guard
      // beside it, unlike `UintSchema` — `Number.isSafeInteger` already answers false for
      // both without coercing anything.
      throw new EncodeError(
        `Expected a safe integer, received ${typeof value === "number" ? value : typeof value}`,
      );
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

  /**
   * No segment of its own, as `UnionSchema` and `LazySchema` also have none: the
   * position holding the wrapper is the parent's to name, and without this the path
   * stops there. The absent case ends the walk rather than descending — `_encode` never
   * reached `inner`, so no failure came from there, and `inner` would refuse the
   * sentinel that only means "not present".
   */
  override _failingChild(value: unknown): FailingChild | undefined {
    if (value === undefined) return undefined;
    return this.inner._failingChild(value);
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

  /**
   * Descends for the reason `OptionalSchema._failingChild` does, with `null` as the
   * sentinel that ends the walk. Copied rather than shared, per that class's brand.
   */
  override _failingChild(value: unknown): FailingChild | undefined {
    if (value === null) return undefined;
    return this.inner._failingChild(value);
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
    // The second test is `LiteralSchema`'s `Object.is`, and a Map is why it is needed
    // here: keys compare with SameValueZero, so `-0` finds the `0` member, is written as
    // that member's index and reads back as `0`.
    //
    // `value === 0` leads, and it is not redundant — it is what keeps the call off the
    // hot path. Comparing the member instead, `!Object.is(this.values[index], value)`,
    // reads a field and calls on every encode and measured **-12%** on the unchecked
    // person fixture, whose one enum field is a third of the record. A `-0` against an
    // enum with no `0` member is already `index === undefined`, so this second test only
    // ever decides the case it is here for.
    if (index === undefined || (value === 0 && Object.is(value, -0))) {
      throw new EncodeError(
        `Unknown enum value ${Object.is(value, -0) ? "-0" : text(value)}`,
      );
    }
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
  throw new EncodeError(`Expected a lowercase UUID, received ${text(value)}`);
}

/**
 * Every byte as its two lowercase hex characters, built by the first UUID decoded rather
 * than at load. A module-level `Array.from` is a call a bundler has to keep, and keeping
 * it cost an `m`-only bundle 114 gzip bytes for a table nothing in it can reach; an
 * unassigned `let` and a function only `UuidSchema` calls leave with the class.
 */
let hexPairs: string[] | undefined;

function hexPairTable(): string[] {
  return (hexPairs ??= Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0")));
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

  /**
   * A table lookup per byte, not `toString(16)` on four-byte words: those words are heap
   * numbers, and V8's radix conversion for them was the whole cost of the decode, 570 to
   * 660 ns per UUID against about 80 this way. Sixteen `byte()` calls rather than one
   * bounds check over the input: a `Reader` method to do that is never tree-shaken, so it
   * charged every `m`-only bundle 20 gzip bytes for a shape `m` cannot build, and it
   * saved 20 ns of the 80. `bytes(16)` measured the same as this and allocates a view.
   */
  _decode(reader: Reader): string {
    const hex = hexPairTable();
    return (
      hex[reader.byte()]! + hex[reader.byte()]! + hex[reader.byte()]! + hex[reader.byte()]! + "-" +
      hex[reader.byte()]! + hex[reader.byte()]! + "-" +
      hex[reader.byte()]! + hex[reader.byte()]! + "-" +
      hex[reader.byte()]! + hex[reader.byte()]! + "-" +
      hex[reader.byte()]! + hex[reader.byte()]! + hex[reader.byte()]! +
      hex[reader.byte()]! + hex[reader.byte()]! + hex[reader.byte()]!
    );
  }
}

/**
 * The widest time value a `Date` can hold, from the spec's TimeClip: anything past it
 * is an Invalid Date, so a decoded millisecond count beyond it names no Date at all.
 */
const MAX_DATE_MS = 8.64e15;

/**
 * A `Date` as its epoch milliseconds, ZigZag varint like an `int`: 6 bytes for any date
 * this century, fewer near 1970, and exact, since a Date holds nothing finer than a
 * millisecond. Delegated to `IntSchema` rather than to `writer.varuint` directly because
 * the ZigZag of a date near either end of the range leaves the safe-integer range, and
 * that class already has the BigInt tail for it.
 *
 * Invalid Date is refused: its time value is NaN, which no integer holds.
 */
export class DateSchema extends Schema<Date> {
  private readonly ints = new IntSchema();

  _encode(writer: Writer, value: Date): void {
    // The tag can be forged with `Symbol.toStringTag`, and a forgery has no `getTime`;
    // without the third test the call below escaped as a TypeError rather than this.
    if (
      !(
        value instanceof Date ||
        (hasTag(value, "[object Date]") && typeof (value as Date).getTime === "function")
      )
    ) {
      throw new EncodeError(`Expected a Date, received ${text(value)}`);
    }
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new EncodeError("Expected a valid Date, received an Invalid Date");
    this.ints._encode(writer, ms);
  }

  _decode(reader: Reader): Date {
    const ms = this.ints._decode(reader);
    if (ms > MAX_DATE_MS || ms < -MAX_DATE_MS) {
      throw new DecodeError(`Date value ${ms} is out of range`, reader.position);
    }
    return new Date(ms);
  }
}

/**
 * A `format: "date-time"` string as the Date it names, 6 bytes rather than 24 to 30
 * characters. Reached only from `compile()`, so `m` does not carry it.
 *
 * Canonical spelling only, refused rather than normalized, for `UuidSchema`'s reason:
 * epoch milliseconds cannot hold a fractional-digit count or an offset, so only the
 * string `toISOString` would write survives the trip, and returning that one for any
 * other spelling would make `decode(encode(x))` differ from `x`.
 */
export class DateTimeSchema extends Schema<string> {
  private readonly dates = new DateSchema();

  _encode(writer: Writer, value: string): void {
    if (typeof value !== "string") {
      throw new EncodeError(`Expected an ISO-8601 date-time string, received ${typeof value}`);
    }
    // `toISOString` throws on an Invalid Date, so the NaN test has to come first.
    const date = new Date(value);
    if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
      throw new EncodeError(
        `Expected a canonical ISO-8601 date-time (the toISOString() spelling), received ${value}`,
      );
    }
    this.dates._encode(writer, date);
  }

  _decode(reader: Reader): string {
    return this.dates._decode(reader).toISOString();
  }
}

/**
 * A `bigint` of any size: a varint header holding the magnitude's byte count doubled
 * plus the sign bit, then the magnitude little-endian with no high zero byte. Zero is
 * the single header byte `0`. The varint path was not reused because its reader caps
 * at ten bytes, and that cap is a hostile-input defence worth keeping.
 *
 * Canonical on both sides: a header of `1` (negative zero) and a zero high byte are
 * refused on decode, since either would give one value two encodings.
 *
 * Through hex text in both directions. `toString(16)` and `BigInt("0x…")` are native
 * and linear in the width, where a shift-and-mask loop in BigInt arithmetic allocates
 * a fresh BigInt per byte and goes quadratic; `hexNibble` and `hexPairTable` are
 * already here for UUIDs.
 */
export class BigIntSchema extends Schema<bigint> {
  _encode(writer: Writer, value: bigint): void {
    if (typeof value !== "bigint") {
      throw new EncodeError(`Expected a bigint, received ${typeof value}`);
    }
    const negative = value < 0n;
    let hex = (negative ? -value : value).toString(16);
    if (hex === "0") return writer.byte(0);
    if (hex.length % 2 === 1) hex = `0${hex}`;
    const count = hex.length / 2;
    if (count > MAX_BYTE_LENGTH) throw new EncodeError("BigInt is too large");
    writer.varuint(count * 2 + (negative ? 1 : 0));
    // Little-endian, so the last hex pair is the lowest byte and goes first.
    for (let index = hex.length - 2; index >= 0; index -= 2) {
      writer.byte((hexNibble(hex.charCodeAt(index)) << 4) | hexNibble(hex.charCodeAt(index + 1)));
    }
  }

  _decode(reader: Reader): bigint {
    const header = reader.varuint();
    // `& 1` keeps the low bit of any integer, as `IntSchema` notes; halving is exact.
    const negative = (header & 1) === 1;
    const count = (header - (negative ? 1 : 0)) / 2;
    if (count === 0) {
      if (negative) throw new DecodeError("Non-canonical bigint", reader.position);
      return 0n;
    }
    // `bytes` enforces the 64 MiB ceiling and the remaining-input check, before a single
    // hex digit is built: a header claiming 64 MiB over two bytes of input is refused here.
    //
    // ponytail: at the ceiling the hex text is 128M UTF-16 units, about 256 MB transient,
    // and `BigInt("0x…")` holds a second copy while it parses. Bounded by an input that
    // has to carry the 64 MiB itself; a 1 MiB magnitude round-trips in about 40 ms.
    // Chunked parsing (shift-and-or over 32-bit words from the top) would cap the
    // transient at the result's own size if a caller ever ships magnitudes that large.
    const bytes = reader.bytes(count);
    if (bytes[count - 1] === 0) throw new DecodeError("Non-canonical bigint", reader.position);
    const hex = hexPairTable();
    let digits = "";
    for (let index = count - 1; index >= 0; index--) digits += hex[bytes[index]!];
    const magnitude = BigInt(`0x${digits}`);
    return negative ? -magnitude : magnitude;
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
    }
    if (item._minWidth > 0) return;
    // A zero-width element decouples the count from the input length, so no budget can
    // bound a *variable* count: three bytes would ask for a million literals.
    //
    // A fixed count is the documented exemption and needs no input at all to satisfy, so
    // it has to be small enough to simply allocate. One fixed array of a million literals
    // stays legal; a second one around it does not, nor does a zero-width object or tuple
    // between them. Three levels of a million made an *empty* payload allocate 10^18
    // slots and took the process with it, and the exemption's advice — bound the outer
    // collection yourself — has no outer collection to bound.
    //
    // One refusal for both: the cause is the one thing and the ceiling is the one number,
    // and a second message with a second throw measured 56 gzip bytes. What a zero-width
    // element *is* moved to `api/errors.md`, which costs a reader nothing at runtime —
    // naming the three shapes here was 28 of the 91 gzip bytes this whole guard spends.
    const slots = length === undefined ? Infinity : length * (1 + item._slots);
    if (slots > MAX_COLLECTION_LENGTH) {
      throw new EncodeError(
        "Array elements must occupy at least one byte, or a fixed count of them must stay under the collection limit",
      );
    }
    this._slots = slots;
  }

  _encode(writer: Writer, value: T[]): void {
    if (!Array.isArray(value)) throw new EncodeError("Expected an array");
    if (this.length === undefined) {
      if (value.length > MAX_COLLECTION_LENGTH) throw new EncodeError("Array is too large");
      writer.varuint(value.length);
    } else if (value.length !== this.length) {
      throw new EncodeError(`Expected an array with ${this.length} items`);
    }
    // Both hoisted, and the count matters more than the field load: the length varint is
    // already written, so re-reading `value.length` each turn would let an element getter
    // that pushes onto the array write more elements than the count it declared.
    const item = this.item;
    const count = value.length;
    for (let index = 0; index < count; index++) {
      item._encode(writer, value[index]!);
    }
  }

  override _failingChild(value: unknown): FailingChild | undefined {
    if (!Array.isArray(value)) return undefined;
    // `Array.from`, not `.map`: map skips a sparse array's holes, and a hole is one of
    // the values that gets here — `_encode` writes it as `undefined` and throws.
    return firstFailing(
      Array.from(value, (item, index) => ({
        schema: this.item,
        segment: `[${index}]`,
        value: item,
      })),
    );
  }

  _decode(reader: Reader): T[] {
    // A fixed length still faces the budget check below: `minItems` may come from a
    // fetched JSON Schema, so it is no more trusted than a length varint.
    const item = this.item;
    const length = this.length ?? reader.varuint();
    if (length > MAX_COLLECTION_LENGTH) {
      throw new DecodeError(`Array length ${length} exceeds the limit`, reader.position);
    }
    // Before allocating a slot: `length` elements need at least `length *
    // item._minWidth` bytes, so a larger count is unsatisfiable.
    if (length * item._minWidth > reader.remaining) {
      throw new DecodeError(
        `Array length ${length} exceeds the remaining input`,
        reader.position,
      );
    }
    const values = new Array<T>(length);
    for (let index = 0; index < length; index++) values[index] = item._decode(reader);
    return values;
  }
}

/**
 * A `Set` in the array layout: a varint count, then the elements in iteration order.
 * Same bytes as `ArraySchema` over the same element, so a Set costs what an array
 * costs; the two differ in what they decode to and in their signature.
 *
 * A duplicate element on decode is refused rather than folded: `new Set` would collapse
 * the pair, and the value would re-encode to one element for a payload that held two,
 * which is the injectivity every other shape keeps. Only a primitive can trip it, since
 * every decoded object is a fresh reference.
 */
export class SetSchema<T> extends Schema<Set<T>> {
  constructor(private readonly item: Schema<T>) {
    super();
    // The array rule, for the array's reason: a zero-width element decouples the count
    // from the input, so three bytes could declare a million of them. A Set has no
    // fixed-count form to exempt.
    if (item._minWidth === 0) throw new EncodeError("Set elements must occupy at least one byte");
  }

  _encode(writer: Writer, value: Set<T>): void {
    if (!(value instanceof Set || hasTag(value, "[object Set]"))) {
      throw new EncodeError("Expected a Set");
    }
    const size = value.size;
    if (size > MAX_COLLECTION_LENGTH) throw new EncodeError("Set is too large");
    writer.varuint(size);
    // Bounded by the count already written, as `ArraySchema` bounds its loop: a Set
    // iterates elements added during iteration, so an element getter that adds one
    // would otherwise write more elements than the count declared. Fewer is caught
    // after the loop, since a deletion mid-way leaves the payload short.
    const item = this.item;
    let written = 0;
    for (const element of value) {
      if (written === size) break;
      item._encode(writer, element);
      written++;
    }
    if (written !== size) throw new EncodeError("Set changed size during encode");
  }

  override _failingChild(value: unknown): FailingChild | undefined {
    if (!(value instanceof Set)) return undefined;
    return firstFailing(
      Array.from(value, (element, index) => ({
        schema: this.item,
        segment: `[${index}]`,
        value: element,
      })),
    );
  }

  _decode(reader: Reader): Set<T> {
    const item = this.item;
    const size = reader.varuint();
    if (size > MAX_COLLECTION_LENGTH) {
      throw new DecodeError(`Set size ${size} exceeds the limit`, reader.position);
    }
    if (size * item._minWidth > reader.remaining) {
      throw new DecodeError(`Set size ${size} exceeds the remaining input`, reader.position);
    }
    const result = new Set<T>();
    for (let index = 0; index < size; index++) {
      const element = item._decode(reader);
      // `add` turns `-0` into `+0`, so a `-0` on the wire would re-encode as `+0` and
      // no Set built in JS could have written it. `element === 0` leads for
      // `EnumSchema`'s reason: it keeps the `Object.is` call off every non-zero element.
      if (result.has(element) || (element === 0 && Object.is(element, -0))) {
        throw new DecodeError("Duplicate Set element", reader.position);
      }
      result.add(element);
    }
    return result;
  }
}

/**
 * A `Map` in the layout of an array of pairs: a varint count, then each key followed by
 * its value, in iteration order. Keys may be any schema, since a Map's may be anything.
 * A duplicate key on decode is refused for `SetSchema`'s reason.
 */
export class MapSchema<K, V> extends Schema<Map<K, V>> {
  constructor(private readonly key: Schema<K>, private readonly value: Schema<V>) {
    super();
    if (key._minWidth + value._minWidth === 0) {
      throw new EncodeError("Map entries must occupy at least one byte");
    }
  }

  _encode(writer: Writer, value: Map<K, V>): void {
    if (!(value instanceof Map || hasTag(value, "[object Map]"))) {
      throw new EncodeError("Expected a Map");
    }
    const size = value.size;
    if (size > MAX_COLLECTION_LENGTH) throw new EncodeError("Map is too large");
    writer.varuint(size);
    // Bounded as `SetSchema` bounds its loop, and for the same reason.
    const keys = this.key;
    const values = this.value;
    let written = 0;
    for (const [entryKey, entryValue] of value) {
      if (written === size) break;
      keys._encode(writer, entryKey);
      values._encode(writer, entryValue);
      written++;
    }
    if (written !== size) throw new EncodeError("Map changed size during encode");
  }

  /** Both halves of an entry under one segment: a key is data, not a path. */
  override _failingChild(value: unknown): FailingChild | undefined {
    if (!(value instanceof Map)) return undefined;
    return firstFailing(
      Array.from(value, ([entryKey, entryValue], index) => [
        { schema: this.key, segment: `[${index}]`, value: entryKey },
        { schema: this.value, segment: `[${index}]`, value: entryValue },
      ]).flat(),
    );
  }

  _decode(reader: Reader): Map<K, V> {
    const keys = this.key;
    const values = this.value;
    const size = reader.varuint();
    if (size > MAX_COLLECTION_LENGTH) {
      throw new DecodeError(`Map size ${size} exceeds the limit`, reader.position);
    }
    if (size * (keys._minWidth + values._minWidth) > reader.remaining) {
      throw new DecodeError(`Map size ${size} exceeds the remaining input`, reader.position);
    }
    const result = new Map<K, V>();
    for (let index = 0; index < size; index++) {
      const entryKey = keys._decode(reader);
      // A `-0` key is refused for `SetSchema`'s reason: `set` would store it as `+0`.
      if (result.has(entryKey) || (entryKey === 0 && Object.is(entryKey, -0))) {
        throw new DecodeError("Duplicate Map key", reader.position);
      }
      result.set(entryKey, values._decode(reader));
    }
    return result;
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
    return firstFailing(
      canonicalKeyOrder(Object.keys(record)).map((key) => ({
        schema: this.value,
        segment: key,
        value: record[key],
      })),
    );
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
 * The JSON type of a value, which is what a union with no discriminant reads to pick a
 * branch. `integer` is absent deliberately: nothing about `5` says which of the two
 * number types it was declared as, so `standard.ts` folds the pair together and refuses
 * a union that would need to tell them apart.
 */
function jsonTypeOf(value: unknown): string | undefined {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return Array.isArray(value) ? "array" : "object";
  }
  return undefined;
}

/**
 * `z.discriminatedUnion`: a varint branch index, then that branch's own encoding. The
 * index usually replaces a byte rather than adding one, since the discriminant is a
 * literal inside its branch and a literal writes nothing.
 *
 * Branches are ordered by discriminant, so declaration order does not reach the wire.
 *
 * With no discriminant to read, `key` is undefined and `cases` are JSON type names: the
 * type of the value picks the branch. That is not a guess — `standard.ts` builds this
 * form only when no two branches share a runtime type, so exactly one can match, and
 * the decoder reads the same index either way. A union whose branches *do* overlap
 * stays refused, because choosing between them would mean trying each in turn and the
 * wrong choice decodes silently.
 */
export class UnionSchema<T> extends Schema<T> {
  private readonly indexes: Map<EnumValue, number>;

  constructor(
    private readonly key: string | undefined,
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
    // A `null` branch makes the union itself decode to null, so a `nullable()` over it
    // would give null two encodings. Only reachable without a discriminant, where null
    // is one of the types; a discriminated branch is always an object.
    this._yieldsNull = branches.some((branch) => branch._yieldsNull);
  }

  private branchOf(value: unknown): number | undefined {
    if (this.key === undefined) return this.indexes.get(jsonTypeOf(value) as EnumValue);
    if (typeof value !== "object" || value === null) return undefined;
    return this.indexes.get((value as Record<string, unknown>)[this.key] as EnumValue);
  }

  _encode(writer: Writer, value: T): void {
    const index = this.branchOf(value);
    if (index === undefined) {
      throw new EncodeError(
        this.key === undefined
          ? `No union branch holds ${jsonTypeOf(value) ?? typeof value}`
          : `No union branch has ${JSON.stringify(this.key)} = ${text(
              (value as Record<string, unknown> | null)?.[this.key],
              true,
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
 * How deep a recursive schema may nest, on either side — the same protection
 * `MAX_DYNAMIC_DEPTH` gives a dynamic value, for the same reason: a cycle takes its
 * depth from the payload rather than the schema, so a handful of bytes would otherwise
 * buy unbounded stack. Higher than the dynamic limit because a recursive schema is
 * declared on purpose and a linked list is a normal thing to declare, where a dynamic
 * value nesting past 64 is a payload doing something strange.
 */
const MAX_RECURSION_DEPTH = 256;

/**
 * The back-edge of a recursive schema: a `$ref` to a definition that encloses it, which
 * is what `z.lazy` and a self-referential type compile to. Built before the schema it
 * points at exists — the cycle cannot be closed any other way — and wired by `resolve`
 * once that schema is built.
 *
 * `_minWidth` stays the inherited 1, and that is exact enough to keep every allocation
 * guard sound. An inhabited cycle has to be escapable, and the only ways out are an
 * optional field, a nullable marker, an array count, a record count or a union index —
 * each of which costs a byte inside the definition. So one byte is a true lower bound,
 * and computing a tighter one would mean a second implementation of every container's
 * width rule. A definition with *no* way out has no finite value at all; rather than
 * detect that, the depth counter below turns it into an error on first use.
 */
export class LazySchema<T> extends Schema<T> {
  private inner: Schema<T> | undefined;
  private depth = 0;

  constructor(yieldsNull: boolean) {
    super();
    this._yieldsNull = yieldsNull;
  }

  resolve(inner: Schema<T>): void {
    this.inner = inner;
  }

  /**
   * The counter lives here rather than on a parameter for `DynamicSchema.nested`'s
   * reason: the recursion runs through the container schemas, which know nothing about
   * depth, and every turn around a cycle passes through exactly one of these. One
   * method for both sides, so the message exists once; the caller's `finally` keeps a
   * throw from leaving the count raised on a reused codec.
   */
  private enter(reader?: Reader): void {
    if (this.depth >= MAX_RECURSION_DEPTH) {
      const message = `Recursive value nests deeper than ${MAX_RECURSION_DEPTH}`;
      throw reader === undefined
        ? new EncodeError(message)
        : new DecodeError(message, reader.position);
    }
    this.depth++;
  }

  /**
   * The one `_encode` in the file that carries a `try`, against the rule `encodePath`
   * explains. It costs only schemas that are actually recursive, which have already
   * paid for the indirection above it.
   */
  _encode(writer: Writer, value: T): void {
    this.enter();
    try {
      this.inner!._encode(writer, value);
    } finally {
      this.depth--;
    }
  }

  _decode(reader: Reader): T {
    this.enter(reader);
    try {
      return this.inner!._decode(reader);
    } finally {
      this.depth--;
    }
  }

  /** Delegated, or the path stops at every level of the recursion. */
  override _failingChild(value: unknown): FailingChild | undefined {
    return this.inner!._failingChild(value);
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
        //
        // The third test is realm tolerance, for `isUint8Array`'s reason: a plain object
        // from a `node:vm` context, an iframe or a worker carries *that* realm's
        // `Object.prototype`, which fails `!==` here and was refused rather than encoded.
        // Every realm's `Object.prototype` is an object whose own prototype is null,
        // while a rich type's never is — `Date.prototype` and a class's `prototype` both
        // sit on `Object.prototype` — so one more step separates them. It runs only once
        // the two cheap identity checks have missed, so a same-realm object pays nothing.
        const prototype = Object.getPrototypeOf(value) as object | null;
        if (
          prototype !== Object.prototype &&
          prototype !== null &&
          Object.getPrototypeOf(prototype) !== null
        ) {
          break;
        }
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
    // `items.length` and not only the items' own slots: decoding a tuple materializes an
    // array of exactly that many slots, and leaving its own length out let
    // `m.array(m.tuple([m.literal(true)]), 999_999)` past the guard at *twice* the
    // ceiling — 999,999 outer slots plus one per tuple. Found by fuzzing the bound rather
    // than by reading it; `ArraySchema` charges the same slot through its `1 +`.
    for (const item of this.items) {
      width += item._minWidth;
      this._slots += item._slots;
    }
    this._slots += this.items.length;
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

  /**
   * Rest elements are numbered from the tuple's start, not the rest's own — handing
   * them to `this.tail` would report `[0]` for what the caller wrote at `[3]`. Indexing
   * past `items` into `rest` is what keeps that one walk rather than two.
   */
  override _failingChild(value: unknown): FailingChild | undefined {
    if (!Array.isArray(value)) return undefined;
    const length = this.rest === undefined ? this.items.length : value.length;
    return firstFailing(
      Array.from({ length }, (_, index) => ({
        schema: this.items[index] ?? this.rest!,
        segment: `[${index}]`,
        value: value[index] as unknown,
      })),
    );
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

/**
 * Compact immutable metadata shared by construction, code generation, and the CSP
 * fallback. A labeled tuple keeps those hot loops readable when destructured and avoids
 * shipping three private property names that a consumer's minifier cannot rename.
 */
type ObjectField = readonly [
  key: string,
  schema: Schema<unknown>,
  optionalIndex: number,
];

/**
 * One `k`/`s` pair per field, after an optional dependency bound as `x` — which is
 * what keeps every key a runtime argument rather than interpolated source.
 */
function recordParts(
  fields: readonly ObjectField[],
  extra?: unknown,
): readonly [parameters: string[], args: unknown[]] {
  const parameters = extra === undefined ? [] : ["x"];
  const args = extra === undefined ? [] : [extra];
  for (let index = 0; index < fields.length; index++) {
    parameters.push(`k${index}`, `s${index}`);
    args.push(fields[index]![0], fields[index]![1]);
  }
  return [parameters, args];
}

/**
 * One generated record decoder per object schema. Three times the interpreted loop,
 * and no shared helper recovers it: V8 allocates one feedback vector per closure
 * *creation site*, so a shared `fields[i].schema._decode(r)` collects every object
 * schema's maps and goes megamorphic (2.7x with one schema loaded, 0.3x with a dozen).
 *
 * Objects **with** optional fields are generated too, which they were not. The presence
 * bitmap was read as making the field set ungeneratable, and that conflated two things:
 * *which* fields arrive is dynamic, but each optional's byte and mask within the bitmap
 * are fixed by the schema, so they emit as literals — `if(b[2]&16)` — and every field
 * still gets its own monomorphic call site. Those objects are not an edge case:
 * heterogeneous array elements are the normal shape of a real document, and shorn was
 * decoding them 2.1x behind msgpackr's shared records on their own benchmark.
 *
 * Keys are arguments, never interpolated: `compile()` may take a key from a fetched
 * JSON Schema, and 5% is cheap for never parsing one as code. Returns undefined under
 * a CSP without `unsafe-eval`, where the interpreted path below is complete.
 */
function buildRecordDecoder(
  fields: readonly ObjectField[],
  optionalCount: number,
  bitmapWidth: number,
): ((reader: Reader) => Record<string, unknown>) | undefined {
  try {
    // `DecodeError` arrives as `x` rather than a capture, for `buildRecordEncoder`'s
    // reason: a wrapper closure would be one creation site shared by every schema.
    const [parameters, args] = recordParts(
      fields,
      optionalCount === 0 ? undefined : DecodeError,
    );
    // All-required stays one object literal, which is measurably better than assigning
    // into a fresh object and is the shape most schemas have.
    let body: string;
    if (optionalCount === 0) {
      const properties = fields.map((_, index) => `[k${index}]:s${index}._decode(r)`);
      body = `return{${properties.join(",")}}`;
    } else {
      const statements: string[] = [];
      // One local per bitmap byte, not the `r.bytes(width)` subarray this replaced: the
      // width is fixed by the schema, so the view was one allocation per decoded object
      // — the whole of it on an array of small optional-carrying records.
      const load = Array.from({ length: bitmapWidth }, (_, byte) => `b${byte}=r.byte()`);
      statements.push(`const ${load.join(",")}`);
      // The same rejection the interpreted path makes, before any field is read: padding
      // above the last optional must be zero, or two payloads decode to one value.
      const spare = optionalCount % 8;
      if (spare !== 0) {
        statements.push(
          `if((b${bitmapWidth - 1}>>>${spare})!==0)throw new x("Non-canonical presence bitmap padding",r.position)`,
        );
      }
      statements.push("const o={}");
      for (let index = 0; index < fields.length; index++) {
        const optionalIndex = fields[index]![2];
        const read = `o[k${index}]=s${index}._decode(r)`;
        // Byte and bit are fixed by the schema, so they are constants here rather than
        // the shifts the interpreted loop recomputes per field on every decode.
        statements.push(
          optionalIndex < 0
            ? read
            : `if(b${optionalIndex >> 3}&${1 << (optionalIndex & 7)})${read}`,
        );
      }
      body = `${statements.join(";")};return o`;
    }
    const make = new Function(...parameters, `return function(r){${body}}`) as (
      ...args: unknown[]
    ) => (reader: Reader) => Record<string, unknown>;
    return make(...args);
  } catch {
    return undefined;
  }
}

/**
 * The encode-side twin of `buildRecordDecoder`, for its reasons and under its rules.
 * Here the shared loop that goes megamorphic is `for (const field of this.fields)`.
 *
 * Objects **with** optional fields are generated too, which they were not — the same
 * oversight the decoder had, and the one `bench/fixtures.mjs` named. A presence bitmap
 * makes *which* fields arrive dynamic, but each optional's bit is fixed by the schema,
 * so a bitmap byte is a constant OR of literals rather than the `Uint8Array` and
 * parallel value array the interpreted path allocates per encode.
 */
function buildRecordEncoder(
  fields: readonly ObjectField[],
  optionalCount: number,
  bitmapWidth: number,
): ((writer: Writer, value: Record<string, unknown>) => void) | undefined {
  try {
    // `EncodeError` arrives as argument `x` rather than a capture: a wrapper closure
    // would be one creation site shared by every schema — the megamorphism this exists
    // to avoid.
    const [parameters, args] = recordParts(fields, EncodeError);
    const guard = `if(typeof v!=="object"||v===null||Array.isArray(v))throw new x("Expected an object")`;
    let body: string;
    if (optionalCount === 0) {
      body = `${guard};${fields.map((_, index) => `s${index}._encode(w,v[k${index}])`).join(";")}`;
    } else {
      const optionals = fields
        .map((field, index) => ({ field, index }))
        .filter(({ field }) => field[2] >= 0);
      // Hoisted, and read exactly once each: the value is wanted twice — for its bit and
      // for its bytes — and a field backed by a getter must not see two reads.
      const hoist = `const ${optionals.map(({ index }) => `o${index}=v[k${index}]`).join(",")}`;
      const bitmap = Array.from({ length: bitmapWidth }, (_, byte) => {
        const bits = optionals
          .filter(({ field }) => field[2] >> 3 === byte)
          .map(({ field, index }) => `(o${index}===undefined?0:${1 << (field[2] & 7)})`);
        return `w.byte(${bits.join("|")})`;
      });
      const writes = fields.map((field, index) =>
        field[2] < 0
          ? `s${index}._encode(w,v[k${index}])`
          : `if(o${index}!==undefined)s${index}._encode(w,o${index})`,
      );
      body = `${guard};${hoist};${bitmap.join(";")};${writes.join(";")}`;
    }
    const make = new Function(...parameters, `return function(w,v){${body}}`) as (
      ...args: unknown[]
    ) => (writer: Writer, value: Record<string, unknown>) => void;
    return make(...args);
  } catch {
    return undefined;
  }
}

export class ObjectSchema<S extends Shape> extends Schema<ObjectOutput<S>> {
  private readonly fields: ObjectField[];
  protected readonly knownKeys: Set<string> | undefined;
  private readonly hasProtoKey: boolean;
  private readonly hasInheritedKey: boolean;
  private readonly optionalCount: number;
  /** Bytes the presence bitmap occupies, and 0 when the shape has no optionals. */
  private readonly bitmapWidth: number;
  private readonly encoder:
    | ((writer: Writer, value: Record<string, unknown>) => void)
    | undefined;

  constructor(
    shape: S,
    private readonly rejectUnknown = false,
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
    protected readonly tail?: Schema<Record<string, unknown>>,
  ) {
    super();
    // Integer-like keys need no special case, though it looks as though they might:
    // `Object.keys` hoists them ahead of the string keys in ascending numeric order, so
    // `{"2":…,"10":…}` enumerates as `2,10` where this sorts to `10,2`. Only the sorted
    // order reaches the wire — a field is read by key, never by enumeration — so the
    // bytes are canonical either way, including for an absent optional's bitmap slot and
    // for an open object's extras record. A refusal stood here until it was measured and
    // found to reject `{"200":…,"404":…}` for nothing.
    const keys = canonicalKeyOrder(Object.keys(shape));
    let optionalIndex = 0;
    this.fields = keys.map((key) => {
      const declared = shape[key]!;
      if (declared instanceof OptionalSchema) {
        return [key, declared.inner, optionalIndex++] as const;
      }
      return [key, declared, -1] as const;
    });
    // Also built for an open object, which needs the same set to find undeclared keys
    // rather than to refuse them.
    this.knownKeys = rejectUnknown || tail !== undefined ? new Set(keys) : undefined;
    this.hasProtoKey = keys.includes("__proto__");
    this.hasInheritedKey = keys.some((key) => key in Object.prototype);
    this.optionalCount = optionalIndex;
    this.bitmapWidth = Math.ceil(optionalIndex / 8);
    // The bitmap is always emitted; an absent optional adds nothing beyond it.
    let width = this.bitmapWidth + (this.tail?._minWidth ?? 0);
    for (const [, schema, optionalIndex] of this.fields) {
      if (optionalIndex < 0) width += schema._minWidth;
      // Every field, not only the required ones: a present optional decodes from the
      // bytes the bitmap says are there, and a zero-width field needs none of them.
      this._slots += schema._slots;
    }
    this._minWidth = width;

    // Own property, shadowing the prototype method, so the generated function is the
    // whole decoder rather than a branch inside one. `__proto__` still needs
    // defineProperty, and an `Object.prototype`-shadowing key needs a non-enumerable
    // own undefined when its optional is absent; both stay interpreted.
    if (!this.hasProtoKey && this.tail === undefined && !(optionalIndex > 0 && this.hasInheritedKey)) {
      const generated = buildRecordDecoder(this.fields, optionalIndex, this.bitmapWidth);
      if (generated !== undefined) {
        this._decode = generated as (reader: Reader) => ObjectOutput<S>;
      }
    }

    // Held in a field and dispatched from the prototype method, *not* shadowed onto the
    // instance the way the decoder is: a distinct `_encode` per schema tips
    // `ArraySchema`'s shared `this.item._encode(...)` site megamorphic, measured at
    // -25% on an array of plain uints — a shape holding no object schema at all.
    //
    // Built for a shape that rejects unknown properties too. It was not, and that held
    // every ArkType object and Valibot `v.object()` (a JSON Schema with no
    // `additionalProperties`) to the interpreted loop at twice the cost of the same
    // bytes from a Zod object. `_encode` scans for unknown keys and then calls this.
    if (!this.hasInheritedKey && this.tail === undefined) {
      this.encoder = buildRecordEncoder(this.fields, optionalIndex, this.bitmapWidth);
    }
  }

  _encode(writer: Writer, value: ObjectOutput<S>): void {
    if (this.encoder !== undefined && !this.rejectUnknown) {
      this.encoder(writer, value as Record<string, unknown>);
      return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new EncodeError("Expected an object");
    }

    const record = value as Record<string, unknown>;
    if (this.rejectUnknown) {
      // A loop rather than `find` with a closure, which measured about 10ns slower on a
      // 64ns ArkType person encode. Not an allocation: V8 removes the closure either way.
      for (const key of Object.keys(record)) {
        if (!this.knownKeys!.has(key)) {
          throw new EncodeError(`Unknown object property ${JSON.stringify(key)}`);
        }
      }
    }
    // Here, after the scan, rather than with the scan emitted into the generated source:
    // that cost an `m`-only bundle 61 gzip bytes, past its 1% gate, for a check `m`
    // cannot ask for. The generated function repeats the object guard above; cheap.
    if (this.encoder !== undefined) {
      this.encoder(writer, record);
      return;
    }

    // A field named like an `Object.prototype` member would otherwise be found on every
    // plain object and missing from every null-prototype one, so the same own data
    // would encode to different bytes. Staging through a null-prototype record restores
    // canonical form; schemas without such a field read the caller's object directly.
    const source = this.hasInheritedKey ? this.ownFields(record) : record;

    if (this.optionalCount === 0) {
      for (const [key, schema] of this.fields) {
        schema._encode(writer, source[key]);
      }
      this.writeExtras(writer, record);
      return;
    }

    const bitmap = new Uint8Array(this.bitmapWidth);
    const optionalValues = new Array<unknown>(this.optionalCount);
    for (const [key, , optionalIndex] of this.fields) {
      if (optionalIndex >= 0) {
        const fieldValue = source[key];
        optionalValues[optionalIndex] = fieldValue;
        if (fieldValue !== undefined) {
          bitmap[optionalIndex >> 3]! |= 1 << (optionalIndex & 7);
        }
      }
    }
    writer.bytes(bitmap);

    for (const [key, schema, optionalIndex] of this.fields) {
      if (optionalIndex >= 0) {
        // The bit above was set from exactly this test, so read the value rather than
        // shifting the answer back out of the bitmap.
        const fieldValue = optionalValues[optionalIndex];
        if (fieldValue !== undefined) {
          schema._encode(writer, fieldValue);
        }
      } else {
        schema._encode(writer, source[key]);
      }
    }
    this.writeExtras(writer, record);
  }

  /**
   * The keys the schema did not name, written as a record after the declared fields. A
   * closed object has none and stops here; `OpenObjectSchema` overrides.
   */
  protected writeExtras(_writer: Writer, _record: Record<string, unknown>): void {}

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
      if (this.knownKeys!.has(key)) {
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
    return firstFailing(
      this.fields
        .filter(([key, , optionalIndex]) => optionalIndex < 0 || record[key] !== undefined)
        .map(([key, schema]) => ({ schema, segment: key, value: record[key] })),
    );
  }

  private ownFields(record: Record<string, unknown>): Record<string, unknown> {
    const own = Object.create(null) as Record<string, unknown>;
    for (const [key] of this.fields) {
      if (Object.hasOwn(record, key)) own[key] = record[key];
    }
    return own;
  }

  _decode(reader: Reader): ObjectOutput<S> {
    const result: Record<string, unknown> = {};
    if (this.optionalCount === 0 && !this.hasProtoKey) {
      for (const [key, schema] of this.fields) result[key] = schema._decode(reader);
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
    for (const [key, schema, optionalIndex] of this.fields) {
      if (
        optionalIndex >= 0 &&
        (bitmap![optionalIndex >> 3]! & (1 << (optionalIndex & 7))) === 0
      ) {
        // An absent optional named like an `Object.prototype` member would read back as
        // the inherited member — an optional `toString` decoding to a function, which
        // the vendor's validate() then rejects. A non-enumerable own `undefined`
        // shadows it. A null-prototype record was tried and handed back objects that
        // failed `String()` and `instanceof Object`.
        if (this.hasInheritedKey && key in Object.prototype) {
          Object.defineProperty(result, key, {
            configurable: true,
            enumerable: false,
            value: undefined,
            writable: true,
          });
        }
        continue;
      }
      const decoded = schema._decode(reader);
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
    this.readExtras(reader, result);
    return result as ObjectOutput<S>;
  }
}

/**
 * Everything an open object does with its undeclared keys on the way out: deriving them,
 * and walking them for a path. Out here rather than in `ObjectSchema` because only the
 * Standard Schema bridge builds a tail, so an `m`-only bundle can run neither — and pays
 * for them anyway when they sit there: the derivation alone measured 164 minified bytes.
 * The same finding that keeps `new RecordSchema(...)` out of that constructor. Nothing `m`
 * exports names this class, so a bundle without `compile` drops it whole.
 */
export class OpenObjectSchema<S extends Shape> extends ObjectSchema<S> {
  protected override writeExtras(writer: Writer, record: Record<string, unknown>): void {
    this.tail!._encode(writer, this.extras(record));
  }

  /**
   * Declared fields first, in the order encode writes them, then the undeclared keys. The
   * tail names the key itself, so an extras key is a direct child of the object in path
   * terms — `o.note` rather than `o.<extras>.note`.
   *
   * The guard repeats the base's because a non-object has no undeclared keys either: the
   * extras of a string would be its character indices.
   */
  override _failingChild(value: unknown): FailingChild | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    return (
      super._failingChild(value) ??
      this.tail!._failingChild(this.extras(value as Record<string, unknown>))
    );
  }

  /** Which keys are undeclared, decided here for both the write and the walk. */
  private extras(record: Record<string, unknown>): Record<string, unknown> {
    const extras = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!this.knownKeys!.has(key)) extras[key] = record[key];
    }
    return extras;
  }
}

export const m = {
  string: (): Schema<string> => new StringSchema(),
  bytes: (): Schema<Uint8Array> => new BytesSchema(),
  boolean: (): Schema<boolean> => new BooleanSchema(),
  uint: (): Schema<number> => new UintSchema(),
  int: (): Schema<number> => new IntSchema(),
  float32: (): Schema<number> => new Float32Schema(),
  float64: (): Schema<number> => new Float64Schema(),
  date: (): Schema<Date> => new DateSchema(),
  bigint: (): Schema<bigint> => new BigIntSchema(),
  literal: <const T extends string | number | boolean | null>(value: T): Schema<T> =>
    new LiteralSchema(value),
  enum: <const T extends readonly [EnumValue, ...EnumValue[]]>(values: T): Schema<T[number]> =>
    new EnumSchema(values),
  array: <T>(item: Schema<T>, length?: number): Schema<T[]> => new ArraySchema(item, length),
  set: <T>(item: Schema<T>): Schema<Set<T>> => new SetSchema(item),
  map: <K, V>(key: Schema<K>, value: Schema<V>): Schema<Map<K, V>> => new MapSchema(key, value),
  // No rest parameter, deliberately: `TupleSchema` takes one and `compile` uses it, but
  // typing it on `m` means a variadic return type and two casts to reach it.
  // `RecordSchema`, `UnionSchema` and `DynamicSchema` are absent for the same reason.
  tuple: <const S extends readonly Schema<unknown>[]>(items: S): Schema<TupleOutput<S>> =>
    new TupleSchema(items),
  object: <S extends Shape>(shape: S): Schema<ObjectOutput<S>> => new ObjectSchema(shape),
};
