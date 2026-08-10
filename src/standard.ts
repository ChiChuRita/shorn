import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import {
  ArraySchema,
  BooleanSchema,
  canonicalEnumOrder,
  canonicalKeyOrder,
  createObjectSchema,
  DecodeError,
  DynamicSchema,
  EncodeError,
  type EnumValue,
  EnumSchema,
  Float64Schema,
  IntSchema,
  LiteralSchema,
  Reader,
  RecordSchema,
  Schema,
  StringSchema,
  TupleSchema,
  UintSchema,
  UnionSchema,
  UuidSchema,
  Writer,
} from "./core.js";

type JsonSchema = Record<string, unknown>;
type WireShape =
  | "any"
  | "boolean"
  | "float64"
  | "int"
  | "string"
  | "uint"
  | "uuid"
  // `length`, `extras` and `rest` below are present only when the schema declares
  // them, so the signature of a shape without one is what it always was.
  | { readonly array: WireShape; readonly length?: number }
  | { readonly enum: readonly EnumValue[] }
  | { readonly literal: string | number | boolean | null }
  | { readonly nullable: WireShape }
  | {
      readonly object: readonly WireField[];
      readonly rejectUnknown: boolean;
      readonly extras?: WireShape;
    }
  | { readonly record: WireShape }
  | { readonly tuple: readonly WireShape[]; readonly rest?: WireShape }
  | {
      readonly union: readonly WireShape[];
      readonly on: string;
      readonly cases: readonly EnumValue[];
    };

interface WireField {
  readonly key: string;
  readonly optional: boolean;
  readonly value: WireShape;
}

export type EncodableStandardSchema<Input = unknown, Output = Input> =
  StandardSchemaV1<Input, Output> & StandardJSONSchemaV1<Input, Output>;

export type SafeResult<T> = { success: true; data: T } | { success: false; error: Error };

/**
 * The whole body of `safeEncode` and `safeDecode`. The normalization is the part
 * worth having once: a vendor's validator may reject with something that is not an
 * `Error`, and `SafeResult` promises one.
 */
