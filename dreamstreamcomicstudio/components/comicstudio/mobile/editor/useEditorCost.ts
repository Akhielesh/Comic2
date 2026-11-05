// How the page editor shows a price (P1-LIMITS rule, applied by P2-EDITOR): governed users never see
// dollars — a quote reads as a share of their usage ("≈2% of your usage"); admins and calls on the
// user's own key see the real price. Reads the shared allowance store (refreshed on mount and focus by
// useUsageAllowance — never on a timer), so nothing here polls the backend.

import { useCallback } from 'react';
import { costContextFromAllowance, formatCostForUser } from '../../../../services/costDisplay';
import { useUsageAllowance } from '../../../usage/useUsageAllowance';

/** `cost(usd)` → "≈2% of your usage" / "$0.07" / "Free". `usd` comes from estimateJobs (markup included unless BYOK). */
export function useEditorCost(byok: boolean): (usd: number) => string {
  const status = useUsageAllowance();
  return useCallback(
    (usd: number) => formatCostForUser(usd, costContextFromAllowance(status, { byok }), { includesMarkup: !byok }),
    [status, byok]
  );
}

export default useEditorCost;
