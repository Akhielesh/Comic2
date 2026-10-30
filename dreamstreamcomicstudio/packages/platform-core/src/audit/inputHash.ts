/**
 * Content-free fingerprints (plan §5.10): audit events, plans and draft actions carry the HASH of what they act on,
 * never the content. `canonicalJson` makes the hash independent of key order, so the host that hashes a plan at
 * approval and the host that re-hashes it at resume always agree.
 */
import { sha256Hex } from './digest.js';

export { base64urlDecode, base64urlEncode, hmacSha256, hmacSha256Hex, sha256, sha256Hex, timingSafeEqual, toHex, utf8Bytes, utf8Decode } from './digest.js';

/** Deeper than this is not a document a tool or a plan carries; `canonicalJson` refuses it (no stack overflow). */
export const CANONICAL_MAX_DEPTH = 256;

/**
 * JSON with object keys sorted (UTF-16 order) at every depth, and the same value rules as `JSON.stringify`: an
 * `undefined` or function property is left out, `undefined` / a function in an array and a non-finite number become
 * `null`, and a `toJSON()` (a Date) is used. Throws `TypeError` on a cycle or on nesting past `CANONICAL_MAX_DEPTH`.
 */
export const canonicalJson = (value: unknown): string => {
  const stack: object[] = [];
  const write = (v: unknown, depth: number): string | undefined => {
    if (v !== null && typeof v === 'object' && typeof (v as { toJSON?: unknown }).toJSON === 'function') v = (v as { toJSON: () => unknown }).toJSON();
    if (v === null) return 'null';
    switch (typeof v) {
      case 'string':
        return JSON.stringify(v);
      case 'number':
        return isFinite(v) ? JSON.stringify(v) : 'null';
      case 'boolean':
        return v ? 'true' : 'false';
      case 'object': {
        if (depth >= CANONICAL_MAX_DEPTH) throw new TypeError('canonicalJson: value is nested too deeply');
        if (stack.indexOf(v as object) !== -1) throw new TypeError('canonicalJson: value has a cycle');
        stack.push(v as object);
        let out: string;
        if (Array.isArray(v)) {
          out = `[${v
            .map((item) => {
              const w = write(item, depth + 1);
              return w === undefined ? 'null' : w;
            })
            .join(',')}]`;
        } else {
          const parts: string[] = [];
          for (const key of Object.keys(v as object).sort()) {
            const item = write((v as { [k: string]: unknown })[key], depth + 1);
            if (item !== undefined) parts.push(`${JSON.stringify(key)}:${item}`);
          }
          out = `{${parts.join(',')}}`;
        }
        stack.pop();
        return out;
      }
      default:
        return undefined; // undefined, function, symbol: left out (or null inside an array)
    }
  };
  const out = write(value, 0);
  return out === undefined ? 'null' : out;
};

/** `sha256:<hex>` of the canonical JSON: the fingerprint audit events, plans and draft actions carry. */
export const inputHash = (value: unknown): string => `sha256:${sha256Hex(canonicalJson(value))}`;

/** Is `value` a fingerprint `inputHash` could have produced? */
export const isInputHash = (value: unknown): value is string => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
