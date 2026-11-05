/**
 * `POST /v1/files` (stage raw bytes for a later PDF job; kept 24 h) and `GET /v1/files/:ref` (download a result).
 * The upload's answer must name the SHA-256 of exactly the bytes that were signed and sent.
 */
import { rfc3986Encode } from '../wire/canonical.js';
import { PLATFORM_HEADERS } from '../wire/headers.js';
import { isBytes } from '../wire/bytes.js';
import { inputFailure } from '../wire/errors.js';
import type { WireFailure } from '../wire/types.js';
import { FILE_REF_PATTERN } from '../wire/types.js';
import type { ClientContext, ResponseMeta, SignedPost } from './request.js';
import { badResponse, encodeFileName, guard, isRecord, isText, isWhole, mediaType, readJson, send } from './request.js';

export const FILE_REF = new RegExp(FILE_REF_PATTERN);

/**
 * The only media types `GET /v1/files/:ref` serves (plan §5.9): pdf, docx, pptx, png, jpeg, webp and psd. Anything
 * else (HTML, SVG, XHTML, XML, scripts, text) is refused rather than handed to a host that might serve it on.
 */
export const SERVED_FILE_TYPES: readonly string[] = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/vnd.adobe.photoshop',
];

export interface UploadFileInput extends SignedPost {
  bytes: Uint8Array;
  fileName: string;
  /** Default `application/octet-stream`: the gateway sniffs the bytes anyway. */
  contentType?: string;
}

export interface StagedFile {
  fileRef: string;
  sha256: string;
  bytes: number;
  /** The media type the gateway sniffed from the bytes. */
  sniffed: string;
}

export type UploadFileResult = { ok: true; file: StagedFile; meta: ResponseMeta } | WireFailure;

export interface DownloadFileInput {
  fileRef: string;
  /** A `job-read` claim, so the gateway can match the file's owner. */
  claim?: string;
}

export type DownloadFileResult = { ok: true; bytes: Uint8Array; contentType: string; meta: ResponseMeta } | WireFailure;

export const uploadFile = (ctx: ClientContext, input: UploadFileInput): Promise<UploadFileResult> =>
  guard(async () => {
    if (!input || !isBytes(input.bytes) || !input.bytes.length) return inputFailure('input', 'uploadFile needs the file bytes');
    const fileName = encodeFileName(input.fileName, rfc3986Encode);
    if (fileName === null) return inputFailure('input', 'fileName must be 1 to 255 characters with no control characters');
    const r = await send(ctx, {
      method: 'POST',
      path: '/v1/files',
      body: input.bytes,
      contentType: input.contentType === undefined ? 'application/octet-stream' : input.contentType,
      headers: { [PLATFORM_HEADERS.fileName]: fileName },
      claim: input.claim,
      idempotencyKey: input.idempotencyKey,
    });
    if (r.ok === false) return r;
    const v = r.status === 200 || r.status === 201 ? readJson(r.body) : undefined;
    if (
      !isRecord(v) ||
      !isText(v.fileRef, 256, FILE_REF) ||
      !isText(v.sha256, 64, /^[0-9a-f]{64}$/) ||
      !isWhole(v.bytes, 0, Number.MAX_SAFE_INTEGER) ||
      !isText(v.sniffed, 128)
    ) {
      return badResponse('staged file', r.meta);
    }
    if (v.sha256 !== r.requestBodySha256Hex || v.bytes !== input.bytes.length) return badResponse('staged file (its hash is not of the bytes sent)', r.meta);
    return { ok: true, file: { fileRef: v.fileRef, sha256: v.sha256, bytes: v.bytes, sniffed: v.sniffed }, meta: r.meta };
  });

export const downloadFile = (ctx: ClientContext, input: DownloadFileInput): Promise<DownloadFileResult> =>
  guard(async () => {
    if (!input || typeof input.fileRef !== 'string' || !FILE_REF.test(input.fileRef)) return inputFailure('input', 'fileRef is not a platform file reference');
    const r = await send(ctx, { method: 'GET', path: `/v1/files/${input.fileRef}`, claim: input.claim });
    if (r.ok === false) return r;
    const type = mediaType(r.contentType);
    // Only the served types (plan §5.9): never HTML, SVG or anything else a browser might run.
    if (r.status !== 200 || SERVED_FILE_TYPES.indexOf(type) === -1) return badResponse('file', r.meta);
    return { ok: true, bytes: r.body, contentType: type, meta: r.meta };
  });