function safely<T>(run: () => T): SafeResult<T> {
  try {
    return { success: true, data: run() };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/** The joined message is for a log line, the array for an HTTP handler. */
function validationError(issues: ReadonlyArray<StandardSchemaV1.Issue>): EncodeError {
  const error = new EncodeError(
    issues
      .map((issue) => {
        const path = issue.path
          ?.map((segment) => String(typeof segment === "object" ? segment.key : segment))
          .join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; "),
  );
  error.issues = issues;
  return error;
}

function validateSync<T>(schema: StandardSchemaV1<unknown, T>, value: unknown): T {
  const result = schema["~standard"].validate(value);
  // Thenable rather than `instanceof Promise`: a vendor may hand back a promise
  // from another realm, which fails the instance check while being one.
  if (typeof (result as { then?: unknown } | null)?.then === "function") {
    throw new EncodeError(
      "This Standard Schema validates asynchronously; use encodeAsync/decodeAsync, which accept either this schema or a codec built from it.",
    );
  }
  const sync = result as StandardSchemaV1.Result<T>;
  if (sync.issues) throw validationError(sync.issues);
  return sync.value;
}

async function validateAsync<T>(schema: StandardSchemaV1<unknown, T>, value: unknown): Promise<T> {
  const result = await schema["~standard"].validate(value);
  if (result.issues) throw validationError(result.issues);
  return result.value;
}

/**
 * A validation failure on the way out is a decode failure to the caller, so the class
 * changes. `cause` keeps the original reachable and `issues` is carried across.
 */
function rethrowAsDecodeError(error: unknown, offset: number): never {
  if (!(error instanceof EncodeError)) throw error;
  const decodeError = new DecodeError(error.message, offset, { cause: error });
  decodeError.issues = error.issues;
  throw decodeError;
}

class StandardBackedSchema<T> extends Schema<T> {
  constructor(
    override readonly _source: StandardSchemaV1<unknown, T>,
    override readonly _structural: Schema<unknown>,
    override readonly signature: string,
  ) {
    super();
    this._minWidth = _structural._minWidth;
    // Carried through, or `compile(z.string().nullable()).nullable()` would build a
    // second null marker over one that already exists and give null two encodings.
    this._yieldsNull = _structural._yieldsNull;
    this._yieldsUndefined = _structural._yieldsUndefined;
  }

  _encode(writer: Writer, value: T): void {
    this._structural._encode(writer, validateSync(this._source, value));
  }

  /**
   * Delegated, or `encodePath` stops here and every `compile()` codec loses the field
   * path the `m` API gets. A validator does not catch everything the writer refuses: a
   * lone surrogate, an oversized array and an over-ceiling byte field are all valid to
   * the vendor and fatal here. Walked with the pre-validation input, which is what
   * `Schema.encode` caught.
   */
  override _failingChild(value: unknown) {
    return this._structural._failingChild(value);
  }

  _decode(reader: Reader): T {
    const value = this._structural._decode(reader);
    try {
      return validateSync(this._source, value);
    } catch (error) {
      rethrowAsDecodeError(error, reader.position);
    }
  }
}

function asSchema(value: unknown): JsonSchema {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EncodeError("Unsupported Standard JSON Schema node");
  }
  return value as JsonSchema;
}

/** Keywords that carry a shape without a `type`; a node holding one is not `any`. */
const COMBINATORS = ["$ref", "allOf", "oneOf", "not"];

/** The scalars a `const` or an `enum` member may be; JSON Schema allows no others. */
function isEnumValue(value: unknown): value is EnumValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * The property that tells a union's branches apart: present and `const` in every
 * branch, never the same value twice. Candidates are tried in canonical order, so a
 * union carrying two usable discriminants picks the same one in every process.
 */
function discriminant(
  branches: readonly JsonSchema[],
): { readonly on: string; readonly cases: readonly EnumValue[] } | undefined {
  const first = branches[0];
  if (first === undefined || branches.some((branch) => branch.type !== "object")) return undefined;

  for (const key of canonicalKeyOrder(Object.keys(asSchema(first.properties ?? {})))) {
    const cases: EnumValue[] = [];
    for (const branch of branches) {
      const property = asSchema(branch.properties ?? {})[key];
      if (typeof property !== "object" || property === null) break;
      const constant = (property as JsonSchema).const;
      if (!("const" in property) || !isEnumValue(constant)) break;
      cases.push(constant);
    }
    if (cases.length === branches.length && new Set(cases).size === cases.length) {
      return { on: key, cases };
    }
  }
  return undefined;
}

function wireShape(schema: JsonSchema): WireShape {
  // `anyOf` and `oneOf` differ in whether the branches may overlap, which is a
  // validation question the vendor has already answered by the time shorn runs.
  // Zod writes a plain union as `anyOf` and a discriminated one as `oneOf`; both
  // arrive here as the same list of branches.
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) {
    const branches = union.map(asSchema);
    const nonNull = branches.filter((branch) => branch.type !== "null");
    if (branches.length === 2 && nonNull.length === 1) {
      return { nullable: wireShape(nonNull[0]!) };
    }

    // ArkType spells `string.uuid` as three branches — the lowercase pattern, plus
    // the nil and max UUIDs as consts — every branch tagged `format: "uuid"`. One
    // wire shape already covers all three, so the union collapses to it.
    if (
      nonNull.length > 0 &&
      nonNull.every(
        (branch) =>
          branch.format === "uuid" && (branch.type === "string" || typeof branch.const === "string"),
      )
    ) {
      return nonNull.length === branches.length ? "uuid" : { nullable: "uuid" };
    }

    const found = discriminant(branches);
    if (found !== undefined) {
      // Ordered by discriminant, so the branch index survives a reordering of the
      // schema. `canonicalEnumOrder` refuses the members with no JSON text of their
      // own, which is why `indexOf`'s strict equality is enough here.
      const cases = canonicalEnumOrder(found.cases);
      return {
        on: found.on,
        cases,
        union: cases.map((value) => wireShape(branches[found.cases.indexOf(value)]!)),
      };
    }
    throw new EncodeError(
      "Only nullable and discriminated JSON Schema unions are currently supported; a discriminated union needs one property that is a distinct const in every branch",
    );
  }

  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter((type) => type !== "null");
    if (schema.type.length === 2 && nonNull.length === 1) {
      return { nullable: wireShape({ ...schema, type: nonNull[0] }) };
    }
    throw new EncodeError("Only nullable JSON Schema type arrays are currently supported");
  }

  if ("const" in schema) {
    if (isEnumValue(schema.const)) return { literal: schema.const };
    throw new EncodeError("Unsupported JSON Schema literal");
  }

  if (Array.isArray(schema.enum) && schema.enum.every(isEnumValue)) {
    const values = canonicalEnumOrder([...new Set(schema.enum)]);
    if (values.length === 0) throw new EncodeError("Empty enums are unsupported");
    return { enum: values };
  }

  switch (schema.type) {
    case "string":
      // The only string format whose text is fully recoverable from its value: a
      // `date-time`'s fractional digits and offset spelling are free, so no timestamp
      // reproduces the string it was parsed from.
      return schema.format === "uuid" ? "uuid" : "string";
    case "boolean":
      return "boolean";
    case "null":
      // `z.null()` and `z.literal(null)` are the same schema written two ways; the
      // second already compiled, so this is the same literal shape from the first.
      return { literal: null };
    case "integer":
      return typeof schema.minimum === "number" && schema.minimum >= 0 ? "uint" : "int";
    case "number":
      return "float64";
    case "array": {
      if (Array.isArray(schema.prefixItems)) {
        const tuple = schema.prefixItems.map((item) => wireShape(asSchema(item)));
        // `items` beside `prefixItems` is the rest element; `false` means there is none.
        return "items" in schema && schema.items !== false
          ? { tuple, rest: wireShape(asSchema(schema.items)) }
          : { tuple };
      }
      if (!("items" in schema)) throw new EncodeError("Arrays require an item schema");
      const array = wireShape(asSchema(schema.items));
      // A count the schema fixes needs no length varint, and like a tuple may hold a
      // zero-width element.
      return typeof schema.minItems === "number" && schema.minItems === schema.maxItems
        ? { array, length: schema.minItems }
        : { array };
    }
    case "object": {
      const properties = asSchema(schema.properties ?? {});
      const additional = schema.additionalProperties;
      // `true` and `{}` both mean a value of any shape; normalized to one here.
      const extras =
        additional === undefined || additional === false
          ? undefined
          : wireShape(additional === true ? {} : asSchema(additional));
      // No declared properties makes it a record: every key open, one value type. With
      // them it is an open object — the same record, written after the declared fields.
      if (extras !== undefined && Object.keys(properties).length === 0) {
        return { record: extras };
      }
      const required = new Set(
        Array.isArray(schema.required)
          ? schema.required.filter((key): key is string => typeof key === "string")
          : [],
      );
      for (const key of required) {
        if (!Object.hasOwn(properties, key)) {
          throw new EncodeError(`Required property ${JSON.stringify(key)} has no schema`);
        }
      }
      return {
        object: canonicalKeyOrder(Object.keys(properties)).map((key) => ({
          key,
          optional: !required.has(key),
          value: wireShape(asSchema(properties[key])),
        })),
        // Asks whether *shorn* must police extra properties, not whether the schema
        // does. `false` means the vendor's own validate() already dealt with them —
        // zod's `object` strips, `strictObject` refuses, both emit `false`. `undefined`
        // (arktype) passes them through, and a closed object has nowhere to put them.
        rejectUnknown: additional === undefined,
        ...(extras === undefined ? {} : { extras }),
      };
    }
    default: {
      // A node with no `type` and nothing structural left to read is `any`: `z.any()`,
      // `z.unknown()`, a bare `{}`. Combinators are excluded deliberately, so a `$ref`
      // recursive schema is refused rather than quietly re-typed as a tagged blob —
      // and refused by name, because "type undefined" told the caller nothing.
      if (schema.type === undefined) {
        const combinator = COMBINATORS.find((keyword) => keyword in schema);
        if (combinator === undefined) return "any";
        throw new EncodeError(
          combinator === "$ref"
            ? "Recursive schemas ($ref) are not supported; flatten to a fixed depth or nest the recursive part as bytes"
            : `Unsupported JSON Schema combinator ${combinator}`,
        );
      }
      throw new EncodeError(`Unsupported Standard JSON Schema type ${String(schema.type)}`);
    }
  }
}

function compileWireShape(shape: WireShape): Schema<unknown> {
  if (typeof shape === "string") {
    switch (shape) {
      case "string":
        return new StringSchema();
      case "boolean":
        return new BooleanSchema();
      case "uint":
        return new UintSchema();
      case "int":
        return new IntSchema();
      case "float64":
        return new Float64Schema();
      case "uuid":
        return new UuidSchema();
      case "any":
        return new DynamicSchema();
    }
  }
  if ("literal" in shape) return new LiteralSchema(shape.literal);
  if ("enum" in shape) return new EnumSchema(shape.enum as [EnumValue, ...EnumValue[]]);
  if ("nullable" in shape) return compileWireShape(shape.nullable).nullable();
  if ("array" in shape) return new ArraySchema(compileWireShape(shape.array), shape.length);
  if ("tuple" in shape) {
    return new TupleSchema(
      shape.tuple.map(compileWireShape),
      shape.rest === undefined ? undefined : compileWireShape(shape.rest),
    );
  }
  if ("record" in shape) return new RecordSchema(compileWireShape(shape.record));
  if ("union" in shape) {
    return new UnionSchema(shape.on, shape.cases, shape.union.map(compileWireShape));
  }

  const objectShape = Object.create(null) as Record<string, Schema<unknown>>;
  for (const field of shape.object) {
    const schema = compileWireShape(field.value);
    objectShape[field.key] = field.optional ? schema.optional() : schema;
  }
  return createObjectSchema(
    objectShape,
    shape.rejectUnknown,
    // Built here rather than inside `ObjectSchema`, so `m` does not carry
    // `RecordSchema` in its bundle.
    shape.extras === undefined ? undefined : new RecordSchema(compileWireShape(shape.extras)),
  );
}

function wireSignature(shape: WireShape): string {
  return JSON.stringify(shape, (key, value) => (key === "rejectUnknown" ? undefined : value));
}

function hasJsonSchema(value: StandardSchemaV1): value is EncodableStandardSchema {
  return "jsonSchema" in value["~standard"];
}

function buildCodec<S extends EncodableStandardSchema>(
  schema: S,
): StandardBackedSchema<StandardSchemaV1.InferOutput<S>>;
function buildCodec<S extends StandardSchemaV1>(
  schema: S,
  structure: StandardJSONSchemaV1<
    StandardSchemaV1.InferInput<S>,
    StandardSchemaV1.InferOutput<S>
  >,
): StandardBackedSchema<StandardSchemaV1.InferOutput<S>>;
function buildCodec(
  schema: StandardSchemaV1,
  structure?: StandardJSONSchemaV1,
): StandardBackedSchema<unknown> {
  const structuralSchema = structure ?? (hasJsonSchema(schema) ? schema : undefined);
  if (structuralSchema === undefined) {
    throw new EncodeError(
      "Standard Schema provides validation but not structure; pass a Standard JSON Schema implementation as the second argument",
    );
  }

  // Every vendor throws here on Date, BigInt, Map, Set, undefined and NaN, since JSON
  // Schema has no form for them. Unwrapped, that error never mentions shorn or says
  // what to do instead, so the vendor's reason is kept and the remedy appended.
  let inputJsonSchema: unknown;
  let outputJsonSchema: unknown;
  try {
    inputJsonSchema = structuralSchema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    });
    outputJsonSchema = structuralSchema["~standard"].jsonSchema.output({
      target: "draft-2020-12",
    });
  } catch (error) {
    // A pointer, not a tutorial: inlining the README recipe measured 112 gzip bytes.
    throw new EncodeError(
      `${error instanceof Error ? error.message : String(error)} — shorn encodes the wire shape; convert rich types at the edge (README: Dates, BigInt, Map and Set)`,
      { cause: error },
    );
  }
  const inputShape = wireShape(asSchema(inputJsonSchema));
  const outputShape = wireShape(asSchema(outputJsonSchema));
  const signature = wireSignature(outputShape);
  if (wireSignature(inputShape) !== signature) {
    // Rarely reached: zod's `z.codec()` has a rich output type, so the conversion above
    // throws before the shapes are compared. What survives here is a schema whose two
    // sides are both JSON Schema representable and still differ — a default, say.
    throw new EncodeError(
      "Schemas with different input and output wire shapes require a bidirectional codec and are not yet supported",
    );
  }
  return new StandardBackedSchema(schema, compileWireShape(outputShape), signature);
}

