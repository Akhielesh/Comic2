/**
 * `check(schema, value)`: the strict validator every host runs on agent output, tool arguments and stored documents
 * (plan §5.1). It never throws on a bad value and never trusts one: unknown keys are rejected, only own properties of
 * plain objects are read, strings are scanned for control characters, links must be `https:` or `mailto:`, and
 * `data:` images are sniffed. The work is bounded by the schema's caps and by `maxNodes`.
 *
 * On success `value` is a fresh plain copy (absent or `undefined` optionals dropped), so later code never sees the
 * caller's object (or its prototype).
 */
import type {
  AssetRefSchema,
  CheckError,
  CheckErrorCode,
  CheckOptions,
  CheckResult,
  LinkSchema,
  ObjectSchema,
  Schema,
  SchemaNode,
  TextSchema,
  UnionSchema,
} from '../contract/schema.js';
import { ASSET_ID_PATTERN, SCHEMA_LIMITS } from '../contract/schema.js';
import { SchemaDefinitionError } from '../errors.js';
import { assertSchema } from './s.js';

type Path = (string | number)[];

interface Ctx {
  errors: CheckError[];
  maxErrors: number;
  nodes: number;
  maxNodes: number;
  stop: boolean;
}

/** Returned by a walk that failed; never part of an accepted value. */
const NO: { readonly no: true } = Object.freeze({ no: true as const });

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/** A JSON-style object: `{}` or `Object.create(null)`, never an array, a class instance or a boxed value. */
const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const KEY_SHOWN = 64;

/** A key from the VALUE (it may be anything): quoted, non-ASCII escaped, cut to `KEY_SHOWN` characters. */
const quoteKey = (key: string): string => {
  const cut = key.length > KEY_SHOWN ? `${key.slice(0, KEY_SHOWN)}…` : key;
  return JSON.stringify(cut).replace(/[\u007f-\uffff]/g, (ch) => `\\u${`000${ch.charCodeAt(0).toString(16)}`.slice(-4)}`);
};

/**
 * `sections[0].blocks[3].text`; a key that is not a short identifier is written `["key"]`, escaped and cut, so a
 * hostile key can neither flood nor spoof a log line.
 */
export const formatPath = (path: readonly (string | number)[]): string => {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else if (IDENT.test(seg) && seg.length <= KEY_SHOWN) out += out ? `.${seg}` : seg;
    else out += `[${quoteKey(seg)}]`;
  }
  return out;
};

const report = (ctx: Ctx, path: Path, code: CheckErrorCode, message: string): typeof NO => {
  if (!ctx.stop) {
    ctx.errors.push({ path: formatPath(path), code, message });
    if (ctx.errors.length >= ctx.maxErrors) ctx.stop = true;
  }
  return NO;
};

const typeName = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);

const list = (values: readonly unknown[]): string => values.map((v) => JSON.stringify(v)).join(', ');

// ── Strings ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Characters no document field may hold: C0 controls except tab, line feed and carriage return; DEL and the C1
 * controls; the bidi embedding / override / isolate controls (they can make text read differently than it is stored,
 * e.g. a file name that shows as `.pdf` but ends in `.exe`); and unpaired surrogates. A single-line field also
 * refuses line breaks (LF, CR, U+2028, U+2029).
 */
const scanText = (text: string, singleLine: boolean): 'bad-char' | 'single-line' | null => {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20) {
      if (c === 0x0a || c === 0x0d) {
        if (singleLine) return 'single-line';
        continue;
      }
      if (c === 0x09) continue;
      return 'bad-char';
    }
    if (c < 0x7f) continue;
    if (c <= 0x9f) return 'bad-char';
    if (c === 0x2028 || c === 0x2029) {
      if (singleLine) return 'single-line';
      continue;
    }
    if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return 'bad-char';
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++;
        continue;
      }
      return 'bad-char';
    }
    if (c >= 0xdc00 && c <= 0xdfff) return 'bad-char';
  }
  return null;
};

