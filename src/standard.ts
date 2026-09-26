import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import {
  ArraySchema,
  BigIntSchema,
  BooleanSchema,
  canonicalEnumOrder,
  canonicalKeyOrder,
  DateSchema,
  DateTimeSchema,
  DecodeError,
  DynamicSchema,
  EncodeError,
  type EnumValue,
  EnumSchema,
  Float64Schema,
  IntSchema,
  LazySchema,
  LiteralSchema,
  MapSchema,
  ObjectSchema,
  OpenObjectSchema,
  Reader,
  RecordSchema,
  Schema,
  SetSchema,
  StringSchema,
  TupleSchema,
  UintSchema,
  UnionSchema,
  UuidSchema,
  Writer,
} from "./core.js";

type JsonSchema = Record<string, unknown>;

/**
 * A JSON Schema as a plain object, the form `structure` accepts beside a Standard JSON
 * Schema implementation. One document serves both sides, so a transform cannot be
 * expressed this way, which is what Standard JSON Schema's two methods are for. A default
 * can: its field is optional in the document, the shape shorn gives a default either way.
 */
export interface JsonSchemaDocument {
  // Optional keywords and no index signature, deliberately. A converter's own document
  // type is an interface, and an interface never satisfies an index signature, so
  // `Record<string, unknown>` would refuse exactly the object the Valibot recipe hands
  // over. Listing the keywords instead lets any document sharing one of them through,
  // and still turns away a `{ structure }` wrapper, which shares none. The runtime gate
  // in `getCompiled` does the real checking.
  readonly $schema?: unknown;
  readonly $id?: unknown;
  readonly $ref?: unknown;
  readonly $defs?: unknown;
  readonly definitions?: unknown;
  readonly type?: unknown;
  readonly properties?: unknown;
  readonly required?: unknown;
  readonly additionalProperties?: unknown;
  readonly propertyNames?: unknown;
  readonly items?: unknown;
  readonly prefixItems?: unknown;
  readonly minItems?: unknown;
  readonly maxItems?: unknown;
  readonly anyOf?: unknown;
  readonly oneOf?: unknown;
  readonly allOf?: unknown;
  readonly not?: unknown;
  readonly const?: unknown;
  readonly enum?: unknown;
  readonly format?: unknown;
  readonly pattern?: unknown;
  readonly minLength?: unknown;
  readonly maxLength?: unknown;
  readonly minimum?: unknown;
  readonly maximum?: unknown;
  readonly exclusiveMinimum?: unknown;
  readonly exclusiveMaximum?: unknown;
  readonly title?: unknown;
  readonly description?: unknown;
  readonly default?: unknown;
  readonly deprecated?: unknown;
  readonly "x-shorn"?: unknown;
  readonly "x-shorn-key"?: unknown;
}

/**
 * shorn's extension keyword, for the four types JSON Schema has no form for. The vendor
 * hooks in `conversionOptions` write it, `valibotOverride` writes it for Valibot, and a
 * hand-written document may carry it. The element of a set and the value of a map sit
 * under `items`, as an array's element does; a map's key has a keyword of its own.
 */
const RICH_KEYWORD = "x-shorn";
const RICH_KEY_KEYWORD = "x-shorn-key";

type WireShape =
  | "any"
  | "bigint"
  | "boolean"
  | "date"
  // A `date-time` string in the Date layout: a shape of its own, since it decodes to a
  // string and `date` to a Date, so the two must not share a signature.
  | "datetime"
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
  // `set` is the array layout and `map` the array-of-pairs layout, under names of their
  // own because they decode to a Set and a Map rather than to arrays.
  | { readonly set: WireShape }
  | { readonly map: readonly [key: WireShape, value: WireShape] }
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
    }
  // A union with no discriminant, keyed by the JSON type of the value instead. A
  // separate variant rather than `on: undefined`, so the two forms cannot derive the
  // same signature.
  | { readonly union: readonly WireShape[]; readonly types: readonly string[] }
  // The back-edge of a cycle, as an index into a `WireDocument`'s definition table.
  | { readonly ref: number };

/**
 * A whole document's shape. The definition table is a property of the document rather
 * than of any shape inside it: a `{ ref }` is only ever resolved against the top level , 
 * and it is absent unless a cycle was found, so a schema without one keeps the signature,
 * and therefore the fingerprint, it already had.
 */
type WireDocument =
  | WireShape
  | { readonly defs: readonly WireShape[]; readonly root: WireShape };

interface WireField {
  readonly key: string;
  readonly optional: boolean;
  readonly value: WireShape;
}

export type EncodableStandardSchema<Input = unknown, Output = Input> =
  StandardSchemaV1<Input, Output> & StandardJSONSchemaV1<Input, Output>;

/**
 * The structure half a validator that carries no JSON Schema of its own has to be handed
 * separately: the extra argument on the second overload of every entry point below.
 */
// One alias rather than the same four lines nine times.
type StructureFor<S extends StandardSchemaV1> =
  | StandardJSONSchemaV1<StandardSchemaV1.InferInput<S>, StandardSchemaV1.InferOutput<S>>
  | JsonSchemaDocument;

export type SafeResult<T> = { success: true; data: T } | { success: false; error: Error };

/**
 * What `safeEncode` and `safeDecode` catch. The normalization is the part worth having
 * once: a vendor's validator may reject with something that is not an `Error`, and
 * `SafeResult` promises one.
 */
