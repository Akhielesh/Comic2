/**
 * Account sync for Stream Studio.
 *
 * Signed-in users get their events mirrored to Supabase
 * (`stream_studio_events`, RLS owner-locked), so the dashboard shows the same
 * history on every device — id + hostKey travel with the account. Signed-out
 * users keep working exactly as before (localStorage only); every call here
 * degrades to a no-op when there's no session or Supabase isn't configured.
 *
 * `stream_studio_access` is the admin-managed gate: no row = normal access,
 * `active = false` = streaming revoked, `scope = 'studio_only'` = the account
 * is onboarded for Stream Studio alone (the main app confines it to
 * /live.html). Rows are written by admins via the service role only.
 */

import { addMyEvent, listMyEvents, type MyEvent } from './events';
import type { StudioPrefs } from './prefs';

export interface StudioAccess {
  signedIn: boolean;
  allowed: boolean;
  scope: 'full' | 'studio_only';
  email?: string;
}

interface CloudEventRow {
  id: string;
  user_id: string;
  host_key: string;
  title: string;
  status: string;
  quality: string | null;
  access: string | null;
  cover: number;
  scheduled_at_ms: number | null;
  started_at_ms: number | null;
  ended_at_ms: number | null;
  created_at_ms: number;
  peak_viewers: number;
}

/** Lazy supabase import keeps @supabase/supabase-js out of the live bundle
 *  until (and unless) it's actually needed. */
async function client() {
  try {
    const mod = await import('@/services/supabase');
    return mod.supabase;
  } catch {
    return null;
  }
}

async function userId(): Promise<{ id: string; email?: string } | null> {
  const supabase = await client();
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getSession();
    const u = data.session?.user;
    return u ? { id: u.id, email: u.email ?? undefined } : null;
  } catch {
    return null;
  }
}

/**
 * Admin-defined access for the current account, from `product_access`:
 * no rows → default access; rows present → the user is confined to the
 * products with active = true (standalone onboarding). Falls back to the
 * legacy stream_studio_access table, then to allowed.
 */
export async function fetchStudioAccess(): Promise<StudioAccess> {
  const u = await userId();
  if (!u) return { signedIn: false, allowed: true, scope: 'full' };
  const supabase = await client();
  if (!supabase) return { signedIn: true, allowed: true, scope: 'full', email: u.email };
  try {
    const { data, error } = await supabase
      .from('product_access')
      .select('product, active')
      .eq('user_id', u.id);
    if (!error && data && data.length > 0) {
      const mine = data.find((r) => r.product === 'stream_studio');
      const allowed = mine ? mine.active !== false : false; // confined to other products
      const standalone = data.filter((r) => r.active !== false).length === 1 && mine?.active !== false;
      return { signedIn: true, allowed, scope: standalone ? 'studio_only' : 'full', email: u.email };
    }
  } catch {
    /* table missing in older envs — fall through */
  }
  try {
    const { data, error } = await supabase
      .from('stream_studio_access')
      .select('active, scope')
      .eq('user_id', u.id)
      .maybeSingle();
    if (error || !data) return { signedIn: true, allowed: true, scope: 'full', email: u.email };
    return {
      signedIn: true,
      allowed: data.active !== false,
      scope: data.scope === 'studio_only' ? 'studio_only' : 'full',
      email: u.email,
    };
  } catch {
    return { signedIn: true, allowed: true, scope: 'full', email: u.email };
  }
}

/* ----------------------------- settings sync ----------------------------- */