const PATTERNS = new WeakMap<object, RegExp>();
const patternOf = (node: TextSchema): RegExp => {
  let re = PATTERNS.get(node);
  if (!re) {
    re = new RegExp(node.pattern as string, 'u');
    PATTERNS.set(node, re);
  }
  return re;
};

const walkText = (node: TextSchema, v: unknown, path: Path, ctx: Ctx): unknown => {
  if (typeof v !== 'string') return report(ctx, path, 'type', `must be text, not ${typeName(v)}`);
  if (v.length > node.max) return report(ctx, path, 'too-long', `must be at most ${node.max} characters (it has ${v.length})`);
  if (node.min !== undefined && v.length < node.min) {
    return report(ctx, path, 'too-short', node.min === 1 ? 'must not be empty' : `must be at least ${node.min} characters`);
  }
  const bad = scanText(v, node.singleLine === true);
  if (bad === 'bad-char') return report(ctx, path, 'bad-char', 'contains a control character, a bidi override or a broken character');
  if (bad === 'single-line') return report(ctx, path, 'single-line', 'must be one line (no line breaks)');
  if (node.pattern !== undefined && !patternOf(node).test(v)) return report(ctx, path, 'pattern', 'has the wrong format');
  return v;
};

// ── Email addresses and links ───────────────────────────────────────────────────────────────────────────────────

/**
 * One plain address in a conservative ASCII subset: a dot-atom local part of letters, digits, `_`, `+` and `-`, and a
 * domain of LDH labels ending in a letter-led TLD. No display names, quotes, comments, IP literals, `%`, `?` or
 * whitespace, so an address can never smuggle a header line or a second recipient into a draft or a `mailto:` link.
 */
const LOCAL = '[A-Za-z0-9_+-]+(?:\\.[A-Za-z0-9_+-]+)*';
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const DOMAIN = `(?:${LABEL}\\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?`;
const EMAIL = new RegExp(`^(${LOCAL})@(${DOMAIN})$`);

const isEmail = (v: string): boolean => {
  if (v.length > SCHEMA_LIMITS.emailMax) return false;
  const m = EMAIL.exec(v);
  return !!m && m[1].length <= SCHEMA_LIMITS.emailLocalMax;
};

/** RFC 3986 characters only (non-ASCII must be percent-encoded): no spaces, quotes, `<`, `>`, `\`, `^`, backtick, `{|}`. */
const URL_REST = "[A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%]*";
const HTTPS = new RegExp(`^https://(${LABEL}(?:\\.${LABEL})*)(?::([0-9]{1,5}))?(?:[/?#]${URL_REST})?$`);
const MAILTO = new RegExp(`^mailto:([^?]*)(?:\\?(${URL_REST}))?$`);
const BAD_PERCENT = /%(?![0-9A-Fa-f]{2})/;
const MAILTO_MAX_ADDRESSES = 20;

/**
 * `https://host[:port][/path][?query][#fragment]` (no userinfo, so `https://bank.example@evil.example` is refused) or
 * `mailto:addr[,addr…][?query]`. Lower-case schemes only; every `%` must start a valid escape.
 */
export const isSafeHref = (v: string, max: number = SCHEMA_LIMITS.linkMax): boolean => {
  if (v.length > max || BAD_PERCENT.test(v)) return false;
  if (v.lastIndexOf('https://', 0) === 0) {
    const m = HTTPS.exec(v);
    return !!m && (m[2] === undefined || Number(m[2]) <= 65535);
  }
  if (v.lastIndexOf('mailto:', 0) === 0) {
    const m = MAILTO.exec(v);
    if (!m) return false;
    const addresses = m[1].split(',');
    return addresses.length <= MAILTO_MAX_ADDRESSES && addresses.every(isEmail);
  }
  return false;
};

// ── Images ──────────────────────────────────────────────────────────────────────────────────────────────────────

