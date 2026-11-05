/**
 * Capped request-body reads for the edge (S16). `req.text()` / `req.arrayBuffer()` buffer the
 * WHOLE body before any size check can run, and a chunked or HTTP/2 upload carries no
 * Content-Length — so a length precheck alone lets an anonymous caller make an isolate hold up to
 * the zone's upload limit. This reader never holds more than `max` bytes:
 *   - a declared Content-Length over the cap is refused without reading anything;
 *   - an unsized body is read chunk by chunk and the stream is cancelled the moment it passes the cap.
 * No Workers-only imports, so it runs (and is tested) under Node too.
 */

/**
 * The body as UTF-8 text, or null when it is larger than `max` bytes or cannot be read.
 * No body at all → '' (an empty POST behaves exactly as `req.text()` did).
 */
export async function readCappedText(req: Request, max: number): Promise<string | null> {
  const declared = req.headers.get('content-length');
  if (declared !== null && declared.trim() !== '' && !(Number(declared) <= max)) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > max) {
        // Stop pulling: the runtime would otherwise keep receiving the upload.
        reader.cancel().catch(() => undefined);
        return null;
      }
      parts.push(value);
    }
  } catch {
    reader.cancel().catch(() => undefined);
    return null;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  // Non-fatal decoding: invalid UTF-8 becomes U+FFFD, exactly like req.text().
  return new TextDecoder().decode(bytes);
}
