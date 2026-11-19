// The alert rules (notify SPEC §2.1, §5.3) on a fake page: where the person is decides between nothing, a toast and a
// chime, and the "(n) " count; the level setting; one chime for alerts within 400 ms (Needs you wins) and at most one
// every 4 s; a key never alerts twice; at most 10 alerts wait while away and come back as one toast or a summary; an
// alert toast waits while someone else's toast is on screen and is dropped after 60 s.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALERT_RULES, createAlertRules, type AlertToastSpec } from './rules';
import { DEFAULT_ALERT_PREFS, type AlertDraft, type AlertKind, type AlertPrefs, type AlertTarget, type ChimeTier } from './types';

const SPICE: AlertTarget = { app: 'comic', id: 'p_spice' };
const NIGHT: AlertTarget = { app: 'comic', id: 'p_night' };
const CHAT: AlertTarget = { app: 'chat', id: 'c_1' };

let seq = 0;
const draft = (kind: AlertKind, target: AlertTarget = SPICE, extra: Partial<AlertDraft> = {}): AlertDraft => ({
  kind,
  key: `k${(seq += 1)}`,
  target,
  title: target === SPICE ? 'Spice Market' : target === NIGHT ? 'Night Shift' : 'Weekend plans',
  ...extra
});

interface Page {
  visible: boolean;
  focused: boolean;
  looking: AlertTarget | null;
  prefs: AlertPrefs;
  busy: boolean;
}
let page: Page;
let toasts: AlertToastSpec[];
let chimes: ChimeTier[];
let badges: number[];

const make = () =>
  createAlertRules(
    {
      now: () => Date.now(),
      visible: () => page.visible,
      focused: () => page.focused,
      lookingAt: (t) => !!page.looking && page.looking.app === t.app && page.looking.id === t.id,
      prefs: () => page.prefs,
      slotBusy: () => page.busy
    },
    {
      toast: (spec) => toasts.push(spec),
      chime: (tier) => chimes.push(tier),
      badge: (n) => badges.push(n)
    }
  );

const lastBadge = () => badges.at(-1) ?? 0;
const settleChime = () => vi.advanceTimersByTime(ALERT_RULES.coalesceMs);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_760_000_000_000);
  page = { visible: true, focused: true, looking: null, prefs: { ...DEFAULT_ALERT_PREFS }, busy: false };
  toasts = [];
  chimes = [];
  badges = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('where the person is (§2.1)', () => {
  it('looking at it (visible, focused, that comic open): nothing at all', () => {
    const rules = make();
    page.looking = SPICE;
    expect(rules.post(draft('reply'))).toBe('looking');
    settleChime();
    expect(toasts).toEqual([]);
    expect(chimes).toEqual([]);
    expect(badges).toEqual([]);
  });

  it('elsewhere in the app, visible and focused: a toast and a chime, no title count', () => {
    const rules = make();
    page.looking = NIGHT;
    expect(rules.post(draft('reply'))).toBe('shown');
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ title: 'The Director replied', message: 'Spice Market', tone: 'healthy', target: SPICE, kind: 'reply' });
    settleChime();
    expect(chimes).toEqual(['ready']);
    expect(lastBadge()).toBe(0);
  });

  it('visible but not focused (another window on top): a toast, a chime and the title count — even on that comic', () => {
    const rules = make();
    page.focused = false;
    page.looking = SPICE;
    rules.post(draft('question'));
    expect(toasts).toHaveLength(1);
    expect(toasts[0].tone).toBe('waiting');
    settleChime();
    expect(chimes).toEqual(['needsYou']);
    expect(lastBadge()).toBe(1);
    // Back: the count clears and the toast already shown is not shown again.
    page.focused = true;
    rules.returned();
    expect(lastBadge()).toBe(0);
    expect(toasts).toHaveLength(1);
  });

  it('tab hidden: a chime and the count now, one toast when the person comes back', () => {
    const rules = make();
    page.visible = false;
    page.focused = false;
    expect(rules.post(draft('drawn', SPICE, { count: 6 }))).toBe('pending');
    settleChime();
    expect(toasts).toEqual([]);
    expect(chimes).toEqual(['ready']);
    expect(lastBadge()).toBe(1);
    // Visible but not yet focused: still away.
    page.visible = true;
    rules.returned();
    expect(toasts).toEqual([]);
    page.focused = true;
    rules.returned();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ title: 'Pages are ready', message: 'Spice Market: 6 drawn' });
    expect(lastBadge()).toBe(0);
  });
});

describe('level, sound and dedupe', () => {
  it('"Only when I’m needed": Ready kinds give nothing; needs-you and failures still alert', () => {
    page.prefs = { ...page.prefs, level: 'needs' };
    const rules = make();
    expect(rules.post(draft('reply'))).toBe('level');
    expect(rules.post(draft('drawn', SPICE, { count: 2 }))).toBe('level');
    expect(rules.post(draft('chat_reply', CHAT))).toBe('level');
    expect(toasts).toEqual([]);
    rules.post(draft('approval', SPICE, { imageCount: 3 }));
    expect(toasts).toHaveLength(1);
    vi.advanceTimersByTime(10_000);
    rules.post(draft('chat_failed', CHAT));
    expect(toasts).toHaveLength(2);
  });

  it('sound off: the toast still shows, no chime', () => {
    page.prefs = { ...page.prefs, sound: false };
    const rules = make();
    rules.post(draft('reply'));
    settleChime();
    expect(toasts).toHaveLength(1);
    expect(chimes).toEqual([]);
  });

  it('the same key never alerts twice (also after it was quiet because the person was looking)', () => {
    const rules = make();
    page.looking = SPICE;
    const d = draft('reply');
    rules.post(d);
    page.looking = null;
    expect(rules.post({ ...d })).toBe('duplicate');
    const e = draft('reply', NIGHT);
    expect(rules.post(e)).toBe('shown');
    expect(rules.post({ ...e })).toBe('duplicate');
    expect(toasts).toHaveLength(1);
  });

  it('remembers the 200 newest keys', () => {
    const rules = make();
    page.looking = SPICE;
    const first = draft('reply');
    rules.post(first);
    for (let i = 0; i < ALERT_RULES.keysMax; i += 1) rules.post(draft('reply'));
    page.looking = null;
    expect(rules.post({ ...first })).toBe('shown');
  });
});

