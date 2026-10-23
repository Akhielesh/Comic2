import { beforeEach, describe, expect, it, vi } from 'vitest';

// Persistence on, inserts captured; the logger captured (no console noise, no network).
const { inserts } = vi.hoisted(() => ({ inserts: [] as { table: string; rows: unknown }[] }));
vi.mock('./supabase.js', () => ({
  getSupabaseCapabilityStatus: () => ({ storagePersistenceEnabled: true }),
  getSupabaseAdmin: () => ({
    from: (table: string) => ({
      insert: async (rows: unknown) => {
        inserts.push({ table, rows });
        return { error: null };
      }
    })
  })
}));
vi.mock('../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { logger } from '../lib/logger.js';
import { recordFeedback, recordServerError, recordTelemetryEvents } from './telemetryStore.js';

const SLUG = 'Ab3dEf6hIj9kLm2nP';

beforeEach(() => {
  inserts.length = 0;
  vi.clearAllMocks();
});

describe('telemetry surfaces never store a read capability (S19)', () => {
  it('masks a /c/<slug> page in telemetry_events and in the log line', async () => {
    const out = await recordTelemetryEvents(
      [{ eventType: 'window_error', severity: 'error', surface: `/c/${SLUG}/my-title?lang=hi`, message: 'boom' }],
      { userId: null, ip: '203.0.113.9' }
    );
    expect(out).toEqual({ accepted: 1, persisted: true });
    const rows = inserts[0].rows as { surface: string }[];
    expect(inserts[0].table).toBe('telemetry_events');
    expect(rows[0].surface).toBe('/c/:slug/my-title');
    expect(JSON.stringify(inserts)).not.toContain(SLUG);
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(SLUG);
  });

  it('masks a classic /share/<token> page in user_feedback', async () => {
    await recordFeedback({ vote: 'like', surface: '/share/tok123secret' }, { userId: null });
    expect(inserts[0].table).toBe('user_feedback');
    expect((inserts[0].rows as { surface: string }).surface).toBe('/share/:token');
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain('tok123secret');
  });

  it('masks the path of a recorded server error', async () => {
    recordServerError({ path: `/api/comic/public/s/${SLUG}/report?x=1`, status: 500, message: 'boom' });
    await vi.waitFor(() => expect(inserts).toHaveLength(1));
    expect((inserts[0].rows as { surface: string }[])[0].surface).toBe('/api/comic/public/s/:slug/report');
  });

  it('keeps ordinary surfaces as they are', async () => {
    await recordTelemetryEvents([{ eventType: 'chat_failed', surface: 'chat' }, { eventType: 'x', surface: '/' }, { eventType: 'y' }], { userId: 'u1' });
    expect((inserts[0].rows as { surface: string | null }[]).map((r) => r.surface)).toEqual(['chat', '/', null]);
  });

  it('masks the page URL an inline / extension-injected script error reports as filename, stack or message', async () => {
    const page = `https://comics.dreamstreamstudio.ai/c/${SLUG}?lang=hi`;
    await recordTelemetryEvents(
      [
        {
          eventType: 'window_error',
          severity: 'error',
          surface: `/c/${SLUG}`,
          message: `Failed to execute 'pushState' on 'History': URL '${page}' cannot be created`,
          metadata: {
            filename: page,
            lineno: 110,
            stack: `Error: boom\n    at ${page}:110:5\n    at https://comics.dreamstreamstudio.ai/assets/index-Ab12.js:1:2`,
            nested: { href: page, list: [page] }
          }
        }
      ],
      { userId: null }
    );
    const row = (inserts[0].rows as { message: string; metadata: Record<string, unknown> }[])[0];
    expect(JSON.stringify(inserts)).not.toContain(SLUG);
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(SLUG);
    expect(row.metadata.filename).toBe('https://comics.dreamstreamstudio.ai/c/:slug');
    expect(row.metadata.lineno).toBe(110);
    expect(String(row.metadata.stack)).toContain('https://comics.dreamstreamstudio.ai/assets/index-Ab12.js:1:2');
    expect(row.message).toContain("URL 'https://comics.dreamstreamstudio.ai/c/:slug' cannot be created");
  });

  it('masks a share page URL in feedback metadata too (the comment is the user\'s own words)', async () => {
    await recordFeedback({ vote: 'dislike', comment: 'slow', metadata: { href: 'https://dreamstreamstudio.ai/share/tok123secret#x' } }, { userId: null });
    expect((inserts[0].rows as { metadata: Record<string, unknown> }).metadata).toEqual({ href: 'https://dreamstreamstudio.ai/share/:token' });
  });
});
