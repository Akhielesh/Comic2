/**
 * `toJsonSchema(schema, {target})` (plan §5.1): the same definition as JSON Schema for three readers.
 *
 * - `strict`: JSON Schema 2020-12 with everything `check()` can express (`oneOf`, `const`, `prefixItems`, patterns,
 *   formats, `additionalProperties: false`). What it cannot express (control characters, data-URI magic bytes, the
 *   link grammar beyond its prefix) `check()` still enforces.
 * - `mcp`: `strict` without `$schema`, for an MCP tool's `inputSchema`; the root must be an object.
 * - `llm`: a flattened schema that function-calling dialects accept: no `oneOf`/`anyOf`/`allOf`/`$ref`/`const`/
 *   `prefixItems`/`pattern`/`format`/`additionalProperties`. A discriminated union becomes ONE object whose tag is an
 *   enum, with every variant's fields (a field only some variants use says which, in its description). The model's
 *   output still goes through `check()`.
 *
 * Output is deterministic: keys appear in definition order.
 */
import type { JsonSchema, JsonSchemaOptions, JsonSchemaTarget, ObjectSchema, Schema, SchemaNode } from '../contract/schema.js';
import { ASSET_ID_PATTERN, SCHEMA_LIMITS } from '../contract/schema.js';
import { SchemaDefinitionError } from '../errors.js';
import { assertSchema } from './s.js';

const DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const DATA_URI_PREFIX = '^data:image/(png|jpeg|webp);base64,';
const LINK_PREFIX = '^(https://|mailto:)';
const TARGETS: readonly JsonSchemaTarget[] = ['llm', 'mcp', 'strict'];

/** The longest `data:` URI a byte cap allows: the longest prefix plus the base64 of `maxBytes`. */
const dataUriMax = (maxBytes: number): number => 'data:image/jpeg;base64,'.length + Math.ceil(maxBytes / 3) * 4;

const withDoc = (node: SchemaNode, out: JsonSchema): JsonSchema => {
  if (node.title !== undefined) out.title = node.title;
  if (node.description !== undefined) out.description = node.description;
  return out;
};

const typeOfValues = (values: readonly unknown[]): string | undefined => {
  if (values.every((v) => typeof v === 'string')) return 'string';
  if (values.every((v) => typeof v === 'number' && Number.isSafeInteger(v))) return 'integer';
  if (values.every((v) => typeof v === 'number')) return 'number';
  if (values.every((v) => typeof v === 'boolean')) return 'boolean';
  return undefined;
};

const range = (out: JsonSchema, min: number | undefined, max: number | undefined): JsonSchema => {
  if (min !== undefined) out.minimum = min;
  if (max !== undefined) out.maximum = max;
  return out;
};

// ── strict / mcp ────────────────────────────────────────────────────────────────────────────────────────────────

const strictObject = (node: ObjectSchema): JsonSchema => {
  const properties: JsonSchema = {};
  const required: string[] = [];
  for (const key of Object.keys(node.fields)) {
    const field = node.fields[key] as SchemaNode;
    if (field.kind === 'optional') properties[key] = withDoc(field, strict(field.inner as SchemaNode));
    else {
      properties[key] = strict(field);
      required.push(key);
    }
  }
  const out: JsonSchema = { type: 'object', properties };
  if (required.length) out.required = required;
  out.additionalProperties = false;
  return withDoc(node as SchemaNode, out);
};