describe('chimes', () => {
  it('alerts within 400 ms share one chime, and Needs you wins', () => {
    const rules = make();
    rules.post(draft('reply'));
    vi.advanceTimersByTime(150);
    rules.post(draft('question', NIGHT));
    vi.advanceTimersByTime(100);
    rules.post(draft('chat_reply', CHAT));
    expect(chimes).toEqual([]);
    vi.advanceTimersByTime(ALERT_RULES.coalesceMs);
    expect(chimes).toEqual(['needsYou']);
  });

  it('at most one chime every 4 s', () => {
    const rules = make();
    rules.post(draft('reply'));
    settleChime();
    vi.advanceTimersByTime(1000);
    rules.post(draft('reply', NIGHT));
    settleChime();
    expect(chimes).toEqual(['ready']);
    vi.advanceTimersByTime(ALERT_RULES.chimeGapMs);
    rules.post(draft('question', CHAT));
    settleChime();
    expect(chimes).toEqual(['ready', 'needsYou']);
  });

  it('no timer is left once a chime has played (an idle page runs none)', () => {
    const rules = make();
    rules.post(draft('reply'));
    expect(vi.getTimerCount()).toBe(1);
    settleChime();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('while away and on return', () => {
  it('keeps at most 10 alerts; the count says how many came; the return toast is one summary', () => {
    const rules = make();
    page.visible = false;
    page.focused = false;
    for (let i = 0; i < 12; i += 1) rules.post(draft(i === 3 ? 'question' : 'reply', i % 2 ? NIGHT : CHAT, { title: `Comic ${i}` }));
    expect(lastBadge()).toBe(12);
    page.visible = true;
    page.focused = true;
    rules.returned();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('12 updates');
    expect(toasts[0].drafts).toHaveLength(ALERT_RULES.pendingMax);
    // The oldest two went past the cap; the question (the 4th) is still there and is the most urgent: Open goes there.
    expect(toasts[0].kind).toBe('question');
    expect(toasts[0].target).toEqual(NIGHT);
    expect(lastBadge()).toBe(0);
  });

  it('on return, an alert about what the person now looks at is dropped; one left shows as itself', () => {
    const rules = make();
    page.visible = false;
    page.focused = false;
    rules.post(draft('reply', SPICE));
    rules.post(draft('drawn', NIGHT, { count: 3 }));
    page.visible = true;
    page.focused = true;
    page.looking = SPICE;
    rules.returned();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ title: 'Pages are ready', target: NIGHT });
  });

  it('nothing pending: coming back shows nothing and clears the count', () => {
    const rules = make();
    rules.returned();
    expect(toasts).toEqual([]);
  });
});

describe('the toast slot', () => {
  it('two alert toasts within 8 s become the summary; later ones start afresh', () => {
    const rules = make();
    rules.post(draft('reply', SPICE));
    vi.advanceTimersByTime(3000);
    rules.post(draft('chat_question', CHAT));
    expect(toasts).toHaveLength(2);
    expect(toasts[1]).toMatchObject({ title: '2 updates', kind: 'chat_question', target: CHAT });
    vi.advanceTimersByTime(ALERT_RULES.summaryWindowMs + 1);
    rules.post(draft('reply', NIGHT));
    expect(toasts[2]).toMatchObject({ title: 'The Director replied', message: 'Night Shift' });
  });

  it('waits while another toast is on screen (an Undo), shows when the slot frees', () => {
    const rules = make();
    page.busy = true;
    expect(rules.post(draft('reply'))).toBe('held');
    settleChime();
    expect(chimes).toEqual(['ready']); // the chime does not wait
    expect(toasts).toEqual([]);
    rules.slotFreed(); // still busy: nothing
    expect(toasts).toEqual([]);
    page.busy = false;
    rules.slotFreed();
    expect(toasts).toHaveLength(1);
    rules.slotFreed();
    expect(toasts).toHaveLength(1);
  });

  it('a held toast older than 60 s is dropped', () => {
    const rules = make();
    page.busy = true;
    rules.post(draft('reply'));
    vi.advanceTimersByTime(ALERT_RULES.holdMaxMs + 1);
    page.busy = false;
    rules.slotFreed();
    expect(toasts).toEqual([]);
  });

  it('a held toast whose target is now looked at is dropped', () => {
    const rules = make();
    page.busy = true;
    rules.post(draft('reply', SPICE));
    page.looking = SPICE;
    page.busy = false;
    rules.slotFreed();
    expect(toasts).toEqual([]);
  });

  it('only the newest alert toast is held', () => {
    const rules = make();
    page.busy = true;
    rules.post(draft('reply', SPICE));
    vi.advanceTimersByTime(10_000);
    rules.post(draft('question', NIGHT));
    page.busy = false;
    rules.slotFreed();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ kind: 'question', target: NIGHT });
  });
});

describe('reset (sign-out)', () => {
  it('forgets what was waiting and clears the count', () => {
    const rules = make();
    page.visible = false;
    page.focused = false;
    rules.post(draft('reply'));
    rules.reset();
    expect(lastBadge()).toBe(0);
    page.visible = true;
    page.focused = true;
    rules.returned();
    expect(toasts).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
