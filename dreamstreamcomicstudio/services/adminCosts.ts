// Admin-only client for the cost centre endpoint (GET /api/admin/costs).
// The response type is shared with the server aggregator (server/src/services/costCentre.ts).

import { get } from './apiClient';
import type { CostCentreReport, CostRangeDays } from '../shared/types/costCentre';

export type { CostCentreReport, CostRangeDays } from '../shared/types/costCentre';

export const getCostCentre = (days: CostRangeDays, options: { fresh?: boolean; signal?: AbortSignal } = {}): Promise<CostCentreReport> =>
  get<CostCentreReport>(`/api/admin/costs?days=${days}${options.fresh ? '&fresh=1' : ''}`, { signal: options.signal });
