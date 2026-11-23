import { createHash, createHmac } from 'node:crypto';
import sharp from 'sharp';
import { FEEDBACK_CATEGORIES } from '../../../apiTypes.js';
import { REPORT_LIMITS, type FeedbackReportInput } from '../../../shared/feedbackReports.js';
import { sniffImageType } from './sharpGuard.js';
import { getSupabaseAdmin, getSupabaseCapabilityStatus } from './supabase.js';

export class ReportError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}
export const REPORT_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const bad = (message: string): never => {
  throw new ReportError(400, message);
};
const unavailable = () => new ReportError(503, 'Your report could not be saved yet. Please try again.');
const allowedFormats = new Set(['jpeg', 'png', 'webp']);
const sentiments = new Set(['positive', 'neutral', 'negative', 'frustrated']);
let imageJobs = 0;

export function parseReport(raw: unknown): FeedbackReportInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('Enter a report.');
  const f = raw as Record<string, unknown>;
  if (typeof f.submissionId !== 'string' || !REPORT_UUID.test(f.submissionId)) return bad('Start a new report.');
  if (f.kind !== 'bug' && f.kind !== 'feedback') return bad('Choose a report type.');
  if (typeof f.comment !== 'string' || f.comment.length > REPORT_LIMITS.comment)
    return bad('Use up to 4,000 characters.');
  if (f.category !== undefined && !(FEEDBACK_CATEGORIES as readonly unknown[]).includes(f.category))
    return bad('Choose a feedback category.');
  if (f.sentiment !== undefined && !sentiments.has(String(f.sentiment))) return bad('Choose a feedback rating.');
  if (f.surface !== undefined && (typeof f.surface !== 'string' || !/^[a-z][a-z0-9 _-]{0,79}$/i.test(f.surface)))
    return bad('Choose a valid app area.');
  if (!Array.isArray(f.images) || f.images.length > REPORT_LIMITS.images)
    return bad('Attach up to 10 screenshots.');
  const maxEncodedSize = Math.ceil(REPORT_LIMITS.uploadBytes / 3) * 4;
  for (const image of f.images) {
    if (
      typeof image !== 'string' ||
      !image.length ||
      image.length > maxEncodedSize ||
      image.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(image)
    ) {
      return bad('Choose a smaller PNG, JPEG or WebP screenshot.');
    }
  }
  const comment = f.comment.trim();
  if (f.kind === 'bug' && !comment) return bad('Describe what happened.');
  if (!comment && !f.images.length && !f.category && !f.sentiment) return bad('Add feedback before sending.');
  return {
    submissionId: f.submissionId,
    kind: f.kind,
    comment,
    category: f.category as string | undefined,
    sentiment: f.sentiment as FeedbackReportInput['sentiment'],
    surface: f.surface as string | undefined,
    images: f.images as string[]
  };
}

async function normalizeImage(encoded: string): Promise<string> {
  const input = Buffer.from(encoded, 'base64');
  if (input.length > REPORT_LIMITS.uploadBytes || !allowedFormats.has(sniffImageType(input)))
    return bad('Choose a PNG, JPEG or WebP screenshot.');
  try {
    const options = { limitInputPixels: REPORT_LIMITS.maxPixels, failOn: 'error' as const, pages: 1 };
    const metadata = await sharp(input, options).metadata();
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > REPORT_LIMITS.maxPixels ||
      (metadata.pages ?? 1) > 1
    )
      return bad('Use a still screenshot of up to 16 megapixels.');
    for (const [edge, quality] of [
      [REPORT_LIMITS.maxEdge, 84],
      [1600, 72],
      [1280, 62]
    ]) {
      const bytes = await sharp(input, options)
        .rotate()
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .webp({ quality, effort: 3 })
        .toBuffer();
      if (bytes.length <= REPORT_LIMITS.storedBytes) return bytes.toString('base64');
    }
    return bad('Crop this screenshot or choose a smaller image.');
  } catch (err) {
    if (err instanceof ReportError) throw err;
    return bad('This screenshot could not be decoded. Choose another PNG, JPEG or WebP.');
  }
}

export async function saveFeedbackReport(raw: unknown, owner: string | null, ip: string) {
  const report = parseReport(raw);
  if (!getSupabaseCapabilityStatus().storagePersistenceEnabled || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    throw unavailable();
  const withFiles = report.images.length > 0;
  if (withFiles && imageJobs >= 2) throw new ReportError(503, 'Screenshot processing is busy. Please try again.');
  if (withFiles) imageJobs++;
  try {
    const digest = createHash('sha256').update(JSON.stringify(report)).digest('hex');
    const images: string[] = [];
    for (const image of report.images) images.push(await normalizeImage(image));
    const quotaKey = createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY)
      .update('feedback-quota-v1:' + (owner ? 'member:' + owner : 'guest:' + ip))
      .digest('hex');
    const storageLimit = Number(process.env.FEEDBACK_IMAGE_STORAGE_LIMIT_BYTES || 1024 * 1024 * 1024);
    const { data, error } = await getSupabaseAdmin().rpc('submit_feedback_report', {
      p_submission: report.submissionId,
      p_digest: digest,
      p_quota_key: quotaKey,
      p_owner: owner,
      p_kind: report.kind,
      p_comment: report.comment,
      p_category: report.category ?? null,
      p_sentiment: report.sentiment ?? null,
      p_surface: report.surface ?? null,
      p_images: images,
      p_storage_limit: Number.isSafeInteger(storageLimit) && storageLimit >= 0 ? storageLimit : 1024 * 1024 * 1024
    });
    if (error?.code === 'P0002')
      throw new ReportError(409, 'This submission changed. Close this form to start a new report.');
    if (error?.code === 'P0003')
      throw new ReportError(
        429,
        'Attachment storage is at its limit. Keep your screenshots and retry later, or remove them to send the text now.'
      );
    if (error || typeof data !== 'string' || !REPORT_UUID.test(data)) throw unavailable();
    return { id: data };
  } catch (error) {
    if (error instanceof ReportError) throw error;
    throw unavailable();
  } finally {
    if (withFiles) imageJobs--;
  }
}

export async function readFeedbackScreenshot(id: string, position: number) {
  if (!REPORT_UUID.test(id) || !Number.isInteger(position) || position < 1 || position > REPORT_LIMITS.images)
    throw new ReportError(404, 'Screenshot not found.');
  const { data, error } = await getSupabaseAdmin()
    .from('feedback_report_images')
    .select('webp')
    .eq('report_id', id)
    .eq('position', position)
    .maybeSingle();
  if (error) throw unavailable();
  if (!data || typeof data.webp !== 'string' || !/^\\x[\da-f]+$/i.test(data.webp))
    throw new ReportError(404, 'Screenshot not found.');
  return Buffer.from(data.webp.slice(2), 'hex');
}
