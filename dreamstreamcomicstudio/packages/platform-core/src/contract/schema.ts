/**
 * FROZEN CONTRACT (platform contract v1, plan §5.1): the schema DSL's public types, the shared model primitives every
 * document model uses, and the op envelope. Types and caps only; the behaviour lives in `src/schema/**` and in the
 * models. Minor versions are additive only (plan §4.5): add an optional field, a union member or an export; never
 * rename, remove or narrow one. A change here is a contract change and needs a note in ADR 0008.
 */

// ── Schema nodes ────────────────────────────────────────────────────────────────────────────────────────────────

/** Every node kind `s.*` builds. Every `text`, `array`, `email` and `link` node carries a cap (`max`). */
export type SchemaKind =
  | 'object'
  | 'array'
  | 'tuple'
  | 'text'
  | 'enum'
  | 'literal'
  | 'union'
  | 'int'
  | 'number'
  | 'bool'
  | 'email'
  | 'link'
  | 'assetRef'
  | 'optional';

/** Human-facing words a node may carry; `toJsonSchema` copies them into the JSON Schema it emits. */
export interface SchemaDoc {
  readonly title?: string;
  readonly description?: string;
}

/**
 * A schema that accepts values of type `T`. Build one with `s.*` (src/schema/s.ts); `check()` validates against it
 * and `toJsonSchema()` projects it. `__type` is a phantom that carries `T` for `Infer`: it is never set at runtime.
 */
export interface Schema<T = unknown> extends SchemaDoc {
  readonly kind: SchemaKind;
  readonly __type?: T;
}

/** The TypeScript type a schema accepts. */
export type Infer<S> = S extends Schema<infer T> ? T : never;

/** `s.text({max})`: a string of at most `max` UTF-16 code units (JavaScript `length`). */
export interface TextSchema extends Schema<string> {
  readonly kind: 'text';
  readonly max: number;
  readonly min?: number;
  /** An ECMAScript regular expression source, matched with the `u` flag. Write the anchors (`^…$`) yourself. */
  readonly pattern?: string;
  /** Refuse `\n` and `\r` (titles, labels, names). */
  readonly singleLine?: boolean;
}

/** `s.array(items, {max})`. */
export interface ArraySchema<T = unknown> extends Schema<T[]> {
  readonly kind: 'array';
  readonly items: Schema<T>;
  readonly max: number;
  readonly min?: number;
}

/** `s.tuple([a, b, …])`: an array of exactly `items.length` values (for example a slide rect `[x, y, w, h]`). */
export interface TupleSchema<T extends unknown[] = unknown[]> extends Schema<T> {
  readonly kind: 'tuple';
  readonly items: readonly Schema<unknown>[];
}

/** `s.object(fields)`: unknown keys are rejected; a field wrapped in `s.optional` may be absent. */
export interface ObjectSchema<T = unknown> extends Schema<T> {
  readonly kind: 'object';
  readonly fields: { readonly [key: string]: Schema<unknown> };
}

/** `s.enum([...])`: one of a fixed list of strings, or of numbers (never mixed). */
export interface EnumSchema<T extends string | number = string | number> extends Schema<T> {
  readonly kind: 'enum';
  readonly values: readonly T[];
}

/** `s.literal(value)`. */
export interface LiteralSchema<T extends string | number | boolean = string | number | boolean> extends Schema<T> {
  readonly kind: 'literal';
  readonly value: T;
}

/** `s.union(tag, variants)`: a discriminated union of objects; each variant holds `tag` as a string literal. */
export interface UnionSchema<T = unknown> extends Schema<T> {
  readonly kind: 'union';
  readonly tag: string;
  readonly variants: readonly ObjectSchema<unknown>[];
}

/** `s.int({min, max})`: a safe integer. */
export interface IntSchema extends Schema<number> {
  readonly kind: 'int';
  readonly min?: number;
  readonly max?: number;
}

/** `s.number({min, max})`: a finite number. */
export interface NumberSchema extends Schema<number> {
  readonly kind: 'number';
  readonly min?: number;
  readonly max?: number;
}

/** `s.bool()`. */
export interface BoolSchema extends Schema<boolean> {
  readonly kind: 'bool';
}

/** `s.email()`: one plain address (`local@domain`, ASCII), never a display name, a list or a header. */
export interface EmailSchema extends Schema<string> {
  readonly kind: 'email';
  readonly max: number;
}

/** `s.link()`: an `https:` or `mailto:` URL, nothing else (no `http:`, `javascript:`, `data:` or userinfo). */
export interface LinkSchema extends Schema<SafeHref> {
  readonly kind: 'link';
  readonly max: number;
}

