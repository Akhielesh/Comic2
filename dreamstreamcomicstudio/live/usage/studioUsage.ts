/**
 * A meeting host's metering (Phase B1, Stream Studio): one SessionMeter per on-camera guest —
 * minutes per path from the links' own path checks, relay bytes from the same stats reads —
 * so the recap can say "3 guests · 45 min on camera · all direct · free". Kept on this device
 * only (usage/ledger.ts). The meeting room doesn't take `{t:'use'}` reports, so nothing is
 * sent. Display only.
 */
import { saveMeetingUse } from './ledger';
import { SessionMeter, streamPathOf, sumTotals, totalMs, type NetPathLike, type SessionTotals, type StatsLike } from './sessionMeter';

export class MeetingMeter {
  private readonly meters = new Map<string, SessionMeter>();

  constructor(private readonly now?: () => number) {}

  /** The host's current guest links (HostPeers.guests()). Guests who left stop counting. */
  sync(list: readonly { sid: string; state: string; path?: NetPathLike | null }[]): void {
    const live = new Set<string>();
    for (const g of list) {
      live.add(g.sid);
      let m = this.meters.get(g.sid);
      if (!m) {
        m = new SessionMeter({ now: this.now });
        this.meters.set(g.sid, m);
      }
      m.setPath(g.state === 'connected' ? streamPathOf(g.path ?? null) : null);
    }
    for (const [sid, m] of this.meters) if (!live.has(sid)) m.setPath(null);
  }

  observe(sid: string, stats: StatsLike | RTCStatsReport, pc: object): void {
    this.meters.get(sid)?.observe(stats, pc);
  }

  totals(): SessionTotals {
    return sumTotals([...this.meters.values()].map((m) => m.totals()));
  }

  /** Guests who were actually linked up for a while. */
  get guests(): number {
    return [...this.meters.values()].filter((m) => totalMs(m.totals().ms) > 0).length;
  }

  /** Into this device's ledger for the recap (nothing to save if no guest linked up). */
  save(eventId: string): void {
    const n = this.guests;
    if (n > 0) saveMeetingUse(eventId, this.totals(), n);
  }
}