const directCache = new WeakMap<object, StandardBackedSchema<unknown>>();
const structuredCache = new WeakMap<object, WeakMap<object, StandardBackedSchema<unknown>>>();

/**
 * The one place a non-Standard-Schema argument is caught — every public entry point
 * funnels through `getCompiled`. Without it, reading `schema["~standard"]` throws a
 * raw TypeError naming an internal property.
 */
function assertStandardSchema(schema: unknown): asserts schema is StandardSchemaV1 {
  // `function` as well as `object`: an arktype schema is callable, and the spec
  // constrains only the `~standard` property, not the host that carries it.
  const holdsProperties =
    schema !== null && (typeof schema === "object" || typeof schema === "function");
  if (holdsProperties && "~standard" in schema) return;

  // One template rather than a branch per diagnosis: three full sentences measured 154
  // gzip bytes against the 1% bundle gate.
  throw new EncodeError(
    `Expected a Standard Schema (zod, valibot, arktype), received ${
      schema instanceof Schema
        ? "a shorn schema — already a codec, call encode/decode on it directly"
        : holdsProperties && ("type" in schema || "$schema" in schema)
          ? "a raw JSON Schema — wrap it in a validator"
          : schema === null
            ? "null"
            : typeof schema
    }`,
  );
}

function getCompiled(
  schema: StandardSchemaV1,
  structure?: StandardJSONSchemaV1,
): StandardBackedSchema<unknown> {
  assertStandardSchema(schema);
  // The structure argument gets the same gate as the schema, or a wrong shape here —
  // a raw JSON Schema, or a `{ structure }` wrapper object — surfaces as a raw
  // TypeError wrapped in the rich-types remedy, which points away from the fix.
  if (structure !== undefined) {
    const std = (structure as { "~standard"?: unknown })["~standard"];
    if (typeof std !== "object" || std === null || !("jsonSchema" in std)) {
      throw new EncodeError(
        "The second argument must be a Standard JSON Schema implementation — toStandardJsonSchema(schema) for Valibot",
      );
    }
  }
  if (structure === undefined) {
    const cached = directCache.get(schema);
    if (cached !== undefined) return cached;
    const compiled = buildCodec(schema as EncodableStandardSchema);
    directCache.set(schema, compiled);
    return compiled;
  }

  let structures = structuredCache.get(schema);
  if (structures === undefined) {
    structures = new WeakMap();
    structuredCache.set(schema, structures);
  }
  const cached = structures.get(structure);
  if (cached !== undefined) return cached;
  const compiled = buildCodec(schema, structure);
  structures.set(structure, compiled);
  return compiled;
}

