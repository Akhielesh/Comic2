/**
 * The schema DSL (plan §5.1): one definition gives a TypeScript type (`Infer`), a JSON Schema (`toJsonSchema`) and a
 * validator (`check`). Every string and array needs a cap, or construction throws `SchemaDefinitionError`; so does
 * any other malformed definition. Nodes are frozen plain data, so tools can project them.
 *
 * `assertSchema` re-validates a node that `s` did not build (a hand-written object literal, a copy from another
 * module instance), so `check()` can never run against an uncapped schema.
 */
import type {
  ArraySchema,
  AssetRefSchema,
  BoolSchema,
  EmailSchema,
  EnumSchema,
  Infer,
  IntSchema,
  LinkSchema,
  LiteralSchema,
  NumberSchema,
  ObjectSchema,
  OptionalSchema,
  Schema,
  SchemaDoc,
  SchemaNode,
  TextSchema,
  TupleSchema,
  UnionSchema,
} from '../contract/schema.js';
import { ID_PATTERN, SCHEMA_LIMITS } from '../contract/schema.js';
import { SchemaDefinitionError } from '../errors.js';

// ── Options ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TextOptions extends SchemaDoc {
  /** Required: the most UTF-16 code units the string may hold. */
  max: number;
  min?: number;
  pattern?: string;
  singleLine?: boolean;
}

export interface ArrayOptions extends SchemaDoc {
  /** Required: the most items the array may hold. */
  max: number;
  min?: number;
}

export interface RangeOptions extends SchemaDoc {
  min?: number;
  max?: number;
}

export interface IdOptions extends SchemaDoc {
  /** At most `SCHEMA_LIMITS.idMax`. */
  max?: number;
}

export interface AssetRefOptions extends SchemaDoc {
  /** Decoded bytes of a `data:` image; at most (and by default) `SCHEMA_LIMITS.assetDataMaxBytes`. */
  maxBytes?: number;
}

// ── Inference helpers ───────────────────────────────────────────────────────────────────────────────────────────

type Fields = { readonly [key: string]: Schema<unknown> };

type Simplify<T> = { [K in keyof T]: T[K] };

type OptionalKeys<F> = { [K in keyof F]-?: F[K] extends { readonly kind: 'optional' } ? K : never }[keyof F];

type InferOptional<S> = S extends OptionalSchema<infer T> ? T : never;

/** The object type `s.object(fields)` accepts: optional fields become `key?:`. */
export type InferObject<F> = Simplify<
  { -readonly [K in Exclude<keyof F, OptionalKeys<F>>]: Infer<F[K]> } & { -readonly [K in OptionalKeys<F>]?: InferOptional<F[K]> }
>;

/** The tuple type `s.tuple(items)` accepts. */
export type InferTuple<I extends readonly unknown[]> = { -readonly [K in keyof I]: Infer<I[K]> };

// ── Structural validation (shared by the constructors and assertSchema) ──────────────────────────────────────────

const BUILT = new WeakSet<object>();

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_FIELDS = ['__proto__', 'constructor', 'prototype'];
const DOC_TITLE_MAX = 200;
const DOC_DESCRIPTION_MAX = 2000;
const PATTERN_MAX = 1000;

const fail = (message: string, path: string): never => {
  throw new SchemaDefinitionError(message, path);
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const join = (path: string, key: string | number): string =>
  typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key;

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/** A required cap: a whole number from `lo` to `hi`. */
const cap = (v: unknown, what: string, lo: number, hi: number, path: string): number => {
  if (v === undefined) return fail(`${what} needs a cap: every string and array must say how big it may get`, path);
  if (!isInt(v) || v < lo || v > hi) return fail(`${what} must be a whole number from ${lo} to ${hi}`, path);
  return v;
};

const optionalInt = (v: unknown, what: string, lo: number, hi: number, path: string): number | undefined => {
  if (v === undefined) return undefined;
  if (!isInt(v) || v < lo || v > hi) return fail(`${what} must be a whole number from ${lo} to ${hi}`, path);
  return v;
};

const optionalFinite = (v: unknown, what: string, path: string): number | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !isFinite(v)) return fail(`${what} must be a finite number`, path);
  return v;
};