/** `s.assetRef()`: an image as a `data:` URI (PNG, JPEG or WebP, sniffed) or a host asset id. Never a URL. */
export interface AssetRefSchema extends Schema<AssetRef> {
  readonly kind: 'assetRef';
  /** Decoded bytes of a `data:` URI; at most `SCHEMA_LIMITS.assetDataMaxBytes`. */
  readonly maxBytes: number;
}

/** `s.optional(inner)`: only meaningful as an object field. */
export interface OptionalSchema<T = unknown> extends Schema<T | undefined> {
  readonly kind: 'optional';
  readonly inner: Schema<T>;
}

/** Every concrete node; `check()` and `toJsonSchema()` switch on `kind`. */
export type SchemaNode =
  | TextSchema
  | ArraySchema
  | TupleSchema
  | ObjectSchema
  | EnumSchema
  | LiteralSchema
  | UnionSchema
  | IntSchema
  | NumberSchema
  | BoolSchema
  | EmailSchema
  | LinkSchema
  | AssetRefSchema
  | OptionalSchema;

// ── check() ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Why a value was rejected. Codes are stable; messages are for people and for a model's repair retry. */
export const CHECK_ERROR_CODES = [
  'type', // the wrong JSON type (or a non-plain object)
  'required', // a required key (or a union's tag) is missing
  'unknown-key', // a key the schema does not declare
  'too-long', // a string over its cap
  'too-short', // a string under its minimum
  'too-many', // an array over its cap, or a tuple with extra items
  'too-few', // an array under its minimum, or a tuple with missing items
  'pattern', // a string that does not match its pattern
  'bad-char', // a control character, a bidi override, or an unpaired surrogate
  'single-line', // a line break in a single-line string
  'enum', // not one of the allowed values
  'literal', // not the required constant
  'tag', // a union tag that names no variant
  'int', // not a safe integer
  'not-finite', // NaN or ±Infinity
  'below-min', // a number under its minimum
  'above-max', // a number over its maximum
  'email', // not one plain email address
  'link', // not an https: or mailto: link
  'asset', // a malformed asset reference (MIME, base64, magic bytes, id)
  'asset-too-large', // a data: image over its byte cap
  'too-many-nodes', // the value is bigger than the check budget allows
] as const;

export type CheckErrorCode = (typeof CHECK_ERROR_CODES)[number];

/**
 * One rejection. `path` names the offending value: `''` is the root, then `.key` for fields and `[i]` for items,
 * e.g. `sections[0].blocks[3].runs[0].text`. A key that is not an identifier is written `["key"]`.
 */
export interface CheckError {
  path: string;
  code: CheckErrorCode;
  message: string;
}

/** `check()` never throws on a bad value; on success `value` is a fresh plain copy (absent optionals dropped). */
export type CheckResult<T> = { ok: true; value: T } | { ok: false; errors: CheckError[] };

export interface CheckOptions {
  /** Stop after this many errors (default `SCHEMA_LIMITS.maxErrors`). */
  maxErrors?: number;
  /** Refuse values with more nodes than this (default `SCHEMA_LIMITS.maxNodes`): bounds the work per check. */
  maxNodes?: number;
}

// ── toJsonSchema() ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * - `strict`: full-fidelity JSON Schema 2020-12 (`$schema`, `oneOf`, `const`, `prefixItems`, patterns, formats,
 *   `additionalProperties: false`).
 * - `mcp`: the same without `$schema`, for an MCP tool's `inputSchema`; the root must be an object.
 * - `llm`: flattened for function-calling dialects: no `oneOf`/`anyOf`/`allOf`/`$ref`/`const`/`prefixItems`/
 *   `pattern`/`format`/`additionalProperties`; a discriminated union becomes one object with an enum tag and optional
 *   fields. The strict `check()` still runs on whatever the model sends.
 */
export type JsonSchemaTarget = 'llm' | 'mcp' | 'strict';

export interface JsonSchemaOptions {
  target: JsonSchemaTarget;
}

/** A JSON Schema document (plain JSON data). */
export type JsonSchema = { [keyword: string]: unknown };

// ── Shared model primitives (RichDoc, DeckSpec and EmailDoc all use these) ─────────────────────────────────────

/** An `https:` or `mailto:` URL that passed `s.link()`. Documents carry no other URL anywhere. */
export type SafeHref = string;

/** A link on a run. */
export interface SafeLink {
  href: SafeHref;
}