export function compile<S extends EncodableStandardSchema>(
  schema: S,
): Schema<StandardSchemaV1.InferOutput<S>>;
export function compile<S extends StandardSchemaV1>(
  schema: S,
  structure: StandardJSONSchemaV1<
    StandardSchemaV1.InferInput<S>,
    StandardSchemaV1.InferOutput<S>
  >,
): Schema<StandardSchemaV1.InferOutput<S>>;
export function compile(
  schema: StandardSchemaV1,
  structure?: StandardJSONSchemaV1,
): Schema<unknown> {
  return getCompiled(schema, structure);
}

/**
 * The same codec with the validator taken out. Identical bytes on the wire; the
 * refinements are simply not run, on either side. On the three-field zod person fixture
 * in `bench/regression.mjs` that is 2.3x on encode and 3.7x on decode — once the
 * structural half is generated code, validation is most of what is left.
 *
 * For a producer you own, at both ends of a link you own. It removes everything the
 * validator did, not only the checks that were going to pass: a transform such as
 * `z.string().trim()` no longer runs, so a value goes out exactly as handed over.
 * Decoding still bounds-checks every read and still refuses trailing bytes, so
 * malformed input throws `DecodeError` rather than escaping — but bytes written against
 * a schema that differs only in its refinements now decode silently. Wrap in
 * `fingerprinted()` to keep the structural half of that check, and keep the validated
 * codec at any boundary you do not own.
 *
 * Takes a schema or a codec, and is cached the same way `compile()` is, so calling it
 * per message is a WeakMap hit rather than a rebuild.
 */