const docOf = (o: SchemaDoc, path: string): SchemaDoc => {
  const out: { title?: string; description?: string } = {};
  if (o.title !== undefined) {
    if (typeof o.title !== 'string' || o.title.length > DOC_TITLE_MAX) fail(`title must be text of at most ${DOC_TITLE_MAX} characters`, path);
    out.title = o.title;
  }
  if (o.description !== undefined) {
    if (typeof o.description !== 'string' || o.description.length > DOC_DESCRIPTION_MAX) {
      fail(`description must be text of at most ${DOC_DESCRIPTION_MAX} characters`, path);
    }
    out.description = o.description;
  }
  return out;
};

const kindOf = (node: unknown): string => (isRecord(node) && typeof node.kind === 'string' ? node.kind : '');

/** A child schema: built by `s` (or valid), and not an `optional` unless `allowOptional`. */
const child = (node: unknown, path: string, allowOptional: boolean): SchemaNode => {
  if (!isRecord(node)) return fail('expected a schema built with s.*', path);
  if (!allowOptional && node.kind === 'optional') return fail('s.optional only marks an object field', path);
  return assertSchema(node, path);
};

/**
 * Validate one node's definition and return a frozen, normalised copy. Children are validated through
 * `assertSchema` (instant for nodes `s` built).
 */
