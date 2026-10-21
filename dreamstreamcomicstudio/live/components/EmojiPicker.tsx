// Reactions, designed: a tabbed picker (Recent, Love, Hype, Cheer, Funny,
// Faces, Party, Things) instead of a wall of 108 emoji, and the host's editor
// for the six one-tap reactions viewers see — with a live preview that floats
// each one up the way it will look on stream.
import React, { useMemo, useState } from 'react';
import { EMOJI_GROUPS, QUICK_EMOJI, recentEmoji } from '../emoji';
import { Icon } from '../ui/icons';
import { cx } from '../ui/primitives';

export function EmojiPicker({ onPick, selected, label = 'Reactions', compact }: { onPick: (e: string) => void; selected?: readonly string[]; label?: string; compact?: boolean }) {
  const recent = useMemo(() => recentEmoji(), []);
  const tabs = useMemo(
    () => [...(recent.length ? [{ id: 'recent', label: 'Recent', icon: '', emoji: recent }] : []), ...EMOJI_GROUPS],
    [recent],
  );
  const [tab, setTab] = useState(tabs[0].id);
  const group = tabs.find((t) => t.id === tab) ?? tabs[0];
  return (
    <div className={cx('epick', compact && 'compact')} role="group" aria-label={label}>
      <div className="epick-tabs" role="tablist" aria-label="Reaction groups">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={t.id === group.id} className={cx('epick-tab', t.id === group.id && 'sel')} onClick={() => setTab(t.id)} title={t.label} aria-label={t.label}>
            {t.icon || <Icon name="clock" size={15} />}
          </button>
        ))}
      </div>
      <div className="epick-name">{group.label}</div>
      <div className="epick-grid" role="tabpanel" aria-label={group.label}>
        {group.emoji.map((e) => (
          <button key={e} className={cx('epick-e', selected?.includes(e) && 'on')} onClick={() => onPick(e)} aria-label={e} aria-pressed={selected ? selected.includes(e) : undefined}>
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The host chooses the six quick reactions: tap a slot, then an emoji. */
export function QuickBarEditor({ value, onChange }: { value: readonly string[]; onChange: (v: string[]) => void }) {
  const [slot, setSlot] = useState<number | null>(null);
  const [floats, setFloats] = useState<{ id: number; e: string; x: number }[]>([]);
  const demo = (e: string, i: number) => {
    const id = Date.now() + Math.random();
    setFloats((f) => [...f.slice(-8), { id, e, x: 8 + i * 15 + Math.random() * 6 }]);
    window.setTimeout(() => setFloats((f) => f.filter((x) => x.id !== id)), 1600);
  };
  const pick = (e: string) => {
    if (slot == null) return;
    const next = [...value];
    const existing = next.indexOf(e);
    if (existing >= 0) next[existing] = next[slot]; // already in the bar: swap places
    next[slot] = e;
    onChange(next);
    demo(e, slot);
    setSlot(null);
  };
  const isDefault = value.join('') === QUICK_EMOJI.join('');
  return (
    <div className="qbar-edit">
      <div className="qbar-stage" aria-hidden>
        {floats.map((f) => <span key={f.id} className="qbar-float" style={{ left: `${f.x}%` }}>{f.e}</span>)}
      </div>
      <div className="qbar-row" role="radiogroup" aria-label="Quick reactions — pick a slot to change it">
        {value.map((e, i) => (
          <button
            key={i}
            role="radio"
            aria-checked={slot === i}
            className={cx('qbar-slot', slot === i && 'sel')}
            onClick={() => {
              setSlot((s) => (s === i ? null : i));
              demo(e, i);
            }}
            aria-label={`Slot ${i + 1}: ${e}`}
          >
            {e}
          </button>
        ))}
        <span className="qbar-plus" aria-hidden><Icon name="plus" size={14} /></span>
      </div>
      <div className="qbar-hint">
        {slot == null ? 'Tap a reaction to change it — viewers get the rest from the “+”.' : `Pick a new reaction for slot ${slot + 1}`}
        {!isDefault && (
          <button className="linkish" onClick={() => { onChange([...QUICK_EMOJI]); setSlot(null); }}>Reset</button>
        )}
      </div>
      {slot != null && <EmojiPicker onPick={pick} selected={value} label="Choose a reaction" />}
    </div>
  );
}
