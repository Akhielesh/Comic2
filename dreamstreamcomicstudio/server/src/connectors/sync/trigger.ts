// ============================================================================
// triggerSync — enqueue (Redis) or run inline (no Redis), without blocking callers
// ============================================================================

import { enqueueSync, isConnectorQueueConfigured, type ConnectorSyncMode } from './queue.js';
import { runConnectorSyncInline } from './runner.js';

/**
 * Kick off a sync for a connection. With Redis it enqueues a (de-duped) job; without
 * Redis it runs INLINE but detached (fire-and-forget) so the HTTP request returns
 * immediately — progress is reflected via connection/sync_state status the client polls.
 */
export const triggerSync = async (
  userId: string,
  connectionId: string,
  mode: ConnectorSyncMode
): Promise<{ queued: boolean }> => {
  if (isConnectorQueueConfigured()) {
    await enqueueSync({ userId, connectionId, mode }, { dedupe: true });
    return { queued: true };
  }
  void runConnectorSyncInline(userId, connectionId, mode).catch((err) =>
    console.error('[connectors] inline sync failed', { connectionId, error: (err as Error)?.message })
  );
  return { queued: false };
};
