import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import {
  ArraySchema,
  BooleanSchema,
  canonicalEnumOrder,
  canonicalKeyOrder,
  DecodeError,
  DynamicSchema,
  EncodeError,
  type EnumValue,
  EnumSchema,
  Float64Schema,
  IntSchema,
  LazySchema,
  LiteralSchema,
  ObjectSchema,
  OpenObjectSchema,
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
    }
  // A union with no discriminant, keyed by the JSON type of the value instead. A
  // separate variant rather than `on: undefined`, so the two forms cannot derive the
  // same signature.
  | { readonly union: readonly WireShape[]; readonly types: readonly string[] }
  // The back-edge of a cycle, as an index into a `WireDocument`'s definition table.
  | { readonly ref: number };

/**
 * A whole document's shape. The definition table is a property of the document rather
 * than of any shape inside it — a `{ ref }` is only ever resolved against the top level —
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
 * separately — the extra argument on the second overload of every entry point below. One
 * alias rather than the same four lines nine times.
 */
type StructureFor<S extends StandardSchemaV1> = StandardJSONSchemaV1<
  StandardSchemaV1.InferInput<S>,
  StandardSchemaV1.InferOutput<S>
>;

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

/** Said from two places, since two vendors lose a `__proto__` field two different ways. */
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
 * The JSON type a branch declares, taken from `type` or from the `const` standing in for
 * it. valibot writes a literal union as bare consts where zod puts a `type` beside each
 * one, and a const names its own type as plainly as the keyword does — without this the
 * same union compiled from one vendor and was refused from the other.
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
 * as, so a union of the pair is not disjoint and stays refused. A branch with a `type`
 * array, or none at all — `z.any()`, a bare `{}` — is refused for the same reason: it
 * overlaps whatever sits beside it.
 */
