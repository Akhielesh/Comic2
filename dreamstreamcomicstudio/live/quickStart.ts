/**
 * Quick start — the one-tap paths into the studio ("Instant meeting" / "Go live now").
 *
 * Pure helpers shared by Create, the Dashboard and the Studio:
 *  - auto titles, so a quick start never asks for a name first;
 *  - the defaults a quick start uses (everything else lives under Advanced);
 *  - the studio "intent" hand-off: a ONE-SHOT sessionStorage note telling the studio
 *    what the tap asked for (open the Invite sheet / count down to live). It is never
 *    put in the URL — a copied or reloaded studio link must not go live by itself;
 *  - share-or-copy for links (native share sheet on phones, clipboard elsewhere).
 */

export type QuickKind = 'meeting' | 'live';
/** What the studio should do once, right after a quick start. */
export type StudioIntent = QuickKind;

/** Settings a quick start uses unless the host changed them under Advanced. */
export const QUICK_DEFAULTS = { access: 'open', maxViewers: 100, cover: 0 } as const;

/** First word of a display name, for friendly titles ("Akhil Srirangam" → "Akhil"). */
export function firstName(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0]?.slice(0, 40) ?? '';
}

/**
 * Title for an event the host didn't name: "Akhil’s meeting · Oct 22" /
 * "Akhil’s live · Oct 22", or "Meeting · Oct 22" / "Live · Oct 22" with no name.
 */
export function autoTitle(kind: QuickKind, name: string | null | undefined, now = Date.now()): string {
  const day = new Date(now).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const who = firstName(name);
  const noun = kind === 'meeting' ? 'meeting' : 'live';
  return who ? `${who}’s ${noun} · ${day}` : `${noun[0].toUpperCase()}${noun.slice(1)} · ${day}`;
}

/** The one-line summary under the quick cards: "720p · Anyone with the link · up to 100 viewers · not recording". */
export function quickDefaultsLine(o: { quality: string; access: 'open' | 'approval'; maxViewers: number; autoRecord: boolean }): string {
  return [
    o.quality,
    o.access === 'approval' ? 'You approve each viewer' : 'Anyone with the link',
    `up to ${o.maxViewers} viewers`,
    o.autoRecord ? 'recording to this device' : 'not recording',
  ].join(' · ');
}

/* --------------------------------------------------------------- intents */

const INTENT_PREFIX = 'ds-live-intent:';
/** An intent older than this is stale (the tap was long ago) and ignored. */
export const INTENT_TTL_MS = 2 * 60_000;

export function setStudioIntent(id: string, intent: StudioIntent, now = Date.now()): void {
  try {
    sessionStorage.setItem(INTENT_PREFIX + id, JSON.stringify({ intent, at: now }));
  } catch {
    /* storage blocked — the studio simply opens as usual */
  }
}

/** Read AND clear the intent for an event: it acts once, then never again. */
export function takeStudioIntent(id: string, now = Date.now()): StudioIntent | null {
  try {
    const raw = sessionStorage.getItem(INTENT_PREFIX + id);
    if (raw == null) return null;
    sessionStorage.removeItem(INTENT_PREFIX + id);
    const v = JSON.parse(raw) as { intent?: unknown; at?: unknown };
    if (v.intent !== 'meeting' && v.intent !== 'live') return null;
    if (typeof v.at !== 'number' || now - v.at > INTENT_TTL_MS || v.at > now + 5_000) return null;
    return v.intent;
  } catch {
    return null;
  }
}

/* ------------------------------------------------- create-page hand-offs */

const SCHEDULE_KEY = 'ds-live-create-schedule';
const ADVANCED_KEY = 'ds-live-create-advanced';

/** "Schedule…" from the dashboard: open Create with Advanced → Schedule ready. */
export function requestScheduleOnCreate(): void {
  try {
    sessionStorage.setItem(SCHEDULE_KEY, '1');
  } catch {
    /* fine — Create still works, just not pre-opened */
  }
}

export function takeScheduleRequest(): boolean {
  try {
    const v = sessionStorage.getItem(SCHEDULE_KEY) === '1';
    sessionStorage.removeItem(SCHEDULE_KEY);
    return v;
  } catch {
    return false;
  }
}

/** Whether Create's Advanced section was left open last time. */
export function loadAdvancedOpen(): boolean {
  try {
    return localStorage.getItem(ADVANCED_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveAdvancedOpen(open: boolean): void {
  try {
    localStorage.setItem(ADVANCED_KEY, open ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

/* ----------------------------------------------------------------- share */

export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'failed';

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand?.('copy') ?? false;
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * The phone's share sheet when there is one (Messages, WhatsApp, Mail…), otherwise copy
 * to the clipboard. A dismissed share sheet is "cancelled" — not silently copied.
 */
export async function shareOrCopy(data: { title?: string; text?: string; url: string }, opts: { copyOnly?: boolean } = {}): Promise<ShareOutcome> {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  if (!opts.copyOnly && nav?.share && (nav.canShare?.(data) ?? true)) {
    try {
      await nav.share(data);
      return 'shared';
    } catch (e) {
      if ((e as { name?: string } | null)?.name === 'AbortError') return 'cancelled';
      /* share unsupported for this payload — copy instead */
    }
  }
  return (await copyText(data.url)) ? 'copied' : 'failed';
}
