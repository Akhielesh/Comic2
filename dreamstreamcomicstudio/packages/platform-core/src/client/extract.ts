/**
 * `POST /v1/extract` (plan §5.9): raw bytes (DOCX, PDF) in, text and sections out. `?maxPages=` is signed (default
 * 24, at most 300). Extracted text is untrusted data: spotlight it, never follow instructions in it.
 */
import { isBytes } from '../wire/bytes.js';
import { inputFailure } from '../wire/errors.js';
import type { WireFailure } from '../wire/types.js';
import { WIRE_LIMITS } from '../wire/types.js';
import type { ClientContext, ResponseMeta, SignedPost } from './request.js';
import { badResponse, guard, isRecord, isText, isWhole, readJson, send } from './request.js';

export interface ExtractInput extends SignedPost {
  bytes: Uint8Array;
  contentType: string;
  /** Pages to read from a PDF (1 to 300); the gateway's default is 24. */
  maxPages?: number;
}

export interface ExtractSection {
  id: string;
  title: string;
  kind: string;
  content: string;
  pageNumber?: number;
}

/** The field names match the consumer-side `RenderingResult` (plan §5.9). */
export interface ExtractResult {
  plainText: string;
  sections: ExtractSection[];
  pageCount: number;
  truncated: boolean;
  engine: string;
}

export type ExtractCallResult = { ok: true; result: ExtractResult; meta: ResponseMeta } | WireFailure;

/** Caps on an extract answer (the client refuses a bigger one as malformed). */
export const EXTRACT_RESULT_LIMITS = {
  plainText: 20000000,
  sections: 10000,
  sectionId: 128,
  sectionTitle: 2000,
  sectionKind: 64,
  sectionContent: 5000000,
  pages: 100000,
  engine: 128,
} as const;

/** The answer, checked for shape and caps; null when it is not an extract result. */
export const parseExtractResult = (value: unknown): ExtractResult | null => {
  const L = EXTRACT_RESULT_LIMITS;
  if (!isRecord(value)) return null;
  if (!isText(value.plainText, L.plainText) || !isWhole(value.pageCount, 0, L.pages) || typeof value.truncated !== 'boolean' || !isText(value.engine, L.engine)) return null;
  if (!Array.isArray(value.sections) || value.sections.length > L.sections) return null;
  const sections: ExtractSection[] = [];
  for (let i = 0; i < value.sections.length; i++) {
    const s = value.sections[i];
    if (!isRecord(s) || !isText(s.id, L.sectionId) || !isText(s.title, L.sectionTitle) || !isText(s.kind, L.sectionKind) || !isText(s.content, L.sectionContent)) return null;
    const section: ExtractSection = { id: s.id, title: s.title, kind: s.kind, content: s.content };
    if (s.pageNumber !== undefined) {
      if (!isWhole(s.pageNumber, 1, L.pages)) return null;
      section.pageNumber = s.pageNumber;
    }
    sections.push(section);
  }
  return { plainText: value.plainText, sections, pageCount: value.pageCount, truncated: value.truncated, engine: value.engine };
};

export const extract = (ctx: ClientContext, input: ExtractInput): Promise<ExtractCallResult> =>
  guard(async () => {
    if (!input || !isBytes(input.bytes) || !input.bytes.length) return inputFailure('input', 'extract needs the file bytes');
    if (input.maxPages !== undefined && !isWhole(input.maxPages, 1, WIRE_LIMITS.extractMaxPages)) {
      return inputFailure('input', `maxPages must be a whole number from 1 to ${WIRE_LIMITS.extractMaxPages}`);
    }
    const r = await send(ctx, {
      method: 'POST',
      path: '/v1/extract',
      query: input.maxPages === undefined ? undefined : { maxPages: input.maxPages },
      body: input.bytes,
      contentType: input.contentType,
      claim: input.claim,
      idempotencyKey: input.idempotencyKey,
    });
    if (r.ok === false) return r;
    const result = r.status === 200 ? parseExtractResult(readJson(r.body)) : null;
    if (result === null) return badResponse('extract result', r.meta);
    return { ok: true, result, meta: r.meta };
  });
