// The alert vocabulary (notify SPEC §2.2, §5.3): what a source tells the alert core, and how each kind sounds and looks.
// Pure data, no browser. Every source (Comic Studio while it is open or after you leave it, Chat, the classic generator)
// posts an AlertDraft; services/alerts/bus.ts decides from where the person is whether it becomes a toast, a chime and
// a "(n) " on the tab title. A draft carries the person's own comic or chat title and counts, never model-written text
// and never a price (copy.ts turns it into fixed phrases).

/** Which app a target lives in. Comic alerts appear on the comics host, Chat alerts on the main site (§5.10). */
export type AlertApp = 'comic' | 'chat';

/** The thing an alert is about: a comic (project id) or a chat (session id). */
export interface AlertTarget {
  app: AlertApp;
  id: string;
}

export const sameTarget = (a: AlertTarget | null | undefined, b: AlertTarget | null | undefined): boolean =>
  !!a && !!b && a.app === b.app && a.id === b.id;

/** The moments (§2.2). */
export type AlertKind =
  | 'reply'
  | 'question'
  | 'plan'
  | 'approval'
  | 'style'
  | 'drawn'
  | 'drawn_issues'
  | 'translated'
  | 'translate_issues'
  | 'published'
  | 'publish_failed'
  | 'failed'
  | 'chat_reply'
  | 'chat_question'
  | 'chat_confirm'
  | 'chat_failed';

export const ALERT_KINDS: readonly AlertKind[] = [
  'reply',
  'question',
  'plan',
  'approval',
  'style',
  'drawn',
  'drawn_issues',
  'translated',
  'translate_issues',
  'published',
  'publish_failed',
  'failed',
  'chat_reply',
  'chat_question',
  'chat_confirm',
  'chat_failed'
];

/** The two chimes: "Ready" (a rising fifth) and "Needs you" (a lower rising minor third). */
export type ChimeTier = 'ready' | 'needsYou';

/** Kinds that mean the person is waited on (a question, an approval, a plan, looks to pick). */
const NEEDS: ReadonlySet<AlertKind> = new Set<AlertKind>(['question', 'plan', 'approval', 'style', 'chat_question', 'chat_confirm']);
/** Kinds that mean something did not finish as asked. */
const FAILURES: ReadonlySet<AlertKind> = new Set<AlertKind>(['drawn_issues', 'translate_issues', 'publish_failed', 'failed', 'chat_failed']);

export const isNeedsKind = (kind: AlertKind): boolean => NEEDS.has(kind);
export const isFailureKind = (kind: AlertKind): boolean => FAILURES.has(kind);

/** Needs-you and failure kinds chime "Needs you"; everything else chimes "Ready" (§2.2). */
export const tierOf = (kind: AlertKind): ChimeTier => (NEEDS.has(kind) || FAILURES.has(kind) ? 'needsYou' : 'ready');

/** The toast's status (§5.3): Ready kinds healthy, needs-you kinds waiting, failures attention (polite, never an alert role). */
export type AlertTone = 'healthy' | 'waiting' | 'attention';
export const toneOf = (kind: AlertKind): AlertTone => (FAILURES.has(kind) ? 'attention' : NEEDS.has(kind) ? 'waiting' : 'healthy');

/** What a source posts. Facts only: the copy is fixed phrases around them (copy.ts). */
export interface AlertDraft {
  kind: AlertKind;
  /** Dedupe key: the same key never alerts twice (message, card, gate ids, so a replayed stream agrees). */
  key: string;
  target: AlertTarget;
  /** The person's own comic or chat title (copy clips it; empty means "Your comic" / "Your chat"). */
  title?: string;
  /** drawn / drawn_issues: pictures drawn. */
  count?: number;
  /** drawn_issues: pictures that need a look. */
  failedCount?: number;
  /** drawn: true when not every drawn picture is a page ("Pictures are ready"). */
  pictures?: boolean;
  /** approval: pictures waiting to be drawn (omitted when unknown). */
  imageCount?: number;
  /** translated / translate_issues: language tags (copy names them). */
  languages?: readonly string[];
}

/** The person's alert settings, per browser (prefs.ts). */
export type AlertVolume = 'soft' | 'normal';
export type AlertLevel = 'all' | 'needs';
export interface AlertPrefs {
  /** Play a chime. */
  sound: boolean;
  volume: AlertVolume;
  /** 'needs': only needs-you and failure kinds produce anything. */
  level: AlertLevel;
}

export const DEFAULT_ALERT_PREFS: AlertPrefs = Object.freeze({ sound: true, volume: 'normal', level: 'all' }) as AlertPrefs;

/** Whether a kind passes the person's level. */
export const passesLevel = (kind: AlertKind, level: AlertLevel): boolean => level === 'all' || tierOf(kind) === 'needsYou';
