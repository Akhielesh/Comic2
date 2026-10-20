/**
 * Camera + microphone plumbing for the baby monitor — the "it just works on
 * every phone" layer: browser checks, lens discovery with friendly names,
 * a constraint ladder that always lands on *something*, human error
 * messages, zoom, and iOS audio routing so talk-back plays on the speaker.
 */

export type Facing = 'environment' | 'user';

export interface BrowserCheck {
  ok: boolean;
  /** Blocking problem, in plain words, with what to do. */
  problem: string | null;
  inApp: string | null;
  ios: boolean;
  android: boolean;
  standalone: boolean;
}

const IN_APP: [RegExp, string][] = [
  [/FBAN|FBAV|FB_IAB/i, 'Facebook'],
  [/Instagram/i, 'Instagram'],
  [/Line\//i, 'LINE'],
  [/Snapchat/i, 'Snapchat'],
  [/TikTok|musical_ly|BytedanceWebview/i, 'TikTok'],
  [/LinkedInApp/i, 'LinkedIn'],
  [/Twitter|X-Client/i, 'X'],
  [/\bGSA\//i, 'the Google app'],
  [/WhatsApp/i, 'WhatsApp'],
  [/MicroMessenger/i, 'WeChat'],
];

export function checkBrowser(ua = navigator.userAgent): BrowserCheck {
  const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
  const android = /Android/i.test(ua);
  const standalone =
    (typeof navigator !== 'undefined' && (navigator as Navigator & { standalone?: boolean }).standalone === true) ||
    (typeof matchMedia !== 'undefined' && matchMedia('(display-mode: standalone)').matches);
  const inApp = IN_APP.find(([re]) => re.test(ua))?.[1] ?? (android && /; wv\)/.test(ua) ? 'an app' : null);
  let problem: string | null = null;
  if (typeof window !== 'undefined' && !window.isSecureContext) problem = 'The camera only works over a secure (https) connection. Open dreamstreamstudio.ai/live directly.';
  else if (inApp) problem = `You're inside ${inApp}'s built-in browser, which can't use the camera. Open this page in ${ios ? 'Safari' : 'Chrome'} instead (⋯ menu → Open in browser).`;
  else if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) problem = `This browser can't use the camera. Use ${ios ? 'Safari' : 'Chrome'} on this device.`;
  return { ok: !problem, problem, inApp, ios, android, standalone };
}

/* ------------------------------------------------------------- lenses */

export interface Lens {
  id: string;
  label: string;
  facing: Facing | null;
  /** Sort key: the everyday back camera first. */
  rank: number;
}

export function describeLens(rawLabel: string, index: number): Omit<Lens, 'id'> {
  const l = rawLabel.toLowerCase();
  const back = /back|rear|environment|world/.test(l);
  const front = /front|user|facetime|selfie|face/.test(l);
  const ultra = /ultra/.test(l);
  const tele = /tele/.test(l);
  const multi = /dual|triple/.test(l);
  const facing: Facing | null = back ? 'environment' : front ? 'user' : null;
  let label = rawLabel.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim() || `Camera ${index + 1}`;
  let rank = 50 + index;
  if (back && ultra) [label, rank] = ['Back · ultra wide', 2];
  else if (back && tele) [label, rank] = ['Back · zoom', 3];
  else if (back && multi) [label, rank] = ['Back · auto', 4];
  else if (back) [label, rank] = ['Back camera', 1];
  else if (front) [label, rank] = ['Front camera', 10];
  return { label, facing, rank };
}

/** All cameras with friendly names (labels need permission first). */
export async function listLenses(): Promise<Lens[]> {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const cams = devs.filter((d) => d.kind === 'videoinput');
    const seen = new Set<string>();
    return cams
      .map((d, i) => ({ id: d.deviceId, ...describeLens(d.label, i) }))
      .filter((l) => l.id && !seen.has(l.label) && seen.add(l.label))
      .sort((a, b) => a.rank - b.rank);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------ opening */

export const MIC_CONSTRAINTS: MediaTrackConstraints = {
  // Echo cancellation lets parents talk back without feedback. Noise
  // suppression and auto-gain stay OFF: they'd hide exactly what we listen for.
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
};

export interface OpenWant {
  deviceId?: string | null;
  facing: Facing;
  audio: boolean;
}

/** Try the best constraints first and degrade until the camera opens. */
export async function openMedia(want: OpenWant): Promise<MediaStream> {
  const size = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } };
  const videos: MediaTrackConstraints[] = [
    ...(want.deviceId ? [{ deviceId: { exact: want.deviceId }, ...size }] : []),
    { facingMode: { ideal: want.facing }, ...size },
    { facingMode: { ideal: want.facing }, width: { ideal: 640 }, height: { ideal: 480 } },
  ];
  const audio: MediaTrackConstraints | boolean = want.audio ? MIC_CONSTRAINTS : false;
  let lastErr: unknown = null;
  for (const video of videos) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video, audio });
    } catch (e) {
      lastErr = e;
      // Permission problems won't be fixed by other constraints.
      if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) throw e;
    }
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ video: true, audio: want.audio ? true : false });
  } catch (e) {
    throw lastErr ?? e;
  }
}

