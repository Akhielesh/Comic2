import { createContext, useContext } from 'react';

// Live-data context provided by LiveArtifact (ChatArtifacts.tsx) to the card it
// wraps. Cards can show fresher data without a model round-trip:
//
//   const live = useLiveData();
//   if (live.canRefresh) live.refresh();            // same call, fresh data
//   live.refresh({ topic: 'business' });            // patch args (news topic chips)
//
// Outside a chat message (gallery, panels) the default no-op context applies.

export interface LiveDataApi {
  /** True when this widget knows the tool call that produced it. */
  canRefresh: boolean;
  /** A refresh is in flight. */
  refreshing: boolean;
  /** ISO timestamp of the last successful refresh, if any. */
  asOf?: string;
  /** Re-run the producing tool call, optionally patching its arguments. */
  refresh: (argsPatch?: Record<string, unknown>) => Promise<void>;
}

const NOOP: LiveDataApi = {
  canRefresh: false,
  refreshing: false,
  refresh: async () => undefined
};

export const LiveDataContext = createContext<LiveDataApi>(NOOP);

export const useLiveData = (): LiveDataApi => useContext(LiveDataContext);
