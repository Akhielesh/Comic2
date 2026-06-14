import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../store.js', () => ({
  getConnection: vi.fn(),
  getSyncState: vi.fn(),
  markConnectionSynced: vi.fn(),
  setConnectionStatus: vi.fn(),
  upsertItems: vi.fn(async () => 1),
  upsertSyncState: vi.fn(),
  toConnectionRef: (r: any) => ({
    id: r.id,
    userId: r.user_id,
    connectorId: r.connector_id,
    accountIdentifier: r.account_identifier,
    grantedScopes: r.granted_scopes || [],
    metadata: r.metadata || {}
  })
}));
vi.mock('../credentials.js', () => ({
  getValidAccessToken: vi.fn(async () => 'tok'),
  markReconnectIfAuth: vi.fn()
}));
vi.mock('../registry.js', () => ({ connectorRegistry: { get: vi.fn() } }));

import { runConnectorSyncPage } from './runner.js';
import * as store from '../store.js';
import * as credentials from '../credentials.js';
import { connectorRegistry } from '../registry.js';
import { ConnectorAuthError, ConnectorRateLimitError } from '../types.js';

const row = (over: Record<string, any> = {}) => ({
  id: 'c1',
  user_id: 'u1',
  connector_id: 'gmail',
  status: 'connected',
  account_identifier: 'a@b.com',
  granted_scopes: [],
  metadata: {},
  ...over
});

const connector = (over: Record<string, any> = {}) => ({
  metadata: { id: 'gmail', capabilities: { syncable: true, searchable: true, realtime: true, apiKeyBased: false } },
  syncFull: vi.fn(async () => ({ items: [{ kind: 'document', externalId: '1' }], cursor: { pageToken: 'P2' }, hasMore: true })),
  syncIncremental: vi.fn(async () => ({ items: [{ kind: 'document', externalId: 'inc' }], cursor: { historyId: 'H2' }, hasMore: false })),
  ...over
});

beforeEach(() => {
  vi.clearAllMocks();
  (store.upsertItems as any).mockResolvedValue(1);
});

describe('runConnectorSyncPage', () => {
  it('runs a full page, persists the cursor + items, and signals more pages', async () => {
    (store.getConnection as any).mockResolvedValue(row());
    (store.getSyncState as any).mockResolvedValue(null);
    const c = connector();
    (connectorRegistry.get as any).mockReturnValue(c);

    const res = await runConnectorSyncPage('u1', 'c1', 'full');

    expect(res).toMatchObject({ status: 'ok', mode: 'full', hasMore: true, itemsSynced: 1 });
    // cursor + accumulated count persisted; status stays 'syncing' because hasMore.
    expect(store.upsertSyncState).toHaveBeenLastCalledWith(
      'c1',
      'u1',
      expect.objectContaining({ cursor: { pageToken: 'P2' }, status: 'syncing', items_synced: 1 })
    );
    expect(store.setConnectionStatus).toHaveBeenCalledWith('c1', 'connected', null);
    expect(store.markConnectionSynced).toHaveBeenCalledWith('c1');
  });

  it('resumes from the persisted cursor (idempotent/resumable)', async () => {
    (store.getConnection as any).mockResolvedValue(row());
    (store.getSyncState as any).mockResolvedValue({ cursor: { pageToken: 'P5' }, items_synced: 5, last_full_sync_at: null });
    const c = connector({
      syncFull: vi.fn(async () => ({ items: [], cursor: { historyId: 'H' }, hasMore: false }))
    });
    (connectorRegistry.get as any).mockReturnValue(c);

    await runConnectorSyncPage('u1', 'c1', 'auto');

    // The connector received the resume cursor, and the accumulated count grew from 5.
    expect(c.syncFull).toHaveBeenCalledWith(expect.objectContaining({ cursor: { pageToken: 'P5' } }));
    expect(store.upsertSyncState).toHaveBeenLastCalledWith(
      'c1',
      'u1',
      expect.objectContaining({ items_synced: 6, status: 'done' })
    );
  });

  it("auto mode runs incremental once a full sync has completed", async () => {
    (store.getConnection as any).mockResolvedValue(row());
    (store.getSyncState as any).mockResolvedValue({ cursor: { historyId: 'H' }, items_synced: 2, last_full_sync_at: '2020-01-01T00:00:00Z' });
    const c = connector();
    (connectorRegistry.get as any).mockReturnValue(c);

    const res = await runConnectorSyncPage('u1', 'c1', 'auto');
    expect(c.syncIncremental).toHaveBeenCalled();
    expect(c.syncFull).not.toHaveBeenCalled();
    expect(res.mode).toBe('incremental');
  });

  it('treats an auth error as terminal: marks reconnect, does NOT throw or retry', async () => {
    (store.getConnection as any).mockResolvedValue(row());
    (store.getSyncState as any).mockResolvedValue(null);
    const c = connector({
      syncFull: vi.fn(async () => {
        throw new ConnectorAuthError('invalid_grant', 'revoked');
      })
    });
    (connectorRegistry.get as any).mockReturnValue(c);

    const res = await runConnectorSyncPage('u1', 'c1', 'full');
    expect(res.status).toBe('reconnect');
    expect(credentials.markReconnectIfAuth).toHaveBeenCalled();
    expect(store.upsertSyncState).toHaveBeenLastCalledWith('c1', 'u1', expect.objectContaining({ status: 'error' }));
  });

  it('rethrows a rate-limit error so the queue retries with backoff', async () => {
    (store.getConnection as any).mockResolvedValue(row());
    (store.getSyncState as any).mockResolvedValue(null);
    const c = connector({
      syncFull: vi.fn(async () => {
        throw new ConnectorRateLimitError('429');
      })
    });
    (connectorRegistry.get as any).mockReturnValue(c);

    await expect(runConnectorSyncPage('u1', 'c1', 'full')).rejects.toBeInstanceOf(ConnectorRateLimitError);
    expect(store.setConnectionStatus).toHaveBeenCalledWith('c1', 'error', expect.any(String));
  });

  it('skips a non-syncable connector (query-on-demand)', async () => {
    (store.getConnection as any).mockResolvedValue(row({ connector_id: 'google_maps' }));
    (connectorRegistry.get as any).mockReturnValue(
      connector({ metadata: { id: 'google_maps', capabilities: { syncable: false, searchable: true, realtime: false, apiKeyBased: true } } })
    );
    const res = await runConnectorSyncPage('u1', 'c1', 'full');
    expect(res.status).toBe('skipped');
  });

  it('returns not_found for a missing or non-owned connection', async () => {
    (store.getConnection as any).mockResolvedValue(null);
    expect((await runConnectorSyncPage('u1', 'c1', 'full')).status).toBe('not_found');

    (store.getConnection as any).mockResolvedValue(row({ user_id: 'someone-else' }));
    expect((await runConnectorSyncPage('u1', 'c1', 'full')).status).toBe('not_found');
  });
});