export function unchecked<T>(codec: Schema<T>): Schema<T>;
export function unchecked<S extends EncodableStandardSchema>(
  schema: S,
): Schema<StandardSchemaV1.InferOutput<S>>;
export function unchecked<S extends StandardSchemaV1>(
  schema: S,
  structure: StandardJSONSchemaV1<
    StandardSchemaV1.InferInput<S>,
    StandardSchemaV1.InferOutput<S>
  >,
): Schema<StandardSchemaV1.InferOutput<S>>;
export function unchecked(
  schemaOrCodec: StandardSchemaV1 | Schema<unknown>,
  structure?: StandardJSONSchemaV1,
): Schema<unknown> {
  const codec =
    schemaOrCodec instanceof Schema ? schemaOrCodec : getCompiled(schemaOrCodec, structure);
  const bare = codec._structural;
  if (bare === undefined) {
    // Not a no-op return of the argument: an `m` schema really is already unchecked, but
    // `compile(schema).nullable()` reaches here too, and handing that back would keep
    // validating under a name that promises it does not.
    throw new EncodeError(
      "unchecked() needs a codec with a validator to remove; compile() returns one, optionally wrapped by fingerprinted(), and the low-level m API is already unvalidated",
    );
  }
  return bare;
}

export function encode<S extends EncodableStandardSchema>(
  schema: S,
  value: StandardSchemaV1.InferOutput<S>,
): Uint8Array;
export function encode<S extends StandardSchemaV1>(
  schema: S,
  value: StandardSchemaV1.InferOutput<S>,
  structure: StandardJSONSchemaV1<
    StandardSchemaV1.InferInput<S>,
    StandardSchemaV1.InferOutput<S>
  >,
): Uint8Array;
export function encode(
  schema: StandardSchemaV1,
  value: unknown,
  structure?: StandardJSONSchemaV1,
): Uint8Array {
  return getCompiled(schema, structure).encode(value);
}