function disjointTypes(
  branches: readonly JsonSchema[],
  ctx: RefContext,
): readonly string[] | undefined {
  const types: string[] = [];
  for (const branch of branches) {
    // A branch that is a bare `$ref` — one arm of a union being the whole recursive
    // definition — keeps its type at the far end of the pointer. One hop, deliberately:
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

/**
 * Whether a shape already decodes to `null` without a marker of its own — exactly the set
 * `Schema.nullable()` declines to put a second marker on.
 */
function admitsNull(shape: WireShape, defNulls?: readonly boolean[]): boolean {
  if (typeof shape === "string") return shape === "any";
  if ("literal" in shape) return shape.literal === null;
  if ("enum" in shape) return shape.enum.includes(null);
  // Only the undiscriminated form can carry a `null` branch — a discriminated one is all
  // objects — but reading the branches keeps both forms on a single rule.
  if ("union" in shape) return shape.union.some((branch) => admitsNull(branch, defNulls));
  // Unanswerable while the cycle is still open, which is every call from `nullableOf`.
  // `defNulls` settles it later, and `LazySchema` carries the answer to the check.
  if ("ref" in shape) return defNulls?.[shape.ref] ?? false;
  return "nullable" in shape;
}

/**
 * A nullable marker over a shape that already holds `null` is dropped here, one level
 * above where `Schema.nullable()` would deal with it — which is the level the signature
 * is taken at, and that turns out to matter.
 *
 * Two cases arrive here, and both reached the caller wrong. `any`, `null` and a
 * null-bearing `enum` made `Schema.nullable()` throw "already decodes to null", blaming a
 * `.nullable()` the caller did write for a marker this compiler added — `z.any().nullable()`
 * is the plain one, since tag 0 is already `null`. A nested `{nullable:{nullable:…}}` did
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
  /** What a pointer is relative to. `$ref: "#"` — zod's spelling — names this. */
  readonly document: JsonSchema;
  /** Pointers being expanded right now; a `$ref` back to one of these is a cycle. */
  readonly active: Set<string>;
  /**
   * What each pointer resolved to: the shape itself once expanded, or the `{ ref }` a
   * cycle head was numbered with the moment something referred back to it. Also what
   * keeps a shared subtree from being walked once per reference — a chain of refs each
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
 * the same number. A reference to something already finished is simply that shape again
 * — a shared subtree, not a recursive one — so it is inlined, which keeps a
 * non-recursive `$ref` out of the signature and off `LazySchema`'s indirection.
 */
function refShape(pointer: string, ctx: RefContext): WireShape {
  const known = ctx.shapes.get(pointer);
  if (known !== undefined) return known;

  if (ctx.active.has(pointer)) {
    // The back-edge of a cycle. Numbered here and remembered, so every later reference to
    // this pointer — including the one that finishes the expansion below — is the same id.
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
 * Every child that *is* one of the definitions, replaced by a reference to it.
 *
 * The top of `shape` is deliberately not tested — a definition's own body is equal to
 * itself, and folding that would leave a definition standing for nothing but its own
 * back-edge. Callers that need the top tested compare it themselves.
 */
function foldDefs(node: unknown, defs: readonly string[]): unknown {
  const fold = (child: unknown): unknown => {
    // A shape's JSON text is what the signature is taken from, so comparing the text is
    // comparing the shape. Rebuilt key by key rather than by variant: a `WireShape` is
    // plain JSON either way, and the walk costs a fifth of the bytes the variants did.
    const index =
      typeof child === "object" && child !== null ? defs.indexOf(JSON.stringify(child)) : -1;
    return index < 0 ? foldDefs(child, defs) : { ref: index };
  };
  if (typeof node !== "object" || node === null) return node;
  if (Array.isArray(node)) return node.map(fold);
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, fold(value)]));
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

  // Vendors spell one recursive type two ways, and the two differ by an unrolling: zod
  // points a `$ref` at the definition from wherever the type is used, while valibot
  // inlines a copy of it there and refers back from inside that copy. Both write the
  // same bytes, so folding a copy of a definition back onto the definition is what keeps
  // the fingerprint from depending on which validator wrote the schema — the promise
  // made in the schema-changes documentation, and otherwise a `fingerprinted()` codec
  // rejects a payload it can decode.
  //
  // ponytail: definitions are compared as they were built, so a definition holding an
  // inlined copy of *another* definition is folded against the un-folded text of that
  // one. Fold to a fixed point if a mutually recursive type ever turns up.
  const defsJson = defs.map((def) => JSON.stringify(def));
  const rootJson = JSON.stringify(root);
  const duplicate = defsJson.indexOf(rootJson);
  return {
    defs: defs.map((def) => foldDefs(def, defsJson) as WireShape),
    root: duplicate < 0 ? (foldDefs(root, defsJson) as WireShape) : { ref: duplicate },
  };
}

function wireShape(schema: JsonSchema, ctx: RefContext): WireShape {
  // Ahead of every other keyword: a `$ref` node carries no `type`, and what it points at
  // is the whole of what it means here.
  if (typeof schema.$ref === "string") return refShape(schema.$ref, ctx);

  // `anyOf` and `oneOf` differ in whether the branches may overlap, which is a
  // validation question the vendor has already answered by the time shorn runs.
  // Zod writes a plain union as `anyOf` and a discriminated one as `oneOf`; both
  // arrive here as the same list of branches.
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) {
    const branches = union.map(asSchema);
    const nonNull = branches.filter((branch) => branchType(branch) !== "null");
    // `z.null().nullable()` writes `anyOf: [{type:"null"}, {type:"null"}]`. Every branch
    // is the same one value, so the union is that value — and refusing it as "not a
    // nullable union" named the one thing it unmistakably was.
    if (nonNull.length === 0 && branches.length > 0) return { literal: null };
    if (branches.length === 2 && nonNull.length === 1) {
      return nullableOf(wireShape(nonNull[0]!, ctx));
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
      return nonNull.length === branches.length ? "uuid" : nullableOf("uuid");
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
        union: cases.map((value) => wireShape(branches[found.cases.indexOf(value)]!, ctx)),
      };
    }

    // No discriminant, but possibly no ambiguity either: branches separated by JSON type
    // need nothing on the wire beyond the index a discriminated union already writes.
    const byType = disjointTypes(branches, ctx);
    if (byType !== undefined) {
      // Ordered by type name, so the branch index survives a reordering of the schema.
      const types = canonicalKeyOrder(byType);
      return {
        types,
        union: types.map((type) => wireShape(branches[byType.indexOf(type)]!, ctx)),
      };
    }

    throw new EncodeError(
      "Only nullable, discriminated and type-disjoint JSON Schema unions are currently supported; give the branches one property that is a distinct const in each, or make no two branches share a JSON type",
    );
  }

  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter((type) => type !== "null");
    // `["null"]` and `["null","null"]` name one type, for the reason the all-null union
    // above does.
    if (nonNull.length === 0 && schema.type.length > 0) return { literal: null };
    if (schema.type.length === 2 && nonNull.length === 1) {
      return nullableOf(wireShape({ ...schema, type: nonNull[0] }, ctx));
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
      // here — a bare `{}` compiles to it below. arktype spells `unknown[]` that way,
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
        if (Object.hasOwn(properties, key)) continue;
        // The `__proto__` case again, from the vendor that drops the property instead of
        // setting a prototype with it — zod lists it in `required` and omits it from
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
        // does. `false` means the vendor's own validate() already dealt with them —
        // zod's `object` strips, `strictObject` refuses, both emit `false`. `undefined`
        // (arktype) passes them through, and a closed object has nowhere to put them.
        rejectUnknown: additional === undefined,
        ...(extras === undefined ? {} : { extras }),
      };
    }
    default: {
      // A node with no `type` and nothing structural left to read is `any`: `z.any()`,
      // `z.unknown()`, a bare `{}`. Combinators are excluded deliberately, so a shape
      // carrying one is refused by name rather than quietly re-typed as a tagged blob —
      // "type undefined" told the caller nothing. A well-formed `$ref` returned at the
      // top of this function; it stays on the list to name the malformed spelling.
      if (schema.type === undefined) {
        const combinator = COMBINATORS.find((keyword) => keyword in schema);
        if (combinator === undefined) return "any";
        throw new EncodeError(`Unsupported JSON Schema combinator ${combinator}`);
      }
      throw new EncodeError(`Unsupported Standard JSON Schema type ${String(schema.type)}`);
    }
  }
}

