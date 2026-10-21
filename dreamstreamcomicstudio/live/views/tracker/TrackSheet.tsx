// Add or edit one tracker entry. One sheet, shaped by the kind: big tap
// targets for the 3 a.m. diaper, a timer or "log after the fact" for feeds
// and sleep, units the family chose (ml/oz, °C/°F) — stored metric.
import React, { useMemo, useState } from 'react';
import type { TrackData, TrackItem, TrackKind } from '../../monitor/trackTypes';
import { Icon } from '../../ui/icons';
import { Btn, cx } from '../../ui/primitives';
import { ACTIVITY_LABEL, KIND_META, cToF, fToC, fromLocalInput, fromOz, toLocalInput, toOz, type TempUnit, type VolUnit } from './fmt';

export interface SheetGuidance {
  level: string;
  text: string;
}

const Chips = <T extends string>({ value, options, onChange, label }: { value: T | undefined; options: [T, string][]; onChange: (v: T | undefined) => void; label: string }) => (
  <div className="ts-chips" role="radiogroup" aria-label={label}>
    {options.map(([v, l]) => (
      <button key={v} type="button" role="radio" aria-checked={value === v} className={cx('cam-chip', value === v && 'sel')} onClick={() => onChange(value === v ? undefined : v)}>
        {l}
      </button>
    ))}
  </div>
);

const Num = ({ value, onChange, step, min, max, label, suffix }: { value: number | undefined; onChange: (v: number | undefined) => void; step: number; min: number; max: number; label: string; suffix: string }) => (
  <div className="ts-num">
    <button type="button" className="ts-step" aria-label={`Less ${label}`} onClick={() => onChange(Math.max(min, Math.round(((value ?? 0) - step) * 100) / 100))}>−</button>
    <label>
      <input
        className="input"
        inputMode="decimal"
        aria-label={label}
        value={value ?? ''}
        onChange={(e) => {
          const v = e.target.value.replace(',', '.');
          onChange(v === '' ? undefined : Math.min(max, Math.max(min, Number(v) || 0)));
        }}
      />
      <span>{suffix}</span>
    </label>
    <button type="button" className="ts-step" aria-label={`More ${label}`} onClick={() => onChange(Math.min(max, Math.round(((value ?? 0) + step) * 100) / 100))}>+</button>
  </div>
);

