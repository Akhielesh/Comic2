// The alert rules (notify SPEC §2.1, §5.3): given where the person is, decide what one alert becomes. Pure decisions
// over an injected page (visible, focused, what they look at, their prefs, whether someone else's toast is on screen)
// and injected outputs (a toast, a chime, the tab count), so every row of §2.1 is a unit test. bus.ts binds it to the
// real document, the ds toast slot, the audio and the tab title.
//
//   looking at it (tab visible, window focused, that comic or chat open)   nothing
//   elsewhere in the app, visible and focused                              toast + chime
//   visible, window not focused                                            toast + chime + "(n) " on the tab
//   tab hidden                                                             chime + "(n) "; the toast when they return
//
// Also: "Only when I'm needed" passes needs-you and failure kinds only; alerts within 400 ms share one chime and Needs
// you wins; at most one chime every 4 s; the same key never twice (the 200 newest kept); while away at most 10 alerts
// wait and come back as one toast, or a summary of several, without the ones about what the person now looks at; two
// alert toasts within 8 s become the summary; an alert toast waits while someone else's toast is on screen and shows
// when the slot frees (no timer), unless it is older than 60 s. The only timer is the 400 ms chime window, and it
// exists only while a chime is due.

import { alertCopy, byUrgency, summaryCopy } from './copy';
import { passesLevel, tierOf, toneOf, type AlertDraft, type AlertKind, type AlertPrefs, type AlertTarget, type AlertTone, type ChimeTier } from './types';

export const ALERT_RULES = Object.freeze({
  coalesceMs: 400,
  chimeGapMs: 4000,
  pendingMax: 10,
  summaryWindowMs: 8000,
  holdMaxMs: 60_000,
  keysMax: 200
});

export interface RulesEnv {
  now(): number;
  visible(): boolean;
  focused(): boolean;
  /** The target the person has open now (a source set it), regardless of visibility and focus. */
  lookingAt(target: AlertTarget): boolean;
  prefs(): AlertPrefs;
  /** Someone else's toast is on screen (a non-alert app toast, a timeline Undo, a History restore). */
  slotBusy(): boolean;
}

/** One toast to show: the copy, its tone, where Open goes and which alerts it stands for. */
export interface AlertToastSpec {
  title: string;
  message: string;
  tone: AlertTone;
  /** The most urgent alert's target: where Open goes. */
  target: AlertTarget;
  /** The most urgent alert's kind (what Open counts). */
  kind: AlertKind;
  drafts: readonly AlertDraft[];
}

export interface RulesOutput {
  toast(spec: AlertToastSpec): void;
  chime(tier: ChimeTier): void;
  badge(count: number): void;
}

/** What post() did with an alert (for tests and the docs; the bus ignores it). */
export type PostOutcome = 'duplicate' | 'level' | 'looking' | 'shown' | 'held' | 'pending';

export interface AlertRules {
  post(draft: AlertDraft): PostOutcome;
  /** The tab became visible or the window took focus: show what waited, clear the count. */
  returned(): void;
  /** The toast slot changed: a held alert toast may show now. */
  slotFreed(): void;
  /** Sign-out or a new account: forget everything waiting, clear the count, cancel a due chime. */
  reset(): void;
}

interface Pending {
  draft: AlertDraft;
  shown: boolean;
}

