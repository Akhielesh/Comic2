import { REPORT_LIMITS, type FeedbackReportInput, type FeedbackReportReceipt } from '../shared/feedbackReports';
import { buildApiUrl } from './clientConfig';

export interface PreparedScreenshot {
  name: string;
  image: string;
  mime: string;
}
export async function prepareReportScreenshot(file: File): Promise<PreparedScreenshot> {
  if (!file.size || file.size > REPORT_LIMITS.originalBytes) throw new Error('Choose a screenshot under 10 MiB.');
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const match = (start: number, expected: number[]) => expected.every((n, i) => bytes[start + i] === n);
  if (
    !(
      match(0, [255, 216, 255]) ||
      match(0, [137, 80, 78, 71, 13, 10, 26, 10]) ||
      (match(0, [82, 73, 70, 70]) && match(8, [87, 69, 66, 80]))
    )
  ) {
    throw new Error('Choose a PNG, JPEG or WebP screenshot.');
  }
  const { decodeRasterFile, encodeRasterFile } = await import('../components/comicstudio/refs/downscale');
  const input = await decodeRasterFile(file).catch(() => {
    throw new Error('This image could not be opened.');
  });
  try {
    if (!input.width || !input.height || input.width * input.height > REPORT_LIMITS.maxPixels)
      throw new Error('Choose a screenshot of up to 16 megapixels.');
    for (const [edge, quality] of [
      [REPORT_LIMITS.maxEdge, 0.88],
      [1600, 0.78],
      [1280, 0.67]
    ]) {
      const fit = Math.min(1, edge / Math.max(input.width, input.height));
      const w = Math.max(1, Math.round(input.width * fit)),
        h = Math.max(1, Math.round(input.height * fit));
      const blob =
        (await encodeRasterFile(input, w, h, 'image/webp', quality)) ??
        (await encodeRasterFile(input, w, h, 'image/jpeg', quality));
      if (!blob || blob.size > REPORT_LIMITS.uploadBytes) continue;
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('This screenshot could not be read.'));
        reader.readAsDataURL(blob);
      });
      return { name: file.name, image: data, mime: blob.type };
    }
    throw new Error('Crop this screenshot or choose a smaller image.');
  } finally {
    input.close?.();
  }
}

export async function sendFeedbackReport(
  input: FeedbackReportInput,
  ownerId: string | undefined,
  signal: AbortSignal
): Promise<FeedbackReportReceipt> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ownerId) {
    const { ownerBearer } = await import('./accountProviderUsage');
    try {
      headers.Authorization = await ownerBearer(ownerId, signal);
    } catch {
      throw new Error('Please sign in again to send this report.');
    }
  }
  let response: Response;
  try {
    response = await fetch(buildApiUrl('/api/telemetry/reports'), {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
      cache: 'no-store',
      redirect: 'error',
      signal
    });
  } catch {
    throw new Error('Could not confirm delivery. Your report is still here. Retry to check or submit it.');
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || typeof payload?.id !== 'string') {
    const message = payload?.error?.message;
    throw new Error(
      response.status >= 400 && response.status < 500 && typeof message === 'string'
        ? message
        : 'Your report could not be saved yet. Please retry.'
    );
  }
  return { id: payload.id };
}
