/**
 * `POST /v1/render` (plan §5.9, wave 4): a RichDoc or DeckSpec rendered to DOCX, PDF or PPTX, as bytes (≤ 10 MB) or
 * `202` with a job. For attachments only: email bodies never come here (hosts render them with `renderEmail`). The
 * bytes must be the kind asked for (`PK\x03\x04` for DOCX and PPTX, `%PDF-` for PDF) with the matching media type.
 */
import { inputFailure } from '../wire/errors.js';
import type { WireFailure } from '../wire/types.js';
import { isPdfBytes } from './convert.js';
import { parseJobRef } from './jobs.js';
import type { ClientContext, ResponseMeta, SignedPost } from './request.js';
import { badResponse, guard, isRecord, jsonBody, mediaType, readJson, send } from './request.js';

export const RENDER_KINDS = ['docx', 'pdf', 'pptx'] as const;
export type RenderKind = (typeof RENDER_KINDS)[number];

/** The media type the gateway answers with for each kind. */
export const RENDER_MEDIA_TYPES: { readonly [K in RenderKind]: string } = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export interface RenderInput extends SignedPost {
  kind: RenderKind;
  /** A RichDoc (docx, pdf) or DeckSpec (pptx, pdf), validated by the gateway. */
  spec: { readonly [key: string]: unknown };
}

export type RenderResult =
  | { ok: true; kind: 'file'; bytes: Uint8Array; contentType: string; meta: ResponseMeta }
  | { ok: true; kind: 'job'; jobId: string; pollToken: string; meta: ResponseMeta }
  | WireFailure;

const isZip = (b: Uint8Array): boolean => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

export const render = (ctx: ClientContext, input: RenderInput): Promise<RenderResult> =>
  guard(async () => {
    if (!input || RENDER_KINDS.indexOf(input.kind) === -1) return inputFailure('input', 'kind must be docx, pdf or pptx');
    if (!isRecord(input.spec)) return inputFailure('input', 'spec must be a JSON object');
    const body = jsonBody({ kind: input.kind, spec: input.spec });
    if (!(body instanceof Uint8Array)) return body;
    const r = await send(ctx, { method: 'POST', path: '/v1/render', body, contentType: 'application/json', claim: input.claim, idempotencyKey: input.idempotencyKey });
    if (r.ok === false) return r;
    if (r.status === 202) {
      const ref = parseJobRef(readJson(r.body));
      return ref === null ? badResponse('job', r.meta) : { ok: true, kind: 'job', jobId: ref.jobId, pollToken: ref.pollToken, meta: r.meta };
    }
    const type = mediaType(r.contentType);
    const want = RENDER_MEDIA_TYPES[input.kind];
    const magic = input.kind === 'pdf' ? isPdfBytes(r.body) : isZip(r.body);
    if (r.status !== 200 || type !== want || !magic) return badResponse(`${input.kind} file`, r.meta);
    return { ok: true, kind: 'file', bytes: r.body, contentType: want, meta: r.meta };
  });
