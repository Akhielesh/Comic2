// Draw the crib, danger zones and play areas on the live picture. Zones are stored in the
// camera's own (unmirrored, uncropped) frame, 0–1 — exactly what the vision
// engine analyses — so the editor shows the whole frame letterboxed.
import React, { useEffect, useRef, useState } from 'react';
import { newZoneId, type Zone } from '../../monitor/vision';
import { Icon } from '../../ui/icons';
import { Btn, cx } from '../../ui/primitives';

const MAX_DANGER = 4;
const DANGER_SUGGESTIONS = ['the window', 'the door', 'the stairs', 'the dresser', 'the radiator', 'cords & outlets'];
const MAX_ACTIVITY = 3;
const ACTIVITY_SUGGESTIONS = ['Play gym', 'Bouncer', 'Play mat', 'Swing', 'High chair'];

export function ZoneEditor({
  stream,
  mirror = false,
  zones: initial,
  onSave,
  onClose,
  babyName,
}: {
  stream: MediaStream | null;
  mirror?: boolean;
  zones: Zone[];
  onSave: (zones: Zone[]) => void;
  onClose: () => void;
  babyName?: string | null;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [zones, setZones] = useState<Zone[]>(initial);
  const [mode, setMode] = useState<'crib' | 'danger' | 'activity'>(initial.some((z) => z.kind === 'crib') ? 'danger' : 'crib');
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [aspect, setAspect] = useState(4 / 3);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    v.srcObject = stream;
    void v.play().catch(() => undefined);
    const onMeta = () => v.videoWidth && v.videoHeight && setAspect(v.videoWidth / v.videoHeight);
    v.addEventListener('loadedmetadata', onMeta);
    onMeta();
    return () => v.removeEventListener('loadedmetadata', onMeta);
  }, [stream]);

  /** Pointer → frame coordinates (0–1, unmirrored). */
  const toFrame = (e: React.PointerEvent) => {
    const r = boxRef.current!.getBoundingClientRect();
    let x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (mirror) x = 1 - x;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  };

  const down = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.ze-zone-x')) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const p = toFrame(e);
    setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };
  const move = (e: React.PointerEvent) => {
    if (!draft) return;
    const p = toFrame(e);
    setDraft({ ...draft, x1: p.x, y1: p.y });
  };
  const up = () => {
    if (!draft) return;
    const x = Math.min(draft.x0, draft.x1);
    const y = Math.min(draft.y0, draft.y1);
    const w = Math.abs(draft.x1 - draft.x0);
    const h = Math.abs(draft.y1 - draft.y0);
    setDraft(null);
    if (w < 0.05 || h < 0.05) return;
    if (mode === 'crib') {
      setZones((zs) => [...zs.filter((z) => z.kind !== 'crib'), { id: newZoneId(), kind: 'crib', name: 'Crib', x, y, w, h }]);
      setMode('danger');
    } else if (mode === 'activity') {
      setZones((zs) => {
        const acts = zs.filter((z) => z.kind === 'activity');
        if (acts.length >= MAX_ACTIVITY) return zs;
        const used = new Set(acts.map((d) => d.name));
        const name = ACTIVITY_SUGGESTIONS.find((s) => !used.has(s)) ?? `Play area ${acts.length + 1}`;
        return [...zs, { id: newZoneId(), kind: 'activity', name, x, y, w, h }];
      });
    } else {
      setZones((zs) => {
        const dangers = zs.filter((z) => z.kind === 'danger');
        if (dangers.length >= MAX_DANGER) return zs;
        const used = new Set(dangers.map((d) => d.name));
        const name = DANGER_SUGGESTIONS.find((s) => !used.has(s)) ?? `zone ${dangers.length + 1}`;
        return [...zs, { id: newZoneId(), kind: 'danger', name, x, y, w, h }];
      });
    }
  };

  // Display position (mirrored like the live picture when needed).
  const place = (z: { x: number; y: number; w: number; h: number }): React.CSSProperties => ({
    left: `${(mirror ? 1 - z.x - z.w : z.x) * 100}%`,
    top: `${z.y * 100}%`,
    width: `${z.w * 100}%`,
    height: `${z.h * 100}%`,
  });

  const crib = zones.find((z) => z.kind === 'crib');
  const dangers = zones.filter((z) => z.kind === 'danger');
  const acts = zones.filter((z) => z.kind === 'activity');
  const rename = (id: string, name: string) => setZones((zs) => zs.map((z) => (z.id === id ? { ...z, name } : z)));
  const remove = (id: string) => setZones((zs) => zs.filter((z) => z.id !== id));

  return (
    <div className="sheet-scrim ze-scrim" role="dialog" aria-modal="true" aria-labelledby="ze-title">
      <div className="sheet ze-sheet fade-in">
        <div className="sheet-head">
          <div className="sheet-icon"><Icon name="target" size={18} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id="ze-title" className="sheet-title serif">Crib, danger zones &amp; play areas</h2>
            <div className="sheet-sub ze-sub">
              {mode === 'crib'
                ? `Drag a box around the crib mattress — ${babyName || 'the baby'}’s movement there drives sleep tracking and climb-out alerts.`
                : mode === 'activity'
                  ? `Drag a box over a play gym, bouncer or play mat — with smart vision on, the log notes when ${babyName || 'the baby'} is there and for how long.`
                  : `Drag a box over anywhere ${babyName || 'the baby'} must not reach — a window, the stairs, a dresser. Movement there alerts everyone.`}
            </div>
          </div>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close"><Icon name="x" size={17} /></button>
        </div>

        <div className="ze-modes" role="radiogroup" aria-label="What to draw">
          <button role="radio" aria-checked={mode === 'crib'} className={cx('cam-chip', mode === 'crib' && 'sel')} onClick={() => setMode('crib')}>
            <Icon name="baby" size={13} />{crib ? 'Redraw crib' : 'Crib'}
          </button>
          <button role="radio" aria-checked={mode === 'danger'} className={cx('cam-chip', mode === 'danger' && 'sel')} disabled={dangers.length >= MAX_DANGER} onClick={() => setMode('danger')}>
            <Icon name="alert" size={13} />Danger zone{dangers.length ? ` (${dangers.length}/${MAX_DANGER})` : ''}
          </button>
          <button role="radio" aria-checked={mode === 'activity'} className={cx('cam-chip', mode === 'activity' && 'sel')} disabled={acts.length >= MAX_ACTIVITY} onClick={() => setMode('activity')}>
            <Icon name="smile" size={13} />Play area{acts.length ? ` (${acts.length}/${MAX_ACTIVITY})` : ''}
          </button>
        </div>

        <div className="ze-frame">
          <div
            ref={boxRef}
            className={cx('ze-box', mode)}
            style={{ aspectRatio: String(aspect) }}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={() => setDraft(null)}
          >
            <video ref={videoRef} className={cx(mirror && 'mirror')} autoPlay muted playsInline />
            {!stream && <div className="ze-empty">Waiting for the camera’s picture…</div>}
            {zones.map((z) => (
              <div key={z.id} className={cx('ze-zone', z.kind)} style={place(z)}>
                <span>{z.kind === 'crib' ? 'Crib' : z.name}</span>
                <button className="ze-zone-x" onClick={() => remove(z.id)} aria-label={`Remove ${z.kind === 'crib' ? 'crib' : z.name}`}><Icon name="x" size={11} /></button>
              </div>
            ))}
            {draft && <div className={cx('ze-zone draft', mode)} style={place({ x: Math.min(draft.x0, draft.x1), y: Math.min(draft.y0, draft.y1), w: Math.abs(draft.x1 - draft.x0), h: Math.abs(draft.y1 - draft.y0) })} />}
          </div>
        </div>

        {(dangers.length > 0 || acts.length > 0) && (
          <div className="ze-list">
            {acts.map((z) => (
              <label key={z.id} className="ze-item">
                <Icon name="smile" size={14} />
                <span>Play area</span>
                <input className="input" value={z.name} maxLength={30} onChange={(e) => rename(z.id, e.target.value)} aria-label="Play area name" />
                <button className="iconbtn" onClick={() => remove(z.id)} aria-label={`Remove ${z.name}`}><Icon name="trash" size={14} /></button>
              </label>
            ))}
            {dangers.map((z) => (
              <label key={z.id} className="ze-item">
                <Icon name="alert" size={14} />
                <span>Movement near</span>
                <input className="input" value={z.name} maxLength={30} onChange={(e) => rename(z.id, e.target.value)} aria-label="Danger zone name" />
                <button className="iconbtn" onClick={() => remove(z.id)} aria-label={`Remove ${z.name}`}><Icon name="trash" size={14} /></button>
              </label>
            ))}
          </div>
        )}
        <p className="faint ze-note">
          <Icon name="info" size={12} /> Works best with the phone fixed in place and some light in the room. If the camera is moved, redraw the zones.
        </p>
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {zones.length > 0 && <Btn variant="subtle" onClick={() => setZones([])}>Clear all</Btn>}
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn variant="solid" icon="check" onClick={() => onSave(zones.map((z) => ({ ...z, name: z.name.trim() || (z.kind === 'crib' ? 'Crib' : z.kind === 'activity' ? 'Play area' : 'danger zone') })))}>Save zones</Btn>
        </div>
      </div>
    </div>
  );
}
