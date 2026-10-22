// How this device alerts you — designed to be read in a glance, not a wall of
// checkboxes. One switch for background alerts, three presets that cover most
// families (Essentials · Recommended · Everything), and — only if you want them —
// topic tiles grouped Baby / Safety / Room / Camera, each switching the phone
// notification AND the on-screen alert together, with a tap-to-hear preview.
import React, { useState } from 'react';
import { alertInfo, DEFAULT_CUES, type AlertCat, type CuePrefs } from '../../monitor/alerts';
import { Icon } from '../../ui/icons';
import { cx, Toggle } from '../../ui/primitives';

interface Topic {
  id: string;
  label: string;
  icon: string;
  /** Background (push) categories this topic covers. */
  push: string[];
  /** On-screen alert categories this topic covers. */
  cues: AlertCat[];
  locked?: boolean;
}

const GROUPS: { label: string; topics: Topic[] }[] = [
  {
    label: 'Baby',
    topics: [
      { id: 'cry', label: 'Crying', icon: 'baby', push: ['cry'], cues: ['cry'] },
      { id: 'fuss', label: 'Fussing', icon: 'smile', push: ['fuss'], cues: ['fuss'] },
      { id: 'cough', label: 'Coughs & sneezes', icon: 'wind', push: ['cough'], cues: ['cough', 'sneeze'] },
      { id: 'happy', label: 'Babbling & laughing', icon: 'music', push: [], cues: ['babble', 'laugh'] },
    ],
  },
  {
    label: 'Safety',
    topics: [
      { id: 'alarm', label: 'Smoke & CO alarm', icon: 'siren', push: ['alarm'], cues: ['alarm'], locked: true },
      { id: 'zone', label: 'Danger zones & climbing out', icon: 'target', push: ['zone'], cues: ['zone', 'crib_out', 'object'] },
      { id: 'glass', label: 'Breaking glass', icon: 'zap', push: ['glass'], cues: ['glass'] },
      { id: 'crash', label: 'Bangs & crashes', icon: 'alert', push: ['crash'], cues: ['crash'] },
    ],
  },
  {
    label: 'Room',
    topics: [
      { id: 'loud', label: 'Very loud (85 dB+)', icon: 'gauge', push: ['noise'], cues: ['very_loud'] },
      { id: 'threshold', label: 'Above your noise limit', icon: 'volume', push: ['loud'], cues: ['loud'] },
      { id: 'machine', label: 'Sound machine too loud', icon: 'ear', push: ['insight'], cues: ['machine'] },
      { id: 'pets', label: 'Pets', icon: 'heart', push: ['cat'], cues: ['cat', 'dog'] },
      { id: 'people', label: 'Voices & music', icon: 'users', push: [], cues: ['voices', 'music'] },
      { id: 'house', label: 'Footsteps, doors & water', icon: 'compass', push: [], cues: ['footsteps', 'door', 'water', 'snore'] },
    ],
  },
  {
    label: 'Camera & family',
    topics: [
      { id: 'offline', label: 'Camera offline', icon: 'wifi', push: ['offline'], cues: ['offline'] },
      { id: 'moved', label: 'Camera moved or paused', icon: 'video', push: ['camera'], cues: ['moved', 'paused'] },
      { id: 'battery', label: 'Camera battery low', icon: 'battery', push: ['battery'], cues: ['battery'] },
      { id: 'report', label: 'Morning sleep report', icon: 'moon', push: ['report'], cues: [] },
      { id: 'guest', label: 'Guests & wrong passcodes', icon: 'lock', push: ['guest'], cues: [] },
    ],
  },
];
const TOPICS = GROUPS.flatMap((g) => g.topics);

type Preset = 'essentials' | 'recommended' | 'everything';
const ESSENTIAL = new Set(['cry', 'alarm', 'zone', 'glass', 'loud', 'offline']);
const RECOMMENDED = new Set(['cry', 'cough', 'alarm', 'zone', 'glass', 'crash', 'loud', 'machine', 'pets', 'offline', 'moved', 'battery', 'report', 'guest']);
const PRESETS: { id: Preset; label: string; says: string; on: (t: Topic) => boolean }[] = [
  { id: 'essentials', label: 'Essentials', says: 'Crying, alarms, danger zones, breaking glass, very loud noise and a camera that goes offline.', on: (t) => ESSENTIAL.has(t.id) },
  { id: 'recommended', label: 'Recommended', says: 'Everything that may need you — plus the morning sleep report. Skips fussing and everyday sounds.', on: (t) => RECOMMENDED.has(t.id) },
  { id: 'everything', label: 'Everything', says: 'Every sound the camera recognises, every camera and family event.', on: () => true },
];

