// Short, stable, dependency-free string hash shared by doc.ts, i18n.ts and ops.ts.
// Moved verbatim from doc.ts (which re-exports it, so the public API is unchanged).
//
// Back-compat F1 (plan §5.1): spec hashes serialise their tuples with stableStringify, so a hash never
// depends on object key order. Postgres jsonb reorders keys on save (shortest first), which made drawn
// pages read "Out of date" after a reload when the hash was JSON.stringify of the in-memory order.

/** Short, stable, dependency-free string hash (FNV-1a 32-bit, hex). */
export const hashString = (input: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The value with every object's keys in sorted order (at every depth); arrays keep their order. */
const sortedDeep = (value: unknown, depth: number): unknown => {
  if (depth > 64) return value; // hashed tuples are shallow; a pathological value is serialised as is
  let v = value;
  // Exactly what JSON.stringify would serialise (Dates and other toJSON values).
  if (v && typeof v === 'object' && typeof (v as { toJSON?: unknown }).toJSON === 'function') v = (v as { toJSON: () => unknown }).toJSON();
  if (Array.isArray(v)) return v.map((x) => sortedDeep(x, depth + 1));
  if (!isPlainObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(v).sort()) out[key] = sortedDeep(v[key], depth + 1);
  return out;
};

/**
 * JSON.stringify with object keys sorted at every depth (array order kept). Same output as JSON.stringify for
 * everything else: undefined object values are dropped, undefined array items become null, strings, numbers
 * and booleans are serialised identically. Two values that differ only in key order serialise identically.
 */
export const stableStringify = (value: unknown): string => {
  const out = JSON.stringify(sortedDeep(value, 0));
  return out === undefined ? 'undefined' : out;
};
