/**
 * Keep the screen on while it matters (going live from a phone, the baby
 * camera). A sleeping phone stops its camera — streams freeze and the baby
 * monitor goes blind. The lock is released by the OS whenever the page is
 * hidden, so it's re-acquired on return.
 */

type Sentinel = { release(): Promise<void>; released: boolean; addEventListener(t: 'release', f: () => void): void };
type WakeLockApi = { request(type: 'screen'): Promise<Sentinel> };

export class ScreenWakeLock {
  private sentinel: Sentinel | null = null;
  private wanted = false;
  private onVis = () => {
    if (this.wanted && document.visibilityState === 'visible') void this.acquire();
  };

  static get supported(): boolean {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  get active(): boolean {
    return !!this.sentinel && !this.sentinel.released;
  }

  async enable(): Promise<boolean> {
    if (!this.wanted) document.addEventListener('visibilitychange', this.onVis);
    this.wanted = true;
    return this.acquire();
  }

  async disable(): Promise<void> {
    this.wanted = false;
    document.removeEventListener('visibilitychange', this.onVis);
    const s = this.sentinel;
    this.sentinel = null;
    try {
      await s?.release();
    } catch { /* already released */ }
  }

  private async acquire(): Promise<boolean> {
    if (!ScreenWakeLock.supported || this.active) return this.active;
    try {
      this.sentinel = await (navigator as Navigator & { wakeLock: WakeLockApi }).wakeLock.request('screen');
      return true;
    } catch {
      return false; // battery saver, not visible, or unsupported
    }
  }
}
