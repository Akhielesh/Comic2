import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GmailConnector } from './gmail.js';
import { ConnectorAuthError } from '../types.js';
import type { SyncContext } from '../types.js';

const mockResponse = (body: any, init: { status?: number } = {}) => {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body
  } as unknown as Response;
};

const sampleMessage = (id: string) => ({
  id,
  threadId: `thread-${id}`,
  snippet: `snippet for ${id}`,
  internalDate: '1700000000000',
  labelIds: ['INBOX'],
  payload: {
    headers: [
      { name: 'From', value: 'alice@example.com' },
      { name: 'Subject', value: `Subject ${id}` },
      { name: 'Date', value: 'Wed, 15 Nov 2023 00:00:00 +0000' }
    ]
  }
});

const ctx = (cursor: Record<string, unknown> = {}): SyncContext => ({
  connection: { id: 'c1', userId: 'u1', connectorId: 'gmail', accountIdentifier: 'a@b.com', grantedScopes: [], metadata: {} },
  getAccessToken: async () => 'tok',
  cursor,
  limit: 2
});

// Route a mocked fetch by URL shape.
const router = (handlers: {
  profile?: () => any;
  list?: (url: string) => any;
  message?: (id: string) => any;
  history?: (url: string) => any;
}) =>
  vi.fn(async (url: string) => {
    if (url.includes('/profile')) return mockResponse(handlers.profile?.() ?? { historyId: '1000' });
    if (url.includes('/history')) return mockResponse(handlers.history?.(url) ?? { history: [] });
    const m = url.match(/\/messages\/([^?]+)/);
    if (m) {
      const r = handlers.message?.(decodeURIComponent(m[1]));
      if (r?.__status) return mockResponse(r.body, { status: r.__status });
      return mockResponse(r ?? sampleMessage(decodeURIComponent(m[1])));
    }
    if (url.includes('/messages')) {
      const r = handlers.list?.(url);
      if (r?.__status) return mockResponse(r.body, { status: r.__status });
      return mockResponse(r ?? { messages: [] });
    }
    return mockResponse({}, { status: 404 });
  });

describe('GmailConnector.normalize', () => {
  it('maps a Gmail message to a normalized document', () => {
    const items = new GmailConnector().normalize(sampleMessage('a'));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'document',
      externalId: 'a',
      title: 'Subject a',
      author: 'alice@example.com',
      occurredAt: new Date(1700000000000).toISOString()
    });
    expect(items[0].payload).toMatchObject({ threadId: 'thread-a', labelIds: ['INBOX'] });
  });

  it('handles an empty/malformed message safely', () => {
    expect(new GmailConnector().normalize({})).toEqual([]);
    expect(new GmailConnector().normalize(null)).toEqual([]);
  });
});

describe('GmailConnector sync (mocked Google)', () => {
  beforeEach(() => {});
  afterEach(() => vi.restoreAllMocks());

  it('full sync fetches a page, captures historyId, and signals more pages', async () => {
    global.fetch = router({
      profile: () => ({ historyId: '1000' }),
      list: () => ({ messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'PAGE2' }),
      message: (id) => sampleMessage(id)
    }) as any;

    const res = await new GmailConnector().syncFull(ctx());
    expect(res.items.map((i) => i.externalId).sort()).toEqual(['a', 'b']);
    expect(res.cursor).toEqual({ pageToken: 'PAGE2', historyId: '1000' });
    expect(res.hasMore).toBe(true);
  });

  it('full sync final page drops the pageToken and keeps historyId', async () => {
    global.fetch = router({
      profile: () => ({ historyId: '2000' }),
      list: () => ({ messages: [{ id: 'a' }] }),
      message: (id) => sampleMessage(id)
    }) as any;

    const res = await new GmailConnector().syncFull(ctx());
    expect(res.cursor).toEqual({ historyId: '2000' });
    expect(res.hasMore).toBe(false);
  });

  it('incremental sync resumes from a historyId via users.history', async () => {
    global.fetch = router({
      history: () => ({ history: [{ messagesAdded: [{ message: { id: 'c' } }] }], historyId: '2100' }),
      message: (id) => sampleMessage(id)
    }) as any;

    const res = await new GmailConnector().syncIncremental(ctx({ historyId: '2000' }));
    expect(res.items.map((i) => i.externalId)).toEqual(['c']);
    expect(res.cursor).toEqual({ historyId: '2100' });
    expect(res.hasMore).toBe(false);
  });

  it('incremental with no baseline falls back to a full sync', async () => {
    const fetchMock = router({
      profile: () => ({ historyId: '3000' }),
      list: () => ({ messages: [{ id: 'z' }] }),
      message: (id) => sampleMessage(id)
    });
    global.fetch = fetchMock as any;

    const res = await new GmailConnector().syncIncremental(ctx({}));
    expect(res.items.map((i) => i.externalId)).toEqual(['z']);
    // profile was consulted → it ran the full-sync path.
    expect(fetchMock.mock.calls.some((c: any[]) => String(c[0]).includes('/profile'))).toBe(true);
  });

  it('surfaces a 401 from Google as a ConnectorAuthError (→ reconnect)', async () => {
    global.fetch = router({
      profile: () => ({ historyId: '1' }),
      list: () => ({ __status: 401, body: 'unauthorized' })
    }) as any;
    await expect(new GmailConnector().syncFull(ctx())).rejects.toBeInstanceOf(ConnectorAuthError);
  });

  it('search returns normalized documents', async () => {
    global.fetch = router({
      list: () => ({ messages: [{ id: 'a' }] }),
      message: (id) => sampleMessage(id)
    }) as any;
    const out: any = await new GmailConnector().fetch({
      connection: ctx().connection,
      getAccessToken: async () => 'tok',
      resource: 'search',
      params: { q: 'from:alice' }
    });
    expect(out.items[0].externalId).toBe('a');
  });

  it('reads a message body (decodes text/plain, skips attachments) + parses a comma display-name From', async () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    const full = {
      id: 'mx',
      threadId: 't',
      internalDate: '1700000000000',
      labelIds: ['INBOX', 'UNREAD'],
      payload: {
        headers: [
          { name: 'From', value: '"Doe, Jane" <jane@x.com>' },
          { name: 'Subject', value: 'Hi' }
        ],
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', body: { data: b64('Hello body') } },
          { mimeType: 'application/pdf', filename: 'a.pdf', body: { data: b64('PDFDATA') } }
        ]
      }
    };
    global.fetch = router({ message: () => full }) as any;
    const out: any = await new GmailConnector().fetch({
      connection: ctx().connection,
      getAccessToken: async () => 'tok',
      resource: 'message',
      params: { id: 'mx' }
    });
    expect(out.email.body).toBe('Hello body'); // attachment text NOT surfaced
    expect(out.email.from).toEqual({ name: 'Doe, Jane', email: 'jane@x.com' });
    expect(out.email.unread).toBe(true);
  });

  it('inbox skips a message that fails to fetch and returns the rest', async () => {
    global.fetch = router({
      list: () => ({ messages: [{ id: 'a' }, { id: 'bad' }, { id: 'c' }] }),
      message: (id) => (id === 'bad' ? { __status: 404, body: 'not found' } : sampleMessage(id))
    }) as any;
    const out: any = await new GmailConnector().fetch({
      connection: ctx().connection,
      getAccessToken: async () => 'tok',
      resource: 'inbox',
      params: {}
    });
    expect(out.emails.map((e: any) => e.id)).toEqual(['a', 'c']);
  });
});