/** Every scalar shape to its schema. The key type is what keeps this exhaustive. */
const SCALAR_SCHEMAS: Record<Extract<WireShape, string>, new () => Schema<unknown>> = {
  any: DynamicSchema,
  boolean: BooleanSchema,
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
  // One round per definition settles a lattice this shallow — a back-edge starts at "no"
  // and only ever turns on — and there is one definition in every schema seen so far, so
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

function hasJsonSchema(value: StandardSchemaV1): value is EncodableStandardSchema {
  return "jsonSchema" in value["~standard"];
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
  const inputShape = toWireShape(asSchema(inputJsonSchema));
  const outputShape = toWireShape(asSchema(outputJsonSchema));
  const signature = wireSignature(outputShape);
  if (wireSignature(inputShape) !== signature) {
    // Rarely reached: zod's `z.codec()` has a rich output type, so the conversion above
    // throws before the shapes are compared. What survives here is a schema whose two
    // sides are both JSON Schema representable and still differ — a default, say.
    throw new EncodeError(
      "Schemas with different input and output wire shapes require a bidirectional codec and are not yet supported",
    );
  }
  return new StandardBackedSchema(schema, compileShape(outputShape), signature);
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
  structure: StructureFor<S>,
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
  structure: StructureFor<S>,
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
  structure: StructureFor<S>,
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
  structure: StructureFor<S>,
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
  structure: StructureFor<S>,
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
  structure: StructureFor<S>,
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
  structure: StructureFor<S>,
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
  structure: StructureFor<S>,
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
