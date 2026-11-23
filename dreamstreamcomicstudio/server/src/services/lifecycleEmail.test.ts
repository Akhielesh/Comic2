// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processLifecycleEmail } from './lifecycleEmail.js';

const send = vi.hoisted(() => vi.fn());
const suppressed = vi.hoisted(() => vi.fn());
vi.mock('./mailer.js', () => ({
  mailerConfigured: () => true, sendWelcome: send, sendAccessRequested: send,
  sendNewsletterConfirm: send, sendNewsletterWelcome: send
}));
vi.mock('./emailStore.js', () => ({ isSuppressed: suppressed }));

const job = () => ({
  id: 'job', signup_id: 'signup', account_id: null, template: 'newsletter-confirm' as const,
  created_at: new Date().toISOString(), lease_id: 'lease', attempts: 1
});
const signup = () => ({
  email: 'fixture@example.test', kind: 'updates', confirmed: false, unsubscribed_at: null,
  confirm_token: 'current', confirm_sent_at: new Date().toISOString(), metadata: {}
});
const db = (rows: Record<string, unknown>) => {
  const updates: Record<string, unknown>[] = [];
  const filters: unknown[][] = [];
  return {
    updates, filters,
    client: {
      auth: { admin: { getUserById: async () => ({ data: { user: rows.user }, error: null }) } },
      from: (table: string) => {
        const chain = {
          select: () => chain, limit: () => chain,
          eq: (...args: unknown[]) => { filters.push([table, ...args]); return chain; },
          update: (value: Record<string, unknown>) => { updates.push(value); return chain; },
          single: async () => ({ data: rows[table], error: null }),
          maybeSingle: async () => ({ data: rows[table], error: null })
        };
        return chain;
      }
    } as unknown as Parameters<typeof processLifecycleEmail>[0]
  };
};

describe('lifecycle queue delivery', () => {
  beforeEach(() => {
    send.mockReset().mockResolvedValue({ ok: true });
    suppressed.mockReset().mockResolvedValue(false);
    vi.stubEnv('INTEREST_EMAILS', 'on');
  });
  it('carries the recorded Comic Studio brand into a receipt', async () => {
    const h = db({ waitlist_signups: { ...signup(), kind: 'access', metadata: { emailBrand: 'comic-studio', answers: { firstName: 'Ada' } } } });
    await processLifecycleEmail(h.client, { ...job(), template: 'access-requested' });
    expect(send).toHaveBeenCalledWith('fixture@example.test', 'Ada', { requestId: 'job', brand: 'comic-studio' });
  });
  it('backs off a transient failure under the same lease and bounds retries', async () => {
    const h = db({ waitlist_signups: signup() });
    send.mockResolvedValue({ ok: false, error: 'temporary' });
    await processLifecycleEmail(h.client, job());
    expect(h.updates[0]).toMatchObject({ state: 'queued', lease_id: null, available_at: expect.any(String) });
    expect(h.filters).toContainEqual(['email_lifecycle_jobs', 'lease_id', 'lease']);
    await processLifecycleEmail(h.client, { ...job(), attempts: 8 });
    expect(h.updates[1].state).toBe('failed');
  });
  it('recognizes a previously acknowledged transport after an interrupted queue completion', async () => {
    const h = db({ email_log: { id: 'entry' } });
    await processLifecycleEmail(h.client, { ...job(), attempts: 2 });
    expect(send).not.toHaveBeenCalled();
    expect(h.updates[0].state).toBe('sent');
  });
  it('skips obsolete, opted-out, expired and disabled deliveries', async () => {
    for (const row of [null, { ...signup(), confirmed: true }, { ...signup(), unsubscribed_at: 'now' },
      { ...signup(), confirm_sent_at: '2000-01-01T00:00:00Z' }]) {
      const h = db({ waitlist_signups: row });
      await processLifecycleEmail(h.client, job());
      expect(h.updates[0].state).toBe('skipped');
    }
    const h = db({ waitlist_signups: signup() });
    suppressed.mockResolvedValue(true);
    await processLifecycleEmail(h.client, job());
    vi.stubEnv('INTEREST_EMAILS', 'off');
    suppressed.mockResolvedValue(false);
    await processLifecycleEmail(h.client, job());
    expect(send).not.toHaveBeenCalled();
    expect(h.updates.map(u => u.state)).toEqual(['skipped','skipped']);
  });
  it('requires the account welcome switch and a still-verified account', async () => {
    const welcomeJob = { ...job(), template: 'welcome' as const, signup_id: null, account_id: 'user' };
    const rows = { email_lifecycle_settings: { account_welcome_enabled: true },
      user: { id: 'user', email: 'verified@example.test', email_confirmed_at: 'now' } };
    const enabled = db(rows);
    await processLifecycleEmail(enabled.client, welcomeJob);
    expect(send).toHaveBeenCalledWith('verified@example.test', undefined, expect.any(String), { requestId: 'job', userId: 'user' });
    const comics = db({ ...rows, user: { ...rows.user, user_metadata: { first_name: 'River', signup_source: 'comic_studio' } } });
    await processLifecycleEmail(comics.client, welcomeJob);
    expect(send).toHaveBeenCalledWith('verified@example.test', 'River', 'https://comics.dreamstreamstudio.ai', { requestId: 'job', userId: 'user', brand: 'comic-studio' });
    expect(send).toHaveBeenCalledTimes(2);
    send.mockClear();
    for (const inputs of [{ ...rows, email_lifecycle_settings: { account_welcome_enabled: false } },
      { ...rows, user: { ...rows.user, email_confirmed_at: null } }]) {
      const h = db(inputs);
      await processLifecycleEmail(h.client, welcomeJob);
      expect(h.updates[0].state).toBe('skipped');
    }
    expect(send).not.toHaveBeenCalled();
  });
});
