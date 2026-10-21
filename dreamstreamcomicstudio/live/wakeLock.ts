/**
 * Keep the screen on while it matters (going live from a phone, the baby
 * camera). A phone that auto-locks stops its camera — on iPhone the
 * microphone can keep going, so viewers hear the room but the picture
 * freezes. Belt and braces:
 *
 *   1. the Screen Wake Lock API, re-acquired whenever the OS drops it (page
 *      hidden, battery saver toggled, a system dialog) plus a 15 s watchdog;
 *   2. if that's refused or missing (iPhone Low Power Mode, home-screen apps
 *      on older iOS), a muted 2-second looping inline video — the classic
 *      "NoSleep" technique — which keeps iOS and Android awake;
 *   3. a `state` the UI shows, so a phone that may still lock is called out
 *      with the exact setting to change.
 */

type Sentinel = { release(): Promise<void>; released: boolean; addEventListener(t: 'release', f: () => void): void };
type WakeLockApi = { request(type: 'screen'): Promise<Sentinel> };

/** native = Wake Lock API · video = looping-video fallback · none = the screen may lock. */
export type WakeState = 'native' | 'video' | 'none';

const KEEP_AWAKE_SRC = '/keep-awake.mp4';

export class ScreenWakeLock {
  private sentinel: Sentinel | null = null;
  private video: HTMLVideoElement | null = null;
  private wanted = false;
  private watchdog: number | undefined;
  private current: WakeState = 'none';
  onChange: ((s: WakeState) => void) | null = null;

  private onVis = () => {
    if (this.wanted && document.visibilityState === 'visible') void this.acquire();
  };
  /** Video playback may need a fresh tap on iOS — retry on the next one. */
  private onTap = () => {
    if (this.wanted && this.current === 'none') void this.startVideo();
  };

  static get supported(): boolean {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  get active(): boolean {
    return this.current !== 'none';
  }

  get state(): WakeState {
    return this.current;
  }

  /** Call from a user gesture where possible (iOS video fallback needs one). */
  async enable(): Promise<boolean> {
    if (!this.wanted) {
      document.addEventListener('visibilitychange', this.onVis);
      window.addEventListener('pointerdown', this.onTap, true);
      this.watchdog = window.setInterval(() => {
        if (this.wanted && document.visibilityState === 'visible' && (!this.sentinel || this.sentinel.released)) void this.acquire();
      }, 15_000);
    }
    this.wanted = true;
    // Without the API, start the video right away — still inside the tap.
    if (!ScreenWakeLock.supported) return this.startVideo();
    return this.acquire();
  }

  async disable(): Promise<void> {
    this.wanted = false;
    document.removeEventListener('visibilitychange', this.onVis);
    window.removeEventListener('pointerdown', this.onTap, true);
    window.clearInterval(this.watchdog);
    const s = this.sentinel;
    this.sentinel = null;
    try {
      await s?.release();
    } catch { /* already released */ }
    this.stopVideo();
    this.set('none');
  }

  private set(s: WakeState): void {
    if (s === this.current) return;
    this.current = s;
    this.onChange?.(s);
  }

  private async acquire(): Promise<boolean> {
    if (!this.wanted || document.visibilityState !== 'visible') return this.active;
    if (ScreenWakeLock.supported && (!this.sentinel || this.sentinel.released)) {
      try {
        const s = await (navigator as Navigator & { wakeLock: WakeLockApi }).wakeLock.request('screen');
        this.sentinel = s;
        s.addEventListener('release', () => {
          if (this.sentinel === s) this.sentinel = null;
          // Dropped while we still want it (not just because the page hid): take it back.
          if (this.wanted && document.visibilityState === 'visible') window.setTimeout(() => void this.acquire(), 1000);
          else if (!this.video) this.set('none');
        });
        this.stopVideo();
        this.set('native');
        return true;
      } catch {
        /* refused: battery saver, Low Power Mode, or not allowed here */
      }
    }
    if (this.sentinel && !this.sentinel.released) return true;
    return this.startVideo();
  }

  private async startVideo(): Promise<boolean> {
    if (typeof document === 'undefined') return false;
    if (!this.video) {
      const v = document.createElement('video');
      v.src = KEEP_AWAKE_SRC;
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.setAttribute('muted', '');
      v.setAttribute('aria-hidden', 'true');
      v.title = 'Keeping the screen on';
      v.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
      document.body.appendChild(v);
      this.video = v;
    }
    try {
      await this.video.play();
      this.set('video');
      return true;
    } catch {
      this.set('none');
      return false;
    }
  }

  private stopVideo(): void {
    const v = this.video;
    this.video = null;
    if (!v) return;
    v.pause();
    v.removeAttribute('src');
    v.load();
    v.remove();
  }
}

/** Plain-language fix for a phone whose screen may still lock. */
export function keepAwakeAdvice(ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  if (/iPhone|iPad|iPod/i.test(ua)) return 'Turn off Low Power Mode, and set Settings › Display & Brightness › Auto-Lock to Never while this phone is the camera.';
  if (/Android/i.test(ua)) return 'Turn off Battery Saver, and set the screen timeout to its longest while this phone is the camera.';
  return 'Turn off battery saver and keep this device awake while it is the camera.';
}
