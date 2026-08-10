import { DecodeError, EncodeError, type Reader, Schema, type Writer } from "./core.js";

/**
 * Hashed into the fingerprint rather than spent as a byte on the wire: a decoder built
 * against a different wire format derives a different fingerprint and rejects the
 * payload anyway. Bump when the encoding of any existing wire shape changes.
 */
const WIRE_FORMAT_VERSION = 1;

const DEFAULT_FINGERPRINT_BYTES = 3;

export interface FingerprintOptions {
  /**
   * Fingerprint bytes to retain, 1 to 4. Default 3.
   *
   * Use 4 for persistent data; 3 favors very small payloads and small, controlled
   * registries. No supported width is collision-proof.
   */
  readonly bytes?: 1 | 2 | 3 | 4;
}

/**
 * FNV-1a over the canonical structural signature. `version` and `retain` seed the LOW
 * byte deliberately: FNV-1a multiplies mod 2^32, so a seed bit at position 8 or above
 * can never influence the low output byte, leaving a 1-byte fingerprint blind to both.
 */
function fingerprintOf(signature: string, retain: number): Uint8Array {
  let hash = 0x811c9dc5 ^ (WIRE_FORMAT_VERSION << 4) ^ retain;
  for (let index = 0; index < signature.length; index++) {
    const code = signature.charCodeAt(index);
    hash = Math.imul(hash ^ (code & 0xff), 0x01000193);
    hash = Math.imul(hash ^ (code >>> 8), 0x01000193);
  }
  const bytes = new Uint8Array(retain);
  for (let index = 0; index < retain; index++) {
    bytes[index] = (hash >>> (8 * (retain - 1 - index))) & 0xff;
  }
  return bytes;
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export class FingerprintedSchema<T> extends Schema<T> {
  private readonly prefix: Uint8Array;

  /**
   * The prefix bytes, so a caller can carry them out of band instead — a Kafka header,
   * a column, a filename — and keep the payload bare.
   *
   * A fresh copy on every read: a stray write into the encoder's own array would make
   * this a non-canonical encoder that still round-trips against itself. Read it once
   * and keep it if you need it in a loop.
   */
  get fingerprint(): Uint8Array {
    return this.prefix.slice();
  }

  /**
   * The same bytes as a lowercase hex string, and the dispatch key for schema
   * evolution: shorn detects a wire-shape mismatch but never resolves one, so an
   * application that stores or queues payloads keeps its own `fingerprintHex` to codec
   * map. Reject duplicate keys when building it. Validation-only versions share a
   * fingerprint and need a separate application version.
   */
  get fingerprintHex(): string {
    return hex(this.prefix);
  }

  constructor(private readonly inner: Schema<T>, signature: string, retain: number) {
    super();
    this.prefix = fingerprintOf(signature, retain);
    this._minWidth = retain + inner._minWidth;
    this._yieldsNull = inner._yieldsNull;
    this._yieldsUndefined = inner._yieldsUndefined;
    // Carried up so async validation composes with the envelope: `encodeAsync` awaits
    // `_source`, then frames through `_structural` — this same envelope over the inner
    // codec's structural half. Eager rather than lazy, since neither the extra object
    // nor a getter's per-read branch is measurable. Recursion stops at depth two.
    if (inner._source !== undefined && inner._structural !== undefined) {
      this._source = inner._source;
      this._structural = new FingerprintedSchema(inner._structural, signature, retain);
    }
  }

  _encode(writer: Writer, value: T): void {
    writer.bytes(this.prefix);
    this.inner._encode(writer, value);
  }

  /** Delegated, or every fingerprinted codec loses its field path. */
  override _failingChild(value: unknown) {
    return this.inner._failingChild(value);
  }

  _decode(reader: Reader): T {
    const expected = this.prefix;
    const start = reader.position;
    // A byte loop, not `reader.bytes(n)`: that allocates a fresh subarray per decode,
    // measured at ~24ns — more than the whole envelope costs.
    for (let index = 0; index < expected.length; index++) {
      if (reader.byte() !== expected[index]) {
        throw new DecodeError(
          `Payload was written by a different schema (expected fingerprint ${hex(expected)})`,
          start,
        );
      }
    }
    return this.inner._decode(reader);
  }
}

/**
 * Prefix a codec's payloads with a short fingerprint of its wire shape, so that
 * bytes written by one shape are rejected by a different one instead of silently
 * decoding to a wrong value.
 *
 * Structural changes only: refinements, validator choice and conversion functions are
 * outside the wire shape and need an application-level version.
 *
 * Costs the fingerprint's bytes plus roughly 1.5ns per encode and 6.3ns per decode.
 * Requires a `compile()` codec; the low-level `m` API is the raw-wire escape hatch
 * and stays unframed.
 */
export function fingerprinted<T>(
  codec: Schema<T>,
  options?: FingerprintOptions,
): FingerprintedSchema<T> {
  const signature = codec.signature;
  if (signature === undefined) {
    throw new EncodeError(
      "fingerprinted() needs a codec built from a Standard JSON Schema; compile() returns one, the low-level m API does not",
    );
  }
  const retain = options?.bytes ?? DEFAULT_FINGERPRINT_BYTES;
  if (retain !== 1 && retain !== 2 && retain !== 3 && retain !== 4) {
    throw new EncodeError(`Fingerprint bytes must be 1, 2, 3 or 4, received ${String(retain)}`);
  }
  return new FingerprintedSchema(codec, signature, retain);
}
