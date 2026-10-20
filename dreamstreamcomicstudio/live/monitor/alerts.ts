/**
 * Alert cues for the family's devices — what a parent SEES and HEARS when
 * the nursery needs them.
 *
 *  - Each category has its own synthesized sound (no audio files): an
 *    urgent siren for alarms, a rising bell for crying, soft tones for
 *    informational sounds — recognizable without looking.
 *  - Optional spoken alerts ("Aria is crying"), vibration, and a flashing
 *    tab title while the page is in the background.
 *  - High/urgent alerts repeat until someone taps "I'm on it" (on any
 *    device) or the sound stops; everything else plays once.
 *  - Per-device preferences, saved locally.
 */

import { SOUND_INFO, type Severity, type SoundCat } from './soundClasses';

export type AlertCat = SoundCat | 'offline' | 'battery';

export const ALERT_META: Record<'offline' | 'battery', { label: string; icon: string; tone: 'red' | 'amber'; severity: Severity }> = {
  offline: { label: 'Camera offline', icon: 'wifi', tone: 'red', severity: 'high' },
  battery: { label: 'Camera battery low', icon: 'battery', tone: 'amber', severity: 'medium' },
};

export function alertInfo(cat: AlertCat): { label: string; icon: string; tone: string; severity: Severity } {
  return cat === 'offline' || cat === 'battery' ? ALERT_META[cat] : SOUND_INFO[cat];
}

export interface CuePrefs {
  /** Play alert sounds on this device. */
  sound: boolean;
  /** 0–1. */
  volume: number;
  /** Read alerts aloud. */
  speak: boolean;
  vibrate: boolean;
  /** Repeat high/urgent alerts until someone responds. */
  repeat: boolean;
  /** Which categories alert on this device (in-app). */
  cats: Record<AlertCat, boolean>;
}

const PREFS_KEY = 'ds-monitor-cues';

export const DEFAULT_CUES: CuePrefs = {
  sound: true,
  volume: 0.8,
  speak: false,
  vibrate: true,
  repeat: true,
  cats: {
    cry: true, fuss: false, cough: true, alarm: true, crash: true, loud: false,
    babble: false, laugh: false, voices: false, music: false, dog: false,
    offline: true, battery: true,
  },
};

export function loadCues(): CuePrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null') as Partial<CuePrefs> | null;
    if (!raw) return structuredClone(DEFAULT_CUES);
    return { ...DEFAULT_CUES, ...raw, cats: { ...DEFAULT_CUES.cats, ...(raw.cats ?? {}), alarm: true } };
  } catch {
    return structuredClone(DEFAULT_CUES);
  }
}

export function saveCues(p: CuePrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch { /* storage unavailable */ }
}

/** Seconds between repeats while unanswered, by severity. */
const REPEAT_SECS: Partial<Record<Severity, number>> = { urgent: 6, high: 15 };
/** Stop repeating after this long even if nobody answers (push keeps going). */
const REPEAT_CAP_MS = 5 * 60_000;

const VIBES: Record<Severity, number[]> = {
  urgent: [600, 200, 600, 200, 600, 200, 600],
  high: [300, 120, 300, 120, 600],
  medium: [220, 120, 220],
  info: [120],
};

type Note = [freq: number, at: number, dur: number, gain?: number, type?: OscillatorType];

/** The sound of each category — distinct contours you learn in a night. */
function pattern(cat: AlertCat | 'ack' | 'test'): Note[] {
  switch (cat) {
    case 'alarm': // alternating siren, loud and long
      return Array.from({ length: 8 }, (_, i) => [i % 2 ? 770 : 960, i * 0.25, 0.24, 0.55, 'square'] as Note);
    case 'cry': // rising two-note bell, twice
      return [[660, 0, 0.5], [880, 0.28, 0.7], [660, 1.0, 0.5], [880, 1.28, 0.8]];
    case 'offline': // descending three notes
      return [[784, 0, 0.35], [659, 0.3, 0.35], [523, 0.6, 0.6]];
    case 'cough':
      return [[440, 0, 0.18, 0.7], [440, 0.24, 0.3, 0.7]];
    case 'crash':
      return [[700, 0, 0.12, 0.7, 'triangle'], [350, 0.1, 0.4, 0.7, 'triangle']];
    case 'fuss':
      return [[520, 0, 0.6, 0.6]];
    case 'loud':
      return [[600, 0, 0.25, 0.6]];
    case 'battery':
      return [[523, 0, 0.25, 0.5], [523, 0.35, 0.25, 0.5]];
    case 'ack':
      return [[523, 0, 0.18, 0.4], [784, 0.15, 0.3, 0.4]];
    default: // babble, laugh, voices, music, dog, test: a soft sparkle
      return [[880, 0, 0.3, 0.35], [1175, 0.12, 0.3, 0.35], [1568, 0.24, 0.45, 0.35]];
  }
}

interface Ringing {
  cat: AlertCat;
  title: string;
  since: number;
  timer: number | undefined;
}

