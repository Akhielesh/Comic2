// @vitest-environment jsdom
// Who may open which Stream Studio screen (live/accessGate.ts): EVERY route view × EVERY account
// status, the one list of links that stay open without an account, and the real addresses people
// are sent or land on, through LiveApp's own parseRoute.
import { describe, expect, it } from 'vitest';
import type { AccountStatus } from './account';
import { GATED_ON_ENTRY, GUEST_PASS_ROUTES, LINK_ROUTES, gateFor, holdsGuestPass, isLinkRoute, statusForGate, type Gate, type RouteView } from './accessGate';

// Records, so adding a route view or an account status without deciding its gate fails to compile.
const VIEWS: Record<RouteView, 'link' | 'studio'> = {
  viewer: 'link',
  event: 'link',
  'event-auto': 'link',
  guest: 'link',
  'monitor-join': 'link',
  secure: 'link',
  dashboard: 'studio',
  create: 'studio',
  settings: 'studio',
  monitor: 'studio',
  calls: 'studio',
  nursery: 'studio',
  'monitor-camera': 'studio',
  'monitor-watch': 'studio',
  studio: 'studio',
  summary: 'studio',
  'summary-lookup': 'studio',
};
/** What a studio screen gets for each status. */
const STUDIO_GATE: Record<AccountStatus, Gate> = {
  loading: 'splash',
  signed_out: 'sign-in',
  needs_code: 'needs-code',
  needs_mfa: 'needs-mfa',
  member: 'open',
  offline: 'open',
};
const views = Object.keys(VIEWS) as RouteView[];
const statuses = Object.keys(STUDIO_GATE) as AccountStatus[];

describe('gateFor — every route view × every account status', () => {
  for (const view of views) {
    for (const status of statuses) {
      const want: Gate = VIEWS[view] === 'link' ? 'open' : STUDIO_GATE[status];
      it(`${view} · ${status} → ${want}`, () => {
        expect(gateFor(view, status)).toBe(want);
        // The same answer for the Route object LiveApp holds.
        expect(gateFor({ view }, status)).toBe(want);
      });
    }
  }
});

describe('the links people were sent — one list, open without an account', () => {
  it('is exactly the watch / invite page, a guest seat, a nursery share link and "Not you?"', () => {
    expect([...LINK_ROUTES].sort()).toEqual(['event', 'event-auto', 'guest', 'monitor-join', 'secure', 'viewer']);
    for (const view of views) expect(isLinkRoute(view)).toBe(VIEWS[view] === 'link');
  });

  it('a link opens in every state — signed out, while loading, before the welcome code, before the two-step code', () => {
    for (const view of LINK_ROUTES) for (const status of statuses) expect(gateFor(view, status)).toBe('open');
  });

  it('everything else — dashboard, create, settings, the monitor, calls, the host studio and recaps — needs the account', () => {
    const gated = views.filter((v) => !isLinkRoute(v)).sort();
    expect(gated).toEqual(['calls', 'create', 'dashboard', 'monitor', 'monitor-camera', 'monitor-watch', 'nursery', 'settings', 'studio', 'summary', 'summary-lookup']);
    for (const view of gated) expect(gateFor(view, 'signed_out')).toBe('sign-in');
  });
});

describe('a nursery share-link guest’s pass — its own watch page, in every account state', () => {
  it('opens only the watch page (a pass only ever watches)', () => {
    expect([...GUEST_PASS_ROUTES]).toEqual(['monitor-watch']);
  });

  it('with a pass, the watch page opens whatever the account says — signed out, loading, no code, code owed', () => {
    for (const status of statuses) expect(gateFor('monitor-watch', status, { guestPass: true })).toBe('open');
  });

  it('a pass opens no other studio screen; without one the watch page is gated like the rest', () => {
    for (const view of views.filter((v) => !isLinkRoute(v) && v !== 'monitor-watch')) {
      for (const status of statuses) expect([view, status, gateFor(view, status, { guestPass: true })]).toEqual([view, status, STUDIO_GATE[status]]);
    }
    for (const status of statuses) expect(gateFor('monitor-watch', status, { guestPass: false })).toBe(STUDIO_GATE[status]);
  });

  it('holdsGuestPass: this device’s pass for THAT nursery, on its watch page only', async () => {
    const NID = '11111111-2222-4333-8444-555555555555';
    const OTHER = '99999999-2222-4333-8444-555555555555';
    const pass = { token: 'gp-1', name: 'Jo', role: 'viewer', until: Date.now() + 86_400_000, nursery: { name: 'N', baby: null } };
    const { parseRoute } = await import('./LiveApp');
    const at = (path: string) => {
      history.replaceState(null, '', path);
      return holdsGuestPass(parseRoute());
    };
    localStorage.clear();
    expect(at(`/live#/monitor/${NID}/watch`)).toBe(false);
    localStorage.setItem(`ds-monitor-guest-${NID}`, JSON.stringify(pass));
    expect(at(`/live#/monitor/${NID}/watch`)).toBe(true);
    expect(at(`/live#/monitor/${OTHER}/watch`)).toBe(false);
    for (const path of [`/live#/monitor/${NID}/camera`, `/live#/monitor/${NID}`, `/live#/monitor/${NID}/invite`, '/live#/monitor', '/live']) {
      expect([path, at(path)]).toEqual([path, false]);
    }
    // A pass that can't still work (past its end by more than any pass lives) opens nothing.
    localStorage.setItem(`ds-monitor-guest-${NID}`, JSON.stringify({ ...pass, until: Date.now() - 200 * 86_400_000 }));
    expect(at(`/live#/monitor/${NID}/watch`)).toBe(false);
    localStorage.clear();
  });
});