export function createAlertRules(env: RulesEnv, out: RulesOutput): AlertRules {
  const keys = new Set<string>();
  let pending: Pending[] = [];
  /** Alerts that arrived while away, past the cap included (the count and the summary say them all). */
  let missed = 0;
  let recent: { draft: AlertDraft; at: number }[] = [];
  let held: { spec: AlertToastSpec; at: number } | null = null;
  let chimeDue: ChimeTier | null = null;
  let chimeTimer: ReturnType<typeof setTimeout> | null = null;
  let lastChimeAt = -Infinity;

  const remember = (key: string) => {
    keys.delete(key);
    keys.add(key);
    while (keys.size > ALERT_RULES.keysMax) keys.delete(keys.values().next().value as string);
  };

  const single = (draft: AlertDraft): AlertToastSpec => ({ ...alertCopy(draft), tone: toneOf(draft.kind), target: draft.target, kind: draft.kind, drafts: [draft] });
  const summary = (drafts: readonly AlertDraft[], total = drafts.length): AlertToastSpec => {
    const lead = byUrgency(drafts)[0];
    return { ...summaryCopy(drafts, total), tone: toneOf(lead.kind), target: lead.target, kind: lead.kind, drafts };
  };

  const show = (spec: AlertToastSpec) => {
    if (env.slotBusy()) {
      held = { spec, at: env.now() };
      return false;
    }
    held = null;
    out.toast(spec);
    return true;
  };

  const chime = (tier: ChimeTier) => {
    if (!env.prefs().sound) return;
    chimeDue = chimeDue === 'needsYou' || tier === 'needsYou' ? 'needsYou' : 'ready';
    if (chimeTimer) return;
    chimeTimer = setTimeout(() => {
      chimeTimer = null;
      const due = chimeDue;
      chimeDue = null;
      const now = env.now();
      if (!due || now - lastChimeAt < ALERT_RULES.chimeGapMs || !env.prefs().sound) return;
      lastChimeAt = now;
      out.chime(due);
    }, ALERT_RULES.coalesceMs);
  };

  const looking = (target: AlertTarget) => env.visible() && env.focused() && env.lookingAt(target);

  const showNow = (draft: AlertDraft): PostOutcome => {
    const now = env.now();
    recent = recent.filter((r) => now - r.at < ALERT_RULES.summaryWindowMs);
    recent.push({ draft, at: now });
    const spec = recent.length >= 2 ? summary(recent.map((r) => r.draft)) : single(draft);
    return show(spec) ? 'shown' : 'held';
  };

  return {
    post(draft) {
      if (!draft || typeof draft.key !== 'string' || !draft.target) return 'duplicate';
      if (keys.has(draft.key)) return 'duplicate';
      remember(draft.key);
      if (!passesLevel(draft.kind, env.prefs().level)) return 'level';
      if (looking(draft.target)) return 'looking';
      chime(tierOf(draft.kind));
      const visible = env.visible();
      const away = !visible || !env.focused();
      let outcome: PostOutcome = 'pending';
      if (visible) outcome = showNow(draft);
      if (away) {
        pending.push({ draft, shown: visible });
        if (pending.length > ALERT_RULES.pendingMax) pending = pending.slice(-ALERT_RULES.pendingMax);
        missed += 1;
        out.badge(missed);
      }
      return outcome;
    },

    returned() {
      if (!env.visible() || !env.focused()) return;
      const kept = pending.filter((p) => !env.lookingAt(p.draft.target));
      const unshown = kept.filter((p) => !p.shown).map((p) => p.draft);
      // Alerts past the cap were never shown either; they are counted in the summary's number.
      const overflow = Math.max(0, missed - pending.length);
      const hadCount = missed > 0;
      pending = [];
      missed = 0;
      if (hadCount) out.badge(0);
      if (!unshown.length) return;
      const total = unshown.length + overflow;
      show(total > 1 ? summary(unshown, total) : single(unshown[0]));
    },

    slotFreed() {
      if (!held || env.slotBusy()) return;
      const { spec, at } = held;
      if (env.now() - at > ALERT_RULES.holdMaxMs || spec.drafts.every((d) => looking(d.target))) {
        held = null;
        return;
      }
      held = null;
      out.toast(spec);
    },

    reset() {
      pending = [];
      recent = [];
      held = null;
      chimeDue = null;
      if (chimeTimer) clearTimeout(chimeTimer);
      chimeTimer = null;
      if (missed > 0) out.badge(0);
      missed = 0;
    }
  };
}