export class AlertCues {
  prefs: CuePrefs = loadCues();
  private ctx: AudioContext | null = null;
  private ringing = new Map<string, Ringing>();
  private snoozed = new Map<AlertCat, number>();
  private titleTimer: number | undefined;
  private baseTitle = typeof document !== 'undefined' ? document.title : '';

  /** Call from any tap so iOS lets us play sounds later. */
  unlock(): void {
    try {
      if (!this.ctx) {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;
        this.ctx = new Ctx();
      }
      void this.ctx.resume().catch(() => undefined);
    } catch { /* no audio */ }
  }

  setPrefs(p: CuePrefs): void {
    this.prefs = p;
    saveCues(p);
  }

  enabled(cat: AlertCat): boolean {
    if (cat === 'alarm') return true; // always on: safety
    return this.prefs.cats[cat] ?? false;
  }

  snooze(cat: AlertCat, minutes: number): void {
    this.snoozed.set(cat, Date.now() + minutes * 60_000);
    for (const [k, r] of this.ringing) if (r.cat === cat) this.stop(k);
  }

  isSnoozed(cat: AlertCat): boolean {
    return (this.snoozed.get(cat) ?? 0) > Date.now();
  }

  /** A new alert. `key` identifies it so a later ack/resolve can stop it. */
  raise(key: string, cat: AlertCat, title: string): void {
    if (!this.enabled(cat) || (cat !== 'alarm' && this.isSnoozed(cat))) return;
    const sev = alertInfo(cat).severity;
    this.cue(cat, title, sev);
    this.flashTitle(title);
    const every = REPEAT_SECS[sev];
    if (!this.prefs.repeat || !every) return;
    this.stop(key);
    const r: Ringing = { cat, title, since: Date.now(), timer: undefined };
    r.timer = window.setInterval(() => {
      if (Date.now() - r.since > REPEAT_CAP_MS || this.isSnoozed(cat)) return this.stop(key);
      this.cue(cat, title, sev, true);
    }, every * 1000);
    this.ringing.set(key, r);
  }

  /** Someone responded, or the sound stopped. */
  stop(key: string): void {
    const r = this.ringing.get(key);
    if (r) window.clearInterval(r.timer);
    this.ringing.delete(key);
    if (this.ringing.size === 0) this.stopTitle();
  }

  stopCat(cat: AlertCat): void {
    for (const [k, r] of this.ringing) if (r.cat === cat) this.stop(k);
  }

  stopAll(): void {
    for (const k of [...this.ringing.keys()]) this.stop(k);
  }

  get anyRinging(): boolean {
    return this.ringing.size > 0;
  }

  acked(): void {
    this.stopAll();
    if (this.prefs.sound) this.play('ack', 0.6);
  }

  /** Preview a category's cue (settings screen). */
  preview(cat: AlertCat, title: string): void {
    this.unlock();
    this.cue(cat, title, alertInfo(cat).severity, false, true);
  }

  private cue(cat: AlertCat, title: string, sev: Severity, repeat = false, force = false): void {
    if (this.prefs.sound || force) this.play(cat, this.prefs.volume);
    if (this.prefs.vibrate) {
      try {
        navigator.vibrate?.(VIBES[sev]);
      } catch { /* unsupported */ }
    }
    if ((this.prefs.speak || force) && !repeat && typeof speechSynthesis !== 'undefined') {
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(title);
        u.rate = 1;
        u.volume = Math.max(0.2, this.prefs.volume);
        speechSynthesis.speak(u);
      } catch { /* unsupported */ }
    }
  }

  private play(cat: AlertCat | 'ack' | 'test', volume: number): void {
    this.unlock();
    const ctx = this.ctx;
    if (!ctx || volume <= 0) return;
    const t0 = ctx.currentTime + 0.02;
    const master = ctx.createGain();
    master.gain.value = Math.min(1, volume);
    master.connect(ctx.destination);
    let end = 0;
    for (const [freq, at, dur, gain = 0.5, type = 'sine'] of pattern(cat)) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = freq;
      const s = t0 + at;
      // Bell envelope: fast attack, exponential decay.
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(gain * (type === 'square' ? 0.35 : 1), s + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
      o.connect(g).connect(master);
      o.start(s);
      o.stop(s + dur + 0.05);
      end = Math.max(end, at + dur);
    }
    window.setTimeout(() => master.disconnect(), (end + 0.3) * 1000);
  }

  private flashTitle(title: string): void {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') return;
    this.stopTitle();
    let on = false;
    this.baseTitle = this.baseTitle || document.title;
    this.titleTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') return this.stopTitle();
      on = !on;
      document.title = on ? `🔴 ${title}` : this.baseTitle;
    }, 900);
  }

  private stopTitle(): void {
    window.clearInterval(this.titleTimer);
    this.titleTimer = undefined;
    if (typeof document !== 'undefined' && this.baseTitle) document.title = this.baseTitle;
  }

  close(): void {
    this.stopAll();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}
