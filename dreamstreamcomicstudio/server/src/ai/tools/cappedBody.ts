// Bounded body reads for responses from servers we do not control (user/model page reads, user
// MCP servers). A body is read only up to a byte cap, then its stream is cancelled so the rest is
// never downloaded or decompressed — a 100-byte brotli body that inflates to gigabytes stops at the
// cap like any other. Text is decoded with the charset the response declares (Content-Type, a BOM,
// or an HTML <meta charset> in the first 1024 bytes), falling back to UTF-8.

export interface CappedBytes {
  bytes: Uint8Array;
  /** True when the body was longer than maxBytes and the read stopped at the cap. */
  truncated: boolean;
}

/** Read at most maxBytes of a body, then cancel the stream (the connection stops downloading). */
export const readBodyCapped = async (res: Response, maxBytes: number): Promise<CappedBytes> => {
  const body = res.body as ReadableStream<Uint8Array> | null;
  if (!body) return { bytes: new Uint8Array(0), truncated: false };
  const cap = Math.max(0, maxBytes);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = cap - total;
      if (value.length > room) {
        if (room > 0) {
          chunks.push(value.subarray(0, room));
          total += room;
        }
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return { bytes, truncated };
};

const CHARSET_PARAM = /charset\s*=\s*["']?\s*([\w.:-]+)/i;
const META_CHARSET = /<meta[^>]{0,512}?charset\s*=\s*["']?\s*([\w.:-]+)/i;

const bomCharset = (b: Uint8Array): string | undefined => {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 'utf-8';
  if (b[0] === 0xff && b[1] === 0xfe) return 'utf-16le';
  if (b[0] === 0xfe && b[1] === 0xff) return 'utf-16be';
  return undefined;
};

/**
 * The charset to decode a body with: a BOM, else the Content-Type charset, else (for HTML or an
 * unlabelled body) a `<meta charset>` / `http-equiv` declaration in the first 1024 bytes, else UTF-8.
 */
export const charsetFor = (contentType: string, bytes: Uint8Array): string => {
  const bom = bomCharset(bytes);
  if (bom) return bom;
  const declared = CHARSET_PARAM.exec(contentType)?.[1];
  if (declared) return declared;
  if (contentType && !/html|xml/i.test(contentType)) return 'utf-8';
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(1024, bytes.length)).toString('latin1');
  return META_CHARSET.exec(head)?.[1] || 'utf-8';
};

/** Decode body bytes as text in their declared charset (an unknown label falls back to UTF-8). */
export const decodeBody = (bytes: Uint8Array, contentType = ''): string => {
  const label = charsetFor(contentType, bytes);
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
};

/** Read at most maxBytes of a body as text in its declared charset. */
export const readTextCapped = async (
  res: Response,
  maxBytes: number
): Promise<{ text: string; truncated: boolean; bytes: number }> => {
  const { bytes, truncated } = await readBodyCapped(res, maxBytes);
  return { text: decodeBody(bytes, res.headers.get('content-type') || ''), truncated, bytes: bytes.length };
};