describe('a running host studio is gated on entry only', () => {
  it('is the host studio alone', () => {
    expect([...GATED_ON_ENTRY]).toEqual(['studio']);
  });

  it('opening it asks for the account; once up, an account change never shuts it', () => {
    for (const status of statuses) {
      expect(gateFor('studio', status)).toBe(STUDIO_GATE[status]);
      expect(gateFor('studio', status, { running: true })).toBe('open');
    }
  });

  it('every other studio screen closes on a sign-out as before', () => {
    for (const view of views.filter((v) => !isLinkRoute(v) && v !== 'studio')) {
      for (const status of statuses) expect([view, status, gateFor(view, status, { running: true })]).toEqual([view, status, STUDIO_GATE[status]]);
    }
  });
});

describe('safety: only a definite answer gates', () => {
  it('offline (a session the server couldn’t confirm, or no auth client) and member never gate any screen', () => {
    for (const view of views) {
      expect(gateFor(view, 'offline')).toBe('open');
      expect(gateFor(view, 'member')).toBe('open');
    }
  });

  it('loading is the splash — never the dashboard, never the sign-in screen', () => {
    for (const view of views.filter((v) => !isLinkRoute(v))) expect(gateFor(view, 'loading')).toBe('splash');
  });

  it('a status it doesn’t know is not an answer: the screen stays open', () => {
    expect(gateFor('monitor-camera', 'something-new' as AccountStatus)).toBe('open');
  });
});

describe('statusForGate — a sign-in link being finished', () => {
  it('holds the splash instead of flashing "sign in" while the link signs the person in', () => {
    expect(statusForGate('signed_out', { authPending: true })).toBe('loading');
    expect(gateFor('dashboard', statusForGate('signed_out', { authPending: true }))).toBe('splash');
  });

  it('changes nothing else', () => {
    for (const s of statuses) {
      expect(statusForGate(s)).toBe(s);
      expect(statusForGate(s, { authPending: false })).toBe(s);
      if (s !== 'signed_out') expect(statusForGate(s, { authPending: true })).toBe(s);
    }
  });
});

describe('real addresses, through LiveApp’s parseRoute', () => {
  const NID = '11111111-2222-4333-8444-555555555555';
  const at = async (path: string) => {
    history.replaceState(null, '', path);
    const { parseRoute } = await import('./LiveApp');
    return parseRoute();
  };

  it('every link people are sent opens signed out', async () => {
    const sent = [
      '/live?e=ev1', // the share / invite link (scheduled → invite page, otherwise the watch page)
      '/live?e=ev1#/watch',
      '/live?e=ev1#/event',
      '/live?e=ev1#/guest?g=guestkey&m=1', // a meeting guest seat
      '/live?e=ev1&g=guestkey', // an older guest link
      `/live#/monitor/join/${NID}/${'c'.repeat(24)}`, // a nursery share link (+ the passcode, typed)
      '/live#/secure/tok_abcdefghijklmnopqrstuvwxyz0123', // "Not you?" from a new-sign-in email
      '/#/secure/tok_abcdefghijklmnopqrstuvwxyz0123', // …on Stream Studio's own host
    ];
    for (const path of sent) {
      const route = await at(path);
      expect([path, gateFor(route, 'signed_out')]).toEqual([path, 'open']);
    }
  });

  it('the studio itself asks for the account', async () => {
    const studio = [
      '/live',
      '/',
      '/live#/create',
      '/live#/settings',
      '/live#/account',
      '/live#/settings?s=security',
      '/live#/monitor',
      `/live#/monitor/${NID}`,
      `/live#/monitor/${NID}/invite`,
      `/live#/monitor/${NID}/camera`,
      `/live#/monitor/${NID}/watch`,
      '/live#/calls',
      `/live#/call/${NID}/abcdef0123456789`, // a ringing call's notification
      '/live#/call/d/abcdef0123456789',
      '/live?e=ev1#/studio?k=hostkey', // the private host link
      '/live?e=ev1&k=hostkey', // …its older form
      '/live?e=ev1#/summary?k=hostkey',
      '/live#/summary/ev1',
    ];
    for (const path of studio) {
      const route = await at(path);
      expect([path, gateFor(route, 'signed_out')]).toEqual([path, 'sign-in']);
      expect([path, gateFor(route, 'member')]).toEqual([path, 'open']);
    }
  });
});
