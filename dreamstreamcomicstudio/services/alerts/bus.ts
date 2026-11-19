// The alert core (notify SPEC §2.3, §6 NF-1 "Bus API"): the one place every source hands its moments to. It binds the
// pure rules (rules.ts) to this page: the document's visibility and focus, the target the person is looking at, the ds
// toast slot, the chime, and the tab-title count. It never makes a network request and starts no timer that calls
// /api (the only timer is the rules' 400 ms chime window). The comics host and the main site each run their own core:
// nothing here crosses hosts (§5.10).
//
// The API (small and stable; NF-2's Comic Studio sources and the live-turn stream registry build on it):
//   startAlerts({ accountId, open, track? })  AlertsHost, once a person is signed in (a new account starts afresh)
//   stopAlerts()                              sign-out: what waited is dropped, the count clears, audio closes,
//                                             and every onAlertsStop hook runs (a held comic stream aborts there)
//   postAlert(draft)                          a source's moment (types.ts AlertDraft); ignored while stopped
//   setLooking(target | null, owner)          a source says what is open in it; each owner clears only its own
//   isLooking(target) / lookingTarget()       the tab is visible and focused and that target is open
//   onLookingChange(fn)                       told when the target, the visibility or the focus changes
//   playChimeNow(tier, { gesture?, after?, prefs? })  the Play button and the classic generator (honours the prefs)
//   onAlertsStop(fn)                          run once at every stopAlerts (returns the unsubscribe)
// Open on a toast only navigates (`open(target)`); it never runs an action or a spend.

import { dismissToast, subscribeToastSlot, toast, toastSlotBusy } from '../../components/ds/Toast';
import { closeAudio, syncAudioToSound, unlockAudio } from './audio';
import { playChime } from './chime';
import { loadAlertPrefs, subscribeAlertPrefs } from './prefs';
import { createAlertRules, type AlertRules, type AlertToastSpec } from './rules';
import { setTabBadge } from './tabBadge';
import { sameTarget, type AlertDraft, type AlertKind, type AlertPrefs, type AlertTarget, type ChimeTier } from './types';

export interface StartAlertsOptions {
  /** The signed-in person (a different id starts afresh). */
  accountId: string;
  /** Navigate to a comic or a chat (Open on a toast). */
  open(target: AlertTarget): void;
  /** Counts an Open (the host passes telemetry in: the core sends nothing itself). Kind only: no title, no id. */
  track?(eventType: 'alert_open', metadata: { kind: AlertKind }): void;
}

interface Running {
  accountId: string;
  open: StartAlertsOptions['open'];
  track?: StartAlertsOptions['track'];
  rules: AlertRules;
  offs: (() => void)[];
}

let running: Running | null = null;
let looking: { target: AlertTarget; owner: string } | null = null;
const lookingListeners = new Set<() => void>();
const stopHooks = new Set<() => void>();
/** The alert toast on screen, and the targets it is about (it goes once the person opens them). */
let shown: { id: number; targets: AlertTarget[] } | null = null;

const pageVisible = (): boolean => {
  try {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden';
  } catch {
    return true;
  }
};
const pageFocused = (): boolean => {
  try {
    return typeof document === 'undefined' || document.hasFocus();
  } catch {
    return true;
  }
};

const each = (fns: Iterable<() => void>) => {
  for (const fn of Array.from(fns)) {
    try {
      fn();
    } catch {
      /* one listener never stops the others */
    }
  }
};

// ── Looking ──────────────────────────────────────────────────────────────────

/** The person is looking at this target: the tab is visible, the window focused, and a source has it open. */
export const isLooking = (target: AlertTarget): boolean => !!looking && sameTarget(looking.target, target) && pageVisible() && pageFocused();

/** The target a source has open now (whatever the tab's visibility). */
export const lookingTarget = (): AlertTarget | null => (looking ? { ...looking.target } : null);

const lookingChanged = () => {
  each(lookingListeners);
  if (shown && shown.targets.length && shown.targets.every((t) => isLooking(t))) {
    const id = shown.id;
    shown = null;
    dismissToast(id);
  }
};

/** A source says what is open in it (`null` to clear); an owner clears only the target it set. */
export function setLooking(target: AlertTarget | null, owner: string): void {
  if (target) {
    if (looking && looking.owner === owner && sameTarget(looking.target, target)) return;
    looking = { target: { app: target.app, id: target.id }, owner };
  } else {
    if (!looking || looking.owner !== owner) return;
    looking = null;
  }
  lookingChanged();
}

