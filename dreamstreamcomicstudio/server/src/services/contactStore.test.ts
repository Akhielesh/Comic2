// @vitest-environment node
// contactStore (CONTACT-1): writes Settings › Contact messages with the service role into
// public.contact_messages — exactly { user_id, email, message } — and never throws or logs the text.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Call = { table: string; op: string; args: unknown[] };
const sb = vi.hoisted(() => ({
  persistence: true,
  calls: [] as Call[],
  insertError: null as null | { code?: string; message: string },
  insertThrows: false,
  rows: [] as Array<Record<string, unknown>>,
  selectError: null as null | { code?: string; message: string },
  updated: null as null | Record<string, unknown>,
  existing: null as null | Record<string, unknown>
}));

vi.mock('./supabase.js', () => ({
  getSupabaseCapabilityStatus: () => ({ supabaseConfigured: true, storagePersistenceEnabled: sb.persistence }),
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      const record = (op: string, ...args: unknown[]) => sb.calls.push({ table, op, args });
      let mode: 'select' | 'update' = 'select';
      const q: Record<string, unknown> = {
        insert: async (row: unknown) => {
          record('insert', row);
          if (sb.insertThrows) throw Object.assign(new Error(`network down ${JSON.stringify(row)}`), { code: 'ECONNRESET' });
          return { error: sb.insertError };
        },
        select: (...args: unknown[]) => { record('select', ...args); return q; },
        update: (...args: unknown[]) => { mode = 'update'; record('update', ...args); return q; },
        order: (...args: unknown[]) => { record('order', ...args); return q; },
        eq: (...args: unknown[]) => { record('eq', ...args); return q; },
        is: (...args: unknown[]) => { record('is', ...args); return q; },
        range: async (...args: unknown[]) => {
          record('range', ...args);
          return { data: sb.selectError ? null : sb.rows, error: sb.selectError };
        },
        maybeSingle: async () => ({ data: mode === 'update' ? sb.updated : sb.existing, error: null })
      };
      return q;
    }
  })
}));
const logged = vi.hoisted(() => ({ lines: [] as unknown[][] }));
vi.mock('../lib/logger.js', () => {
  const push = (...args: unknown[]) => { logged.lines.push(args); };
  return { logger: { debug: push, info: push, warn: push, error: push } };
});

import {
  CONTACT_EMAIL_MAX,
  CONTACT_EMAIL_MIN,
  CONTACT_MESSAGE_MAX,
  CONTACT_PAGE_LIMIT,
  contactInsertRow,
  insertContactMessage,
  listContactMessages,
  markContactMessageHandled,
  supabaseContactStore
} from './contactStore.js';

const USER = '0f0e0d0c-0b0a-4908-8706-050403020100';
const MSG_ID = '6a1f3c2e-9b8d-4c7a-8e6f-5d4c3b2a1908';
const INPUT = { userId: USER, email: 'reply@example.com', message: 'The reader skips page 2 on my tablet.' };

beforeEach(() => {
  sb.persistence = true;
  sb.calls.length = 0;
  sb.insertError = null;
  sb.insertThrows = false;
  sb.rows = [];
  sb.selectError = null;
  sb.updated = null;
  sb.existing = null;
  logged.lines.length = 0;
});

describe('insertContactMessage', () => {
  it('inserts exactly { user_id, email, message } into public.contact_messages', async () => {
    expect(await insertContactMessage(INPUT)).toEqual({ ok: true });
    expect(sb.calls).toEqual([
      { table: 'contact_messages', op: 'insert', args: [{ user_id: USER, email: INPUT.email, message: INPUT.message }] }
    ]);
    // No id, timestamps or handled flag from the server: the table's defaults own those.
    expect(Object.keys(contactInsertRow(INPUT)).sort()).toEqual(['email', 'message', 'user_id']);
  });

  it('is unavailable (and touches nothing) without the service role', async () => {
    sb.persistence = false;
    expect(await insertContactMessage(INPUT)).toEqual({ ok: false, reason: 'unavailable' });
    expect(sb.calls).toEqual([]);
  });

  it('reports a database error (the table missing, PGRST205) as failed, logging the code only', async () => {
    sb.insertError = { code: 'PGRST205', message: `Could not find the table 'public.contact_messages' (${INPUT.message})` };
    expect(await insertContactMessage(INPUT)).toEqual({ ok: false, reason: 'failed' });
    expect(logged.lines).toEqual([['contact_persist_failed', { code: 'PGRST205' }]]);
    expect(JSON.stringify(logged.lines)).not.toContain(INPUT.message);
    expect(JSON.stringify(logged.lines)).not.toContain(INPUT.email);
  });

  it('never throws, and never logs the text when the client throws with it in the error', async () => {
    sb.insertThrows = true;
    await expect(insertContactMessage(INPUT)).resolves.toEqual({ ok: false, reason: 'failed' });
    expect(JSON.stringify(logged.lines)).not.toContain(INPUT.message);
    expect(JSON.stringify(logged.lines)).not.toContain(INPUT.email);
  });

  it('carries the caps server/sql/contact_messages.sql checks', () => {
    expect([CONTACT_EMAIL_MIN, CONTACT_EMAIL_MAX, CONTACT_MESSAGE_MAX, CONTACT_PAGE_LIMIT]).toEqual([3, 320, 5000, 50]);
  });
});