/** Push this device's settings to the account (newer-wins on other devices). */
export async function pushPrefsToCloud(): Promise<void> {
  const u = await userId();
  if (!u) return;
  const supabase = await client();
  if (!supabase) return;
  try {
    const { loadPrefs } = await import('./prefs');
    await supabase
      .from('stream_studio_settings')
      .upsert({ user_id: u.id, prefs: loadPrefs(), updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  } catch {
    /* offline / table missing */
  }
}

/** Pull account settings; adopt them locally when they're newer than this
 *  device's last edit. Returns true when cloud settings were adopted. */
export async function pullPrefsFromCloud(): Promise<boolean> {
  const u = await userId();
  if (!u) return false;
  const supabase = await client();
  if (!supabase) return false;
  try {
    const { data, error } = await supabase
      .from('stream_studio_settings')
      .select('prefs, updated_at')
      .eq('user_id', u.id)
      .maybeSingle();
    if (error || !data?.prefs) return false;
    const cloudAt = new Date(data.updated_at as string).getTime() || 0;
    const { prefsSavedAt, adoptCloudPrefs } = await import('./prefs');
    if (cloudAt > prefsSavedAt()) {
      adoptCloudPrefs(data.prefs as Partial<StudioPrefs>, cloudAt);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Sign the account out of this device (Stream Studio standalone account UI). */
export async function signOut(): Promise<void> {
  const supabase = await client();
  if (!supabase) return;
  try {
    await supabase.auth.signOut();
  } catch {
    /* already signed out */
  }
}

const toRow = (ev: MyEvent, uid: string): Omit<CloudEventRow, 'user_id'> & { user_id: string } => ({
  id: ev.id,
  user_id: uid,
  host_key: ev.hostKey,
  title: ev.title,
  status: ev.status ?? 'idle',
  quality: ev.quality ?? null,
  access: ev.access ?? null,
  cover: ev.cover ?? 0,
  scheduled_at_ms: ev.scheduledAt ?? null,
  started_at_ms: ev.startedAt ?? null,
  ended_at_ms: ev.endedAt ?? null,
  created_at_ms: ev.createdAt,
  peak_viewers: ev.peakViewers ?? 0,
});

const fromRow = (r: CloudEventRow): MyEvent => ({
  id: r.id,
  hostKey: r.host_key,
  title: r.title,
  createdAt: r.created_at_ms,
  scheduledAt: r.scheduled_at_ms,
  status: (['idle', 'live', 'paused', 'ended'] as const).includes(r.status as never) ? (r.status as MyEvent['status']) : 'idle',
  startedAt: r.started_at_ms,
  endedAt: r.ended_at_ms,
  quality: r.quality ?? undefined,
  access: (r.access === 'approval' ? 'approval' : r.access === 'open' ? 'open' : undefined),
  cover: r.cover,
  peakViewers: r.peak_viewers,
});

/** Push one event to the account (after create / status changes). No-op signed out. */
export async function pushEventToCloud(ev: MyEvent): Promise<void> {
  const u = await userId();
  if (!u) return;
  const supabase = await client();
  if (!supabase) return;
  try {
    await supabase.from('stream_studio_events').upsert(toRow(ev, u.id), { onConflict: 'id' });
  } catch {
    /* offline / table missing — local copy is still authoritative */
  }
}

/**
 * Two-way merge: cloud rows this device doesn't know come down (cross-device
 * history), local events the cloud doesn't know go up. Returns true when
 * anything came down (callers re-read the registry).
 */
export async function syncMyEvents(): Promise<boolean> {
  const u = await userId();
  if (!u) return false;
  const supabase = await client();
  if (!supabase) return false;
  try {
    const { data, error } = await supabase
      .from('stream_studio_events')
      .select('*')
      .order('created_at_ms', { ascending: false })
      .limit(100);
    if (error) return false;
    const cloud = (data ?? []) as CloudEventRow[];
    const local = listMyEvents();
    const localIds = new Set(local.map((e) => e.id));
    const cloudIds = new Set(cloud.map((r) => r.id));

    let pulled = false;
    for (const row of cloud) {
      if (!localIds.has(row.id)) {
        addMyEvent(fromRow(row));
        pulled = true;
      }
    }
    const missing = local.filter((e) => !cloudIds.has(e.id));
    if (missing.length > 0) {
      await supabase.from('stream_studio_events').upsert(missing.map((e) => toRow(e, u.id)), { onConflict: 'id' });
    }
    return pulled;
  } catch {
    return false;
  }
}
