// Short, stable, dependency-free string hash shared by doc.ts, i18n.ts and ops.ts.
// Moved verbatim from doc.ts (which re-exports it, so the public API is unchanged).

/** Short, stable, dependency-free string hash (FNV-1a 32-bit, hex). */
export const hashString = (input: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};