const DATA_URI = /^data:image\/(png|jpeg|webp);base64,/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const ASSET_ID = new RegExp(ASSET_ID_PATTERN);
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decode the first `count` bytes of a base64 string (no `atob` in ES2017). */
const headBytes = (b64: string, count: number): number[] => {
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (let i = 0; i < b64.length && out.length < count; i++) {
    const v = B64.indexOf(b64.charAt(i));
    if (v < 0) break; // padding
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return out;
};

const startsWith = (bytes: number[], sig: number[], at = 0): boolean => sig.every((b, i) => bytes[at + i] === b);

/** The bytes must be what the MIME type says: PNG, JPEG or WebP magic. */
const magicMatches = (mime: string, b64: string): boolean => {
  const head = headBytes(b64, 12);
  if (mime === 'png') return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (mime === 'jpeg') return startsWith(head, [0xff, 0xd8, 0xff]);
  return startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8); // RIFF….WEBP
};

const isSafeAssetId = (v: string): boolean => ASSET_ID.test(v) && v.indexOf('//') === -1 && v.split('/').indexOf('..') === -1;

const walkAsset = (node: AssetRefSchema, v: unknown, path: Path, ctx: Ctx): unknown => {
  if (!isPlainObject(v)) return report(ctx, path, 'type', `must be an object, not ${typeName(v)}`);
  if (!hasOwn(v, 'kind') || v.kind === undefined) {
    path.push('kind');
    report(ctx, path, 'required', 'is required ("data" or "asset")');
    path.pop();
    return NO;
  }
  const kind = v.kind;
  if (kind !== 'data' && kind !== 'asset') {
    path.push('kind');
    report(ctx, path, 'tag', `must be one of "data", "asset" (images are data: URIs or host asset ids, never URLs)`);
    path.pop();
    return NO;
  }
  const field = kind === 'data' ? 'dataUri' : 'id';
  let failed = false;
  for (const key of Object.keys(v)) {
    if (key !== 'kind' && key !== field) {
      path.push(key);
      report(ctx, path, 'unknown-key', `is not a field of a "${kind}" image`);
      path.pop();
      failed = true;
    }
  }
  path.push(field);
  const value = hasOwn(v, field) ? v[field] : undefined;
  let ok = false;
  if (value === undefined) report(ctx, path, 'required', 'is required');
  else if (typeof value !== 'string') report(ctx, path, 'type', `must be text, not ${typeName(value)}`);
  else if (kind === 'asset') {
    if (value.length > SCHEMA_LIMITS.assetIdMax) report(ctx, path, 'too-long', `must be at most ${SCHEMA_LIMITS.assetIdMax} characters`);
    else if (!isSafeAssetId(value)) report(ctx, path, 'asset', 'must be a host asset id (no scheme, no leading /, no .. or //)');
    else ok = true;
  } else {
    const m = DATA_URI.exec(value);
    if (!m) report(ctx, path, 'asset', 'must be a data:image/png, image/jpeg or image/webp base64 URI');
    else {
      const b64 = value.slice(m[0].length);
      const pad = b64.length > 1 && b64.charAt(b64.length - 1) === '=' ? (b64.charAt(b64.length - 2) === '=' ? 2 : 1) : 0;
      const bytes = (b64.length / 4) * 3 - pad;
      if (bytes > node.maxBytes) report(ctx, path, 'asset-too-large', `must be at most ${node.maxBytes} bytes`);
      else if (!b64.length || b64.length % 4 !== 0 || !BASE64.test(b64)) report(ctx, path, 'asset', 'is not valid base64');
      else if (!magicMatches(m[1], b64)) report(ctx, path, 'asset', `does not hold ${m[1].toUpperCase()} bytes`);
      else ok = true;
    }
  }
  path.pop();
  return ok && !failed ? { kind, [field]: value } : NO;
};

// ── Walk ────────────────────────────────────────────────────────────────────────────────────────────────────────

