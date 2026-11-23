import { useCallback, useEffect, useRef, useState } from 'react';
import {
  readingSettings,
  type ReadingSettingAction,
  type SyncedReadingState
} from '../services/libraryReadingSync';

interface AccountProgress {
  owner: string;
  data?: SyncedReadingState;
  working: boolean;
  error?: string;
}

export function useLibraryReadingProgress(owner: string | null) {
  const [view, setView] = useState<AccountProgress>();
  const requestId = useRef(0);
  const mutating = useRef(false);
  const current = view?.owner === owner ? view : undefined;

  const run = useCallback(
    async (action: ReadingSettingAction = 'get', epoch: string | null = null) => {
      if (!owner || mutating.current) return;
      const id = ++requestId.current;
      mutating.current = action !== 'get';
      setView((previous) => ({
        owner,
        data: previous?.owner === owner ? previous.data : undefined,
        working: true
      }));
      try {
        const data = await readingSettings(owner, action, epoch);
        if (id === requestId.current) setView({ owner, data, working: false });
      } catch {
        if (id === requestId.current) {
          setView({
            owner,
            working: false,
            error:
              action === 'get'
                ? 'Your synced progress is unavailable. You can still read any public comic.'
                : 'Your change could not be confirmed. Refresh your progress and try again.'
          });
        }
      } finally {
        if (id === requestId.current) mutating.current = false;
      }
    },
    [owner]
  );

  useEffect(() => {
    if (!owner) return;
    void run();
    const reload = () => {
      if (!document.hidden) void run();
    };
    const pageShown = (event: PageTransitionEvent) => {
      if (event.persisted) reload();
    };
    window.addEventListener('pageshow', pageShown);
    document.addEventListener('visibilitychange', reload);
    return () => {
      requestId.current++;
      mutating.current = false;
      window.removeEventListener('pageshow', pageShown);
      document.removeEventListener('visibilitychange', reload);
    };
  }, [owner, run]);

  return { current, run };
}
