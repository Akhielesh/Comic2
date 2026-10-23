/** Studio preferences (Customize screen) — persisted locally, applied at go-live. */

export type CameraLook = 'none' | 'soften' | 'warm' | 'mono';
export type AlertSound = 'soft' | 'off';

export interface StudioPrefs {
  /** Default quality preset id for new events. */
  qualityId: string;
  /** Override the preset's video bitrate (bps); 0 = use the preset value. */
  videoBpsOverride: number;
  /** Frame rate for the program canvas. */
  fps: number;
  /** Prefer mp4/h264 recording when the browser supports both containers. */
  preferMp4: boolean;
  /** Record the local master at ~2.5× the stream bitrate. */
  recordHighBitrate: boolean;
  /** Camera look burned into the program feed. */
  look: CameraLook;
  /** Screen + cam scene: where the camera sits and how big. */
  pipPos: 'br' | 'bl' | 'tr' | 'tl' | 'side';
  pipSize: 'sm' | 'md' | 'lg';
  /** Show the chat rail when the studio opens. */
  chatOpen: boolean;
  /** Floating emoji over the program preview. */
  floatingReactions: boolean;
  /** The six one-tap reactions viewers see (sent to the room when you go live). */
  quickReactions: string[];
  /** Viewers wait this many seconds between messages (0 = off). */
  slowSec: number;
  /** Toast when someone joins the lobby / gets admitted. */
  alertJoins: boolean;
  /** Toast on viewer milestones (10 / 25 / 50 / 100 …). */
  alertMilestones: boolean;
  alertSound: AlertSound;
  /** Auto-start the local recording when going live. */
  autoRecord: boolean;
  /** Also upload finished recordings to the event's 7-day server store. OFF by
   *  default (ADR 0007): Google Drive and this device are free; a cloud copy uses
   *  our storage and the host's upload, so it only happens when the host opts in. */
  cloudRecordings: boolean;
  /** Host display name, reused across events. */
  hostName: string;
  /** Self-view mirroring: auto = front camera in Solo only (the program out
   *  is never mirrored — this is purely how YOU see yourself). */
  mirrorPreview: 'auto' | 'on' | 'off';
  /** Where finished recordings go: ask every time, or a remembered default. */
  saveTarget: 'ask' | 'picker' | 'drive' | 'download';
  /** Recording length limit in minutes (0 = none). Alerts at 5 min / 1 min, then auto-stop + save. */
  recLimitMin: number;
  /** Stream length limit in minutes (0 = none). Alerts at 5 min / 1 min, then the stream ends. */
  streamLimitMin: number;
  /** Shape of the saved prefs (see migratePrefs). Saved prefs without it are version 1. */
  prefsVersion: number;
}

/**
 * 2 = the 7-day cloud copy became opt-in. Version-1 prefs saved the whole object,
 * default `cloudRecordings: true` included, so a stored `true` can't be told apart
 * from a choice; from version 2 on, whatever is stored was chosen.
 */
export const PREFS_VERSION = 2;

export const DEFAULT_PREFS: StudioPrefs = {
  qualityId: '720p',
  videoBpsOverride: 0,
  fps: 30,
  preferMp4: true,
  recordHighBitrate: true,
  look: 'none',
  pipPos: 'br',
  pipSize: 'md',
  chatOpen: true,
  floatingReactions: true,
  quickReactions: ['❤️', '🔥', '👏', '😂', '🤯', '🎉'],
  slowSec: 0,
  alertJoins: true,
  alertMilestones: true,
  alertSound: 'soft',
  // Off by default: a second full-resolution encoder doubles the device's
  // work while streaming — the #1 cause of laggy streams on laptops/phones.
  autoRecord: false,
  // Off by default: recordings go to Google Drive or this device (both free).
  // The 7-day copy on our storage is a tap away in the save sheet.
  cloudRecordings: false,
  hostName: '',
  mirrorPreview: 'auto',
  saveTarget: 'ask',
  recLimitMin: 0,
  streamLimitMin: 0,
  prefsVersion: PREFS_VERSION,
};

const KEY = 'ds-live-prefs';
const SAVED_AT_KEY = 'ds-live-prefs-saved-at';
/** 'pending' → the save sheet says once that cloud copies became opt-in; then 'seen'. */
const CLOUD_NOTICE_KEY = 'ds-live-cloud-copy-notice';

export interface PrefsMigration {
  prefs: StudioPrefs;
  /** The stored shape was older than PREFS_VERSION (write the result back). */
  migrated: boolean;
  /** A version-1 `cloudRecordings: true` (the old default) was turned off. */
  cloudCopyTurnedOff: boolean;
}

