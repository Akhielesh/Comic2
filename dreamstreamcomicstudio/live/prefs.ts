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
  /** Viewers wait this many seconds between messages (0 = off). */
  slowSec: number;
  /** Toast when someone joins the lobby / gets admitted. */
  alertJoins: boolean;
  /** Toast on viewer milestones (10 / 25 / 50 / 100 …). */
  alertMilestones: boolean;
  alertSound: AlertSound;
  /** Auto-start the local recording when going live. */
  autoRecord: boolean;
  /** Also upload finished recordings to the event's 7-day server store. */
  cloudRecordings: boolean;
  /** Host display name, reused across events. */
  hostName: string;
  /** Self-view mirroring: auto = front camera in Solo only (the program out
   *  is never mirrored — this is purely how YOU see yourself). */
  mirrorPreview: 'auto' | 'on' | 'off';
}

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
  slowSec: 0,
  alertJoins: true,
  alertMilestones: true,
  alertSound: 'soft',
  autoRecord: true,
  cloudRecordings: true,
  hostName: '',
  mirrorPreview: 'auto',
};

const KEY = 'ds-live-prefs';
const SAVED_AT_KEY = 'ds-live-prefs-saved-at';

export function loadPrefs(): StudioPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return { ...DEFAULT_PREFS, ...(raw ? (JSON.parse(raw) as Partial<StudioPrefs>) : {}) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(p: StudioPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
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
  const merged = { ...DEFAULT_PREFS, ...p };
  try {
    localStorage.setItem(KEY, JSON.stringify(merged));
    localStorage.setItem(SAVED_AT_KEY, String(cloudUpdatedAtMs));
  } catch {
    /* storage unavailable */
  }
  return merged;
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