const UNIONS = new WeakMap<object, { [tag: string]: ObjectSchema }>();
const variantsOf = (node: UnionSchema): { [tag: string]: ObjectSchema } => {
  let map = UNIONS.get(node);
  if (!map) {
    map = Object.create(null) as { [tag: string]: ObjectSchema };
    for (const variant of node.variants) {
      const lit = variant.fields[node.tag] as SchemaNode;
      if (lit.kind === 'literal') map[String(lit.value)] = variant;
    }
    UNIONS.set(node, map);
  }
  return map;
};

const walkObject = (node: ObjectSchema, v: unknown, path: Path, ctx: Ctx): unknown => {
  if (!isPlainObject(v)) return report(ctx, path, 'type', `must be an object, not ${typeName(v)}`);
  const out: Record<string, unknown> = {};
  let failed = false;
  for (const key of Object.keys(node.fields)) {
    const field = node.fields[key] as SchemaNode;
    const value = hasOwn(v, key) ? v[key] : undefined;
    path.push(key);
    if (value === undefined) {
      if (field.kind !== 'optional') {
        report(ctx, path, 'required', 'is required');
        failed = true;
      }
    } else {
      const r = walk(field.kind === 'optional' ? (field.inner as SchemaNode) : field, value, path, ctx);
      if (r === NO) failed = true;
      else out[key] = r;
    }
    path.pop();
    if (ctx.stop) return NO;
  }
  for (const key of Object.keys(v)) {
    if (!hasOwn(node.fields, key)) {
      path.push(key);
      report(ctx, path, 'unknown-key', 'is not a known field');
      path.pop();
      failed = true;
      if (ctx.stop) return NO;
    }
  }
  return failed ? NO : out;
};

const walkItems = (items: readonly SchemaNode[] | SchemaNode, v: unknown[], path: Path, ctx: Ctx): unknown => {
  const out: unknown[] = [];
  let failed = false;
  for (let i = 0; i < v.length; i++) {
    path.push(i);
    const r = walk(Array.isArray(items) ? items[i] : (items as SchemaNode), v[i], path, ctx);
    path.pop();
    if (r === NO) failed = true;
    else out.push(r);
    if (ctx.stop) return NO;
  }
  return failed ? NO : out;
};

const walkNumber = (v: unknown, min: number | undefined, max: number | undefined, int: boolean, path: Path, ctx: Ctx): unknown => {
  if (typeof v !== 'number') return report(ctx, path, 'type', `must be a number, not ${typeName(v)}`);
  if (!isFinite(v)) return report(ctx, path, 'not-finite', 'must be a finite number');
  if (int && !Number.isSafeInteger(v)) return report(ctx, path, 'int', 'must be a whole number');
  if (min !== undefined && v < min) return report(ctx, path, 'below-min', `must be at least ${min}`);
  if (max !== undefined && v > max) return report(ctx, path, 'above-max', `must be at most ${max}`);
  return v;
};

const walkLink = (node: LinkSchema, v: unknown, path: Path, ctx: Ctx): unknown => {
  if (typeof v !== 'string') return report(ctx, path, 'type', `must be text, not ${typeName(v)}`);
  if (v.length > node.max) return report(ctx, path, 'too-long', `must be at most ${node.max} characters`);
  if (!isSafeHref(v, node.max)) return report(ctx, path, 'link', 'must be an https:// or mailto: link (no other scheme, no user@ before the host)');
  return v;
};