describe('listContactMessages', () => {
  const row = (i: number) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    email: `p${i}@example.com`,
    message: `message ${i}`,
    created_at: new Date(Date.UTC(2026, 10, 12, 9, 0, 0) - i * 60_000).toISOString(),
    handled_at: null,
    user_id: USER
  });

  it('reads newest first, 50 a page, and offers the next offset only on a full page', async () => {
    sb.rows = Array.from({ length: 50 }, (_, i) => row(i));
    const first = await listContactMessages({});
    expect(first.ok && first.items).toHaveLength(50);
    expect(first.ok && first.nextCursor).toBe('50');
    expect(sb.calls.filter((c) => c.op === 'order').map((c) => c.args)).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: false }]
    ]);
    expect(sb.calls.find((c) => c.op === 'range')?.args).toEqual([0, 49]);
    // Only the reader's fields leave the store (no user id).
    expect(sb.calls.find((c) => c.op === 'select')?.args).toEqual(['id, email, message, created_at, handled_at']);
    expect(Object.keys((first.ok && first.items[0]) || {}).sort()).toEqual(['created_at', 'email', 'handled_at', 'id', 'message']);

    sb.calls.length = 0;
    sb.rows = [row(50)];
    const second = await listContactMessages({ cursor: '50' });
    expect(sb.calls.find((c) => c.op === 'range')?.args).toEqual([50, 99]);
    expect(second).toEqual({ ok: true, items: [{ id: row(50).id, email: 'p50@example.com', message: 'message 50', created_at: row(50).created_at, handled_at: null }] });
  });

  it('never reads more than 50 at once, whatever limit is asked for', async () => {
    await listContactMessages({ limit: '500', cursor: '-3' });
    expect(sb.calls.find((c) => c.op === 'range')?.args).toEqual([0, 49]);
    sb.calls.length = 0;
    await listContactMessages({ limit: 10 });
    expect(sb.calls.find((c) => c.op === 'range')?.args).toEqual([0, 9]);
  });

  it('is unavailable without the service role and failed on a read error', async () => {
    sb.persistence = false;
    expect(await listContactMessages()).toEqual({ ok: false, reason: 'unavailable' });
    sb.persistence = true;
    sb.selectError = { code: '42P01', message: 'relation does not exist' };
    expect(await listContactMessages()).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('markContactMessageHandled', () => {
  it('stamps handled_at on an open message', async () => {
    sb.updated = { id: MSG_ID, handled_at: '2026-11-12T09:00:00.000Z' };
    expect(await markContactMessageHandled(MSG_ID)).toEqual({ ok: true, handledAt: '2026-11-12T09:00:00.000Z' });
    const update = sb.calls.find((c) => c.op === 'update');
    expect(Object.keys(update?.args[0] as object)).toEqual(['handled_at']);
    // Only while still open, so a second click keeps the first time.
    expect(sb.calls.filter((c) => c.op === 'eq' || c.op === 'is').map((c) => [c.op, ...c.args])).toEqual([
      ['eq', 'id', MSG_ID],
      ['is', 'handled_at', null]
    ]);
  });

  it('keeps the first handled time when it is already handled', async () => {
    sb.updated = null;
    sb.existing = { id: MSG_ID, handled_at: '2026-11-10T08:00:00.000Z' };
    expect(await markContactMessageHandled(MSG_ID)).toEqual({ ok: true, handledAt: '2026-11-10T08:00:00.000Z' });
  });

  it('answers not_found for an id with no row', async () => {
    expect(await markContactMessageHandled(MSG_ID)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('is the store the routes use', () => {
    expect(supabaseContactStore).toEqual({ insert: insertContactMessage, list: listContactMessages, markHandled: markContactMessageHandled });
  });
});