const assetVariants = (maxBytes: number, llm: boolean): JsonSchema[] => [
  {
    type: 'object',
    properties: {
      kind: llm ? { type: 'string', enum: ['data'] } : { type: 'string', const: 'data' },
      dataUri: llm
        ? { type: 'string', maxLength: dataUriMax(maxBytes) }
        : { type: 'string', maxLength: dataUriMax(maxBytes), pattern: DATA_URI_PREFIX, contentEncoding: 'base64' },
    },
    required: ['kind', 'dataUri'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: {
      kind: llm ? { type: 'string', enum: ['asset'] } : { type: 'string', const: 'asset' },
      id: llm ? { type: 'string', maxLength: SCHEMA_LIMITS.assetIdMax } : { type: 'string', maxLength: SCHEMA_LIMITS.assetIdMax, pattern: ASSET_ID_PATTERN },
    },
    required: ['kind', 'id'],
    additionalProperties: false,
  },
];

function strict(node: SchemaNode): JsonSchema {
  switch (node.kind) {
    case 'text': {
      const out: JsonSchema = { type: 'string', maxLength: node.max };
      if (node.min !== undefined) out.minLength = node.min;
      if (node.pattern !== undefined) out.pattern = node.pattern;
      return withDoc(node, out);
    }
    case 'array': {
      const out: JsonSchema = { type: 'array', items: strict(node.items as SchemaNode), maxItems: node.max };
      if (node.min !== undefined) out.minItems = node.min;
      return withDoc(node, out);
    }
    case 'tuple':
      return withDoc(node, {
        type: 'array',
        prefixItems: node.items.map((item) => strict(item as SchemaNode)),
        items: false,
        minItems: node.items.length,
        maxItems: node.items.length,
      });
    case 'object':
      return strictObject(node);
    case 'union':
      return withDoc(node, { oneOf: node.variants.map((v) => strictObject(v)) });
    case 'enum': {
      const type = typeOfValues(node.values);
      return withDoc(node, type ? { type, enum: node.values.slice() } : { enum: node.values.slice() });
    }
    case 'literal':
      return withDoc(node, { type: typeOfValues([node.value]), const: node.value });
    case 'int':
      return withDoc(node, range({ type: 'integer' }, node.min, node.max));
    case 'number':
      return withDoc(node, range({ type: 'number' }, node.min, node.max));
    case 'bool':
      return withDoc(node, { type: 'boolean' });
    case 'email':
      return withDoc(node, { type: 'string', format: 'email', maxLength: node.max });
    case 'link':
      return withDoc(node, { type: 'string', format: 'uri', maxLength: node.max, pattern: LINK_PREFIX });
    case 'assetRef':
      return withDoc(node, { oneOf: assetVariants(node.maxBytes, false) });
    case 'optional':
      throw new SchemaDefinitionError('s.optional only marks an object field');
  }
}

// ── llm ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const isJsonObject = (v: unknown): v is JsonSchema => typeof v === 'object' && v !== null && !Array.isArray(v);

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isJsonObject(a) && isJsonObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
};

const maxOf = (a: unknown, b: unknown): number | undefined => (typeof a === 'number' && typeof b === 'number' ? Math.max(a, b) : undefined);
const minOf = (a: unknown, b: unknown): number | undefined => (typeof a === 'number' && typeof b === 'number' ? Math.min(a, b) : undefined);

/**
 * One schema that admits what either admits (as loosely as needed): used when two union variants (or two tuple items)
 * declare the same field differently. Exactness is not the goal here; `check()` is. Both must share one JSON type
 * (`integer` and `number` merge to `number`): a field that is text in one variant and a number in another has no
 * typed flat form, and several function-calling dialects refuse a property without a `type`, so that throws.
 */