const normalise = (raw: unknown, path: string): SchemaNode => {
  if (!isRecord(raw)) return fail('expected a schema built with s.*', path);
  const doc = docOf(raw as SchemaDoc, path);
  switch (raw.kind) {
    case 'text': {
      const max = cap(raw.max, 's.text', 1, SCHEMA_LIMITS.textCapMax, path);
      const min = optionalInt(raw.min, 's.text min', 0, max, path);
      const node: { -readonly [K in keyof TextSchema]: TextSchema[K] } = { kind: 'text', max, ...doc };
      if (min !== undefined) node.min = min;
      if (raw.pattern !== undefined) {
        if (typeof raw.pattern !== 'string' || !raw.pattern || raw.pattern.length > PATTERN_MAX) {
          fail(`s.text pattern must be a regular expression source of at most ${PATTERN_MAX} characters`, path);
        }
        try {
          new RegExp(raw.pattern as string, 'u');
        } catch {
          fail('s.text pattern is not a valid regular expression', path);
        }
        node.pattern = raw.pattern as string;
      }
      if (raw.singleLine !== undefined) {
        if (typeof raw.singleLine !== 'boolean') fail('s.text singleLine must be true or false', path);
        node.singleLine = raw.singleLine as boolean;
      }
      return node;
    }
    case 'array': {
      const items = child(raw.items, join(path, '[]'), false);
      const max = cap(raw.max, 's.array', 1, SCHEMA_LIMITS.arrayCapMax, path);
      const min = optionalInt(raw.min, 's.array min', 0, max, path);
      const node: { -readonly [K in keyof ArraySchema]: ArraySchema[K] } = { kind: 'array', items, max, ...doc };
      if (min !== undefined) node.min = min;
      return node;
    }
    case 'tuple': {
      const list = raw.items;
      if (!Array.isArray(list) || list.length < 1 || list.length > SCHEMA_LIMITS.tupleItemsMax) {
        return fail(`s.tuple needs 1 to ${SCHEMA_LIMITS.tupleItemsMax} item schemas`, path);
      }
      const items = Object.freeze(list.map((item, i) => child(item, join(path, i), false)));
      return { kind: 'tuple', items, ...doc };
    }
    case 'object': {
      const fields = raw.fields;
      if (!isRecord(fields)) return fail('s.object needs a fields object', path);
      const keys = Object.keys(fields);
      if (keys.length > SCHEMA_LIMITS.fieldsMax) fail(`s.object takes at most ${SCHEMA_LIMITS.fieldsMax} fields`, path);
      const out: { [key: string]: SchemaNode } = {};
      for (const key of keys) {
        if (!FIELD_NAME.test(key) || key.length > SCHEMA_LIMITS.fieldNameMax || RESERVED_FIELDS.indexOf(key) !== -1) {
          fail(`field name "${key}" must be an identifier of at most ${SCHEMA_LIMITS.fieldNameMax} characters (not __proto__, constructor or prototype)`, path);
        }
        out[key] = child(fields[key], join(path, key), true);
      }
      return { kind: 'object', fields: Object.freeze(out), ...doc };
    }
    case 'enum': {
      const values = raw.values;
      if (!Array.isArray(values) || values.length < 1 || values.length > SCHEMA_LIMITS.enumValuesMax) {
        return fail(`s.enum needs 1 to ${SCHEMA_LIMITS.enumValuesMax} values`, path);
      }
      const strings = values.every((v) => typeof v === 'string' && v.length >= 1 && v.length <= SCHEMA_LIMITS.literalMax);
      const numbers = values.every((v) => typeof v === 'number' && isFinite(v));
      if (!strings && !numbers) fail(`s.enum values must all be non-empty strings (at most ${SCHEMA_LIMITS.literalMax} characters) or all finite numbers`, path);
      if (values.some((v, i) => values.indexOf(v) !== i)) fail('s.enum values must be unique', path);
      return { kind: 'enum', values: Object.freeze(values.slice()) as readonly (string | number)[], ...doc };
    }
    case 'literal': {
      const value = raw.value;
      const ok =
        (typeof value === 'string' && value.length <= SCHEMA_LIMITS.literalMax) ||
        (typeof value === 'number' && isFinite(value)) ||
        typeof value === 'boolean';
      if (!ok) fail(`s.literal takes a string of at most ${SCHEMA_LIMITS.literalMax} characters, a finite number or a boolean`, path);
      return { kind: 'literal', value: value as string | number | boolean, ...doc };
    }
    case 'union': {
      const tag = raw.tag;
      if (typeof tag !== 'string' || !FIELD_NAME.test(tag) || tag.length > SCHEMA_LIMITS.fieldNameMax) {
        return fail('s.union needs a tag: the field name every variant uses for its literal', path);
      }
      const list = raw.variants;
      if (!Array.isArray(list) || list.length < 1 || list.length > SCHEMA_LIMITS.unionVariantsMax) {
        return fail(`s.union needs 1 to ${SCHEMA_LIMITS.unionVariantsMax} variants`, path);
      }
      const seen: string[] = [];
      const variants = list.map((v, i) => {
        const at = join(path, i);
        const variant = child(v, at, false);
        if (variant.kind !== 'object') return fail('every s.union variant must be an s.object', at);
        const tagField = variant.fields[tag] as SchemaNode | undefined;
        if (!tagField || tagField.kind !== 'literal' || typeof tagField.value !== 'string') {
          return fail(`every s.union variant needs "${tag}" as an s.literal string`, at);
        }
        if (seen.indexOf(tagField.value) !== -1) fail(`two s.union variants share the tag "${tagField.value}"`, at);
        seen.push(tagField.value);
        return variant;
      });
      return { kind: 'union', tag, variants: Object.freeze(variants), ...doc };
    }
    case 'int':
    case 'number': {
      const read = raw.kind === 'int' ? (v: unknown, w: string) => optionalInt(v, w, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, path) : (v: unknown, w: string) => optionalFinite(v, w, path);
      const min = read(raw.min, `s.${raw.kind} min`);
      const max = read(raw.max, `s.${raw.kind} max`);
      if (min !== undefined && max !== undefined && min > max) fail(`s.${raw.kind} min must not exceed max`, path);
      const node: { kind: 'int' | 'number'; min?: number; max?: number } = { kind: raw.kind, ...doc };
      if (min !== undefined) node.min = min;
      if (max !== undefined) node.max = max;
      return node as IntSchema | NumberSchema;
    }
    case 'bool':
      return { kind: 'bool', ...doc };
    case 'email':
      return { kind: 'email', max: cap(raw.max, 's.email', 6, SCHEMA_LIMITS.emailMax, path), ...doc };
    case 'link':
      return { kind: 'link', max: cap(raw.max, 's.link', 12, SCHEMA_LIMITS.linkMax, path), ...doc };
    case 'assetRef':
      return { kind: 'assetRef', maxBytes: cap(raw.maxBytes, 's.assetRef maxBytes', 1, SCHEMA_LIMITS.assetDataMaxBytes, path), ...doc };
    case 'optional':
      return { kind: 'optional', inner: child(raw.inner, path, false), ...doc };
    default:
      return fail(`unknown schema kind "${kindOf(raw)}"`, path);
  }
};

