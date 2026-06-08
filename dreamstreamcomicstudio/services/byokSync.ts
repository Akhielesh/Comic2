// Best-effort cloud sync of BYOK provider keys. Posts the key to the server, which
// encrypts it with a server-only secret before storing (replaces the old client-side
// encryption whose secret shipped in the bundle). Never throws — the local key store
// (services/apiKeys) remains the source of truth, so a failed sync doesn't break BYOK.

import { post, del } from './apiClient';

export const syncByokKeyToServer = async (provider: string, key: string): Promise<void> => {
  try {
    await post('/api/account/byok', { provider, key });
  } catch {
    /* best-effort mirror — local storage already holds the key */
  }
};

export const removeByokKeyFromServer = async (provider: string): Promise<void> => {
  try {
    await del(`/api/account/byok/${encodeURIComponent(provider)}`);
  } catch {
    /* best-effort */
  }
};
