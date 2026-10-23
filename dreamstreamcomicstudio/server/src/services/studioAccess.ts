// One account, every studio: what a signed-in person can use right now, and how to
// unlock the rest. Both apps (DreamStream and Stream Studio) read this one answer
// from GET /api/account/studios, so they can never disagree about access.
//
// Sources of truth (unchanged — this only reads them):
//   - product_access: no rows ⇒ open-beta default (every studio); rows ⇒ the account
//     is confined to exactly the active ones (admin-managed, server/sql/product_access.sql)
//   - live_profiles: Stream Studio membership (welcome code, or a pre-launch account
//     that's grandfathered on its first visit — live__legacy_eligible)
//   - monitor_members: the nurseries this person belongs to (baby monitor + family calls)
//   - rbac: admins (shown on the account, not a studio)
//   - the name: live_profiles / profile_private / profiles.username (shared/accountName.ts)
//
// Code Studio is retired (docs/decisions/0005-retire-code-studio.md) and never listed.
import type { AccountAccess, StudioAccess, StudioId, StudioStatus } from '../../../shared/studioAccess.js';
import { resolveName } from '../../../shared/accountName.js';
import { resolveAccessProfile } from './rbac.js';
import { STREAM_HOST_ON, streamAppHref } from '../../../shared/streamHost.js';

export type { AccountAccess, StudioAccess, StudioId, StudioStatus };
import { getSupabaseAdmin } from './supabase.js';

export interface AccessInputs {
  productRows: { product: string; active: boolean }[];
  /** Stream Studio member (live_profiles row). */
  streamMember: boolean;
  /** A pre-launch account Stream Studio unlocks on first visit. */
  streamGrandfathered: boolean;
  nurseries: number;
}

// Main-app studios are paths on the main app; Stream Studio's are written the old way and go
// through shared/streamHost.ts, so with STREAM_HOST_ON they point at stream.dreamstreamstudio.ai.
const studiosFor = (streamHostOn: boolean): Record<StudioId, { label: string; tagline: string; href: string }> => ({
  comic_studio: { label: 'Comic Studio', tagline: 'Write, draw and publish comics with AI', href: '/?view=dashboard' },
  chat_studio: { label: 'Chat Studio', tagline: 'The assistant, with your connected apps', href: '/?view=chat' },
  stream_studio: { label: 'Stream Studio', tagline: 'Go live from your browser', href: streamAppHref('/live', streamHostOn) },
  baby_monitor: { label: 'Baby monitor & family calls', tagline: 'A private nursery camera, the baby tracker and FaceTime-style calls', href: streamAppHref('/live#/monitor', streamHostOn) },
});

const ASK = { label: 'Ask an admin for access', href: 'mailto:contact@dreamstreamstudio.ai?subject=Studio%20access' };