const mergeLlm = (a: JsonSchema, b: JsonSchema): JsonSchema => {
  if (deepEqual(a, b)) return a;
  const ta = a.type;
  const tb = b.type;
  const numeric = (t: unknown): boolean => t === 'integer' || t === 'number';
  if (typeof ta !== 'string' || typeof tb !== 'string' || (ta !== tb && !(numeric(ta) && numeric(tb)))) {
    throw new SchemaDefinitionError('union variants (or tuple items) declare one field with different JSON types; the llm target cannot flatten it');
  }
  const out: JsonSchema = {};
  out.type = ta === tb ? ta : 'number';
  if (Array.isArray(a.enum) && Array.isArray(b.enum)) {
    const values = a.enum.slice();
    for (const v of b.enum) if (values.indexOf(v) === -1) values.push(v);
    out.enum = values;
  }
  const set = (key: string, v: number | undefined): void => {
    if (v !== undefined) out[key] = v;
  };
  set('maxLength', maxOf(a.maxLength, b.maxLength));
  set('minLength', minOf(a.minLength, b.minLength));
  set('maxItems', maxOf(a.maxItems, b.maxItems));
  set('minItems', minOf(a.minItems, b.minItems));
  set('maximum', maxOf(a.maximum, b.maximum));
  set('minimum', minOf(a.minimum, b.minimum));
  if (isJsonObject(a.items) && isJsonObject(b.items)) out.items = mergeLlm(a.items, b.items);
  if (isJsonObject(a.properties) && isJsonObject(b.properties)) {
    const props: JsonSchema = {};
    const pa = a.properties;
    const pb = b.properties;
    for (const k of Object.keys(pa)) props[k] = isJsonObject(pb[k]) ? mergeLlm(pa[k] as JsonSchema, pb[k] as JsonSchema) : pa[k];
    for (const k of Object.keys(pb)) if (!(k in props)) props[k] = pb[k];
    out.properties = props;
    const ra = Array.isArray(a.required) ? (a.required as string[]) : [];
    const rb = Array.isArray(b.required) ? (b.required as string[]) : [];
    const required = ra.filter((k) => rb.indexOf(k) !== -1);
    if (required.length) out.required = required;
  }
  if (typeof a.description === 'string' && a.description === b.description) out.description = a.description;
  return out;
};

const quoteList = (values: readonly string[]): string => {
  const q = values.map((v) => `"${v}"`);
  return q.length === 1 ? q[0] : `${q.slice(0, -1).join(', ')} or ${q[q.length - 1]}`;
};

const addNote = (schema: JsonSchema, note: string): JsonSchema => {
  const out: JsonSchema = {};
  for (const k of Object.keys(schema)) out[k] = schema[k];
  out.description = typeof schema.description === 'string' && schema.description ? `${schema.description} ${note}` : note;
  return out;
};

/** Variants → `{type: object, properties: {tag: enum, …every field}, required: [tag, …fields every variant requires]}`. */
const flattenUnion = (tag: string, variants: { tag: string; schema: JsonSchema }[]): JsonSchema => {
  const tags = variants.map((v) => v.tag);
  const byField: { [key: string]: { tag: string; schema: JsonSchema; required: boolean }[] } = {};
  const order: string[] = [];
  for (const v of variants) {
    const props = v.schema.properties as JsonSchema;
    const required = (v.schema.required as string[] | undefined) || [];
    for (const key of Object.keys(props)) {
      if (key === tag) continue;
      if (!byField[key]) {
        byField[key] = [];
        order.push(key);
      }
      byField[key].push({ tag: v.tag, schema: props[key] as JsonSchema, required: required.indexOf(key) !== -1 });
    }
  }
  const properties: JsonSchema = { [tag]: { type: 'string', enum: tags } };
  const required = [tag];
  for (const key of order) {
    const uses = byField[key];
    let schema = uses[0].schema;
    for (let i = 1; i < uses.length; i++) schema = mergeLlm(schema, uses[i].schema);
    if (uses.length < variants.length) schema = addNote(schema, `Only when ${tag} is ${quoteList(uses.map((u) => u.tag))}.`);
    else if (uses.every((u) => u.required)) required.push(key);
    properties[key] = schema;
  }
  return { type: 'object', properties, required };
};

const llmObject = (node: ObjectSchema): JsonSchema => {
  const properties: JsonSchema = {};
  const required: string[] = [];
  for (const key of Object.keys(node.fields)) {
    const field = node.fields[key] as SchemaNode;
    if (field.kind === 'optional') properties[key] = withDoc(field, llm(field.inner as SchemaNode));
    else {
      properties[key] = llm(field);
      required.push(key);
    }
  }
  const out: JsonSchema = { type: 'object', properties };
  if (required.length) out.required = required;
  return withDoc(node as SchemaNode, out);
};