/** Told when the looked-at target, the tab's visibility or the window's focus changes. */
export function onLookingChange(fn: () => void): () => void {
  lookingListeners.add(fn);
  return () => void lookingListeners.delete(fn);
}

// ── Output ───────────────────────────────────────────────────────────────────

const showToast = (spec: AlertToastSpec) => {
  let id = 0;
  const clear = () => {
    if (shown?.id === id) shown = null;
  };
  const handle = toast({
    title: spec.title,
    message: spec.message,
    tone: spec.tone,
    source: 'alert',
    action: {
      label: 'Open',
      onClick: () => {
        const run = running;
        if (!run) return;
        try {
          run.track?.('alert_open', { kind: spec.kind });
        } catch {
          /* counting never blocks the Open */
        }
        run.open(spec.target);
      }
    },
    onDismiss: clear,
    onLost: clear
  });
  id = handle.id;
  shown = { id, targets: spec.drafts.map((d) => d.target) };
};

// ── Start / stop ─────────────────────────────────────────────────────────────

/** Turns the core on for a signed-in person. A new account stops the old one first. */
export function startAlerts(options: StartAlertsOptions): void {
  if (running && running.accountId === options.accountId) {
    running.open = options.open;
    running.track = options.track;
    return;
  }
  if (running) stopAlerts();
  const rules = createAlertRules(
    {
      now: () => Date.now(),
      visible: pageVisible,
      focused: pageFocused,
      lookingAt: (t) => !!looking && sameTarget(looking.target, t),
      prefs: loadAlertPrefs,
      slotBusy: toastSlotBusy
    },
    {
      toast: showToast,
      chime: (tier) => void playChime(tier, loadAlertPrefs().volume),
      badge: setTabBadge
    }
  );
  const offs: (() => void)[] = [];
  const onPageChange = () => {
    rules.returned();
    lookingChanged();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onPageChange);
    offs.push(() => document.removeEventListener('visibilitychange', onPageChange));
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', onPageChange);
    window.addEventListener('blur', lookingChanged);
    offs.push(() => window.removeEventListener('focus', onPageChange));
    offs.push(() => window.removeEventListener('blur', lookingChanged));
    offs.push(subscribeAlertPrefs(() => syncAudioToSound(loadAlertPrefs().sound)));
  }
  offs.push(subscribeToastSlot(() => rules.slotFreed()));
  running = { accountId: options.accountId, open: options.open, track: options.track, rules, offs };
  syncAudioToSound(loadAlertPrefs().sound);
}

/** Sign-out: everything waiting is dropped, the tab count clears, the audio closes and the stop hooks run. */
export function stopAlerts(): void {
  const run = running;
  if (!run) return;
  running = null;
  each(run.offs);
  run.rules.reset();
  setTabBadge(0);
  closeAudio();
  if (shown) {
    const id = shown.id;
    shown = null;
    dismissToast(id);
  }
  each(stopHooks);
}

/** Whether the core is on (a person is signed in on this page). */
export const alertsRunning = (): boolean => !!running;

/** Run `fn` at every stopAlerts (sign-out or an account switch). Returns the unsubscribe. */
export function onAlertsStop(fn: () => void): () => void {
  stopHooks.add(fn);
  return () => void stopHooks.delete(fn);
}

/** A source's moment. Ignored while the core is off. */
export function postAlert(draft: AlertDraft): void {
  if (!running || !draft) return;
  try {
    running.rules.post(draft);
  } catch {
    /* an alert never breaks the work it reports */
  }
}

export interface PlayChimeNowOptions {
  /** Called from a press (the Play button): unlocks the audio first. */
  gesture?: boolean;
  /** Seconds from now, in the same audio context (Ready, then Needs you, from one press). */
  after?: number;
  /** The sound and volume to play with (the Settings card passes its own store's); this browser's prefs otherwise. */
  prefs?: Pick<AlertPrefs, 'sound' | 'volume'>;
}

/** Plays a chime now if the sound is on, at the person's volume. Resolves whether it played. */
export async function playChimeNow(tier: ChimeTier, opts: PlayChimeNowOptions = {}): Promise<boolean> {
  const prefs = opts.prefs ?? loadAlertPrefs();
  if (!prefs.sound) return false;
  if (opts.gesture) unlockAudio();
  return playChime(tier, prefs.volume, { after: opts.after ?? 0 });
}