export type RunMark = 'b' | 'i' | 'u' | 'code';

/** Inline text: at most `MODEL_LIMITS.runText` characters, a set of marks and an optional link. */
export interface Run {
  text: string;
  marks?: RunMark[];
  link?: SafeLink;
}

/** A list item: inline runs, indented 0–`MODEL_LIMITS.listIndentMax` levels. */
export interface ListItem {
  runs: Run[];
  indent?: number;
}

export interface TableCell {
  runs: Run[];
}

export interface TableRow {
  cells: TableCell[];
}

/** `#RRGGBB` (`HEX_COLOR_PATTERN`). */
export type HexColor = string;

export type AssetMime = 'image/png' | 'image/jpeg' | 'image/webp';

/** An image as bytes we already hold: `data:image/(png|jpeg|webp);base64,…`, at most 5 MB decoded. */
export interface DataAssetRef {
  kind: 'data';
  dataUri: string;
}

/** An image the host stores; the host resolves `id` itself (renderers never fetch or read paths). */
export interface HostAssetRef {
  kind: 'asset';
  id: string;
}

/** There are no URL fields anywhere: images are `data:` URIs or host asset ids. */
export type AssetRef = DataAssetRef | HostAssetRef;

// ── Ops (shared envelope; plan §5.2 op rules) ─────────────────────────────────────────────────────────────────

/** An op's own id (`ID_PATTERN`). Each op id applies at most once. */
export type OpId = string;

/** Who an op comes from. The HOST stamps it: an op a model produced is always `'agent'`, whatever it claims. */
export type OpActor = 'user' | 'agent';

/**
 * Every op is `{op, id, baseRev, …}`. `baseRev` is the document `rev` the op was made against: an `apply*Ops` call
 * applies an op only while `op.baseRev === (doc.rev ?? 0)` at the start of the call, and bumps `rev` by 1 when it
 * applies at least one op, so a replayed batch is refused as `stale`.
 */
export interface OpBase {
  id: OpId;
  baseRev: number;
}

export type OpRejectCode = 'invalid' | 'stale' | 'duplicate' | 'not-found' | 'forbidden' | 'limit';

/** One refused op. `index` is its position in the call's `ops`; a malformed op may have no readable `opId`. */
export interface OpRejection {
  index: number;
  opId?: OpId;
  code: OpRejectCode;
  message: string;
}

/**
 * What `apply*Ops(doc, ops)` returns. Pure, immutable and never throws: a malformed op leaves `doc` unchanged (the
 * same reference when nothing applied) and is listed in `rejected`.
 */
export interface OpResult<D, O> {
  doc: D;
  applied: O[];
  rejected: OpRejection[];
}

// ── Caps ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Caps of the DSL's built-in kinds and of `check()`. */
export const SCHEMA_LIMITS = {
  /** `s.id()` and every op / block / section / slide id. */
  idMax: 64,
  /** RFC 5321 path limit. */
  emailMax: 254,
  emailLocalMax: 64,
  linkMax: 2048,
  assetIdMax: 200,
  /** Decoded bytes of a `data:` image: 5 MB (5 × 1024 × 1024). */
  assetDataMaxBytes: 5242880,
  /** Object field names. */
  fieldNameMax: 64,
  fieldsMax: 256,
  enumValuesMax: 256,
  literalMax: 200,
  unionVariantsMax: 64,
  tupleItemsMax: 16,
  /** No single string or array cap may exceed these (a cap that large is no cap). */
  textCapMax: 10000000,
  arrayCapMax: 1000000,
  /** `check()` defaults. */
  maxErrors: 20,
  maxNodes: 200000,
} as const;

/** Caps shared by every model's inline content. */
export const MODEL_LIMITS = {
  /** `Run.text`. */
  runText: 4000,
  /** `Run.marks` (each mark at most once). */
  marks: 4,
  /** `ListItem.indent` is 0 to this. */
  listIndentMax: 2,
  /** `alt` text on images. */
  alt: 1000,
} as const;

/** Ids: a letter or digit, then letters, digits, `_`, `.`, `:` or `-`; at most `SCHEMA_LIMITS.idMax`. */
export const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$';

/** `HexColor`. */
export const HEX_COLOR_PATTERN = '^#[0-9A-Fa-f]{6}$';

/** Host asset ids: no scheme, no leading `/`, no `..` segment, no `//` (checked besides this pattern). */
export const ASSET_ID_PATTERN = '^[A-Za-z0-9_-][A-Za-z0-9._/-]{0,199}$';
