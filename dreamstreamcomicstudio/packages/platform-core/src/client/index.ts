/**
 * The platform client (plan §5.8): convert, extract, uploadFile, downloadFile, pdf, render, jobs.create, jobs.get,
 * plus `verifyCallback` and `jobPollUrl`. Server-side only: it holds the app secret.
 *
 * - **It never throws.** Every call resolves to `{ok: true, …}` or a `WireFailure`
 *   `{ok: false, code, message, retryable, reason, status?, requestId?}`: a network error is
 *   `{code: 'engine-failed', retryable: true}`; the gateway's 413 / 415 / 504 are `too-large` / `unsupported` /
 *   `timeout` even when an edge proxy answered them without a platform error body.
 * - **It refuses before sending** a POST without an `Idempotency-Key` and a POST that carries a body without a claim.
 * - Crypto, fetch and the clock are injected (`WireCrypto`, `FetchLike`, `WireClock`); it reads no global.
 *
 * With `strict` off (the backend), narrow a result with `r.ok === false`.
 */
import type { WireFailure } from '../wire/types.js';
import { convert } from './convert.js';
import type { ConvertInput, ConvertResult } from './convert.js';
import { extract } from './extract.js';
import type { ExtractCallResult, ExtractInput } from './extract.js';
import { downloadFile, uploadFile } from './files.js';
import type { DownloadFileInput, DownloadFileResult, UploadFileInput, UploadFileResult } from './files.js';
import { createJob, getJob, jobPollUrl } from './jobs.js';
import type { CreateJobInput, CreateJobResult, GetJobInput, GetJobResult } from './jobs.js';
import { pdf } from './pdf.js';
import type { PdfInput, PdfResult } from './pdf.js';
import { render } from './render.js';
import type { RenderInput, RenderResult } from './render.js';
import { createContext } from './request.js';
import type { PlatformClientConfig } from './request.js';

export interface PlatformClient {
  convert(input: ConvertInput): Promise<ConvertResult>;
  extract(input: ExtractInput): Promise<ExtractCallResult>;
  uploadFile(input: UploadFileInput): Promise<UploadFileResult>;
  downloadFile(input: DownloadFileInput): Promise<DownloadFileResult>;
  pdf(input: PdfInput): Promise<PdfResult>;
  render(input: RenderInput): Promise<RenderResult>;
  jobs: {
    create(input: CreateJobInput): Promise<CreateJobResult>;
    get(input: GetJobInput): Promise<GetJobResult>;
    /** The URL a browser polls with the job's poll token (null when either is malformed). */
    pollUrl(jobId: string, pollToken: string): string | null;
  };
  /** Why the config is unusable (every call then fails with `invalid`), or null. */
  readonly configError: string | null;
}

/** A client for one app key. Creating it never throws; a bad config makes every call return `invalid`. */
export const createPlatformClient = (config: PlatformClientConfig): PlatformClient => {
  const ctx = createContext(config);
  return {
    convert: (input) => convert(ctx, input),
    extract: (input) => extract(ctx, input),
    uploadFile: (input) => uploadFile(ctx, input),
    downloadFile: (input) => downloadFile(ctx, input),
    pdf: (input) => pdf(ctx, input),
    render: (input) => render(ctx, input),
    jobs: {
      create: (input) => createJob(ctx, input),
      get: (input) => getJob(ctx, input),
      pollUrl: (jobId, pollToken) => (ctx.configError === null ? jobPollUrl(ctx.origin, jobId, pollToken) : null),
    },
    configError: ctx.configError,
  };
};

/** Any client call's failure. */
export type PlatformCallFailure = WireFailure;

export type { PlatformClientConfig, ResponseMeta, SignedPost } from './request.js';
export { CONVERT_TARGET_FORMATS, isPdfBytes } from './convert.js';
export type { ConvertInput, ConvertOutputType, ConvertResult, ConvertTargetFormat } from './convert.js';
export { EXTRACT_RESULT_LIMITS, parseExtractResult } from './extract.js';
export type { ExtractCallResult, ExtractInput, ExtractResult, ExtractSection } from './extract.js';
export type { DownloadFileInput, DownloadFileResult, StagedFile, UploadFileInput, UploadFileResult } from './files.js';
export type { PdfInput, PdfJobSpec, PdfResult } from './pdf.js';
export { RENDER_KINDS, RENDER_MEDIA_TYPES } from './render.js';
export type { RenderInput, RenderKind, RenderResult } from './render.js';
export { JOB_STATES, jobPollUrl, parseJobStatus, verifyCallback } from './jobs.js';
export type {
  CallbackRequest,
  CreateJobInput,
  CreateJobResult,
  CreatedJob,
  GetJobInput,
  GetJobResult,
  JobCompletedEvent,
  JobState,
  JobStatus,
  VerifyCallbackOptions,
  VerifyCallbackResult,
} from './jobs.js';
