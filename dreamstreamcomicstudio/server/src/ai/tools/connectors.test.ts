import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../connectors/index.js', () => ({ connectorRegistry: { get: vi.fn() } }));
vi.mock('../../connectors/store.js', () => ({
  getActiveConnection: vi.fn(),
  toConnectionRef: (r: any) => ({
    id: r.id,
    userId: r.user_id,
    connectorId: r.connector_id,
    accountIdentifier: r.account_identifier,
    grantedScopes: [],
    metadata: {}
  })
}));
vi.mock('../../connectors/credentials.js', () => ({ getValidAccessToken: vi.fn(async () => 'tok') }));
vi.mock('../../connectors/retrieval.js', () => ({ retrieveItems: vi.fn() }));

import { CONNECTOR_TOOL_NAMES, buildConnectorTool } from './connectors.js';
import { connectorRegistry } from '../../connectors/index.js';
import * as store from '../../connectors/store.js';
import * as retrieval from '../../connectors/retrieval.js';
import { ConnectorAuthError } from '../../connectors/types.js';

const row = { id: 'c1', user_id: 'u1', connector_id: 'gmail', status: 'connected', account_identifier: 'a@b.com', granted_scopes: [], metadata: {} };
const okConnector = (items: any[]) => ({
  metadata: { capabilities: { syncable: true } },
  fetch: vi.fn(async () => ({ items }))
});

beforeEach(() => vi.clearAllMocks());

describe('connector AI tools', () => {
  it('registers the expected per-user tools', () => {
    expect(CONNECTOR_TOOL_NAMES).toEqual(
      expect.arrayContaining(['gmail_search', 'drive_search', 'calendar_agenda', 'sheets_read', 'maps_lookup', 'connected_data_search'])
    );
    expect(buildConnectorTool('does_not_exist')).toBeNull();
    for (const n of CONNECTOR_TOOL_NAMES) {
      const t = buildConnectorTool(n, { userId: 'u1' });
      expect(t?.name).toBe(n);
      expect(typeof t?.execute).toBe('function');
    }
  });

  it('tells the model to sign in when there is no user on the turn', async () => {
    const res = await buildConnectorTool('gmail_search')!.execute({ query: 'hi' });
    expect(res.notice?.level).toBe('info');
    expect(res.content).toMatch(/no user is signed in/i);
  });

  it('prompts to connect when the user has no Gmail connection', async () => {
    (store.getActiveConnection as any).mockResolvedValue(null);
    (connectorRegistry.get as any).mockReturnValue(okConnector([]));
    const res = await buildConnectorTool('gmail_search', { userId: 'u1' })!.execute({ query: 'hi' });
    expect(res.content).toMatch(/connect Gmail/i);
  });

  it('formats Gmail results with citations, scoped to the user', async () => {
    (store.getActiveConnection as any).mockResolvedValue(row);
    const connector = okConnector([
      { kind: 'document', externalId: 'm1', title: 'Invoice', snippet: 'due friday', url: 'https://mail/m1', occurredAt: '2026-01-02T00:00:00Z' }
    ]);
    (connectorRegistry.get as any).mockReturnValue(connector);

    const res = await buildConnectorTool('gmail_search', { userId: 'u1' })!.execute({ query: 'invoice' });
    expect(res.content).toMatch(/Invoice/);
    expect(res.citations?.[0]?.url).toBe('https://mail/m1');
    // Scoped: looked up the signed-in user's connection.
    expect(store.getActiveConnection).toHaveBeenCalledWith('u1', 'gmail');
  });

  it('maps a revoked token to a reconnect prompt', async () => {
    (store.getActiveConnection as any).mockResolvedValue(row);
    (connectorRegistry.get as any).mockReturnValue({
      metadata: { capabilities: {} },
      fetch: vi.fn(async () => {
        throw new ConnectorAuthError('unauthorized', 'revoked');
      })
    });
    const res = await buildConnectorTool('drive_search', { userId: 'u1' })!.execute({ query: 'x' });
    expect(res.notice?.level).toBe('warn');
    expect(res.content).toMatch(/reconnect/i);
  });

  it('connected_data_search runs a scoped RAG query over synced items', async () => {
    (retrieval.retrieveItems as any).mockResolvedValue([
      { title: 'Doc A', snippet: 'about widgets', url: 'https://x/a', author: null, occurred_at: '2026-01-01T00:00:00Z', connector_id: 'google_drive', kind: 'document' }
    ]);
    const res = await buildConnectorTool('connected_data_search', { userId: 'u1' })!.execute({ query: 'widgets' });
    expect(retrieval.retrieveItems).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', query: 'widgets' }));
    expect(res.content).toMatch(/Doc A/);
    expect(res.citations?.[0]?.url).toBe('https://x/a');
  });
});