/**
 * Return `node` as a valid schema, or throw `SchemaDefinitionError`. Nodes built by `s` pass at once; anything else
 * is validated in full (caps included) once per object, then remembered.
 */
export const assertSchema = (node: unknown, path = ''): SchemaNode => {
  if (isRecord(node) && BUILT.has(node)) return node as unknown as SchemaNode;
  normalise(node, path); // throws when invalid
  BUILT.add(node as object);
  return node as unknown as SchemaNode;
};

const build = <S>(raw: Record<string, unknown>): S => {
  const node = Object.freeze(normalise(raw, ''));
  BUILT.add(node);
  return node as unknown as S;
};

// ── Constructors ────────────────────────────────────────────────────────────────────────────────────────────────

const text = (options: TextOptions): TextSchema => build({ ...(isRecord(options) ? options : {}), kind: 'text' });

/** An id: `ID_PATTERN`, at most `SCHEMA_LIMITS.idMax` (or `max`) characters. */
const id = (options: IdOptions = {}): TextSchema =>
  build({ ...docOnly(options), kind: 'text', max: options.max !== undefined ? options.max : SCHEMA_LIMITS.idMax, pattern: ID_PATTERN, singleLine: true });

const array = <T>(items: Schema<T>, options: ArrayOptions): ArraySchema<T> =>
  build({ ...(isRecord(options) ? options : {}), kind: 'array', items });

const tuple = <const I extends readonly Schema<unknown>[]>(items: I, options: SchemaDoc = {}): TupleSchema<InferTuple<I>> =>
  build({ ...docOnly(options), kind: 'tuple', items });

const object = <F extends Fields>(fields: F, options: SchemaDoc = {}): ObjectSchema<InferObject<F>> =>
  build({ ...docOnly(options), kind: 'object', fields });

const enumOf = <const V extends readonly string[] | readonly number[]>(values: V, options: SchemaDoc = {}): EnumSchema<V[number]> =>
  build({ ...docOnly(options), kind: 'enum', values });

const literal = <const V extends string | number | boolean>(value: V, options: SchemaDoc = {}): LiteralSchema<V> =>
  build({ ...docOnly(options), kind: 'literal', value });

const union = <V extends readonly ObjectSchema<unknown>[]>(tag: string, variants: V, options: SchemaDoc = {}): UnionSchema<Infer<V[number]>> =>
  build({ ...docOnly(options), kind: 'union', tag, variants });

const int = (options: RangeOptions = {}): IntSchema => build({ ...(isRecord(options) ? options : {}), kind: 'int' });

const number = (options: RangeOptions = {}): NumberSchema => build({ ...(isRecord(options) ? options : {}), kind: 'number' });

const bool = (options: SchemaDoc = {}): BoolSchema => build({ ...docOnly(options), kind: 'bool' });

const email = (options: SchemaDoc = {}): EmailSchema => build({ ...docOnly(options), kind: 'email', max: SCHEMA_LIMITS.emailMax });

const link = (options: SchemaDoc = {}): LinkSchema => build({ ...docOnly(options), kind: 'link', max: SCHEMA_LIMITS.linkMax });

const assetRef = (options: AssetRefOptions = {}): AssetRefSchema =>
  build({
    ...docOnly(options),
    kind: 'assetRef',
    maxBytes: isRecord(options) && options.maxBytes !== undefined ? options.maxBytes : SCHEMA_LIMITS.assetDataMaxBytes,
  });

const optional = <T>(inner: Schema<T>, options: SchemaDoc = {}): OptionalSchema<T> => build({ ...docOnly(options), kind: 'optional', inner });

function docOnly(options: unknown): SchemaDoc {
  if (!isRecord(options)) return {};
  const out: { title?: unknown; description?: unknown } = {};
  if (options.title !== undefined) out.title = options.title;
  if (options.description !== undefined) out.description = options.description;
  return out as SchemaDoc;
}

/**
 * The DSL. Caps are mandatory where the plan says so: `s.text({max})`, `s.array(items, {max})`; `s.email()`,
 * `s.link()`, `s.id()` and `s.assetRef()` carry built-in caps.
 */
export const s = {
  object,
  array,
  tuple,
  text,
  id,
  enum: enumOf,
  literal,
  union,
  int,
  number,
  bool,
  email,
  link,
  assetRef,
  optional,
} as const;
