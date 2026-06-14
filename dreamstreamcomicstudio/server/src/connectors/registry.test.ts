import { describe, it, expect } from 'vitest';
import { ConnectorRegistry } from './registry.js';
import type {
  AccountConnector,
  ConnectorMetadata,
  FetchInput,
  InitiateAuthInput,
  NormalizedItem,
  SyncContext,
  SyncResult,
  TokenSet
} from './types.js';

// A self-contained "dummy" connector implemented ONLY against the public interface —
// no edits to core routing/schema/sync. Proving it registers, lists, and runs its
// lifecycle through the registry is the extensibility proof.
class DummyConnector implements AccountConnector {
  readonly metadata: ConnectorMetadata = {
    id: 'dummy_source',
    displayName: 'Dummy Source',
    description: 'A test connector.',
    icon: 'Plug',
    category: 'other',
    authType: 'api_key',
    requiredScopes: [],
    capabilities: { searchable: true, syncable: true, realtime: false, apiKeyBased: true }
  };
  async initiate(_input: InitiateAuthInput) {
    return { mode: 'completed' as const, accountIdentifier: 'dummy', tokens: { accessToken: 'k' } };
  }
  async handleCallback() {
    return { tokens: { accessToken: 'k' } as TokenSet, accountIdentifier: 'dummy', grantedScopes: [] };
  }
  async refresh(refreshToken: string) {
    return { accessToken: refreshToken };
  }
  async revoke() {}
  async syncFull(_ctx: SyncContext): Promise<SyncResult> {
    return { items: this.normalize({ id: '1', title: 'Hello' }), cursor: { page: 1 }, hasMore: false };
  }
  async syncIncremental(ctx: SyncContext): Promise<SyncResult> {
    return { items: [], cursor: ctx.cursor, hasMore: false };
  }
  async fetch(_input: FetchInput) {
    return { ok: true };
  }
  normalize(raw: any): NormalizedItem[] {
    return [{ kind: 'document', externalId: String(raw.id), title: raw.title }];
  }
}

describe('ConnectorRegistry', () => {
  it('registers and looks up a connector', () => {
    const reg = new ConnectorRegistry();
    const dummy = new DummyConnector();
    reg.register(dummy);
    expect(reg.has('dummy_source')).toBe(true);
    expect(reg.get('dummy_source')).toBe(dummy);
    expect(reg.require('dummy_source')).toBe(dummy);
  });

  it('rejects duplicate ids loudly', () => {
    const reg = new ConnectorRegistry();
    reg.register(new DummyConnector());
    expect(() => reg.register(new DummyConnector())).toThrow(/already registered/);
  });

  it('validates the id format', () => {
    const reg = new ConnectorRegistry();
    const bad = new DummyConnector();
    (bad.metadata as any).id = 'Bad-Id';
    expect(() => reg.register(bad)).toThrow(/snake_case/);
  });

  it('exposes catalog metadata and the syncable subset', () => {
    const reg = new ConnectorRegistry();
    reg.register(new DummyConnector());
    expect(reg.catalog().map((m) => m.id)).toEqual(['dummy_source']);
    expect(reg.syncable().map((c) => c.metadata.id)).toEqual(['dummy_source']);
  });

  it('require() throws for an unknown connector', () => {
    const reg = new ConnectorRegistry();
    expect(() => reg.require('nope')).toThrow(/Unknown connector/);
  });

  describe('extensibility proof — a new connector runs through the same path', () => {
    it('a freshly-registered connector connects, syncs and normalizes via the interface', async () => {
      const reg = new ConnectorRegistry();
      reg.register(new DummyConnector());

      // 1. It shows up in the catalog with no core edits.
      expect(reg.catalog().some((m) => m.id === 'dummy_source')).toBe(true);

      // 2. It connects (api_key 'completed' path) through the generic interface.
      const connector = reg.require('dummy_source');
      const init = await connector.initiate({ userId: 'u1', redirectUri: 'x', apiKey: 'k' });
      expect(init.mode).toBe('completed');
      expect(init.tokens?.accessToken).toBe('k');

      // 3. It syncs + normalizes through the SAME SyncContext the runner uses.
      const ctx: SyncContext = {
        connection: { id: 'c1', userId: 'u1', connectorId: 'dummy_source', accountIdentifier: 'dummy', grantedScopes: [], metadata: {} },
        getAccessToken: async () => 'k',
        cursor: {}
      };
      const result = await connector.syncFull(ctx);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ kind: 'document', externalId: '1', title: 'Hello' });
      expect(result.hasMore).toBe(false);
    });
  });
});
