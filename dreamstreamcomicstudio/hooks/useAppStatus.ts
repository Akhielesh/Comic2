import { useSyncExternalStore } from 'react';
import { appStatus, type StatusSnapshot } from '../services/appStatus';

// Subscribe React to the global app status store. Returns the current snapshot (events +
// in-flight activity), re-rendering only when it actually changes.
export const useAppStatus = (): StatusSnapshot =>
  useSyncExternalStore(appStatus.subscribe, appStatus.getSnapshot, appStatus.getSnapshot);
