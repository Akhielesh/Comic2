import { del, post } from './apiClient';
import { getAccountKeyMeta, getActiveKeyValue, setAccountKeyMeta, type ApiKeyProvider } from './apiKeys';
import { isLocalOwner } from './localOwner';

export type ProviderMirrorResult = 'synced' | 'failed' | 'skipped';

const pending = new Map<string, Promise<ProviderMirrorResult>>();

/**
 * Mirror the active device key to the account. Serialize writes per account and provider so a
 * slower activation cannot overwrite a later deletion or activation on the same device.
 */
export const reconcileProviderMirror = (userId: string, provider: ApiKeyProvider): Promise<ProviderMirrorResult> => {
  const id = `${userId}:${provider}`;
  const update = async (): Promise<ProviderMirrorResult> => {
    if (!isLocalOwner(userId)) return 'skipped';
    const active = getActiveKeyValue(provider);
    try {
      if (active) {
        const result = await post<{ provider: ApiKeyProvider; key: string }, { persisted?: boolean }>(
          '/api/account/byok',
          { provider, key: active },
          { expectedAccountId: userId }
        );
        if (result?.persisted !== true) return 'failed';
      } else {
        const result = await del<{ ok?: boolean }>(`/api/account/byok/${encodeURIComponent(provider)}`, { expectedAccountId: userId });
        if (result?.ok !== true) return 'failed';
      }
      if (isLocalOwner(userId)) {
        const metadata = getAccountKeyMeta().filter((entry) => entry.provider !== provider);
        if (active) metadata.push({ provider, suffix: active.slice(-4) });
        setAccountKeyMeta(metadata);
      }
      return 'synced';
    } catch {
      return 'failed';
    }
  };
  const previous = pending.get(id);
  const next = previous ? previous.then(update) : update();
  pending.set(id, next);
  void next.then(() => {
    if (pending.get(id) === next) pending.delete(id);
  });
  return next;
};
