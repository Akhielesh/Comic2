// Incremental parser for the streamed app-generation JSON.
//
// The generate model returns ONE JSON object: {title, description, template, files:[{path,
// content}, ...]}. To make generation feel *synchronous* (the user watches files appear), we
// stream the model's tokens and, on each chunk, scan the accumulated text to discover which
// files exist so far — their path (as soon as it's known) and whether the file object has
// finished closing (so we can mark it "written" with a byte count).
//
// Pure + dependency-free so it's unit-testable without a network or a model. Re-scans the whole
// buffer each call (simple + robust; the buffer is small — a few tens of KB).

export interface StreamedFile {
  /** File path as declared in JSON (may be normalized later). */
  path: string;
  /** True once the file's JSON object has fully closed (`}`) — i.e. content finished streaming. */
  complete: boolean;
  /** Decoded length of the file's `content` so far (approx bytes for a size label). */
  bytes: number;
}

const isWs = (c: string): boolean => c === ' ' || c === '\n' || c === '\t' || c === '\r';

interface ReadString {
  /** Decoded string value (partial if not yet terminated). */
  value: string;
  /** Index just past the closing quote, or -1 if the string is still streaming. */
  end: number;
}

/** Read a JSON string starting at `i` (which must point at the opening `"`). Tolerant of a
 *  string that hasn't finished streaming yet (returns end:-1 with the partial value). */
export const readJsonString = (text: string, i: number): ReadString => {
  if (text[i] !== '"') return { value: '', end: -1 };
  let j = i + 1;
  let s = '';
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') {
      const n = text[j + 1];
      if (n === undefined) return { value: s, end: -1 }; // escape split across chunks
      switch (n) {
        case 'n': s += '\n'; break;
        case 't': s += '\t'; break;
        case 'r': s += '\r'; break;
        case 'b': s += '\b'; break;
        case 'f': s += '\f'; break;
        case '"': s += '"'; break;
        case '\\': s += '\\'; break;
        case '/': s += '/'; break;
        case 'u': {
          if (j + 6 > text.length) return { value: s, end: -1 }; // \uXXXX split across chunks
          const code = parseInt(text.slice(j + 2, j + 6), 16);
          s += Number.isNaN(code) ? '' : String.fromCharCode(code);
          j += 6;
          continue;
        }
        default: s += n;
      }
      j += 2;
      continue;
    }
    if (c === '"') return { value: s, end: j + 1 };
    s += c;
    j++;
  }
  return { value: s, end: -1 }; // unterminated → still streaming
};

/** Skip a non-string scalar value (number/true/false/null) up to the next `,`, `}` or `]`. */
const skipScalar = (text: string, i: number): number => {
  let j = i;
  while (j < text.length && text[j] !== ',' && text[j] !== '}' && text[j] !== ']') j++;
  return j < text.length ? j : -1;
};

/**
 * Scan the accumulated generation text and return the files discovered so far, in order.
 * A file appears here as soon as its `path` is known; `complete` flips true once its object
 * closes. The last entry may be incomplete (still streaming).
 */
export const scanStreamedFiles = (text: string): StreamedFile[] => {
  const out: StreamedFile[] = [];
  const filesKey = text.indexOf('"files"');
  if (filesKey < 0) return out;
  let i = text.indexOf('[', filesKey);
  if (i < 0) return out;
  i++; // past '['

  while (i < text.length) {
    while (i < text.length && (isWs(text[i]) || text[i] === ',')) i++;
    if (i >= text.length) break;
    if (text[i] === ']') break; // files array closed
    if (text[i] !== '{') { i++; continue; }
    i++; // past '{'

    let path: string | undefined;
    let bytes = 0;
    let objClosed = false;

    while (i < text.length) {
      while (i < text.length && (isWs(text[i]) || text[i] === ',')) i++;
      if (i >= text.length) break;
      if (text[i] === '}') { objClosed = true; i++; break; }
      if (text[i] !== '"') { i++; continue; }

      const key = readJsonString(text, i);
      if (key.end < 0) { i = text.length; break; } // key split across chunks
      i = key.end;
      while (i < text.length && (isWs(text[i]) || text[i] === ':')) i++;
      if (i >= text.length) break;

      if (text[i] === '"') {
        const val = readJsonString(text, i);
        if (key.value === 'path' && val.value) path = val.value;
        if (key.value === 'content') bytes = val.value.length;
        if (val.end < 0) { i = text.length; break; } // value still streaming → object open
        i = val.end;
      } else {
        const next = skipScalar(text, i);
        if (next < 0) { i = text.length; break; }
        i = next;
      }
    }

    if (path !== undefined) out.push({ path, complete: objClosed, bytes });
    if (!objClosed) break; // current object still streaming — nothing after it yet
  }

  return out;
};