export function decode<S extends EncodableStandardSchema>(
  schema: S,
  value: Uint8Array,
): StandardSchemaV1.InferOutput<S>;
export function decode<S extends StandardSchemaV1>(
  schema: S,
  value: Uint8Array,
  structure: StandardJSONSchemaV1<
    StandardSchemaV1.InferInput<S>,
    StandardSchemaV1.InferOutput<S>
  >,
): StandardSchemaV1.InferOutput<S>;
export function decode(
  schema: StandardSchemaV1,
  value: Uint8Array,
  structure?: StandardJSONSchemaV1,
): unknown {
  return getCompiled(schema, structure).decode(value);
}

export function safeEncode<S extends EncodableStandardSchema>(
  schema: S,
  value: StandardSchemaV1.InferOutput<S>,
): SafeResult<Uint8Array>;
export function safeEncode<S extends StandardSchemaV1>(
  schema: S,
  value: StandardSchemaV1.InferOutput<S>,
  structure: StandardJSONSchemaV1<
    StandardSchemaV1.InferInput<S>,
    StandardSchemaV1.InferOutput<S>
  >,
): SafeResult<Uint8Array>;
export function safeEncode(
  schema: StandardSchemaV1,
  value: unknown,
  structure?: StandardJSONSchemaV1,
): SafeResult<Uint8Array> {
  return safely(() => getCompiled(schema, structure).encode(value));
}