/** `llm` strips formats and patterns, so a kind with its own grammar says it in words (after the author's own). */
const hinted = (node: SchemaNode, out: JsonSchema, hint: string): JsonSchema => {
  const doc = withDoc(node, out);
  doc.description = typeof doc.description === 'string' ? `${doc.description} ${hint}` : hint;
  return doc;
};

const tagOf = (variant: ObjectSchema, tag: string): string => {
  const lit = variant.fields[tag] as SchemaNode;
  return lit.kind === 'literal' ? String(lit.value) : '';
};

function llm(node: SchemaNode): JsonSchema {
  switch (node.kind) {
    case 'text': {
      const out: JsonSchema = { type: 'string', maxLength: node.max };
      if (node.min !== undefined) out.minLength = node.min;
      return withDoc(node, out);
    }
    case 'array': {
      const out: JsonSchema = { type: 'array', items: llm(node.items as SchemaNode), maxItems: node.max };
      if (node.min !== undefined) out.minItems = node.min;
      return withDoc(node, out);
    }
    case 'tuple': {
      const items = node.items.map((item) => llm(item as SchemaNode));
      let merged = items[0];
      for (let i = 1; i < items.length; i++) merged = mergeLlm(merged, items[i]);
      return withDoc(node, { type: 'array', items: merged, minItems: items.length, maxItems: items.length });
    }
    case 'object':
      return llmObject(node);
    case 'union':
      return withDoc(node, flattenUnion(node.tag, node.variants.map((v) => ({ tag: tagOf(v, node.tag), schema: llmObject(v) }))));
    case 'enum': {
      const type = typeOfValues(node.values);
      return withDoc(node, type ? { type, enum: node.values.slice() } : { enum: node.values.slice() });
    }
    case 'literal':
      return withDoc(node, { type: typeOfValues([node.value]), enum: [node.value] });
    case 'int':
      return withDoc(node, range({ type: 'integer' }, node.min, node.max));
    case 'number':
      return withDoc(node, range({ type: 'number' }, node.min, node.max));
    case 'bool':
      return withDoc(node, { type: 'boolean' });
    case 'email':
      return hinted(node, { type: 'string', maxLength: node.max }, 'One email address, like name@example.com.');
    case 'link':
      return hinted(node, { type: 'string', maxLength: node.max }, 'An https:// or mailto: link.');
    case 'assetRef': {
      const [data, asset] = assetVariants(node.maxBytes, true);
      const flat = flattenUnion('kind', [
        { tag: 'data', schema: data },
        { tag: 'asset', schema: asset },
      ]);
      const props = flat.properties as JsonSchema;
      props.dataUri = addNote(props.dataUri as JsonSchema, 'A data:image/png, image/jpeg or image/webp base64 URI.');
      props.id = addNote(props.id as JsonSchema, 'An image id the app gave you.');
      return withDoc(node, { ...flat, description: 'An image: never a web URL.' });
    }
    case 'optional':
      throw new SchemaDefinitionError('s.optional only marks an object field');
  }
}

/** Project `schema` to JSON Schema for `target`. Throws `SchemaDefinitionError` for a bad schema or target. */
export const toJsonSchema = (schema: Schema<unknown>, options: JsonSchemaOptions): JsonSchema => {
  const target: unknown = options ? options.target : undefined;
  if (typeof target !== 'string' || TARGETS.indexOf(target as JsonSchemaTarget) === -1) throw new SchemaDefinitionError(`toJsonSchema target must be one of ${TARGETS.join(', ')}`);
  const root = assertSchema(schema);
  if (root.kind === 'optional') throw new SchemaDefinitionError('s.optional only marks an object field');
  if (target === 'llm') return llm(root);
  if (target === 'mcp') {
    if (root.kind !== 'object') throw new SchemaDefinitionError('an MCP inputSchema must be an s.object at the root');
    return strict(root);
  }
  const out: JsonSchema = { $schema: DRAFT };
  const body = strict(root);
  for (const k of Object.keys(body)) out[k] = body[k];
  return out;
};