/** What went wrong, and exactly what to do about it. */
export function mediaErrorText(e: unknown, check: Pick<BrowserCheck, 'ios' | 'android'>): string {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    if (check.ios) return 'Camera or microphone access is blocked. On iPhone: tap “aA” in the address bar → Website Settings → Camera: Allow, Microphone: Allow. (Or Settings → Safari → Camera / Microphone → Ask.) Then tap Try again.';
    if (check.android) return 'Camera or microphone access is blocked. In Chrome: tap the icon left of the address → Permissions → allow Camera and Microphone. Then tap Try again.';
    return 'Camera or microphone access is blocked. Click the camera icon in the address bar → Always allow, then tap Try again.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') return 'Another app is using the camera (FaceTime, a video call, the Camera app…). Close it, then tap Try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No usable camera was found on this device.';
  return 'The camera could not start. Close other apps using it and try again.';
}

/** Ask the camera for a different lens/facing, replacing only the video track. */
export async function openVideoOnly(want: Omit<OpenWant, 'audio'>): Promise<MediaStreamTrack> {
  const s = await openMedia({ ...want, audio: false });
  const t = s.getVideoTracks()[0];
  if (!t) throw new DOMException('no video', 'NotFoundError');
  return t;
}

/* ---------------------------------------------------------------- zoom */

export interface ZoomRange {
  min: number;
  max: number;
  step: number;
}

export function zoomRange(track: MediaStreamTrack | null | undefined): ZoomRange | null {
  try {
    const caps = track?.getCapabilities?.() as (MediaTrackCapabilities & { zoom?: { min: number; max: number; step?: number } }) | undefined;
    if (!caps?.zoom || caps.zoom.max <= caps.zoom.min) return null;
    return { min: caps.zoom.min, max: Math.min(caps.zoom.max, caps.zoom.min * 8), step: caps.zoom.step || 0.1 };
  } catch {
    return null;
  }
}

export async function setZoom(track: MediaStreamTrack, zoom: number): Promise<void> {
  try {
    await track.applyConstraints({ advanced: [{ zoom } as MediaTrackConstraintSet] });
  } catch { /* not supported */ }
}

/* --------------------------------------------------------------- audio */

/**
 * iOS routes WebRTC audio to the quiet earpiece while the mic is open unless
 * the page declares a play-and-record session (Safari 16.4+).
 */
export function preferSpeaker(): void {
  try {
    const nav = navigator as Navigator & { audioSession?: { type: string } };
    if (nav.audioSession) nav.audioSession.type = 'play-and-record';
  } catch { /* unsupported */ }
}

/** A hidden <audio> element in the DOM (iOS plays remote audio far more reliably than detached elements). */
export function remoteAudioEl(): HTMLAudioElement {
  const el = document.createElement('audio');
  el.autoplay = true;
  el.setAttribute('playsinline', '');
  el.style.display = 'none';
  document.body.appendChild(el);
  return el;
}

export function dropAudioEl(el: HTMLAudioElement | undefined | null): void {
  if (!el) return;
  el.srcObject = null;
  el.remove();
}

/* ------------------------------------------------------------- battery */

export interface PowerState {
  level: number | null;
  charging: boolean | null;
}

type BatteryLike = { level: number; charging: boolean; addEventListener(t: string, f: () => void): void; removeEventListener(t: string, f: () => void): void };

/** Watch battery where the browser exposes it (Chrome/Android; not iOS). */
export async function watchPower(onChange: (p: PowerState) => void): Promise<() => void> {
  try {
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> };
    const b = await nav.getBattery?.();
    if (!b) {
      onChange({ level: null, charging: null });
      return () => undefined;
    }
    const upd = () => onChange({ level: Math.round(b.level * 100), charging: b.charging });
    upd();
    b.addEventListener('levelchange', upd);
    b.addEventListener('chargingchange', upd);
    return () => {
      b.removeEventListener('levelchange', upd);
      b.removeEventListener('chargingchange', upd);
    };
  } catch {
    onChange({ level: null, charging: null });
    return () => undefined;
  }
}

/** Network hints where available. */
export function networkHint(): { online: boolean; type: string | null; slow: boolean } {
  const c = (navigator as Navigator & { connection?: { type?: string; effectiveType?: string } }).connection;
  return { online: navigator.onLine, type: c?.type ?? null, slow: c?.effectiveType === '2g' || c?.effectiveType === 'slow-2g' };
}