export function AlertsCard({
  pushOn,
  pushNote,
  pushPrefs,
  cues,
  onPushOn,
  onPushPrefs,
  onCues,
  onTest,
  onPreview,
  more,
}: {
  pushOn: boolean;
  /** One line under the title (browser support, iPhone Home Screen). */
  pushNote: string;
  pushPrefs: Record<string, boolean>;
  cues: CuePrefs;
  onPushOn: (on: boolean) => void;
  onPushPrefs: (next: Record<string, boolean>) => void;
  onCues: (patch: Partial<CuePrefs>) => void;
  onTest: () => void;
  onPreview: (c: AlertCat) => void;
  /** Rare, per-device switches (keep screen on, silent here, hear while talking). */
  more: React.ReactNode;
}) {
  const [custom, setCustom] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const isOn = (t: Topic) => t.locked || t.push.some((k) => pushPrefs[k]) || t.cues.some((c) => cues.cats[c]);
  const current = PRESETS.find((p) => TOPICS.every((t) => !!isOn(t) === (t.locked || p.on(t))));

  const apply = (on: (t: Topic) => boolean) => {
    const push = { ...pushPrefs };
    const cats = { ...cues.cats };
    for (const t of TOPICS) {
      const v = t.locked || on(t);
      for (const k of t.push) push[k] = v;
      for (const c of t.cues) cats[c] = v;
    }
    onPushPrefs({ ...push, alarm: true });
    onCues({ cats: { ...cats, alarm: true } });
  };
  const toggle = (t: Topic) => {
    if (t.locked) return;
    const v = !isOn(t);
    apply((x) => (x.id === t.id ? v : !!isOn(x)));
  };

  return (
    <div className="card card-pad al-card" data-tour="mv-alerts">
      <div className="row" style={{ gap: 10 }}>
        <span className={cx('al-bell', pushOn && 'on')}><Icon name="bell" size={17} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>Alerts on this device</b>
          <div className="faint al-note">{pushNote}</div>
        </div>
        <Toggle on={pushOn} onChange={onPushOn} label="Background alerts" />
      </div>

      <div className="al-presets" role="radiogroup" aria-label="What reaches you">
        {PRESETS.map((p) => (
          <button key={p.id} role="radio" aria-checked={current?.id === p.id} className={cx('al-preset', current?.id === p.id && 'sel')} onClick={() => apply(p.on)}>
            {p.label}
          </button>
        ))}
        <button role="radio" aria-checked={!current || custom} className={cx('al-preset', 'custom', (!current || custom) && 'sel')} onClick={() => setCustom((c) => !c)}>
          <Icon name="sliders" size={13} />{current ? 'Choose' : 'Custom'}
        </button>
      </div>
      <p className="al-says">{current ? current.says : 'Your own mix — tap a topic to switch it.'}</p>

      {(custom || !current) && (
        <div className="al-groups">
          {GROUPS.map((g) => (
            <div key={g.label} className="al-group">
              <div className="al-glabel">{g.label}</div>
              <div className="al-tiles">
                {g.topics.map((t) => {
                  const on = isOn(t);
                  const tone = t.cues[0] ? alertInfo(t.cues[0]).tone : 'neutral';
                  return (
                    <div key={t.id} className={cx('al-tile', `t-${tone}`, on && 'on', t.locked && 'locked')}>
                      <button className="al-tile-main" onClick={() => toggle(t)} aria-pressed={!!on} title={t.locked ? 'Always on for safety' : undefined}>
                        <span className="al-ic"><Icon name={t.icon} size={16} /></span>
                        <span className="al-lbl">{t.label}</span>
                        <span className="al-dot" aria-hidden />
                      </button>
                      {t.cues[0] && (
                        <button className="al-play" onClick={() => onPreview(t.cues[0])} aria-label={`Hear the ${t.label.toLowerCase()} alert`} title="Hear it">
                          <Icon name="play" size={11} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="al-screen">
        <span className="al-glabel">While this screen is open</span>
        <div className="al-chips">
          {([
            ['sound', 'volume', 'Sound'],
            ['speak', 'chat', 'Speak'],
            ['vibrate', 'phone', 'Vibrate'],
            ['repeat', 'refresh', 'Repeat'],
          ] as const).map(([k, icon, label]) => (
            <button key={k} className={cx('al-chip', cues[k] && 'on')} aria-pressed={cues[k]} onClick={() => onCues({ [k]: !cues[k] } as Partial<CuePrefs>)} title={k === 'repeat' ? 'Repeat urgent alerts until someone responds' : undefined}>
              <Icon name={icon} size={14} />{label}
            </button>
          ))}
        </div>
        {cues.sound && (
          <label className="cue-volume">
            <Icon name="volume" size={15} />
            <input type="range" className="slider" min={0} max={1} step={0.05} value={cues.volume} style={{ '--pct': `${cues.volume * 100}%` } as React.CSSProperties} onChange={(e) => onCues({ volume: Number(e.target.value) })} aria-label="Alert volume" />
          </label>
        )}
      </div>

      <div className="al-foot">
        {pushOn && <button className="linkish" onClick={onTest}><Icon name="bell" size={13} /> Send a test notification</button>}
        <button className="linkish" onClick={() => setShowMore((m) => !m)} aria-expanded={showMore}>
          More on this device <Icon name="chevronDown" size={13} />
        </button>
      </div>
      {showMore && <div className="al-more">{more}</div>}
    </div>
  );
}

/** The defaults, for tests and resets. */
export const DEFAULT_ALERT_CUES = DEFAULT_CUES;
