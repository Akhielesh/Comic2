// ============================================================================
// Sync runner — idempotent, resumable, one page per call
// ============================================================================
//
// runConnectorSyncPage runs ONE page of a connection's sync and persists the cursor,
// so a crash/retry resumes exactly where it left off (the item upsert is idempotent
// on connection_id+kind+external_id). The worker re-enqueues a follow-up while
// hasMore; the inline path (no Redis) loops a bounded number of pages itself.
//
// Auth failures are terminal (mark the connection "reconnect", don't retry); rate
// limits + transient errors are rethrown so BullMQ retries with backoff.
// ============================================================================

import { ConnectorAuthError, ConnectorRateLimitError, type SyncContext } from '../types.js';
import { connectorRegistry } from '../registry.js';
import { getValidAccessToken, markReconnectIfAuth } from '../credentials.js';
import { CONNECTORS_SYNC_PAGE_SIZE } from '../../config.js';
import {
  getConnection,
  getSyncState,
  markConnectionSynced,
  setConnectionStatus,
  toConnectionRef,
  upsertItems,
  upsertSyncState,
  type ConnectionRow
} from '../store.js';
import type { ConnectorSyncMode } from './queue.js';
import { logPageStart, logPageDone, logReconnect, logError, logRunStart, logRunEnd, type RunOutcome } from './syncLog.js';

export interface SyncPageResult {
  status: 'ok' | 'reconnect' | 'skipped' | 'not_found';
  mode: 'full' | 'incremental';
  hasMore: boolean;
  itemsSynced: number;
}

const resolveMode = (mode: ConnectorSyncMode, sync: { last_full_sync_at: string | null } | null): 'full' | 'incremental' => {
  if (mode === 'full') return 'full';
  if (mode === 'incremental') return 'incremental';
  // 'auto' → first sync is full, thereafter incremental.
  return sync?.last_full_sync_at ? 'incremental' : 'full';
};

export const runConnectorSyncPage = async (
  userId: string,
  connectionId: string,
  mode: ConnectorSyncMode
): Promise<SyncPageResult> => {
  const connection = await getConnection(connectionId);
  if (!connection || connection.user_id !== userId) {
    return { status: 'not_found', mode: 'incremental', hasMore: false, itemsSynced: 0 };
  }

  const connector = connectorRegistry.get(connection.connector_id);
  if (!connector || !connector.metadata.capabilities.syncable) {
    // e.g. Google Maps — query-on-demand, nothing to sync.
    return { status: 'skipped', mode: 'incremental', hasMore: false, itemsSynced: 0 };
  }

  const syncState = await getSyncState(connectionId);
  const effectiveMode = resolveMode(mode, syncState);
  const cursor = (syncState?.cursor as Record<string, unknown>) || {};

  const startedAt = Date.now();
  const tag = { connectorId: connection.connector_id, account: connection.account_identifier, connectionId, mode: effectiveMode };
  logPageStart({ ...tag, cursorIn: cursor });

  await upsertSyncState(connectionId, userId, { status: 'syncing', last_error: null });
  if (connection.status === 'connected' || connection.status === 'error') {
    await setConnectionStatus(connectionId, 'syncing');
  }

  const ctx: SyncContext = {
    connection: toConnectionRef(connection),
    getAccessToken: () => getValidAccessToken(connection, connector),
    cursor,
    limit: CONNECTORS_SYNC_PAGE_SIZE
  };

  try {
    const result = effectiveMode === 'full' ? await connector.syncFull(ctx) : await connector.syncIncremental(ctx);
    const written = await upsertItems(userId, ctx.connection, result.items);

    const itemsSynced = (syncState?.items_synced || 0) + written;
    const nowIso = new Date().toISOString();
    await upsertSyncState(connectionId, userId, {
      cursor: result.cursor,
      status: result.hasMore ? 'syncing' : 'done',
      last_sync_at: nowIso,
      last_error: null,
      items_synced: itemsSynced,
      ...(effectiveMode === 'full' && !result.hasMore ? { last_full_sync_at: nowIso } : {})
    });

    await markConnectionSynced(connectionId);
    await setConnectionStatus(connectionId, 'connected', null);

    logPageDone({
      ...tag,
      items: result.items,
      written,
      hasMore: result.hasMore,
      cursorOut: result.cursor,
      total: itemsSynced,
      ms: Date.now() - startedAt
    });

    return { status: 'ok', mode: effectiveMode, hasMore: result.hasMore, itemsSynced: written };
  } catch (err) {
    if (err instanceof ConnectorAuthError) {
      // Terminal until the user reconnects — mark + DON'T retry.
      await markReconnectIfAuth(connection, err);
      await upsertSyncState(connectionId, userId, { status: 'error', last_error: err.message });
      logReconnect({ ...tag, message: err.message });
      return { status: 'reconnect', mode: effectiveMode, hasMore: false, itemsSynced: 0 };
    }
    // Rate limit / transient → record + rethrow so the queue retries with backoff.
    const message = err instanceof ConnectorRateLimitError ? `rate limited: ${err.message}` : (err as Error)?.message || 'sync failed';
    await upsertSyncState(connectionId, userId, { status: 'error', last_error: message });
    await setConnectionStatus(connectionId, 'error', message);
    logError({ ...tag, message, willRetry: true });
    throw err;
  }
};

/**
 * Run a connection's sync to completion INLINE (no queue), bounded by maxPages so a
 * huge mailbox can't block the request thread forever — the rest continues on the
 * next sync. Used when REDIS_URL is unset.
 */
export const runConnectorSyncInline = async (
  userId: string,
  connectionId: string,
  mode: ConnectorSyncMode,
  maxPages = 8
): Promise<{ itemsSynced: number; pages: number; status: SyncPageResult['status'] }> => {
  const startedAt = Date.now();
  logRunStart({ connectionId, mode, maxPages });

  let total = 0;
  let pages = 0;
  let nextMode: ConnectorSyncMode = mode;
  let status: SyncPageResult['status'] = 'ok';
  let lastHasMore = false;
  try {
    for (; pages < maxPages; ) {
      const r = await runConnectorSyncPage(userId, connectionId, nextMode);
      pages++;
      total += r.itemsSynced;
      lastHasMore = r.status === 'ok' && r.hasMore;
      if (r.status !== 'ok') {
        status = r.status;
        break;
      }
      if (!r.hasMore) break;
      // Continue the SAME sync run (full pagination stays full).
      nextMode = r.mode;
    }
  } catch (err) {
    // A transient/rate-limit page error propagates (triggerSync's caller handles it) — but
    // log the run end so the inline path isn't silent on failure.
    logRunEnd({ connectionId, mode, outcome: 'error', pages, total, ms: Date.now() - startedAt, note: (err as Error)?.message });
    throw err;
  }

  // 'capped' = the page budget ran out while more remained: only part of the account was
  // ingested this run, and sync_state stays 'syncing' until the next sync continues it.
  const outcome: RunOutcome = status !== 'ok' ? (status as RunOutcome) : lastHasMore && pages >= maxPages ? 'capped' : 'drained';
  logRunEnd({ connectionId, mode, outcome, pages, total, ms: Date.now() - startedAt });
  return { itemsSynced: total, pages, status };
};