/** Pure: the access picture from what the database says. */
export function computeStudioAccess(i: AccessInputs, opts: { streamHostOn?: boolean } = {}): { confined: boolean; studios: StudioAccess[] } {
  const streamHostOn = opts.streamHostOn ?? STREAM_HOST_ON;
  const STUDIOS = studiosFor(streamHostOn);
  const live = (legacy: string) => streamAppHref(legacy, streamHostOn);
  const rows = new Map(i.productRows.map((r) => [r.product, r.active]));
  const confined = rows.size > 0;
  // No rows: open beta, everything. Rows: exactly the active ones.
  const granted = (p: 'comic_studio' | 'chat_studio' | 'stream_studio') => (confined ? rows.get(p) === true : true);
  const revoked = (p: string) => rows.get(p) === false;
  const make = (id: StudioId, status: StudioStatus, detail: string, action?: StudioAccess['action']): StudioAccess => ({ id, ...STUDIOS[id], status, detail, ...(action ? { action } : {}) });

  const studios: StudioAccess[] = [];
  for (const id of ['comic_studio', 'chat_studio'] as const) {
    studios.push(
      granted(id)
        ? make(id, 'open', confined ? 'Included with your account' : 'Included (open beta)')
        : make(id, 'locked', revoked(id) ? 'Access was turned off for this account' : 'Not part of your account yet', ASK),
    );
  }

  const streamOk = granted('stream_studio');
  const member = i.streamMember || i.streamGrandfathered;
  studios.push(
    !streamOk
      ? make('stream_studio', 'locked', revoked('stream_studio') ? 'Access was turned off for this account' : 'Not part of your account yet', ASK)
      : member
        ? make('stream_studio', 'open', i.streamMember ? 'Unlocked' : 'Unlocks on your first visit (early account)')
        : make('stream_studio', 'needs_code', 'One step: your welcome code', { label: 'Enter welcome code', href: live('/live#/settings') }),
  );

  // The baby monitor, tracker and calls ride on Stream Studio membership.
  studios.push(
    !streamOk
      ? make('baby_monitor', 'locked', 'Comes with Stream Studio', ASK)
      : !member
        ? make('baby_monitor', 'needs_code', 'Comes with Stream Studio — enter your welcome code', { label: 'Enter welcome code', href: live('/live#/settings') })
        : i.nurseries > 0
          ? make('baby_monitor', 'open', `${i.nurseries} ${i.nurseries === 1 ? 'nursery' : 'nurseries'}`)
          : make('baby_monitor', 'open', 'Create a nursery or ask a parent to add you', { label: 'Set up a nursery', href: live('/live#/monitor') }),
  );
  return { confined, studios };
}

/** Loads the inputs for one user (service role) and computes the picture. Never throws: unknowns read as "no". */
export async function loadAccountAccess(user: { id: string; email?: string | null }): Promise<AccountAccess> {
  const db = getSupabaseAdmin();
  const safe = async <T>(p: PromiseLike<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch {
      return fallback;
    }
  };
  type Res<T> = { data: T | null; error: unknown };
  const [products, live, legacy, nurseries, profile, priv, plan, access] = await Promise.all([
    safe(db.from('product_access').select('product, active').eq('user_id', user.id) as unknown as PromiseLike<Res<{ product: string; active: boolean }[]>>, { data: [], error: null }),
    safe(db.from('live_profiles').select('display_name').eq('user_id', user.id).maybeSingle() as unknown as PromiseLike<Res<{ display_name: string | null }>>, { data: null, error: null }),
    safe(db.rpc('live__legacy_eligible', { p_uid: user.id }) as unknown as PromiseLike<Res<boolean>>, { data: false, error: null }),
    safe(db.from('monitor_members').select('nursery_id', { count: 'exact', head: true }).eq('user_id', user.id) as unknown as PromiseLike<Res<null> & { count?: number | null }>, { data: null, error: null, count: 0 }),
    safe(db.from('profiles').select('username, created_at').eq('id', user.id).maybeSingle() as unknown as PromiseLike<Res<{ username: string | null; created_at: string | null }>>, { data: null, error: null }),
    safe(db.from('profile_private').select('first_name, last_name').eq('id', user.id).maybeSingle() as unknown as PromiseLike<Res<{ first_name: string | null; last_name: string | null }>>, { data: null, error: null }),
    safe(db.from('user_plan_subscriptions').select('plan_tier').eq('user_id', user.id).maybeSingle() as unknown as PromiseLike<Res<{ plan_tier: string | null }>>, { data: null, error: null }),
    safe(resolveAccessProfile({ userId: user.id, email: user.email }), { isAdmin: false, isModerator: false, isResearcher: false, bootstrapAdmin: false, roles: [] }),
  ]);
  const computed = computeStudioAccess({
    productRows: Array.isArray(products.data) ? products.data : [],
    streamMember: !!live.data,
    streamGrandfathered: legacy.data === true,
    nurseries: (nurseries as { count?: number | null }).count ?? 0,
  });
  return {
    account: {
      id: user.id,
      email: user.email ?? null,
      name: resolveName({ live: live.data?.display_name, first: priv.data?.first_name, last: priv.data?.last_name, username: profile.data?.username }),
      username: profile.data?.username ?? null,
      since: profile.data?.created_at ?? null,
      plan: plan.data?.plan_tier ?? null,
      admin: access.isAdmin,
    },
    ...computed,
  };
}
