// Live OpenRouter key status — the REAL remaining credit + free-tier flag the project budget must
// respect. Source of truth is the server's /api/models/verify (GET /key + /credits against the
// caller's key). normalizeKeyStatus is pure (unit-tested); fetchKeyStatus does the call.

export interface KeyStatus {
  connected: boolean;
  /** A free-tier key has no paid credit → builds must use free models only. */
  isFreeTier: boolean;
  /** USD the key can still spend: the key's own limit_remaining, else account credits remaining.
   *  null = unknown / no cap. A project budget can never exceed this. */
  remainingUsd: number | null;
}

/** Pure: pull { connected, isFreeTier, remainingUsd } out of the /api/models/verify payload. */
export const normalizeKeyStatus = (verify: unknown): KeyStatus => {
  const or = (verify as any)?.sources?.openrouter;
  if (!or) return { connected: false, isFreeTier: false, remainingUsd: null };
  const liveKey = or.liveKey || {};
  const credits = or.credits || null;
  const keyRemaining = typeof liveKey.limit_remaining === 'number' ? liveKey.limit_remaining : null;
  const acctRemaining = credits && typeof credits.remaining === 'number' ? credits.remaining : null;
  return {
    connected: Boolean(or.connected),
    isFreeTier: liveKey.is_free_tier === true,
    remainingUsd: keyRemaining ?? acctRemaining
  };
};

/** Fetch the caller's live key status (free-tier + remaining credit). Never throws. apiClient is
 *  imported lazily so the pure normalizeKeyStatus stays testable without the supabase-coupled client. */
export const fetchKeyStatus = async (): Promise<KeyStatus> => {
  try {
    const { get } = await import('./apiClient');
    return normalizeKeyStatus(await get<unknown>('/api/models/verify'));
  } catch {
    return { connected: false, isFreeTier: false, remainingUsd: null };
  }
};
