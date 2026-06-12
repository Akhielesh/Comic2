// Monthly model-choice trends — aggregated request counts per month/product/source/model.
// Counts are platform-wide aggregates only; nothing here is tied to an individual user.
//
// Backend contract (parallel workstream; may not exist yet — resolves to `null` on
// 404/error so panels can degrade gracefully):
//   GET /api/models/usage-monthly?months=6
//     → { rows: [{ month: 'YYYY-MM', product, source, model, requests }] }

import { get } from './apiClient';

export interface ModelUsageRow {
  /** 'YYYY-MM'. */
  month: string;
  product: string;
  source: string;
  model: string;
  requests: number;
}

const asNumber = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Monthly usage rows, or null when the endpoint is missing/erroring. */
export const fetchModelUsageMonthly = async (
  months = 6,
  options?: { signal?: AbortSignal }
): Promise<ModelUsageRow[] | null> => {
  try {
    const raw = await get<{ rows?: unknown[] }>(`/api/models/usage-monthly?months=${months}`, options);
    if (!raw || !Array.isArray(raw.rows)) return null;
    return raw.rows
      .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
      .filter((r) => typeof r.month === 'string' && r.month.length > 0)
      .map((r) => ({
        month: r.month as string,
        product: asString(r.product),
        source: asString(r.source),
        model: asString(r.model),
        requests: Math.max(0, asNumber(r.requests))
      }));
  } catch {
    return null;
  }
};
