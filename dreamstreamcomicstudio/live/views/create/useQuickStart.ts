// One tap from Create or the Dashboard to a running studio: same sign-in and backend
// gates as "Create event", then create → remember → hand the studio its intent → open it.
// The tap itself is the user gesture, so the camera prompt and the audio unlock happen
// right here, in parallel with creating the event (iOS needs both inside a tap).
import { useState } from 'react';
import { openAuth, useAccount } from '../../account';
import { SignInRequiredError, createEvent, probeLiveWorker, type LiveWorkerProbeResult } from '../../api';
import { SEGMENT_MS, presetById } from '../../config';
import { addMyEvent, type MyEvent } from '../../events';
import { discardPrimedCamera, primeCamera } from '../../media';
import type { Nav } from '../../nav';
import { loadPrefs, savePrefs } from '../../prefs';
import { QUICK_DEFAULTS, autoTitle, setStudioIntent, type QuickKind } from '../../quickStart';
import { primeAudioContext } from '../../studio/audioMixer';
import { pushEventToCloud } from '../../sync';

export interface QuickStartOptions {
  /** Typed title; blank → an auto title. */
  title?: string;
  /** On-stream host name (the caller's cleanHost expression). */
  host?: string;
  /** Name the auto title is built from ("Akhil’s meeting · Oct 22"); blank → "Meeting · Oct 22". */
  titleName?: string;
  /** Remember `host` as the on-stream name (Create's "Your name" field). */
  rememberHost?: boolean;
  quality?: string;
  access?: 'open' | 'approval';
  maxViewers?: number;
  cover?: number;
  desc?: string;
  autoRecord?: boolean;
  /** Last known backend probe — a known failure blocks; unknown is checked now. */
  probe?: LiveWorkerProbeResult | null;
  onProbe?: (r: LiveWorkerProbeResult) => void;
}

export const QUICK_BUSY_COPY: Record<QuickKind, string> = {
  meeting: 'Starting your meeting…',
  live: 'Getting you live…',
};

export function useQuickStart(nav: Nav) {
  const account = useAccount();
  const [busy, setBusy] = useState<QuickKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async (kind: QuickKind, o: QuickStartOptions = {}): Promise<boolean> => {
    if (busy) return false;
    if (account.status !== 'member' && account.status !== 'loading') {
      openAuth(
        account.status === 'needs_code' ? 'code' : 'signin',
        kind === 'meeting'
          ? 'Sign in to start a meeting — the people you invite never need an account.'
          : 'Sign in to host your stream — viewers never need an account.',
      );
      return false;
    }
    if (o.probe && !o.probe.ok) {
      setError(`Streaming backend is not reachable: ${o.probe.detail}`);
      return false;
    }
    const prefs = loadPrefs();
    const quality = o.quality ?? prefs.qualityId;
    // Inside the tap: ask for camera + mic and wake audio now, while the event is created.
    primeAudioContext();
    primeCamera(presetById(quality));
    setBusy(kind);
    setError(null);
    try {
      const readiness = o.probe?.ok ? o.probe : await probeLiveWorker();
      o.onProbe?.(readiness);
      if (!readiness.ok) {
        discardPrimedCamera();
        setError(`Streaming backend is not reachable: ${readiness.detail}`);
        return false;
      }
      const title = (o.title ?? '').trim() || autoTitle(kind, o.titleName ?? account.name ?? '');
      const host = (o.host ?? '').trim() || prefs.hostName.trim() || account.name || 'Host';
      const access = o.access ?? QUICK_DEFAULTS.access;
      const cover = o.cover ?? QUICK_DEFAULTS.cover;
      const eventKind = kind === 'meeting' ? 'meeting' : 'broadcast';
      const res = await createEvent({
        title,
        host,
        desc: (o.desc ?? '').trim(),
        cover,
        access,
        quality,
        segMs: SEGMENT_MS,
        scheduledAt: null,
        maxViewers: o.maxViewers ?? QUICK_DEFAULTS.maxViewers,
        kind: eventKind,
      });
      const mine: MyEvent = {
        id: res.id,
        hostKey: res.hostKey,
        title,
        createdAt: Date.now(),
        scheduledAt: null,
        status: 'idle',
        quality,
        access,
        cover,
        kind: eventKind,
        autoRecord: o.autoRecord ?? prefs.autoRecord,
      };
      addMyEvent(mine);
      void pushEventToCloud(mine); // cross-device history when signed in
      if (o.rememberHost && o.host != null) {
        const clean = o.host.trim();
        savePrefs({ ...loadPrefs(), hostName: !clean || clean === account.name || clean === 'Host' ? '' : clean });
      }
      setStudioIntent(res.id, kind);
      nav.studio(res.id, res.hostKey);
      return true;
    } catch (e) {
      discardPrimedCamera();
      if (e instanceof SignInRequiredError) {
        openAuth('signin', e.message);
        setError(e.message);
      } else {
        setError(e instanceof Error ? e.message : 'Could not reach the live worker — is it running?');
      }
      return false;
    } finally {
      setBusy(null);
    }
  };

  return { start, busy, error, setError };
}