function safely<T>(run: () => T): SafeResult<T> {
  try {
    return { success: true, data: run() };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/**
 * An issue's path in the notation `EncodeError.path` uses for the wire, `tags[1].id`, so a
 * field reads the same whichever side refused it. Valibot's segments are `{ key }` objects.
 */
function issuePath(issue: StandardSchemaV1.Issue): string {
  let path = "";
  for (const segment of issue.path ?? []) {
    const key = typeof segment === "object" ? segment.key : segment;
    path += typeof key === "number" ? `[${key}]` : `${path && "."}${String(key)}`;
  }
  return path;
}

/**
 * The joined message is for a log line, the array for an HTTP handler. `path` is the
 * first issue's, and is what `Schema.encode` would otherwise have guessed at by walking
 * the value the validator was handed, which named the wrong field once it coerced one.
 */
function validationError(issues: ReadonlyArray<StandardSchemaV1.Issue>): EncodeError {
  const paths = issues.map(issuePath);
  const error = new EncodeError(
    issues.map((issue, index) => (paths[index] ? `${paths[index]}: ` : "") + issue.message).join("; "),
  );
  error.issues = issues;
  if (paths[0]) error.path = paths[0];
  return error;
}

/**
 * A validator that throws instead of returning issues, in the class the entry point
 * promises. `z.int().refine((v) => { … })` whose body throws is all it takes, and until
 * 0.3.0 that error escaped `encode`, `decode` and both async twins as itself: a
 * `RangeError` out of a function documented to throw only `EncodeError`, so a caller
 * narrowing on the class fell straight through it. Wrapped here rather than at the four
 * entry points, which is also the only layer that knows a validator ran at all: an
 * arbitrary throw from inside `_encode` is the caller's own getter and must stay its own
 * error. `cause` keeps the original.
 */
function thrownByValidator(error: unknown): EncodeError {
  if (error instanceof EncodeError) return error;
  return new EncodeError(
    error instanceof Error ? error.message : "The validator threw a value that is not an Error",
    { cause: error },
  );
}

function validateSync<T>(schema: StandardSchemaV1<unknown, T>, value: unknown): T {
  // The `try` covers the validator's call and nothing else, so the structural halves keep
  // the catch-free bodies `encodePath` explains. One per encode or decode, not one per
  // leaf, and the validated person fixture measured no change either way.
  let result: ReturnType<StandardSchemaV1<unknown, T>["~standard"]["validate"]>;
  try {
    result = schema["~standard"].validate(value);
  } catch (error) {
    throw thrownByValidator(error);
  }
  // Thenable rather than `instanceof Promise`: a vendor may hand back a promise
  // from another realm, which fails the instance check while being one.
  if (typeof (result as { then?: unknown } | null)?.then === "function") {
    // Handled before it is dropped. Zod answers with a Promise whenever a refinement
    // throws, so this is often a rejection nobody else will ever see, and an unhandled
    // rejection ends a Node process by default: one bad value took the server with it.
    (result as PromiseLike<unknown>).then(undefined, () => {});
    throw new EncodeError(
      "This Standard Schema validates asynchronously; use encodeAsync/decodeAsync, which accept either this schema or a codec built from it.",
    );
  }
  const sync = result as StandardSchemaV1.Result<T>;
  if (sync.issues) throw validationError(sync.issues);
  return sync.value;
}

async function validateAsync<T>(schema: StandardSchemaV1<unknown, T>, value: unknown): Promise<T> {
  let result: StandardSchemaV1.Result<T>;
  try {
    result = await schema["~standard"].validate(value);
  } catch (error) {
    throw thrownByValidator(error);
  }
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
    // Every fact a container reads from its children, since this codec can be one: an
    // `m` array around it that saw no `_slots` skipped the empty-payload slot ceiling.
    this._minWidth = _structural._minWidth;
    this._slots = _structural._slots;
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

/** Said from three places, since the vendors lose a `__proto__` field three different ways. */
const PROTO_KEY_MESSAGE =
  'A "__proto__" property does not survive a JSON Schema; rename the field';

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

/**
 * The values a node names outright: a `const`, or an `enum` whose members are all
 * scalars. Such a node is a set of values whatever its `type` says, because each value
 * names its own type. The vendors disagree about the keyword beside it: zod writes a
 * `type` next to a literal, valibot and arktype often write none, and valibot writes a
 * `type` array beside a mixed picklist. Reading the values alone is what gives
 * `{ enum: [x] }` and `{ const: x }`, the same JSON Schema, the same wire shape.
 */
function literalValues(schema: JsonSchema): readonly EnumValue[] | undefined {
  if ("const" in schema) return isEnumValue(schema.const) ? [schema.const] : undefined;
  return Array.isArray(schema.enum) && schema.enum.every(isEnumValue) ? schema.enum : undefined;
}

/**
 * A set of values as a wire shape: nothing for one value, an index for more. `null` is
 * never a member here: every caller has taken it out to become a marker or a type of its
 * own, so an enum shape never holds `null` and never needs `admitsNull`'s answer.
 *
 * `true` and `false` together are `boolean` by another name, and write the same bytes as
 * it, so they get its shape and its fingerprint rather than a second one.
 */
function literalSet(values: readonly EnumValue[]): WireShape {
  const members = canonicalEnumOrder([...new Set(values)]);
  if (members.length === 2 && members[0] === false && members[1] === true) return "boolean";
  return members.length === 1 ? { literal: members[0]! } : { enum: members };
}

/**
 * A node's branches when it is a union: `anyOf`, `oneOf`, or a `type` array, which is the
 * same union written short. Zod 4.5 compacts an `anyOf` over bare types to one, so
 * `z.union([z.string(), z.number()])` arrives that way from 4.5 and as `anyOf` from 4.4
 * and from every other vendor. Each type becomes a branch carrying every other keyword,
 * and each branch reads only the ones that belong to its own type.
 *
 * Not a `$ref`: a pointer is followed by `refShape` and never opened up here, so a cycle
 * is still found where it closes. Not a set of values either, whose `type` array only
 * restates what the values already say.
 */
function unionBranches(schema: JsonSchema): readonly unknown[] | undefined {
  if (typeof schema.$ref === "string" || schema[RICH_KEYWORD] !== undefined) return undefined;
  const union =
    schema.anyOf ??
    schema.oneOf ??
    (literalValues(schema) === undefined && Array.isArray(schema.type)
      ? schema.type.map((type) => ({ ...schema, type }))
      : undefined);
  return Array.isArray(union) ? union : undefined;
}

/**
 * Every branch of a union, with any branch that is itself a union opened into its own.
 * A nested union is the same type as the flat one, and the vendors nest where they
 * please: zod compacts a union of bare types into a `type` array but nests an `anyOf`
 * as soon as one branch carries a keyword such as `.min(1)`, and `v.nullable(v.union())`
 * always nests. Classified as nested, one type had two wire shapes that could not read
 * each other's bytes.
 */
function flatBranches(branches: readonly unknown[], into: JsonSchema[] = []): JsonSchema[] {
  for (const branch of branches.map(asSchema)) {
    const nested = unionBranches(branch);
    if (nested === undefined) into.push(branch);
    else flatBranches(nested, into);
  }
  return into;
}

/**
 * The JSON type a branch declares, taken from `type` or from the `const` standing in for
 * it. Only a `$ref`'s target can still be a const by the time this is asked: a branch
 * that is a set of values is grouped by its values' types before any branch is typed.
 */
function branchType(branch: JsonSchema): string | undefined {
  if (typeof branch.type === "string") return branch.type;
  if (!("const" in branch) || !isEnumValue(branch.const)) return undefined;
  return branch.const === null ? "null" : typeof branch.const;
}

/**
 * The JSON type of each branch, when every branch declares exactly one and no two share
 * it. That is the whole condition for encoding a union with no discriminant: the type of
 * the value names its branch, so nothing is tried and nothing is guessed.
 *
 * `integer` folds into `number` because no value carries which of the two it was declared
 * as, so a union of the pair is not disjoint and stays refused. A branch with no `type`
 * at all, `z.any()`, a bare `{}`, is refused for the same reason: it overlaps whatever
 * sits beside it.
 */
function disjointTypes(
  branches: readonly JsonSchema[],
  ctx: RefContext,
): readonly string[] | undefined {
  const types: string[] = [];
  for (const branch of branches) {
    // A branch that is a bare `$ref`: one arm of a union being the whole recursive
    // definition: keeps its type at the far end of the pointer. One hop, deliberately:
    // a pointer to another pointer reads as typeless and is refused, like any other
    // branch whose type cannot be named.
    const target =
      typeof branch.$ref === "string" ? resolvePointer(ctx.document, branch.$ref) : branch;
    const declared = branchType(target);
    if (declared === undefined) return undefined;
    const type = declared === "integer" ? "number" : declared;
    if (types.includes(type)) return undefined;
    types.push(type);
  }
  return types.length === 0 ? undefined : types;
}

const UNION_REFUSAL =
  "Only nullable, discriminated and type-disjoint JSON Schema unions are currently supported; give the branches one property that is a distinct const in each, or make no two branches share a JSON type";

/**
 * One wire shape per union type, however the vendor spelled it. The branches arrive
 * flattened; this takes the `null`s out, reads what is left, and puts `null` back in
 * the one form that fits.
 *
 * `null` is a branch typed `null`, a `const: null`, or a `null` among an enum's values.
 * The rest is read in order:
 *
 * - nothing left: the union is `null` itself, which is what zod 4.4's
 *   `z.null().nullable()`, `anyOf: [{type:"null"}, {type:"null"}]`, amounts to;
 * - only sets of values: one merged set, so `z.union([z.literal("a"), z.literal("b")])`,
 *   which used to be refused, writes what `z.enum(["a", "b"])` writes;
 * - one branch: that branch, and no index to pick it;
 * - arktype's three spellings of a uuid, or a discriminant: those shapes, as before.
 *
 * For all of those `null` is a marker in front. For a type-disjoint union it is one of
 * the types instead, since `null` has a JSON type of its own: that is the form zod 4.5
 * and arktype already produced for `a | b | null`, and it costs the index byte the
 * union writes anyway where a marker would add one.
 */
function unionShape(branches: readonly JsonSchema[], ctx: RefContext): WireShape {
  let hasNull = false;
  // Every branch that holds something besides `null`, and of those, the ones that are
  // not sets of values. The sets are pooled instead, by the JSON type of their members,
  // which is also the whole merged set when nothing else is left. Pooled rather than
  // refused, so that arktype's `"'a' | 'b' | number"`, two consts beside a number,
  // reads as zod's enum beside one.
  const rest: JsonSchema[] = [];
  const typed: JsonSchema[] = [];
  const literals = new Map<string, EnumValue[]>();
  for (const branch of branches) {
    const values = literalValues(branch);
    if (values === undefined ? branch.type === "null" : values.includes(null)) hasNull = true;
    if (values === undefined ? branch.type === "null" : values.every((value) => value === null)) {
      continue;
    }
    rest.push(branch);
    if (values === undefined) typed.push(branch);
    for (const value of values ?? []) {
      if (value === null) continue;
      const pool = literals.get(typeof value);
      if (pool === undefined) literals.set(typeof value, [value]);
      else pool.push(value);
    }
  }
  const marked = (shape: WireShape): WireShape => (hasNull ? nullableOf(shape) : shape);
  if (rest.length === 0) {
    // An empty `anyOf` holds no value at all, which is not a shape anyone meant.
    if (hasNull) return { literal: null };
    throw new EncodeError(UNION_REFUSAL);
  }
  if (typed.length === 0) return marked(literalSet([...literals.values()].flat()));
  if (rest.length === 1) return marked(wireShape(rest[0]!, ctx));

  // ArkType spells `string.uuid` as three branches: the lowercase pattern, plus
  // the nil and max UUIDs as consts: every branch tagged `format: "uuid"`. One
  // wire shape already covers all three, so the union collapses to it.
  if (
    rest.every(
      (branch) =>
        branch.format === "uuid" && (branch.type === "string" || typeof branch.const === "string"),
    )
  ) {
    return marked("uuid");
  }

  const found = discriminant(rest);
  if (found !== undefined) {
    // Ordered by discriminant, so the branch index survives a reordering of the
    // schema. `canonicalEnumOrder` refuses the members with no JSON text of their
    // own, which is why `indexOf`'s strict equality is enough here.
    const cases = canonicalEnumOrder(found.cases);
    return marked({
      on: found.on,
      cases,
      union: cases.map((value) => wireShape(rest[found.cases.indexOf(value)]!, ctx)),
    });
  }

  // No discriminant, but possibly no ambiguity either: branches separated by JSON type
  // need nothing on the wire beyond the index a discriminated union already writes.
  // Each pooled set and the `null` become branches of their own, written as the JSON
  // Schema they are, so that a type they share with another branch is refused by the
  // same test as any other overlap.
  for (const [type, values] of literals) typed.push({ type, enum: values });
  if (hasNull) typed.push({ type: "null" });
  const byType = disjointTypes(typed, ctx);
  if (byType !== undefined) {
    // Ordered by type name, so the branch index survives a reordering of the schema.
    const types = canonicalKeyOrder(byType);
    return {
      types,
      union: types.map((type) => wireShape(typed[byType.indexOf(type)]!, ctx)),
    };
  }

  throw new EncodeError(UNION_REFUSAL);
}

/**
 * Whether a shape already decodes to `null` without a marker of its own: exactly the set
 * `Schema.nullable()` declines to put a second marker on.
 */
function admitsNull(shape: WireShape, defNulls?: readonly boolean[]): boolean {
  if (typeof shape === "string") return shape === "any";
  if ("literal" in shape) return shape.literal === null;
  // No `enum` case: `literalSet` takes `null` out of every set of values before it
  // becomes one. Only the undiscriminated union can carry a `null` branch: a
  // discriminated one is all objects, but reading the branches keeps both forms on a
  // single rule.
  if ("union" in shape) return shape.union.some((branch) => admitsNull(branch, defNulls));
  // Unanswerable while the cycle is still open, which is every call from `nullableOf`.
  // `defNulls` settles it later, and `LazySchema` carries the answer to the check.
  if ("ref" in shape) return defNulls?.[shape.ref] ?? false;
  return "nullable" in shape;
}

/**
 * A nullable marker over a shape that already holds `null` is dropped here, one level
 * above where `Schema.nullable()` would deal with it, which is the level the signature
 * is taken at, and that turns out to matter.
 *
 * Two cases arrive here, and both reached the caller wrong. `any` and `null` made
 * `Schema.nullable()` throw "already decodes to null", blaming a `.nullable()` the caller
 * did write for a marker this compiler added: `z.any().nullable()` is the plain one, since
 * tag 0 is already `null`. A null-bearing enum used to be a third, and no longer arrives:
 * its `null` is taken out to become this marker. A nested `{nullable:{nullable:…}}` did
 * *not* throw, because `Schema.nullable()` collapses a repeat and returns itself, but it
 * collapsed below the signature: two schemas writing byte-identical payloads carried
 * different fingerprints and so rejected each other's bytes, which is the false positive
 * `fingerprinted()` exists to not produce.
 *
 * No shape changes what it writes. The nested case's fingerprint does change, to the one
 * matching the bytes it was already producing.
 */
function nullableOf(shape: WireShape): WireShape {
  return admitsNull(shape) ? shape : { nullable: shape };
}

/**
 * The state one document's `$ref`s are resolved against. Threaded through `wireShape`
 * rather than closed over, so every recursion site says out loud that it is walking the
 * same document.
 */
interface RefContext {
  /** What a pointer is relative to. `$ref: "#"`, zod's spelling, names this. */
  readonly document: JsonSchema;
  /** Pointers being expanded right now; a `$ref` back to one of these is a cycle. */
  readonly active: Set<string>;
  /**
   * What each pointer resolved to: the shape itself once expanded, or the `{ ref }` a
   * cycle head was numbered with the moment something referred back to it. Also what
   * keeps a shared subtree from being walked once per reference: a chain of refs each
   * used twice would otherwise expand exponentially, which matters because the document
   * may have been fetched rather than written.
   */
  readonly shapes: Map<string, WireShape>;
  readonly defs: (WireShape | undefined)[];
}

/**
 * JSON Pointer, the subset a `$ref` uses. Same-document only: fetching a remote schema
 * mid-build is not something a serializer should be doing.
 */
function resolvePointer(document: JsonSchema, pointer: string): JsonSchema {
  if (pointer === "#" || pointer === "") return document;
  if (!pointer.startsWith("#/")) {
    throw new EncodeError(
      `Unsupported JSON Schema reference ${JSON.stringify(pointer)}; only same-document references are supported`,
    );
  }
  let node: unknown = document;
  for (const segment of pointer.slice(2).split("/")) {
    // `~1` before `~0`, as RFC 6901 requires: the other order turns `~01` into `/`.
    node = asSchema(node)[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (node === undefined) {
      throw new EncodeError(`JSON Schema reference ${JSON.stringify(pointer)} does not resolve`);
    }
  }
  return asSchema(node);
}

/**
 * A `$ref`, as either a definition or an inlined copy.
 *
 * A reference reached while its own target is still being expanded is the back-edge of a
 * cycle: it becomes a numbered definition, and every later reference to that pointer is
 * the same number. A reference to something already finished is simply that shape again,
 * a shared subtree, not a recursive one, so it is inlined, which keeps a
 * non-recursive `$ref` out of the signature and off `LazySchema`'s indirection.
 *
 * The numbering is the walk's own, and depends on where the walk entered each cycle;
 * `canonicalDocument` replaces it with one that does not.
 */
function refShape(pointer: string, ctx: RefContext): WireShape {
  const known = ctx.shapes.get(pointer);
  if (known !== undefined) return known;

  if (ctx.active.has(pointer)) {
    // The back-edge of a cycle. Numbered here and remembered, so every later reference to
    // this pointer, including the one that finishes the expansion below, is the same id.
    const ref: WireShape = { ref: ctx.defs.length };
    ctx.defs.push(undefined);
    ctx.shapes.set(pointer, ref);
    return ref;
  }

  ctx.active.add(pointer);
  const shape = wireShape(resolvePointer(ctx.document, pointer), ctx);
  ctx.active.delete(pointer);

  const ref = ctx.shapes.get(pointer);
  if (ref === undefined) {
    ctx.shapes.set(pointer, shape);
    return shape;
  }
  // Present only if something referred back mid-expansion, which is what made it a
  // definition; the slot reserved above is filled now that the shape exists.
  ctx.defs[(ref as { readonly ref: number }).ref] = shape;
  return ref;
}

/**
 * A recursive document in the one form its type has, whichever type the walk met first.
 *
 * `refShape` numbers a definition wherever a cycle first closes, and where that is
 * depends on the spelling: zod points a `$ref` at a definition from wherever the type is
 * used while valibot inlines one unrolling there, and a zod object declaring `b` before
 * `a` enters a mutual recursion at the other type. Same cycle, same bytes, different
 * signatures, and `fingerprinted()` then refused payloads it could decode. Folding one
 * definition's copy back onto another cannot settle it: the two definitions are the one
 * cycle entered at different types, and neither is a subtree of the other.
 *
 * So the root and the definitions are read as one graph: every object and array in them
 * a node, and a `{ ref }` not a node but an edge to that definition's body. The graph is
 * minimized. Nodes start in classes by their own text with their children left out, and
 * a class splits by its members' children's classes until no class splits: two nodes
 * still sharing a class unfold to the same infinite tree. The classes are then emitted
 * from the root, depth first, children in the order the signature writes them. A class
 * met again while it is still being emitted closes a cycle and becomes the next
 * definition; a finished definition is a `{ ref }` wherever it appears; any other class
 * is inlined, from a memo, so a subtree shared many times is built once.
 *
 * `rejectUnknown` stays in a node's text although the signature leaves it out: a merged
 * class compiles once, and two objects differing only in whether they police extra keys
 * must not compile to one of them.
 */
function canonicalDocument(root: WireShape, defs: readonly WireShape[]): WireDocument {
  const nodes: object[] = [];
  const labels: string[] = [];
  const edges: number[][] = [];
  const ids = new Map<object, number>();
  const isNode = (value: unknown): value is object => typeof value === "object" && value !== null;
  const visit = (start: object): number => {
    let node = start;
    for (let hops = 0; "ref" in node; hops++) {
      // A definition whose body is itself a reference: a `$ref` to a `$ref`, round in a
      // circle with no schema anywhere on it, as `{ "$ref": "#" }` alone is. It described
      // no value, and compiled to a codec that failed on first use.
      if (hops > defs.length) throw new EncodeError("Unsupported Standard JSON Schema node");
      node = defs[(node as { readonly ref: number }).ref] as object;
    }
    let id = ids.get(node);
    if (id !== undefined) return id;
    ids.set(node, (id = nodes.length));
    nodes.push(node);
    // Every child written as `{}`, which no scalar a shape holds is written as.
    labels.push(JSON.stringify(node, (key, value) => (key !== "" && isNode(value) ? {} : value)));
    const children: number[] = [];
    edges.push(children);
    for (const value of Object.values(node)) if (isNode(value)) children.push(visit(value));
    return id;
  };
  const top = visit(root as object);

  // Refined incrementally: a node can split from its class only when one of its children
  // has just changed class, so each round reads those nodes alone, against the classes
  // as they stood when the round began. Re-reading every node every round made a cycle
  // of n alike links ending in one odd link quadratic, n rounds of n nodes: 200 links
  // took 69 ms that way, against 37 for the fold this replaced and 3 for this. The
  // difference costs 121 gzip bytes, and a fetched document can be that cycle.
  const seen = new Map<string, number>();
  const classes = labels.map((label) => {
    let cls = seen.get(label);
    if (cls === undefined) seen.set(label, (cls = seen.size));
    return cls;
  });
  const sizes: number[] = [];
  for (const cls of classes) sizes[cls] = (sizes[cls] ?? 0) + 1;
  const parents = nodes.map((): number[] => []);
  edges.forEach((children, id) => children.forEach((child) => parents[child]!.push(id)));
  for (let dirty = new Set(nodes.keys()); dirty.size > 0; ) {
    const groups = new Map<string, number[]>();
    // How many members of each class this round did not read.
    const unread = new Map<number, number>();
    for (const id of dirty) {
      const cls = classes[id]!;
      const key = `${cls}:${edges[id]!.map((child) => classes[child])}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(id);
      unread.set(cls, (unread.get(cls) ?? sizes[cls]!) - 1);
    }
    dirty = new Set();
    for (const group of groups.values()) {
      // A class read in full keeps its number for its first group. Any other group read
      // here differs from the members that were not, which all still agree with each
      // other, so it moves to a class of its own.
      const cls = classes[group[0]!]!;
      if (unread.get(cls) === 0) {
        unread.set(cls, -1);
        continue;
      }
      sizes[cls]! -= group.length;
      sizes.push(group.length);
      for (const id of group) {
        classes[id] = sizes.length - 1;
        for (const parent of parents[id]!) dirty.add(parent);
      }
    }
  }

  const first: number[] = [];
  classes.forEach((cls, id) => (first[cls] ??= id));
  const out: unknown[] = [];
  // What each class emits as, once it is known: its inlined shape, or the `{ ref }` of the
  // definition it became. `null` while it is still being emitted.
  const forms: unknown[] = [];
  const emit = (cls: number): unknown => {
    let form = forms[cls];
    if (form === null) form = forms[cls] = { ref: out.push(undefined) - 1 };
    if (form !== undefined) return form;
    forms[cls] = null;
    const id = first[cls]!;
    const node = nodes[id]!;
    const children = edges[id]!;
    // Loops rather than `map` callbacks, so a level of nesting costs one stack frame here
    // and a deep schema overflows no sooner than the walk that built it. A node with no
    // children, an enum's thousand members say, is the one it already was.
    let shape: unknown = node;
    if (children.length > 0) {
      const entries = Object.entries(node);
      let next = 0;
      for (const entry of entries) if (isNode(entry[1])) entry[1] = emit(classes[children[next++]!]!);
      shape = Array.isArray(node) ? entries.map((entry) => entry[1]) : Object.fromEntries(entries);
    }
    form = forms[cls];
    if (form === null) return (forms[cls] = shape);
    out[(form as { readonly ref: number }).ref] = shape;
    return form;
  };
  const shape = emit(classes[top]!) as WireShape;
  return out.length === 0 ? shape : { defs: out as WireShape[], root: shape };
}

/**
 * One document as one shape, with any cycle lifted into a definition table.
 *
 * The root is expanded through `refShape` rather than directly, so that `$ref: "#"` is
 * recognised as the back-edge it is.
 */
function toWireShape(document: JsonSchema): WireDocument {
  const ctx: RefContext = { document, active: new Set(), shapes: new Map(), defs: [] };
  const root = refShape("#", ctx);
  if (ctx.defs.length === 0) return root;
  const defs = ctx.defs as WireShape[];
  // Now, and only now, is `admitsNull` answerable for a back-edge, so this is where the
  // marker `nullableOf` had to guess about comes off. It has to happen at this level
  // rather than in `compileShape`, because this is the level the signature is taken at,
  // and before the graph is minimized, so a spelling carrying the redundant marker and
  // one without it are the same graph by the time it is.
  const nulls = defNulls(defs);
  return canonicalDocument(
    dropDefNullable(root, nulls) as WireShape,
    defs.map((def) => dropDefNullable(def, nulls) as WireShape),
  );
}

/**
 * A `{ nullable: { ref } }` over a definition that already decodes to `null`, collapsed
 * to the definition. This is `nullableOf`'s rule, applied where the answer exists: a
 * cycle is still open when that function runs, so `admitsNull` reads a back-edge as "no"
 * and wraps a marker that `Schema.nullable()` then refuses outright: `T.nullable()`
 * where `T` is a recursive `T | null` did not compile at all, and the message blamed the
 * `.nullable()` the caller had written for a marker this compiler added.
 *
 * Nothing that compiled before changes shape: every occurrence of this pattern threw, so
 * no payload and no fingerprint depended on it. Collapsing cannot cascade, because
 * `nullableOf` never nests one nullable inside another.
 */
function dropDefNullable(node: unknown, nulls: readonly boolean[]): unknown {
  if (typeof node !== "object" || node === null) return node;
  if (Array.isArray(node)) return node.map((value) => dropDefNullable(value, nulls));
  const shape = node as { readonly nullable?: unknown };
  const inner = shape.nullable;
  if (
    typeof inner === "object" &&
    inner !== null &&
    "ref" in inner &&
    nulls[(inner as { readonly ref: number }).ref] === true
  ) {
    return inner;
  }
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [key, dropDefNullable(value, nulls)]),
  );
}

function wireShape(schema: JsonSchema, ctx: RefContext): WireShape {
  // Ahead of every other keyword: a `$ref` node carries no `type`, and what it points at
  // is the whole of what it means here.
  if (typeof schema.$ref === "string") return refShape(schema.$ref, ctx);

  // Next, because a node carrying the keyword has no `type` either: the vendor had
  // nothing to write there, which is the whole reason the keyword exists.
  const rich = schema[RICH_KEYWORD];
  if (rich !== undefined) {
    switch (rich) {
      case "date":
        return "date";
      case "bigint":
        return "bigint";
      case "set":
        return { set: "items" in schema ? wireShape(asSchema(schema.items), ctx) : "any" };
      case "map":
        return {
          map: [
            RICH_KEY_KEYWORD in schema ? wireShape(asSchema(schema[RICH_KEY_KEYWORD]), ctx) : "any",
            "items" in schema ? wireShape(asSchema(schema.items), ctx) : "any",
          ],
        };
    }
    throw new EncodeError(
      `Unsupported ${RICH_KEYWORD} kind ${typeof rich === "string" ? rich : typeof rich}`,
    );
  }

  // `anyOf` and `oneOf` differ in whether the branches may overlap, which is a
  // validation question the vendor has already answered by the time shorn runs.
  // Zod writes a plain union as `anyOf` and a discriminated one as `oneOf`; both
  // arrive here as the same list of branches, and a `type` array as the branches it
  // abbreviates.
  const union = unionBranches(schema);
  if (union !== undefined) return unionShape(flatBranches(union), ctx);

  // A set of values standing alone is read by the union's rule, as the one-branch union
  // it is: `z.literal(["a", "b", null])` is `z.enum(["a", "b"]).nullable()` spelled
  // another way, and writes the same marker and index; `z.enum(["a"])` is `z.literal("a")`
  // and writes nothing.
  const values = literalValues(schema);
  if (values !== undefined) {
    if (values.length === 0) throw new EncodeError("Empty enums are unsupported");
    return unionShape([schema], ctx);
  }
  if ("const" in schema) throw new EncodeError("Unsupported JSON Schema literal");

  switch (schema.type) {
    case "string":
      // The two formats with a packed form. Neither text is fully recoverable from its
      // value, so both schemas accept only the one spelling that survives the trip and
      // refuse the rest at encode; `UuidSchema` and `DateTimeSchema` say which.
      return schema.format === "uuid" ? "uuid" : schema.format === "date-time" ? "datetime" : "string";
    case "boolean":
      return "boolean";
    case "null":
      // `z.null()` and `z.literal(null)` are the same schema written two ways; the
      // second already compiled, so this is the same literal shape from the first.
      return { literal: null };
    case "integer":
      // `.positive()` and `.nonnegative()` are the same lower bound written two ways:
      // Zod emits `exclusiveMinimum: 0` for the first and `minimum: 0` for the second.
      // Reading only `minimum` costs the commonest non-negative integer schema the
      // zigzag path, which crosses every varint boundary at half the value.
      return (typeof schema.minimum === "number" && schema.minimum >= 0) ||
        (typeof schema.exclusiveMinimum === "number" && schema.exclusiveMinimum >= -1)
        ? "uint"
        : "int";
    case "number":
      return "float64";
    case "array": {
      if (Array.isArray(schema.prefixItems)) {
        const tuple = schema.prefixItems.map((item) => wireShape(asSchema(item), ctx));
        // `items` beside `prefixItems` is the rest element; `false` means there is none.
        return "items" in schema && schema.items !== false
          ? { tuple, rest: wireShape(asSchema(schema.items), ctx) }
          : { tuple };
      }
      // No `items` leaves the elements unconstrained, which is what `any` already means
      // here: a bare `{}` compiles to it below. arktype spells `unknown[]` that way,
      // where zod and valibot both write `items: {}`; refusing it made the same type
      // compile from two vendors and not the third.
      const array = "items" in schema ? wireShape(asSchema(schema.items), ctx) : "any";
      // A count the schema fixes needs no length varint, and like a tuple may hold a
      // zero-width element.
      return typeof schema.minItems === "number" && schema.minItems === schema.maxItems
        ? { array, length: schema.minItems }
        : { array };
    }
    case "object": {
      const properties = asSchema(schema.properties ?? {});
      // A field named `__proto__` does not survive the trip through JSON Schema: valibot
      // builds `properties` by assignment, so the key sets that object's prototype
      // instead of joining it, and the field is invisible below. Left alone it compiled
      // to an object without the field, and an unvalidated codec then dropped the value
      // on the wire without a word.
      const proto: unknown = Object.getPrototypeOf(properties);
      if (proto !== Object.prototype && proto !== null) throw new EncodeError(PROTO_KEY_MESSAGE);
      const additional = schema.additionalProperties;
      // `true` and `{}` both mean a value of any shape; normalized to one here.
      const extras =
        additional === undefined || additional === false
          ? undefined
          : wireShape(additional === true ? {} : asSchema(additional), ctx);
      // No declared properties makes it a record: every key open, one value type. With
      // them it is an open object: the same record, written after the declared fields.
      if (extras !== undefined && Object.keys(properties).length === 0) {
        return { record: extras };
      }
      const required = new Set(
        Array.isArray(schema.required)
          ? schema.required.filter((key): key is string => typeof key === "string")
          : [],
      );
      for (const key of required) {
        if (Object.hasOwn(properties, key)) continue;
        // The `__proto__` case again, from the vendor that drops the property instead of
        // setting a prototype with it: zod lists it in `required` and omits it from
        // `properties`. Same remedy, so the same sentence rather than one naming a
        // missing schema, which is not what went wrong.
        throw new EncodeError(
          key === "__proto__"
            ? PROTO_KEY_MESSAGE
            : `Required property ${JSON.stringify(key)} has no schema`,
        );
      }
      return {
        object: canonicalKeyOrder(Object.keys(properties)).map((key) => ({
          key,
          optional: !required.has(key),
          value: wireShape(asSchema(properties[key]), ctx),
        })),
        // Asks whether *shorn* must police extra properties, not whether the schema
        // does. `false` means the vendor's own validate() already dealt with them , 
        // zod's `object` strips, `strictObject` refuses, both emit `false`. `undefined`
        // (arktype) passes them through, and a closed object has nowhere to put them.
        rejectUnknown: additional === undefined,
        ...(extras === undefined ? {} : { extras }),
      };
    }
    default: {
      // A node with no `type` and nothing structural left to read is `any`: `z.any()`,
      // `z.unknown()`, a bare `{}`. Combinators are excluded deliberately, so a shape
      // carrying one is refused by name rather than quietly re-typed as a tagged blob , 
      // "type undefined" told the caller nothing. A well-formed `$ref` returned at the
      // top of this function; it stays on the list to name the malformed spelling.
      if (schema.type === undefined) {
        const combinator = COMBINATORS.find((keyword) => keyword in schema);
        if (combinator === undefined) return "any";
        throw new EncodeError(`Unsupported JSON Schema combinator ${combinator}`);
      }
      // Not `String(schema.type)`: the document may have been fetched, and a node
      // carrying an object with no prototype, or a `toString` of its own, would
      // replace this refusal with a TypeError of its own.
      throw new EncodeError(
        `Unsupported Standard JSON Schema type ${
          typeof schema.type === "object" ? "object" : String(schema.type)
        }`,
      );
    }
  }
}

/** Every scalar shape to its schema. The key type is what keeps this exhaustive. */
const SCALAR_SCHEMAS: Record<Extract<WireShape, string>, new () => Schema<unknown>> = {
  any: DynamicSchema,
  bigint: BigIntSchema,
  boolean: BooleanSchema,
  date: DateSchema,
  datetime: DateTimeSchema,
  float64: Float64Schema,
  int: IntSchema,
  string: StringSchema,
  uint: UintSchema,
  uuid: UuidSchema,
};

/** The definition each `{ ref }` stands for, absent unless the shape holds a cycle. */
type Lazies = readonly LazySchema<unknown>[];

function compileWireShape(shape: WireShape, lazies?: Lazies): Schema<unknown> {
  if (typeof shape === "string") return new SCALAR_SCHEMAS[shape]();
  if ("literal" in shape) return new LiteralSchema(shape.literal);
  if ("enum" in shape) return new EnumSchema(shape.enum as [EnumValue, ...EnumValue[]]);
  if ("ref" in shape) return lazies![shape.ref]!;
  if ("nullable" in shape) return compileWireShape(shape.nullable, lazies).nullable();
  if ("array" in shape) {
    return new ArraySchema(compileWireShape(shape.array, lazies), shape.length);
  }
  if ("tuple" in shape) {
    return new TupleSchema(
      // An arrow, not a bare reference: `map` passes the index, which `lazies` would take.
      shape.tuple.map((item) => compileWireShape(item, lazies)),
      shape.rest === undefined ? undefined : compileWireShape(shape.rest, lazies),
    );
  }
  if ("record" in shape) return new RecordSchema(compileWireShape(shape.record, lazies));
  if ("set" in shape) return new SetSchema(compileWireShape(shape.set, lazies));
  if ("map" in shape) {
    return new MapSchema(
      compileWireShape(shape.map[0], lazies),
      compileWireShape(shape.map[1], lazies),
    );
  }
  if ("union" in shape) {
    const branches = shape.union.map((branch) => compileWireShape(branch, lazies));
    // Without a discriminant the cases are JSON type names and the key is absent; the
    // wire form is the same varint index either way.
    return "types" in shape
      ? new UnionSchema(undefined, shape.types, branches)
      : new UnionSchema(shape.on, shape.cases, branches);
  }

  const objectShape = Object.create(null) as Record<string, Schema<unknown>>;
  for (const field of shape.object) {
    const schema = compileWireShape(field.value, lazies);
    objectShape[field.key] = field.optional ? schema.optional() : schema;
  }
  // The open half is built here rather than inside `ObjectSchema`, so `m` carries neither
  // `RecordSchema` nor the walk over the keys it holds.
  if (shape.extras !== undefined) {
    return new OpenObjectSchema(
      objectShape,
      shape.rejectUnknown,
      new RecordSchema(compileWireShape(shape.extras, lazies)),
    );
  }
  return new ObjectSchema(objectShape, shape.rejectUnknown);
}

/**
 * Which definitions can themselves decode to `null`, as the least fixed point over the
 * table: a back-edge starts at "no" and one round per definition settles the rest, since
 * a boolean lattice this shallow cannot keep moving.
 *
 * This is the one check `nullableOf` cannot make while a cycle is still open. `LazySchema`
 * carries the answer, so `nullable()` over a definition that already holds null is
 * refused when the codec is built rather than giving null two spellings on the wire.
 */
function defNulls(defs: readonly WireShape[]): boolean[] {
  const nulls = new Array<boolean>(defs.length).fill(false);
  // One round per definition settles a lattice this shallow: a back-edge starts at "no"
  // and only ever turns on, and there is one definition in every schema seen so far, so
  // the quadratic shape of this costs nothing worth an early exit.
  for (let round = 0; round < defs.length; round++) {
    defs.forEach((def, id) => (nulls[id] = admitsNull(def, nulls)));
  }
  return nulls;
}

/**
 * Definitions first, each as a `LazySchema` that exists before the schema it stands for
 * does. Every container reads its children's `_minWidth` in its own constructor, so a
 * back-edge has to be answerable before the cycle it closes is built.
 */
function compileShape(shape: WireDocument): Schema<unknown> {
  if (typeof shape !== "object" || !("defs" in shape)) return compileWireShape(shape);
  const lazies = defNulls(shape.defs).map((yieldsNull) => new LazySchema<unknown>(yieldsNull));
  shape.defs.forEach((def, id) => lazies[id]!.resolve(compileWireShape(def, lazies)));
  return compileWireShape(shape.root, lazies);
}

function wireSignature(shape: WireDocument): string {
  return JSON.stringify(shape, (key, value) => (key === "rejectUnknown" ? undefined : value));
}

/**
 * The output side's shape, with every object field the input side leaves optional made
 * optional here too, at any depth. That is the whole of what a default changes:
 * `z.string().default("x")` and ArkType's `"string = 'x'"` are optional going in and
 * required coming out, while Valibot's `v.optional(v.string(), "x")` writes one document
 * with the field optional on both sides. Taking the input side's optionality gives all
 * three one shape, and so one signature and one set of bytes.
 *
 * Nothing is lost by it but a presence bit. Encode validates first, so the value always
 * carries the field and the bit is always set; decode reads a missing field as absent and
 * the validator fills it, as it would for any input without it.
 *
 * Everything else comes from the output side, `rejectUnknown` included: Zod's input side
 * leaves out the `additionalProperties: false` its output side declares, and taking it
 * from there would make an `unchecked()` codec refuse the extras it has always ignored.
 * This walk decides nothing: the caller compares its result with the input side's
 * signature, and any other difference, a field required going in and optional coming out
 * among them, survives the walk and fails that comparison.
 */
function optionalAsInput(input: unknown, output: unknown): unknown {
  if (!output || typeof output !== "object") return output;
  // `Object()` so that a leaf, or a missing branch, on the input side reads as having no
  // children: wherever the two sides disagree, the comparison refuses the result anyway.
  const from = Object(input) as Record<string, unknown>;
  const merged = (Array.isArray(output) ? [] : {}) as Record<string, unknown>;
  for (const key of Object.keys(output)) {
    const node = (output as Record<string, unknown>)[key];
    // Optional if either side says so. A field optional only on the output side stays
    // optional here, where the input side's signature then refuses it.
    merged[key] = key === "optional" ? node || from[key] : optionalAsInput(from[key], node);
  }
  return merged;
}

function hasJsonSchema(value: StandardSchemaV1): value is EncodableStandardSchema {
  return "jsonSchema" in value["~standard"];
}

/** Either form `structure` takes. */
type Structure = StandardJSONSchemaV1 | JsonSchemaDocument;

function isStandardJsonSchema(structure: Structure): structure is StandardJSONSchemaV1 {
  return "~standard" in structure;
}

type Side = "input" | "output";

/** Whether a document points anywhere, which a child converted on its own must not. */
function holdsRef(node: unknown): boolean {
  if (typeof node !== "object" || node === null) return false;
  if (!Array.isArray(node) && typeof (node as JsonSchema).$ref === "string") return true;
  return Object.values(node).some(holdsRef);
}

/**
 * A Standard Schema's own JSON Schema, for the element of a set or the key or value of a
 * map: Zod's generator writes `{}` for the container and never descends, so the child is
 * converted as a document of its own and inlined where `items` would go. That is also
 * why a `$ref` anywhere in it is refused: it would resolve against the root document,
 * where its target is not.
 *
 * `converting` is the recursion guard. The override runs after Zod has traversed the
 * whole document, so a set whose element is the enclosing type would convert the type,
 * reach the set, and convert the type again without end.
 */
function childJsonSchema(child: unknown, io: Side, converting: Set<unknown>): JsonSchema {
  const recursion =
    "A recursive type inside a Set or Map is not supported; hold the recursion in an array or an object instead";
  if (converting.has(child)) throw new EncodeError(recursion);
  const std = (child as { readonly "~standard"?: EncodableStandardSchema["~standard"] })["~standard"];
  if (std?.jsonSchema === undefined) {
    throw new EncodeError("A Set or Map element has no Standard JSON Schema of its own");
  }
  converting.add(child);
  try {
    const document = asSchema(std.jsonSchema[io](conversionOptions(std.vendor, io, converting)));
    if (holdsRef(document)) throw new EncodeError(recursion);
    return document;
  } finally {
    converting.delete(child);
  }
}

interface ZodOverrideContext {
  readonly zodSchema: {
    readonly _zod: {
      readonly def: {
        readonly type: string;
        readonly values?: readonly unknown[];
        readonly keyType?: unknown;
        readonly valueType?: unknown;
        readonly reverseTransform?: unknown;
        readonly shape?: object;
      };
    };
  };
  readonly jsonSchema: JsonSchema;
}

/**
 * Zod's hook, one per side. Zod tests `unrepresentable` before it runs any override, so
 * the test is turned off and this does its work: the four types shorn encodes are
 * tagged with the keyword, and everything else the test would have thrown for is thrown
 * for here, in Zod's words, so that a `z.undefined()` field is refused exactly as it was.
 */
function zodOverride(io: Side, converting: Set<unknown>): (context: ZodOverrideContext) => void {
  return (context) => {
    const def = context.zodSchema._zod.def;
    const json = context.jsonSchema;
    switch (def.type) {
      case "date":
      case "bigint":
        json[RICH_KEYWORD] = def.type;
        return;
      case "set":
        json[RICH_KEYWORD] = "set";
        json.items = childJsonSchema(def.valueType, io, converting);
        return;
      case "map":
        json[RICH_KEYWORD] = "map";
        json[RICH_KEY_KEYWORD] = childJsonSchema(def.keyType, io, converting);
        json.items = childJsonSchema(def.valueType, io, converting);
        return;
      case "object":
        // Zod 4.6 writes a `__proto__` field into `properties` as an own key, where 4.5
        // left it out, but its validator still drops the key from every value it returns,
        // so every encode failed on a field that looked declared. Refused here, with the
        // message the other spellings get, because the document alone reads as valid.
        if (def.shape !== undefined && Object.hasOwn(def.shape, "__proto__")) {
          throw new EncodeError(PROTO_KEY_MESSAGE);
        }
        return;
      case "pipe":
        // A `z.codec()` is the one pipe with a way back, and shorn cannot take it: encode
        // writes the validator's output, so decode reads that output and runs the forward
        // transform over it again. A seconds-to-milliseconds codec came back a thousand
        // times too large. A plain `.pipe()` has no reverse and is read as before.
        if (def.reverseTransform !== undefined) {
          throw new EncodeError(
            "A z.codec() would transform twice; compile its wire side instead",
          );
        }
        return;
      case "literal":
        // With the test off, Zod drops an `undefined` member and writes a bigint one as a
        // number; either would come back as a different value than was declared.
        if (def.values?.some((value) => value === undefined || typeof value === "bigint")) {
          throw new EncodeError("A literal undefined or bigint cannot be represented in JSON Schema");
        }
        return;
      case "undefined":
      case "void":
      case "symbol":
      case "nan":
      case "custom":
      case "function":
      case "transform":
        throw new EncodeError(`${def.type} cannot be represented in JSON Schema`);
    }
  };
}

/**
 * ArkType's hook, keyed by the code it would otherwise throw for; a code not named here
 * keeps ArkType's own throw. `Set` and `Map` are keywords there but carry no element
 * type, so there is nothing to write under `items`, and they are refused by name rather
 * than encoded as empty containers.
 */
const ARKTYPE_FALLBACK = {
  date: (context: { readonly base: JsonSchema }) => ({ ...context.base, [RICH_KEYWORD]: "date" }),
  domain: (context: { readonly base: JsonSchema; readonly domain: string }) => {
    if (context.domain === "bigint") return { ...context.base, [RICH_KEYWORD]: "bigint" };
    throw new EncodeError(`${context.domain} cannot be represented in JSON Schema`);
  },
  proto: (context: { readonly proto: { readonly name: string } }) => {
    const name = context.proto.name;
    throw new EncodeError(
      name === "Set" || name === "Map"
        ? `ArkType's ${name} carries no element type, so there is nothing to encode its members as; convert it at the edge`
        : `${name} cannot be represented in JSON Schema`,
    );
  },
};

/**
 * What each vendor's Standard JSON Schema method is asked for. The target is the same
 * everywhere; the library options are how a vendor is made to describe the four types
 * JSON Schema cannot, and only a vendor known to read them is handed any.
 */
function conversionOptions(
  vendor: string,
  io: Side,
  converting: Set<unknown>,
): StandardJSONSchemaV1.Options {
  const target = "draft-2020-12";
  if (vendor === "zod") {
    return {
      target,
      libraryOptions: { unrepresentable: "any", override: zodOverride(io, converting) },
    };
  }
  if (vendor === "arktype") return { target, libraryOptions: { fallback: ARKTYPE_FALLBACK } };
  return { target };
}

export interface ValibotOverrideContext {
  readonly valibotSchema: { readonly type: string };
}

/**
 * For Valibot's `overrideSchema` slot. Valibot's Standard JSON Schema wrapper takes no
 * options, so its Date, bigint, Set and Map can be tagged only through the raw converter,
 * which also returns a plain document; pass that to `compile` as the structure:
 *
 *     compile(schema, toJsonSchema(schema, { overrideSchema: valibotOverride(toJsonSchema) }))
 *
 * The hook throws `EncodeError` for a recursive type reached through a Set or Map.
 *
 * @see https://shorn.dev/api/functions/#valibotoverride
 */
export function valibotOverride<J>(
  convert: (
    schema: never,
    config: { readonly overrideSchema: (context: ValibotOverrideContext) => J | undefined },
  ) => J,
): (context: ValibotOverrideContext) => J | undefined {
  // The converter is an argument rather than an import: shorn depends on no validator, and
  // the element of a set has to be converted through the same hook, or a set inside a set
  // would throw where the outer one did not. `J` is the converter's own document type, so
  // the returned function fits the slot without shorn having to name that type.
  //
  // The recursion guard `childJsonSchema` keeps for Zod, by depth rather than identity:
  // a Valibot object getter builds a fresh `v.set(v.lazy(...))` on every access, so no
  // schema object ever recurs, and the converter would be asked for the enclosing type
  // without end and leave as a stack overflow rather than a refusal. Sixty-four nested
  // Sets and Maps is not a schema anyone writes; a cycle reaches it at once.
  let depth = 0;
  const inner = (child: unknown): unknown => {
    if (depth >= 64) {
      throw new EncodeError(
        "A recursive type inside a Set or Map is not supported; hold the recursion in an array or an object instead",
      );
    }
    depth++;
    try {
      return (convert as (schema: unknown, config: unknown) => unknown)(child, {
        overrideSchema: override,
      });
    } finally {
      depth--;
    }
  };
  const override = (context: ValibotOverrideContext): J | undefined => {
    const schema = context.valibotSchema as {
      readonly type: string;
      readonly key?: unknown;
      readonly value?: unknown;
    };
    switch (schema.type) {
      case "date":
      case "bigint":
        return { [RICH_KEYWORD]: schema.type } as J;
      case "set":
        return { [RICH_KEYWORD]: "set", items: inner(schema.value) } as J;
      case "map":
        return {
          [RICH_KEYWORD]: "map",
          [RICH_KEY_KEYWORD]: inner(schema.key),
          items: inner(schema.value),
        } as J;
    }
    return undefined;
  };
  return override;
}

function buildCodec<S extends EncodableStandardSchema>(
  schema: S,
): StandardBackedSchema<StandardSchemaV1.InferOutput<S>>;
function buildCodec<S extends StandardSchemaV1>(
  schema: S,
  structure: StructureFor<S>,
): StandardBackedSchema<StandardSchemaV1.InferOutput<S>>;
function buildCodec(
  schema: StandardSchemaV1,
  structure?: Structure,
): StandardBackedSchema<unknown> {
  const structuralSchema = structure ?? (hasJsonSchema(schema) ? schema : undefined);
  if (structuralSchema === undefined) {
    throw new EncodeError(
      "Standard Schema provides validation but not structure; pass a Standard JSON Schema implementation as the second argument",
    );
  }

  let inputJsonSchema: unknown;
  let outputJsonSchema: unknown;
  if (isStandardJsonSchema(structuralSchema)) {
    // What a vendor still throws on here, undefined, NaN, a symbol, a transform, is a
    // value with no wire form at all. Unwrapped, that error never mentions shorn or says
    // what to do instead, so the vendor's reason is kept and the remedy appended.
    const std = structuralSchema["~standard"];
    const converting = new Set<unknown>();
    try {
      inputJsonSchema = std.jsonSchema.input(conversionOptions(std.vendor, "input", converting));
      outputJsonSchema = std.jsonSchema.output(conversionOptions(std.vendor, "output", converting));
    } catch (error) {
      // A refusal from inside one of shorn's own hooks already says what to do.
      if (error instanceof EncodeError) throw error;
      throw new EncodeError(
        `${error instanceof Error ? error.message : String(error)} (shorn has no wire form for this value; convert it at the edge, see Rejected Shapes)`,
        { cause: error },
      );
    }
  } else {
    // A plain document describes one shape, and so both sides.
    inputJsonSchema = outputJsonSchema = structuralSchema;
  }
  const inputShape = toWireShape(asSchema(inputJsonSchema));
  const shape = optionalAsInput(
    inputShape,
    toWireShape(asSchema(outputJsonSchema)),
  ) as WireDocument;
  const signature = wireSignature(shape);
  if (wireSignature(inputShape) !== signature) {
    // A default no longer reaches this, and a `z.codec()` does not: Zod's hook refuses it
    // by name during the conversion above. What is left is a schema whose two sides are
    // both representable and differ in a way `optionalAsInput` does not reconcile: a pipe
    // into a narrower wire type, `z.string().pipe(z.uuid())`, an ArkType morph from a
    // numeric string to a number, a field that is optional only on the way out.
    throw new EncodeError(
      "Schemas with different input and output wire shapes require a bidirectional codec and are not yet supported",
    );
  }
  return new StandardBackedSchema(schema, compileShape(shape), signature);
}

const directCache = new WeakMap<object, StandardBackedSchema<unknown>>();
const structuredCache = new WeakMap<object, WeakMap<object, StandardBackedSchema<unknown>>>();

/**
 * The one place a non-Standard-Schema argument is caught: every public entry point
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
        ? "a shorn schema: already a codec, call encode/decode on it directly"
        : holdsProperties && ("type" in schema || "$schema" in schema)
          ? "a raw JSON Schema: wrap it in a validator"
          : schema === null
            ? "null"
            : typeof schema
    }`,
  );
}

/**
 * What marks a plain object as a JSON Schema rather than a mistake. A `{ structure }`
 * wrapper, or a validator passed twice, carries none of these and would otherwise read
 * as an empty schema, compile to a dynamic value, and appear to work.
 */
const JSON_SCHEMA_KEYWORDS = [
  "$schema", "$ref", "type", "anyOf", "oneOf", "const", "enum", "properties", RICH_KEYWORD,
];

function getCompiled(schema: StandardSchemaV1, structure?: Structure): StandardBackedSchema<unknown> {
  assertStandardSchema(schema);
  // The structure argument gets the same gate as the schema, or a wrong shape here
  // surfaces as a raw TypeError from deep in the conversion, which points away from
  // the fix. A Standard JSON Schema implementation and a plain document both pass.
  if (structure !== undefined) {
    const std =
      typeof structure === "object" && structure !== null
        ? (structure as { readonly "~standard"?: unknown })["~standard"]
        : null;
    if (
      std === null ||
      (std === undefined
        ? !JSON_SCHEMA_KEYWORDS.some((keyword) => keyword in structure)
        : typeof std !== "object" || !("jsonSchema" in std))
    ) {
      throw new EncodeError(
        "The second argument must be a Standard JSON Schema implementation (toStandardJsonSchema(schema) for Valibot) or a JSON Schema document",
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

/**
 * The codec for a schema, with `.encode()` and `.decode()` that validate on both sides,
 * built once and cached per schema object. Throws `EncodeError` for a shape shorn cannot
 * encode. Pass `structure` for a validator with no JSON Schema of its own, like Valibot.
 *
 * @see https://shorn.dev/api/functions/#compile
 */
export function compile<S extends EncodableStandardSchema>(
  schema: S,
): Schema<StandardSchemaV1.InferOutput<S>>;
export function compile<S extends StandardSchemaV1>(
  schema: S,
  structure: StructureFor<S>,
): Schema<StandardSchemaV1.InferOutput<S>>;
export function compile(
  schema: StandardSchemaV1,
  structure?: Structure,
): Schema<unknown> {
  return getCompiled(schema, structure);
}

/** A codec as given, or the cached one `compile()` builds, for the entry points taking either. */
function codecOf(schemaOrCodec: StandardSchemaV1 | Schema<unknown>, structure?: Structure): Schema<unknown> {
  return schemaOrCodec instanceof Schema ? schemaOrCodec : getCompiled(schemaOrCodec, structure);
}

/**
 * The same codec with the validator taken out. Identical bytes on the wire; the
 * refinements are simply not run, on either side.
 *
 * For a producer you own, at both ends of a link you own. It removes everything the
 * validator did, not only the checks that were going to pass: a transform such as
 * `z.string().trim()` no longer runs, so a value goes out exactly as handed over.
 * Decoding still bounds-checks every read and still refuses trailing bytes, so
 * malformed input throws `DecodeError` rather than escaping, but bytes written against
 * a schema that differs only in its refinements now decode silently. Wrap in
 * `fingerprinted()` to keep the structural half of that check, and keep the validated
 * codec at any boundary you do not own.
 *
 * Takes a schema or a codec, and is cached the same way `compile()` is, so calling it
 * per message is a WeakMap hit rather than a rebuild. Throws `EncodeError` for a codec
 * with no validator to remove.
 *
 * @see https://shorn.dev/api/functions/#unchecked
 */
export function unchecked<T>(codec: Schema<T>): Schema<T>;
export function unchecked<S extends EncodableStandardSchema>(
  schema: S,
): Schema<StandardSchemaV1.InferOutput<S>>;
export function unchecked<S extends StandardSchemaV1>(
  schema: S,
  structure: StructureFor<S>,
): Schema<StandardSchemaV1.InferOutput<S>>;
export function unchecked(
  schemaOrCodec: StandardSchemaV1 | Schema<unknown>,
  structure?: Structure,
): Schema<unknown> {
  // On the three-field zod person fixture in `bench/regression.mjs` that is 2.3x on
  // encode and 3.7x on decode: once the structural half is generated code, validation is
  // most of what is left.
  const bare = codecOf(schemaOrCodec, structure)._structural;
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

/**
 * Validates the value, then writes it as bytes, in an exact-size array you can keep.
 * Throws `EncodeError` if validation fails or shorn cannot encode the schema. Pass
 * `structure` for a validator with no JSON Schema of its own, like Valibot.
 *
 * @see https://shorn.dev/api/functions/#encode
 */
export function encode<S extends EncodableStandardSchema>(
  schema: S,
  value: StandardSchemaV1.InferInput<S>,
): Uint8Array;
export function encode<S extends StandardSchemaV1>(
  schema: S,
  value: StandardSchemaV1.InferInput<S>,
  structure: StructureFor<S>,
): Uint8Array;
// The validator's input type, not its output, here and on the schema overloads of
// `safeEncode` and `encodeAsync`: the value is validated before a byte is written, so
// whatever the validator accepts is a valid argument, a branded field as a plain string,
// a coerced field as its raw text, a defaulted field left out. A codec overload keeps
// its output type, since that is the only type a `Schema<T>` carries.
export function encode(
  schema: StandardSchemaV1,
  value: unknown,
  structure?: Structure,
): Uint8Array {
  return getCompiled(schema, structure).encode(value);
}

/**
 * Reads a value back from its bytes, then validates it. Throws `DecodeError` for
 * malformed bytes or a value the validator refuses, and `EncodeError` if shorn cannot
 * encode the schema. Pass `structure` for a validator with no JSON Schema of its own.
 *
 * @see https://shorn.dev/api/functions/#decode
 */
export function decode<S extends EncodableStandardSchema>(
  schema: S,
  value: Uint8Array,
): StandardSchemaV1.InferOutput<S>;
export function decode<S extends StandardSchemaV1>(
  schema: S,
  value: Uint8Array,
  structure: StructureFor<S>,
): StandardSchemaV1.InferOutput<S>;
export function decode(
  schema: StandardSchemaV1,
  value: Uint8Array,
  structure?: Structure,
): unknown {
  return getCompiled(schema, structure).decode(value);
}

/**
 * `encode` that returns `{ success: false, error }` for a value that fails, instead of
 * throwing. Takes a schema or a codec. A schema shorn cannot encode still throws
 * `EncodeError`, from the first call, since that is a bug in the program.
 *
 * @see https://shorn.dev/api/functions/#safeencode--safedecode
 */
export function safeEncode<T>(codec: Schema<T>, value: T): SafeResult<Uint8Array>;
export function safeEncode<S extends EncodableStandardSchema>(
  schema: S,
  value: StandardSchemaV1.InferInput<S>,
): SafeResult<Uint8Array>;
export function safeEncode<S extends StandardSchemaV1>(
  schema: S,
  value: StandardSchemaV1.InferInput<S>,
  structure: StructureFor<S>,
): SafeResult<Uint8Array>;
export function safeEncode(
  schema: StandardSchemaV1 | Schema<unknown>,
  value: unknown,
  structure?: Structure,
): SafeResult<Uint8Array> {
  // Built outside `safely`: a schema shorn refuses is a bug in the program, not a bad
  // value, and returned as a result it answered every request with a 400.
  const codec = codecOf(schema, structure);
  return safely(() => codec.encode(value));
}

/**
 * `decode` that returns `{ success: false, error }` for bytes that fail, instead of
 * throwing. Takes a schema or a codec. A schema shorn cannot encode still throws
 * `EncodeError`, from the first call, since that is a bug in the program.
 *
 * @see https://shorn.dev/api/functions/#safeencode--safedecode
 */
export function safeDecode<T>(codec: Schema<T>, value: Uint8Array): SafeResult<T>;
export function safeDecode<S extends EncodableStandardSchema>(
  schema: S,
  value: Uint8Array,
): SafeResult<StandardSchemaV1.InferOutput<S>>;
export function safeDecode<S extends StandardSchemaV1>(
  schema: S,
  value: Uint8Array,
  structure: StructureFor<S>,
): SafeResult<StandardSchemaV1.InferOutput<S>>;
export function safeDecode(
  schema: StandardSchemaV1 | Schema<unknown>,
  value: Uint8Array,
  structure?: Structure,
): SafeResult<unknown> {
  // Outside `safely` for `safeEncode`'s reason. The payload is the only input a caller
  // does not control, so every failure of the bytes is still a result.
  const codec = codecOf(schema, structure);
  return safely(() => codec.decode(value));
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
  jsonSchema: Structure | undefined,
): readonly [source: StandardSchemaV1<unknown, unknown>, structure: Schema<unknown>] {
  const codec = codecOf(schemaOrCodec, jsonSchema);
  const source = codec._source;
  const structure = codec._structural;
  if (source === undefined || structure === undefined) {
    // Reached by an `m` schema and by `compile(schema).nullable()`, where the marker
    // wraps the codec that holds the validator. Both encode fine synchronously.
    throw new EncodeError(
      "This codec has no validator to await; async validation needs a codec from compile(), optionally wrapped by fingerprinted()",
    );
  }
  return [source, structure];
}

/**
 * `encode` for a schema with asynchronous refinements. Takes a schema or a codec built
 * from one, `fingerprinted()` included. Rejects as `encode` throws, and with
 * `EncodeError` for a codec with no validator to await.
 *
 * @see https://shorn.dev/api/functions/#encodeasync--decodeasync
 */
export async function encodeAsync<T>(codec: Schema<T>, value: T): Promise<Uint8Array>;
export async function encodeAsync<S extends EncodableStandardSchema>(
  schema: S,
  value: StandardSchemaV1.InferInput<S>,
): Promise<Uint8Array>;
export async function encodeAsync<S extends StandardSchemaV1>(
  schema: S,
  value: StandardSchemaV1.InferInput<S>,
  structure: StructureFor<S>,
): Promise<Uint8Array>;
export async function encodeAsync(
  schema: StandardSchemaV1 | Schema<unknown>,
  value: unknown,
  jsonSchema?: Structure,
): Promise<Uint8Array> {
  const [source, structure] = asyncParts(schema, jsonSchema);
  return structure.encode(await validateAsync(source, value));
}

/**
 * `decode` for a schema with asynchronous refinements. Takes a schema or a codec built
 * from one, `fingerprinted()` included. Rejects as `decode` throws, and with
 * `EncodeError` for a codec with no validator to await.
 *
 * @see https://shorn.dev/api/functions/#encodeasync--decodeasync
 */
export async function decodeAsync<T>(codec: Schema<T>, value: Uint8Array): Promise<T>;
export async function decodeAsync<S extends EncodableStandardSchema>(
  schema: S,
  value: Uint8Array,
): Promise<StandardSchemaV1.InferOutput<S>>;
export async function decodeAsync<S extends StandardSchemaV1>(
  schema: S,
  value: Uint8Array,
  structure: StructureFor<S>,
): Promise<StandardSchemaV1.InferOutput<S>>;
export async function decodeAsync(
  schema: StandardSchemaV1 | Schema<unknown>,
  value: Uint8Array,
  jsonSchema?: Structure,
): Promise<unknown> {
  const [source, structure] = asyncParts(schema, jsonSchema);
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
