import { COMICS_ORIGIN } from '../../../services/productHost.js';
// Durable interest and onboarding email. The trigger writes the job in the same transaction as the
// registration/verification. No provider call is on the browser's response deadline.
import { APP_PUBLIC_URL, EMAIL_PUBLIC_BASE_URL, NEWSLETTER_CONFIRM_TTL_HOURS } from '../config.js';
import { getSupabaseAdmin } from './supabase.js';
import { mailerConfigured, sendAccessRequested, sendNewsletterConfirm, sendNewsletterWelcome, sendWelcome, type SendResult } from './mailer.js';
import { isSuppressed } from './emailStore.js';

interface Job {
  id: string;
  template: 'welcome' | 'access-requested' | 'newsletter-confirm' | 'newsletter-welcome';
  signup_id: string | null;
  account_id: string | null;
  created_at: string;
  lease_id: string;
  attempts: number;
}
type Db = ReturnType<typeof getSupabaseAdmin>;
const DAY = 86_400_000;
const MAX_ATTEMPTS = 8;
const BATCH = 10;

const deliver = async (db: Db, job: Job): Promise<SendResult | null> => {
  if (Date.parse(job.created_at) < Date.now() - DAY || job.attempts > MAX_ATTEMPTS) return null;
  if (job.attempts > 1) {
    // A process can die after transport accepted the message but before the queue acknowledged it.
    const logged = await db.from('email_log').select('id').eq('request_id', job.id)
      .eq('template', job.template).eq('status', 'sent').limit(1).maybeSingle();
    if (logged.error) throw logged.error;
    if (logged.data) return { ok: true };
  }
  const meta = { requestId: job.id };
  if (job.template === 'welcome') {
    const setting = await db.from('email_lifecycle_settings').select('account_welcome_enabled').eq('id', true).single();
    if (setting.error) throw setting.error;
    if (!setting.data?.account_welcome_enabled || !job.account_id) return null;
    const account = await db.auth.admin.getUserById(job.account_id);
    if (account.error) throw account.error;
    const user = account.data.user;
    if (!user?.email_confirmed_at || !user.email) return null;
    const comic = user.user_metadata?.signup_source === 'comic_studio';
    const firstName = typeof user.user_metadata?.first_name === 'string' ? user.user_metadata.first_name.slice(0, 100) : undefined;
    return sendWelcome(user.email, firstName, comic ? COMICS_ORIGIN : APP_PUBLIC_URL, { ...meta, userId: user.id, ...(comic ? { brand: 'comic-studio' as const } : {}) });
  }

  if (process.env.INTEREST_EMAILS !== 'on' || !job.signup_id) return null;
  const { data: signup, error } = await db.from('waitlist_signups')
    .select('kind,email,confirmed,confirm_token,confirm_sent_at,unsubscribed_at,metadata').eq('id', job.signup_id).maybeSingle();
  if (error) throw error;
  if (!signup || signup.unsubscribed_at) return null;
  const receiptMeta = signup.metadata?.emailBrand === 'comic-studio' ? { ...meta, brand: 'comic-studio' as const } : meta;
  const name = signup.metadata?.answers?.firstName;
  const firstName = typeof name === 'string' ? name : undefined;
  if (job.template === 'access-requested') {
    return signup.kind === 'access' ? sendAccessRequested(signup.email, firstName, receiptMeta) : null;
  }
  if (signup.kind !== 'updates') return null;
  if (job.template === 'newsletter-welcome') return signup.confirmed ? sendNewsletterWelcome(signup.email, firstName, receiptMeta) : null;
  if (signup.confirmed || !signup.confirm_token || !signup.confirm_sent_at || await isSuppressed(signup.email)) return null;
  if (NEWSLETTER_CONFIRM_TTL_HOURS > 0 &&
    Date.parse(signup.confirm_sent_at) < Date.now() - NEWSLETTER_CONFIRM_TTL_HOURS * 3_600_000) return null;
  const link = new URL('/api/newsletter/confirm', EMAIL_PUBLIC_BASE_URL || APP_PUBLIC_URL);
  link.searchParams.set('e', signup.email);
  link.searchParams.set('t', signup.confirm_token);
  return sendNewsletterConfirm(signup.email, link.toString(), firstName, receiptMeta);
};

export const processLifecycleEmail = async (db: Db, job: Job): Promise<void> => {
  let result: SendResult | null;
  try {
    result = await deliver(db, job);
  } catch {
    result = { ok: false, error: 'delivery temporarily unavailable' };
  }
  const state = result === null || result.skipped === 'suppressed' ? 'skipped' : result.ok ? 'sent' :
    job.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued';
  const retryMs = Math.min(3_600_000, 60_000 * 2 ** Math.min(job.attempts - 1, 6));
  const { error } = await db.from('email_lifecycle_jobs').update({
    state, lease_id: null, lease_until: null,
    ...(state === 'queued' ? { available_at: new Date(Date.now() + retryMs).toISOString() } : {})
  }).eq('id', job.id).eq('lease_id', job.lease_id);
  if (error) throw error;
};

let running: Promise<void> | undefined;
export const wakeLifecycleEmail = (): void => {
  if (running || !mailerConfigured()) return;
  running = (async () => {
    const db = getSupabaseAdmin();
    for (let count = 0; count < BATCH; count++) {
      const { data, error } = await db.rpc('claim_lifecycle_email');
      if (error) throw error;
      const job = Array.isArray(data) ? data[0] as Job | undefined : undefined;
      if (!job) return;
      await processLifecycleEmail(db, job);
    }
  })().catch(() => console.warn('[email] lifecycle queue unavailable; check service role and email_lifecycle.sql'))
    .finally(() => { running = undefined; });
};

/** Also recover work from a previous process when the container wakes from sleep. */
export const startLifecycleEmail = (): void => {
  wakeLifecycleEmail();
  setInterval(wakeLifecycleEmail, 60_000).unref();
};