function walk(node: SchemaNode, v: unknown, path: Path, ctx: Ctx): unknown {
  if (ctx.stop) return NO;
  if (++ctx.nodes > ctx.maxNodes) {
    report(ctx, path, 'too-many-nodes', `is too big to check (more than ${ctx.maxNodes} values)`);
    ctx.stop = true;
    return NO;
  }
  switch (node.kind) {
    case 'text':
      return walkText(node, v, path, ctx);
    case 'array': {
      if (!Array.isArray(v)) return report(ctx, path, 'type', `must be a list, not ${typeName(v)}`);
      if (v.length > node.max) return report(ctx, path, 'too-many', `must have at most ${node.max} items (it has ${v.length})`);
      if (node.min !== undefined && v.length < node.min) return report(ctx, path, 'too-few', `must have at least ${node.min} item${node.min === 1 ? '' : 's'}`);
      return walkItems(node.items as SchemaNode, v, path, ctx);
    }
    case 'tuple': {
      if (!Array.isArray(v)) return report(ctx, path, 'type', `must be a list, not ${typeName(v)}`);
      const n = node.items.length;
      if (v.length < n) return report(ctx, path, 'too-few', `must have exactly ${n} items`);
      if (v.length > n) return report(ctx, path, 'too-many', `must have exactly ${n} items`);
      return walkItems(node.items as readonly SchemaNode[], v, path, ctx);
    }
    case 'object':
      return walkObject(node, v, path, ctx);
    case 'union': {
      if (!isPlainObject(v)) return report(ctx, path, 'type', `must be an object, not ${typeName(v)}`);
      const map = variantsOf(node);
      path.push(node.tag);
      const tag = hasOwn(v, node.tag) ? v[node.tag] : undefined;
      let variant: ObjectSchema | undefined;
      if (tag === undefined) report(ctx, path, 'required', `is required (one of ${list(Object.keys(map))})`);
      else if (typeof tag !== 'string' || !hasOwn(map, tag)) report(ctx, path, 'tag', `must be one of ${list(Object.keys(map))}`);
      else variant = map[tag];
      path.pop();
      return variant ? walkObject(variant, v, path, ctx) : NO;
    }
    case 'enum':
      return (node.values as readonly unknown[]).indexOf(v) !== -1 ? v : report(ctx, path, 'enum', `must be one of ${list(node.values)}`);
    case 'literal':
      return v === node.value ? v : report(ctx, path, 'literal', `must be ${JSON.stringify(node.value)}`);
    case 'int':
      return walkNumber(v, node.min, node.max, true, path, ctx);
    case 'number':
      return walkNumber(v, node.min, node.max, false, path, ctx);
    case 'bool':
      return typeof v === 'boolean' ? v : report(ctx, path, 'type', `must be true or false, not ${typeName(v)}`);
    case 'email':
      if (typeof v !== 'string') return report(ctx, path, 'type', `must be text, not ${typeName(v)}`);
      if (v.length > node.max) return report(ctx, path, 'too-long', `must be at most ${node.max} characters`);
      return isEmail(v) ? v : report(ctx, path, 'email', 'must be one email address, like name@example.com');
    case 'link':
      return walkLink(node, v, path, ctx);
    case 'assetRef':
      return walkAsset(node, v, path, ctx);
    case 'optional':
      // Only reachable for a value inside an array or tuple, which assertSchema already refuses.
      throw new SchemaDefinitionError('s.optional only marks an object field');
  }
}

const positive = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : fallback);

/**
 * Validate `value` against `schema`. Returns `{ok: true, value}` (a fresh copy) or `{ok: false, errors}` with at
 * least one `{path, code, message}`. Throws only for a badly DEFINED schema (`SchemaDefinitionError`).
 */
export const check = <T>(schema: Schema<T>, value: unknown, options?: CheckOptions): CheckResult<T> => {
  const root = assertSchema(schema);
  const opts: CheckOptions = options || {};
  if (root.kind === 'optional') throw new SchemaDefinitionError('s.optional only marks an object field; check the inner schema');
  const ctx: Ctx = {
    errors: [],
    maxErrors: positive(opts.maxErrors, SCHEMA_LIMITS.maxErrors),
    nodes: 0,
    maxNodes: positive(opts.maxNodes, SCHEMA_LIMITS.maxNodes),
    stop: false,
  };
  const out = walk(root, value, [], ctx);
  if (ctx.errors.length || out === NO) {
    if (!ctx.errors.length) ctx.errors.push({ path: '', code: 'type', message: 'is not valid' });
    return { ok: false, errors: ctx.errors };
  }
  return { ok: true, value: out as T };
};
