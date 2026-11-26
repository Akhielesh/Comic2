import { beforeEach, describe, expect, it, vi } from 'vitest';

// Persistence on, inserts captured; the logger captured (no console noise, no network).
const { inserts, deletes, deleteError } = vi.hoisted(() => ({
  inserts: [] as { table: string; rows: unknown }[],
  deletes: [] as { table: string; where: [string, unknown][] }[],
  deleteError: { current: null as { message: string } | null }
}));
vi.mock('./supabase.js', () => ({
  getSupabaseCapabilityStatus: () => ({ storagePersistenceEnabled: true }),
  getSupabaseAdmin: () => ({
    from: (table: string) => ({
      insert: async (rows: unknown) => {
        inserts.push({ table, rows });
        return { error: null };
      },
      delete: () => {
        const entry = { table, where: [] as [string, unknown][] };
        deletes.push(entry);
        const chain = {
          eq: (column: string, value: unknown) => {
            entry.where.push([column, value]);
            return chain;
          },
          then: (resolve: (v: { error: { message: string } | null }) => unknown) => resolve({ error: deleteError.current })
        };
        return chain;
      }
    })
  })
}));
vi.mock('../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { logger } from '../lib/logger.js';
import { recordFeedback, recordServerError, recordTelemetryEvents, withdrawFeedback } from './telemetryStore.js';

const SLUG = 'Ab3dEf6hIj9kLm2nP';

beforeEach(() => {
  inserts.length = 0;
  deletes.length = 0;
  deleteError.current = null;
  vi.clearAllMocks();
});

describe("a reply rating's Undo (withdrawFeedback)", () => {
  it('removes only the signed-in person’s own rows for that one reply', async () => {
    expect(await withdrawFeedback({ targetType: 'comic_reply', targetId: 'msg_42' }, { userId: 'user-1' })).toEqual({ withdrawn: true });
    expect(deletes).toEqual([{ table: 'user_feedback', where: [['user_id', 'user-1'], ['target_type', 'comic_reply'], ['target_id', 'msg_42']] }]);
  });

  it('never touches general feedback, reports or another kind, and never runs without a person or an id', async () => {
    for (const targetType of ['platform', 'chat_response', 'bug', 'feedback', 'studio', '', undefined]) {
      expect(await withdrawFeedback({ targetType, targetId: 'msg_42' }, { userId: 'user-1' }), String(targetType)).toEqual({ withdrawn: false });
    }
    expect(await withdrawFeedback({ targetType: 'comic_reply', targetId: 'msg_42' }, { userId: null })).toEqual({ withdrawn: false });
    expect(await withdrawFeedback({ targetType: 'comic_reply', targetId: '   ' }, { userId: 'user-1' })).toEqual({ withdrawn: false });
    expect(await withdrawFeedback(null, { userId: 'user-1' })).toEqual({ withdrawn: false });
    expect(deletes).toEqual([]);
  });

  it('says so when the delete fails (the rating stays, the button can try again)', async () => {
    deleteError.current = { message: 'permission denied' };
    expect(await withdrawFeedback({ targetType: 'comic_reply', targetId: 'msg_42' }, { userId: 'user-1' })).toEqual({ withdrawn: false });
    expect(logger.warn).toHaveBeenCalledWith('feedback_withdraw_failed', expect.objectContaining({ message: 'permission denied' }));
  });

  it('a reply rating is stored like any other vote, with its target kept', async () => {
    await recordFeedback({ targetType: 'comic_reply', targetId: 'msg_42', vote: 'dislike', source: 'comic_studio', sessionId: 'proj_1', metadata: { cards: ['plan'] } }, { userId: 'user-1' });
    expect(inserts[0]).toMatchObject({ table: 'user_feedback', rows: { target_type: 'comic_reply', target_id: 'msg_42', vote: 'dislike', source: 'comic_studio', session_id: 'proj_1', user_id: 'user-1', comment: null } });
  });
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

  it('keeps receipt-bearing report types exclusive to the validated report route', async () => {
    await recordFeedback({targetType:'  bug ', comment:'test', metadata:{attachmentCount:10}}, {userId:null});
    expect(inserts[0].rows).toMatchObject({target_type:'platform'});
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
