/**
 * `POST /v1/convert` (plan §5.9): raw bytes in, a converted document out, synchronously (budget ≤ 25 s, never 202).
 * The endpoint keeps its established wire format: the source name in `X-Atlas-File-Name` (percent-encoded) and the
 * wanted format in `X-Atlas-Target-Format`. The answer is `application/pdf`, `text/html; charset=utf-8` or
 * `text/plain`; a PDF must start with `%PDF-`. HTML output stays server-to-server: re-sanitise it before showing it.
 */
import { rfc3986Encode } from '../wire/canonical.js';
import { PLATFORM_HEADERS } from '../wire/headers.js';
import { inputFailure } from '../wire/errors.js';
import type { WireFailure } from '../wire/types.js';
import type { ClientContext, ResponseMeta, SignedPost } from './request.js';
import { badResponse, encodeFileName, guard, mediaType, send } from './request.js';

export const CONVERT_TARGET_FORMATS = ['html', 'pdf'] as const;
export type ConvertTargetFormat = (typeof CONVERT_TARGET_FORMATS)[number];

export interface ConvertInput extends SignedPost {
  bytes: Uint8Array;
  /** The source's media type, e.g. `application/vnd.openxmlformats-officedocument.wordprocessingml.document`. */
  contentType: string;
  fileName: string;
  targetFormat: ConvertTargetFormat;
}

export type ConvertOutputType = 'application/pdf' | 'text/html' | 'text/plain';

export type ConvertResult = { ok: true; bytes: Uint8Array; contentType: ConvertOutputType; meta: ResponseMeta } | WireFailure;

const OUTPUT_TYPES: readonly string[] = ['application/pdf', 'text/html', 'text/plain'];

/** `%PDF-` */
export const isPdfBytes = (bytes: Uint8Array): boolean =>
  bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;

export const convert = (ctx: ClientContext, input: ConvertInput): Promise<ConvertResult> =>
  guard(async () => {
    if (!input || !(input.bytes instanceof Uint8Array) || !input.bytes.length) return inputFailure('input', 'convert needs the file bytes');
    if (CONVERT_TARGET_FORMATS.indexOf(input.targetFormat) === -1) return inputFailure('input', 'targetFormat must be html or pdf');
    const fileName = encodeFileName(input.fileName, rfc3986Encode);
    if (fileName === null) return inputFailure('input', 'fileName must be 1 to 255 characters with no control characters');
    const r = await send(ctx, {
      method: 'POST',
      path: '/v1/convert',
      body: input.bytes,
      contentType: input.contentType,
      headers: { [PLATFORM_HEADERS.convertFileName]: fileName, [PLATFORM_HEADERS.convertTargetFormat]: input.targetFormat },
      claim: input.claim,
      idempotencyKey: input.idempotencyKey,
    });
    if (r.ok === false) return r;
    const type = mediaType(r.contentType);
    if (r.status !== 200 || OUTPUT_TYPES.indexOf(type) === -1) return badResponse('conversion', r.meta);
    if (type === 'application/pdf' && !isPdfBytes(r.body)) return badResponse('PDF', r.meta);
    return { ok: true, bytes: r.body, contentType: type as ConvertOutputType, meta: r.meta };
  });