export function safeDecode<S extends EncodableStandardSchema>(
  schema: S,
  value: Uint8Array,
): SafeResult<StandardSchemaV1.InferOutput<S>>;
export function safeDecode<S extends StandardSchemaV1>(
  schema: S,
  value: Uint8Array,
  structure: StandardJSONSchemaV1<
    StandardSchemaV1.InferInput<S>,
    StandardSchemaV1.InferOutput<S>
  >,
): SafeResult<StandardSchemaV1.InferOutput<S>>;
export function safeDecode(
  schema: StandardSchemaV1,
  value: Uint8Array,
  structure?: StandardJSONSchemaV1,
): SafeResult<unknown> {
  return safely(() => getCompiled(schema, structure).decode(value));
}

/**
 * The validator and a codec over the same bytes that skips it, from either a Standard
 * Schema or a codec already built from one. `getCompiled` is cached, so passing the
 * schema costs a WeakMap hit. Read through the `_source`/`_structural` seam rather
 * than by unwrapping known classes, so `fingerprinted()` composes without either async
 * function importing `envelope.ts`.
 */
function asyncParts(
  schemaOrCodec: StandardSchemaV1 | Schema<unknown>,
  jsonSchema: StandardJSONSchemaV1 | undefined,
): { source: StandardSchemaV1<unknown, unknown>; structure: Schema<unknown> } {
  const codec =
    schemaOrCodec instanceof Schema ? schemaOrCodec : getCompiled(schemaOrCodec, jsonSchema);
  const source = codec._source;
  const structure = codec._structural;
  if (source === undefined || structure === undefined) {
    // Reached by an `m` schema and by `compile(schema).nullable()`, where the marker
    // wraps the codec that holds the validator. Both encode fine synchronously.
    throw new EncodeError(
      "This codec has no validator to await; async validation needs a codec from compile(), optionally wrapped by fingerprinted()",
    );
  }
  return { source, structure };
}

export async function encodeAsync<T>(codec: Schema<T>, value: T): Promise<Uint8Array>;
export async function encodeAsync<S extends EncodableStandardSchema>(
  schema: S,
  value: StandardSchemaV1.InferOutput<S>,
): Promise<Uint8Array>;
export async function encodeAsync<S extends StandardSchemaV1>(
  schema: S,
  value: StandardSchemaV1.InferOutput<S>,
  structure: StandardJSONSchemaV1<
    StandardSchemaV1.InferInput<S>,
    StandardSchemaV1.InferOutput<S>
  >,
): Promise<Uint8Array>;
export async function encodeAsync(
  schema: StandardSchemaV1 | Schema<unknown>,
  value: unknown,
  jsonSchema?: StandardJSONSchemaV1,
): Promise<Uint8Array> {
  const { source, structure } = asyncParts(schema, jsonSchema);
  return structure.encode(await validateAsync(source, value));
}

export async function decodeAsync<T>(codec: Schema<T>, value: Uint8Array): Promise<T>;
export async function decodeAsync<S extends EncodableStandardSchema>(
  schema: S,
  value: Uint8Array,
): Promise<StandardSchemaV1.InferOutput<S>>;
export async function decodeAsync<S extends StandardSchemaV1>(
  schema: S,
  value: Uint8Array,
  structure: StandardJSONSchemaV1<
    StandardSchemaV1.InferInput<S>,
    StandardSchemaV1.InferOutput<S>
  >,
): Promise<StandardSchemaV1.InferOutput<S>>;
export async function decodeAsync(
  schema: StandardSchemaV1 | Schema<unknown>,
  value: Uint8Array,
  jsonSchema?: StandardJSONSchemaV1,
): Promise<unknown> {
  const { source, structure } = asyncParts(schema, jsonSchema);
  // The public `decode`: a private structural decode stood here and rebuilt the same
  // framing without the `Uint8Array` brand check, so a wrong input type escaped as a
  // raw `TypeError` instead of a `DecodeError`.
  const decoded = structure.decode(value);
  try {
    return await validateAsync(source, decoded);
  } catch (error) {
    // `decode` refuses trailing data, so a decode that reaches validation has consumed
    // every byte: the payload length *is* the post-structure offset.
    rethrowAsDecodeError(error, value.length);
  }
}
