// Which comics have live Director work in this tab (liveturn LT-2): a message or action stream that a studio started
// and that is still open, whether or not the studio is on screen. Read from the module-scope registry
// (live/studioStreams.ts) with useSyncExternalStore: no request, no timer. The comic sidebar (LT-14) marks those rows
// "Thinking…" without a read of its own.

import { useMemo, useSyncExternalStore } from 'react';
import { subscribeStudioStreams, workingKeys } from './studioStreams';

const EMPTY: ReadonlySet<string> = new Set();

/** The ids of this account's comics with live work in this tab (the same Set while nothing changes). */
export const workingProjectIds = (keys: ReadonlySet<string>, accountId: string | null | undefined): ReadonlySet<string> => {
  if (!keys.size) return EMPTY;
  const prefix = `${(accountId || '').toLowerCase()}:`;
  const ids = new Set<string>();
  for (const key of keys) if (key.startsWith(prefix)) ids.add(key.slice(prefix.length));
  return ids.size ? ids : EMPTY;
};

export function useStudioWorking(accountId: string | null | undefined): ReadonlySet<string> {
  const keys = useSyncExternalStore(subscribeStudioStreams, workingKeys, workingKeys);
  return useMemo(() => workingProjectIds(keys, accountId), [keys, accountId]);
}
