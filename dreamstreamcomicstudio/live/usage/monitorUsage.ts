/**
 * The baby-monitor viewer's metering, in one place, so the viewer screen only plugs it in
 * (a few lines in views/MonitorViewer.tsx):
 *
 *   - which path the picture and sound take right now (Home Wi-Fi · Direct · our relay · our
 *     server), from state the screen already has;
 *   - a SessionMeter that reports `{t:'use'}` to the room (path change, every 15 min,
 *     pagehide) and writes this device's own night / month ledger;
 *   - relay bytes from the path check's own stats report (no extra getStats).
 *
 * Display only. Nothing here can pause a picture, a sound or an alert.
 */
import type { StreamPath } from '@/shared/stream/usage';
import { PATH_TIP, relayTip } from '../costCopy';
import { addMonitorMs, addNightSegment } from './ledger';
import { flushOnPageHide, SessionMeter, streamPathOf, type NetPathLike, type UseReport } from './sessionMeter';
import { knownNurseryRelay } from './usageClient';

/** A page this late to tick was frozen (a locked phone): that gap isn't counted for any path. */
const FROZEN_GAP_MS = 3 * 60_000;

/**
 * The path for the meter: the direct connection when it's up, else the relay picture through
 * our server while it's actually drawing, else none.
 */
export function viewerPath(s: { linkState: string; netPath: NetPathLike | null; relayOn: boolean; relayDrawing: boolean }): StreamPath | null {
  if (s.linkState === 'connected' && s.netPath) return streamPathOf(s.netPath);
  if (s.relayOn && s.relayDrawing) return 'server';
  return null;
}

export interface ViewerMeter {
  meter: SessionMeter;
  /** The page or the screen is going: flush once, stop listening. */
  dispose(): void;
}

export function createViewerMeter(nid: string, send: (m: UseReport) => void, now?: () => number): ViewerMeter {
  const meter = new SessionMeter({
    send,
    now,
    maxGapMs: FROZEN_GAP_MS,
    onSegment: (path, from, to) => {
      addNightSegment(nid, path, from, to);
      addMonitorMs(path, from, to);
    },
  });
  const off = flushOnPageHide(meter);
  return {
    meter,
    dispose() {
      off();
      meter.setPath(null);
      meter.flush();
    },
  };
}

/**
 * The direct pill's tooltip. On our relay it adds this month's relay data when a parent's
 * device last read it ("Relay data this month: 2.1 of 10 GB") — no request of its own.
 * `isParent`: the nursery's usage is parents-only (the room answers 'forbidden' to everyone
 * else), so a caregiver, viewer or share-link guest on the same device never sees the figure.
 */
export function pathTip(path: StreamPath | null, nid: string, isParent: boolean): string {
  if (path === 'turn') return relayTip(isParent ? knownNurseryRelay(nid) : null);
  return PATH_TIP[path ?? 'direct'];
}
