import React from 'react';

const LAZY_IMPORT_RETRY_KEY = 'dreamstream_lazy_import_retry';

const isChunkLoadFailure = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('failed to fetch dynamically imported module') ||
    message.includes('importing a module script failed') ||
    message.includes('chunkloaderror') ||
    message.includes('loading chunk')
  );
};

const clearRetryFlag = () => {
  try {
    sessionStorage.removeItem(LAZY_IMPORT_RETRY_KEY);
  } catch {
    // ignore storage issues in constrained browsers
  }
};

const hasRetried = () => {
  try {
    return sessionStorage.getItem(LAZY_IMPORT_RETRY_KEY) === '1';
  } catch {
    return false;
  }
};

const markRetried = () => {
  try {
    sessionStorage.setItem(LAZY_IMPORT_RETRY_KEY, '1');
  } catch {
    // ignore storage issues in constrained browsers
  }
};

export const lazyImportWithRetry = <T extends React.ComponentType<any>>(
  importer: () => Promise<{ default: T }>
): React.LazyExoticComponent<T> =>
  React.lazy(async () => {
    try {
      const module = await importer();
      if (typeof window !== 'undefined') clearRetryFlag();
      return module;
    } catch (error) {
      if (typeof window !== 'undefined' && isChunkLoadFailure(error) && !hasRetried()) {
        markRetried();
        window.location.reload();
        return new Promise<{ default: T }>(() => {
          // Keep pending while the browser reloads.
        });
      }
      throw error;
    }
  });