/**
 * Bring saved prefs (this device's, or the account copy synced from another device)
 * up to PREFS_VERSION. Pure. Every other setting is kept exactly as saved.
 *  - v1 `cloudRecordings: false` was a choice (the default was true): kept.
 *  - v1 `cloudRecordings: true` was almost always the default nobody chose: turned
 *    off, and the save sheet says so once so anyone who did choose it can turn it
 *    back on.
 *  - v2+: kept as saved.
 */
export function migratePrefs(raw: Partial<StudioPrefs> | null | undefined): PrefsMigration {
  if (!raw || typeof raw !== 'object') return { prefs: { ...DEFAULT_PREFS }, migrated: false, cloudCopyTurnedOff: false };
  const version = Number.isFinite(raw.prefsVersion) ? Number(raw.prefsVersion) : 1;
  const prefs: StudioPrefs = { ...DEFAULT_PREFS, ...raw, prefsVersion: Math.max(version, PREFS_VERSION) };
  let cloudCopyTurnedOff = false;
  if (version < 2) {
    cloudCopyTurnedOff = raw.cloudRecordings === true;
    prefs.cloudRecordings = false;
  }
  return { prefs, migrated: version < PREFS_VERSION, cloudCopyTurnedOff };
}

function flagCloudNotice(): void {
  try {
    if (localStorage.getItem(CLOUD_NOTICE_KEY) !== 'seen') localStorage.setItem(CLOUD_NOTICE_KEY, 'pending');
  } catch {
    /* storage unavailable */
  }
}

/** True until the save sheet has told this device that cloud copies are now opt-in. */
export function cloudCopyNoticePending(): boolean {
  try {
    return localStorage.getItem(CLOUD_NOTICE_KEY) === 'pending';
  } catch {
    return false;
  }
}

export function markCloudCopyNoticeSeen(): void {
  try {
    if (localStorage.getItem(CLOUD_NOTICE_KEY) === 'pending') localStorage.setItem(CLOUD_NOTICE_KEY, 'seen');
  } catch {
    /* storage unavailable */
  }
}

export function loadPrefs(): StudioPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    const m = migratePrefs(raw ? (JSON.parse(raw) as Partial<StudioPrefs>) : null);
    if (m.migrated) {
      // Write the upgrade back once. The saved-at stamp is left alone: migrating
      // isn't a new choice, so cloud sync's "newer wins" is unaffected.
      localStorage.setItem(KEY, JSON.stringify(m.prefs));
      if (m.cloudCopyTurnedOff) flagCloudNotice();
    }
    return m.prefs;
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(p: StudioPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...p, prefsVersion: PREFS_VERSION }));
    localStorage.setItem(SAVED_AT_KEY, String(Date.now()));
  } catch {
    /* storage unavailable */
  }
  // Every save path mirrors to the account (signed-out = no-op). Dynamic
  // import keeps prefs ↔ sync from becoming a static cycle.
  void import('./sync').then((m) => m.schedulePrefsPush()).catch(() => undefined);
}

/** When this device last changed settings — used by cloud sync (newer wins). */
export function prefsSavedAt(): number {
  try {
    return Number(localStorage.getItem(SAVED_AT_KEY)) || 0;
  } catch {
    return 0;
  }
}

/** Cloud settings landed — write them locally with their cloud timestamp. */
export function adoptCloudPrefs(p: Partial<StudioPrefs>, cloudUpdatedAtMs: number): StudioPrefs {
  // An account copy saved by an older build migrates the same way as a local one.
  const m = migratePrefs(p);
  try {
    localStorage.setItem(KEY, JSON.stringify(m.prefs));
    localStorage.setItem(SAVED_AT_KEY, String(cloudUpdatedAtMs));
    if (m.cloudCopyTurnedOff) flagCloudNotice();
  } catch {
    /* storage unavailable */
  }
  return m.prefs;
}

/** CanvasRenderingContext2D filter string for each camera look. */
export const LOOK_FILTERS: Record<CameraLook, string> = {
  none: 'none',
  soften: 'blur(0.6px) brightness(1.04) saturate(1.05)',
  warm: 'sepia(0.22) saturate(1.15) brightness(1.02)',
  mono: 'grayscale(1) contrast(1.05)',
};

export const LOOK_LABELS: { id: CameraLook; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'soften', label: 'Soften' },
  { id: 'warm', label: 'Warm' },
  { id: 'mono', label: 'Mono' },
];

/** Small confirmation chime for alerts (WebAudio — no asset needed). */
export function playChime(): void {
  try {
    const Ctx = window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 740;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.45);
    osc.onended = () => ctx.close().catch(() => undefined);
  } catch {
    /* audio blocked */
  }
}