export function TrackSheet({
  kind,
  item,
  units,
  recentMeds,
  canStartTimer,
  guidance,
  onSave,
  onStart,
  onDelete,
  onClose,
}: {
  kind: TrackKind;
  /** Editing an existing entry. */
  item: TrackItem | null;
  units: { vol: VolUnit; temp: TempUnit };
  recentMeds: { name: string; dose?: number; unit?: TrackData['unit']; everyH?: number }[];
  canStartTimer: boolean;
  /** Live advice for what's being entered (fever, medicine timing). */
  guidance?: (k: TrackKind, d: TrackData) => SheetGuidance | null;
  onSave: (v: { start: number; end: number | null; data: TrackData }) => void;
  onStart: (data: TrackData) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const meta = KIND_META[kind];
  const now = Date.now();
  const timed = !!meta.timed || kind === 'sleep';
  const [data, setData] = useState<TrackData>(() => item?.data ?? (kind === 'diaper' ? {} : kind === 'bottle' ? { milk: 'formula' } : {}));
  const [start, setStart] = useState(() => toLocalInput(item?.start ?? now));
  const [mins, setMins] = useState<number | undefined>(() => (item?.end != null ? Math.round((item.end - item.start) / 60_000) : timed ? undefined : undefined));
  const [err, setErr] = useState<string | null>(null);
  const set = (p: Partial<TrackData>) => setData((d) => ({ ...d, ...p }));
  const tip = useMemo(() => guidance?.(kind, data) ?? null, [guidance, kind, data]);

  // Volumes are stored in ml and shown in the family's unit.
  const vol = (ml: number | undefined) => (ml == null ? undefined : units.vol === 'oz' ? Math.round(toOz(ml) * 10) / 10 : Math.round(ml));
  const setVol = (k: 'ml' | 'mlLeft' | 'mlRight', v: number | undefined) => set({ [k]: v == null ? undefined : Math.round(units.vol === 'oz' ? fromOz(v) : v) });
  const presets = units.vol === 'oz' ? [2, 3, 4, 5, 6, 8] : [60, 90, 120, 150, 180, 240];

  const save = () => {
    const s = fromLocalInput(start);
    if (!Number.isFinite(s)) return setErr('Pick a time.');
    if (s > Date.now() + 5 * 60_000) return setErr('That’s in the future.');
    if (kind === 'bottle' && !data.ml) return setErr('Add how much.');
    if (kind === 'temp' && data.c == null) return setErr('Add the temperature.');
    if (kind === 'med' && !data.name) return setErr('Add the medicine’s name.');
    if (kind === 'growth' && data.kg == null && data.cm == null && data.headCm == null) return setErr('Add at least one measurement.');
    if (kind === 'diaper' && !data.pee && !data.poo && data.pee !== false) return setErr('Wet, dirty or both?');
    let end: number | null = s;
    if (timed) {
      if (item && item.end == null && mins == null) end = null; // still running
      else if (mins == null || mins <= 0) return setErr('How long?');
      else end = s + mins * 60_000;
      if (end != null && end > Date.now() + 5 * 60_000) return setErr('That ends in the future — shorten it or start a timer.');
    }
    const d = { ...data };
    if (kind === 'breast' && end != null && !d.left && !d.right) {
      // A plain duration: put it on the side they chose (or split it).
      const secs = Math.round((end - s) / 1000);
      if (d.side === 'left') d.left = secs;
      else if (d.side === 'right') d.right = secs;
    }
    onSave({ start: s, end, data: d });
  };

  return (
    <div className="sheet-scrim" role="dialog" aria-modal="true" aria-labelledby="ts-title" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('sheet ts-sheet fade-in', `tone-${meta.tone}`)}>
        <div className="sheet-head">
          <div className="sheet-icon"><Icon name={meta.icon} size={18} /></div>
          <h2 id="ts-title" className="sheet-title serif" style={{ flex: 1 }}>{item ? `Edit ${meta.label.toLowerCase()}` : meta.label}</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close"><Icon name="x" size={17} /></button>
        </div>

        {kind === 'diaper' && (
          <div className="ts-big3">
            {([['pee', 'Wet', { pee: true, poo: false }], ['poo', 'Dirty', { pee: false, poo: true }], ['both', 'Both', { pee: true, poo: true }], ['dry', 'Dry', { pee: false, poo: false }]] as const).map(([k, l, v]) => {
              const sel = k === 'both' ? data.pee && data.poo : k === 'pee' ? data.pee && !data.poo : k === 'poo' ? !data.pee && data.poo : data.pee === false && data.poo === false;
              return (
                <button key={k} type="button" className={cx('ts-big', sel && 'sel')} onClick={() => set(v)} aria-pressed={!!sel}>
                  <Icon name={k === 'dry' ? 'check' : 'drop'} size={20} />{l}
                </button>
              );
            })}
          </div>
        )}
        {kind === 'diaper' && data.poo && (
          <>
            <div className="ts-label">Colour</div>
            <Chips label="Colour" value={data.color} onChange={(color) => set({ color })} options={[['yellow', 'Yellow'], ['green', 'Green'], ['brown', 'Brown'], ['orange', 'Orange'], ['black', 'Black'], ['red', 'Red'], ['white', 'White / grey']]} />
            <div className="ts-label">Texture</div>
            <Chips label="Texture" value={data.texture} onChange={(texture) => set({ texture })} options={[['runny', 'Runny'], ['seedy', 'Seedy'], ['soft', 'Soft'], ['formed', 'Formed'], ['hard', 'Hard']]} />
          </>
        )}
        {kind === 'diaper' && (
          <label className="row ts-check"><input type="checkbox" checked={!!data.rash} onChange={(e) => set({ rash: e.target.checked || undefined })} />Diaper rash</label>
        )}

        {kind === 'bottle' && (
          <>
            <div className="ts-label">How much</div>
            <Num label="Amount" value={vol(data.ml)} onChange={(v) => setVol('ml', v)} step={units.vol === 'oz' ? 0.5 : 10} min={0} max={units.vol === 'oz' ? 34 : 1000} suffix={units.vol} />
            <div className="ts-chips">
              {presets.map((p) => (
                <button key={p} type="button" className={cx('cam-chip', vol(data.ml) === p && 'sel')} onClick={() => setVol('ml', p)}>{p} {units.vol}</button>
              ))}
            </div>
            <div className="ts-label">Milk</div>
            <Chips label="Milk" value={data.milk} onChange={(milk) => set({ milk })} options={[['formula', 'Formula'], ['breast', 'Breast milk'], ['mixed', 'Mixed'], ['other', 'Other']]} />
          </>
        )}

        {kind === 'breast' && (
          <>
            <div className="ts-label">{item ? 'Minutes per side' : 'Start on'}</div>
            {!item && <Chips label="Side" value={data.side} onChange={(side) => set({ side })} options={[['left', 'Left'], ['right', 'Right']]} />}
            {item && (
              <div className="ts-two">
                <label>Left<Num label="Left minutes" value={data.left != null ? Math.round(data.left / 60) : undefined} onChange={(v) => set({ left: v == null ? undefined : v * 60 })} step={1} min={0} max={120} suffix="min" /></label>
                <label>Right<Num label="Right minutes" value={data.right != null ? Math.round(data.right / 60) : undefined} onChange={(v) => set({ right: v == null ? undefined : v * 60 })} step={1} min={0} max={120} suffix="min" /></label>
              </div>
            )}
          </>
        )}

        {kind === 'pump' && (
          <div className="ts-two">
            <label>Left<Num label="Left amount" value={vol(data.mlLeft)} onChange={(v) => setVol('mlLeft', v)} step={units.vol === 'oz' ? 0.5 : 10} min={0} max={units.vol === 'oz' ? 20 : 600} suffix={units.vol} /></label>
            <label>Right<Num label="Right amount" value={vol(data.mlRight)} onChange={(v) => setVol('mlRight', v)} step={units.vol === 'oz' ? 0.5 : 10} min={0} max={units.vol === 'oz' ? 20 : 600} suffix={units.vol} /></label>
          </div>
        )}

        {kind === 'solids' && (
          <>
            <div className="ts-label">Foods</div>
            <input className="input" value={data.foods ?? ''} maxLength={120} placeholder="e.g. avocado, oatmeal" onChange={(e) => set({ foods: e.target.value || undefined })} />
            <div className="ts-label">How much they ate</div>
            <Chips label="Amount" value={data.amount} onChange={(amount) => set({ amount })} options={[['taste', 'A taste'], ['some', 'Some'], ['most', 'Most'], ['all', 'All']]} />
            <div className="ts-label">Reaction (optional)</div>
            <input className="input" value={data.reaction ?? ''} maxLength={120} placeholder="e.g. loved it · rash on cheek" onChange={(e) => set({ reaction: e.target.value || undefined })} />
          </>
        )}

        {kind === 'sleep' && (
          <>
            <div className="ts-label">Where</div>
            <Chips label="Where" value={data.where} onChange={(where) => set({ where })} options={[['crib', 'Crib'], ['bassinet', 'Bassinet'], ['arms', 'Arms'], ['stroller', 'Stroller'], ['car', 'Car seat'], ['bed', 'Bed']]} />
          </>
        )}

        {kind === 'activity' && (
          <>
            <div className="ts-label">What</div>
            <Chips label="Activity" value={data.type} onChange={(type) => set({ type })} options={(Object.keys(ACTIVITY_LABEL) as (keyof typeof ACTIVITY_LABEL)[]).map((k) => [k, ACTIVITY_LABEL[k]])} />
          </>
        )}

        {kind === 'growth' && (
          <div className="ts-three">
            {units.vol === 'oz' ? (
              <>
                <label>Weight<Num label="Weight" value={data.kg != null ? Math.round(data.kg * 2.20462 * 100) / 100 : undefined} onChange={(v) => set({ kg: v == null ? undefined : Math.round((v / 2.20462) * 1000) / 1000 })} step={0.1} min={0} max={80} suffix="lb" /></label>
                <label>Length<Num label="Length" value={data.cm != null ? Math.round((data.cm / 2.54) * 10) / 10 : undefined} onChange={(v) => set({ cm: v == null ? undefined : Math.round(v * 2.54 * 10) / 10 })} step={0.25} min={0} max={50} suffix="in" /></label>
                <label>Head<Num label="Head" value={data.headCm != null ? Math.round((data.headCm / 2.54) * 10) / 10 : undefined} onChange={(v) => set({ headCm: v == null ? undefined : Math.round(v * 2.54 * 10) / 10 })} step={0.25} min={0} max={24} suffix="in" /></label>
              </>
            ) : (
              <>
                <label>Weight<Num label="Weight" value={data.kg} onChange={(kg) => set({ kg })} step={0.05} min={0} max={40} suffix="kg" /></label>
                <label>Length<Num label="Length" value={data.cm} onChange={(cm) => set({ cm })} step={0.5} min={0} max={130} suffix="cm" /></label>
                <label>Head<Num label="Head" value={data.headCm} onChange={(headCm) => set({ headCm })} step={0.5} min={0} max={60} suffix="cm" /></label>
              </>
            )}
          </div>
        )}

        {kind === 'med' && (
          <>
            {recentMeds.length > 0 && !item && (
              <div className="ts-chips">
                {recentMeds.map((m) => (
                  <button key={m.name} type="button" className={cx('cam-chip', data.name === m.name && 'sel')} onClick={() => set({ name: m.name, dose: m.dose, unit: m.unit, everyH: m.everyH })}>{m.name}</button>
                ))}
              </div>
            )}
            <div className="ts-label">Medicine</div>
            <input className="input" value={data.name ?? ''} maxLength={60} placeholder="e.g. Infant acetaminophen" onChange={(e) => set({ name: e.target.value || undefined })} />
            <div className="ts-two">
              <label>Dose<Num label="Dose" value={data.dose} onChange={(dose) => set({ dose })} step={0.5} min={0} max={1000} suffix={data.unit ?? 'ml'} /></label>
              <label>Every<Num label="Hours between doses" value={data.everyH} onChange={(everyH) => set({ everyH })} step={1} min={0} max={48} suffix="h" /></label>
            </div>
            <Chips label="Unit" value={data.unit} onChange={(unit) => set({ unit })} options={[['ml', 'ml'], ['mg', 'mg'], ['drops', 'drops'], ['tablet', 'tablet'], ['puff', 'puff']]} />
            <p className="faint ts-small">Use the dose your pediatrician or the package gives for your baby’s weight — the tracker only keeps time.</p>
          </>
        )}

        {kind === 'temp' && (
          <>
            <div className="ts-label">Temperature</div>
            <Num
              label="Temperature"
              value={data.c == null ? undefined : units.temp === 'f' ? Math.round(cToF(data.c) * 10) / 10 : data.c}
              onChange={(v) => set({ c: v == null ? undefined : Math.round((units.temp === 'f' ? fToC(v) : v) * 10) / 10 })}
              step={0.1}
              min={units.temp === 'f' ? 86 : 30}
              max={units.temp === 'f' ? 113 : 45}
              suffix={units.temp === 'f' ? '°F' : '°C'}
            />
            <div className="ts-label">How</div>
            <Chips label="Method" value={data.method} onChange={(method) => set({ method })} options={[['rectal', 'Rectal'], ['armpit', 'Armpit'], ['ear', 'Ear'], ['forehead', 'Forehead'], ['oral', 'Mouth']]} />
          </>
        )}

        {tip && (
          <div className={cx('banner', tip.level === 'urgent' || tip.level === 'call' ? 'err' : tip.level === 'watch' ? 'warn' : 'info')} style={{ marginTop: 12 }}>
            <Icon name={tip.level === 'urgent' || tip.level === 'call' ? 'alert' : 'info'} size={15} />
            <span>{tip.text}</span>
          </div>
        )}

        <div className="ts-label">Note (optional)</div>
        <input className="input" value={data.note ?? ''} maxLength={300} placeholder={kind === 'note' ? 'What happened?' : 'Anything worth remembering'} onChange={(e) => set({ note: e.target.value || undefined })} />

        <div className="ts-when">
          <label>
            <span>{timed ? 'Started' : 'When'}</span>
            <input className="input" type="datetime-local" value={start} max={toLocalInput(Date.now() + 60_000)} onChange={(e) => setStart(e.target.value)} />
          </label>
          {timed && (!!item || !canStartTimer || mins != null) && (
            <label>
              <span>Lasted</span>
              <Num label="Minutes" value={mins} onChange={setMins} step={5} min={0} max={18 * 60} suffix="min" />
            </label>
          )}
        </div>

        {err && <div className="banner warn" style={{ marginTop: 10 }}><Icon name="alert" size={15} />{err}</div>}

        <div className="ts-actions">
          {timed && !item && canStartTimer && (
            <Btn variant="solid" icon="timer" onClick={() => onStart(data)}>
              {kind === 'sleep' ? 'Start sleep timer' : kind === 'breast' ? `Start${data.side ? ` · ${data.side}` : ''}` : 'Start timer'}
            </Btn>
          )}
          {timed && !item && canStartTimer && mins == null ? (
            <Btn variant="subtle" onClick={() => setMins(kind === 'sleep' ? 60 : 15)}>Log a past one</Btn>
          ) : (
            <Btn variant={timed && !item ? 'soft' : 'solid'} icon="check" onClick={save}>{item ? 'Save' : 'Log it'}</Btn>
          )}
          {item && (
            <Btn variant="danger" icon="trash" onClick={() => window.confirm('Delete this entry for everyone?') && onDelete()}>Delete</Btn>
          )}
        </div>
      </div>
    </div>
  );
}
