/**
 * The "Alerts" card in Settings → Preferences (notify SPEC §6 NF-5): one place to turn the chime off, pick its volume,
 * choose "only when I'm needed", and hear both chimes. Saved per browser (services/alerts/prefs.ts), never on the
 * account, so the card says so. Composed from the ds primitives on the Settings section recipe; ink only (no hue, no
 * spark, no price). A change is counted (`alert_settings`, the new values only).
 */
import React, { useCallback, useId } from 'react';
import { Play } from 'lucide-react';
import { cn } from '../../lib/utils';
import { MUTED, SECTION_CARD, SECTION_TITLE } from '../chat/studioDesign';
import { Button } from '../ds/Button';
import { Segmented } from '../ds/Segmented';
import { Switch } from '../ds/Switch';
import { playChimeNow } from '../../services/alerts/bus';
import { localPrefsStore, useAlertPrefs, type AlertPrefsStore } from '../../services/alerts/prefs';
import type { AlertLevel, AlertPrefs, AlertVolume } from '../../services/alerts/types';

export interface AlertSettingsCardProps {
  /** Where the prefs live (the browser's store; the QA scene passes a memory one). */
  store?: AlertPrefsStore;
  /** Count a change (telemetry by default; the QA scene passes nothing to count). */
  onChanged?(prefs: AlertPrefs): void;
}

const VOLUMES = [
  { value: 'soft', label: 'Soft' },
  { value: 'normal', label: 'Normal' }
] as const;
const LEVELS = [
  { value: 'all', label: 'Everything' },
  { value: 'needs', label: "Only when I'm needed" }
] as const;

const ROW = 'flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2';
const LABEL = 'm-0 text-[length:var(--ds-text-base)] font-medium text-[var(--ds-ink)]';
const HINT = cn('m-0 text-[length:var(--ds-text-sm)]', MUTED);
/**
 * Each segment as wide as its own label: the ds Segmented's items are flex-1, which splits an inline track equally,
 * so the longer label ("Normal", "Only when I'm needed") was cut while the row had room. flex-auto (basis = content)
 * is what the board Segmented settled on for the same reason; a label is cut only if the row squeezes the whole track.
 */
const SEGMENTS_BY_LABEL = '[&>button]:flex-auto';

/** Telemetry, loaded on the first change (the card's module graph stays small); one promise keeps the counts in order. */
let telemetry: Promise<typeof import('../../services/telemetry')> | null = null;
/** Counts a change with its new values only. */
const countChange = (prefs: AlertPrefs): void => {
  telemetry ??= import('../../services/telemetry');
  void telemetry
    .then(({ captureEvent }) =>
      captureEvent({ eventType: 'alert_settings', severity: 'info', metadata: { sound: prefs.sound, volume: prefs.volume, level: prefs.level } })
    )
    .catch(() => {
      telemetry = null; // a failed load is tried again on the next change
    });
};

/** Play Ready, then Needs you, from this one press (the press also unlocks the audio), with the card's own prefs. */
export const playBothChimes = ({ sound, volume }: Pick<AlertPrefs, 'sound' | 'volume'>): void => {
  const prefs = { sound, volume };
  void playChimeNow('ready', { gesture: true, prefs });
  void playChimeNow('needsYou', { gesture: true, after: 0.75, prefs });
};

export function AlertSettingsCard({ store = localPrefsStore, onChanged = countChange }: AlertSettingsCardProps): React.ReactElement {
  const prefs = useAlertPrefs(store);
  const id = useId();
  const soundId = `${id}-sound`;
  const change = useCallback(
    (patch: Partial<AlertPrefs>) => {
      store.set(patch);
      try {
        onChanged(store.get());
      } catch {
        /* counting never blocks the change */
      }
    },
    [store, onChanged]
  );

  return (
    <section data-alert-settings="" aria-labelledby={`${id}-title`} className={cn(SECTION_CARD, 'space-y-4 p-5')}>
      <div className="space-y-1">
        <h3 id={`${id}-title`} className={SECTION_TITLE}>
          Alerts
        </h3>
        <p className={HINT}>A short chime and a note when a comic or a chat finishes, or waits on you, while you are elsewhere.</p>
      </div>

      <div className={ROW}>
        <label htmlFor={soundId} className={LABEL}>
          Play a chime
        </label>
        <Switch id={soundId} checked={prefs.sound} onCheckedChange={(sound) => change({ sound })} />
      </div>

      <div className={ROW}>
        <p className={LABEL} id={`${id}-volume`}>
          Volume
        </p>
        <Segmented<AlertVolume> label="Volume" value={prefs.volume} options={VOLUMES} onChange={(volume) => change({ volume })} disabled={!prefs.sound} size="sm" className={SEGMENTS_BY_LABEL} />
      </div>

      <div className={ROW}>
        <p className={LABEL}>Alert me for</p>
        <Segmented<AlertLevel> label="Alert me for" value={prefs.level} options={LEVELS} onChange={(level) => change({ level })} size="sm" className={SEGMENTS_BY_LABEL} />
      </div>

      <div className={ROW}>
        <Button variant="outline" size="sm" onClick={() => playBothChimes(prefs)} disabled={!prefs.sound}>
          <Play aria-hidden />
          Play
        </Button>
        <p className={HINT}>Saved in this browser.</p>
      </div>
    </section>
  );
}
