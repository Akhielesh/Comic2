// The inspector's typed transform (agent-editor plan §3 C2; master plan §2.4): X, Y, W, H (minimum height) and
// rotation of one balloon, in % of the page or mm / in on the printed trim. Each field writes one B9 engine edit:
//   X, Y      balloon {x, y, pinned: true}   setBoxEdit (the outline moves; the tail tip stays on its point)
//   W         balloon {w}                     setBoxEdit
//   H         balloon {minH}                  setBoxEdit (the height handle's field)
//   Rotation  balloon {rot}                   rotateEdit (±45°)
// These are existing, server-accepted balloon fields (not Pro fields), so they write whatever the Pro switch says.
// Arrow steps coalesce into one undo entry per field; a typed value is its own. A refusal is said in plain words.

import React, { useMemo, useState } from 'react';
import type { Balloon, ComicDoc, Page } from '../../../shared/comic/doc';
import type { DocOp } from '../../../shared/comic/ops';
import type { LetterPlan } from '../../../shared/comic/lettering/layout';
import { EDITOR_LIMITS } from '../../../shared/comic/limits';
import { editOf, sceneObject, type EditResult } from '../../../shared/comic/editor/scene';
import { rotateEdit, setBoxEdit } from '../../../shared/comic/editor/transform';
import type { PatchOptions } from '../types';
import { cn } from '../../../lib/utils';
import { MUTED, OVERLINE } from '../../chat/studioDesign';
import { Segmented } from '../board/ui';
import { NumberField, type NumberCommit } from './NumberField';
import { balloonOp, pinKeepingSizeOps, sceneFor } from './styleOps';
import { LENGTH_UNITS, readUnits, unitScale, unitStep, writeUnits, type LengthUnit } from '../editor/inspector/units';

export interface TransformSectionProps {
  doc: ComicDoc;
  page: Page;
  plans: readonly LetterPlan[];
  /** Page height in plan units (width is 1000). */
  H: number;
  /** The selected lines (the section edits one balloon). */
  lineIds: readonly string[];
  /** Stored + software-placed balloons (placements.balloons). */
  balloons: ReadonlyMap<string, Balloon>;
  apply(ops: DocOp[], opts?: PatchOptions): void;
  editionLang?: string;
  className?: string;
}

type Field = 'x' | 'y' | 'w' | 'h' | 'rot';

/** The ops a transform field commits, from the B9 engine (exported for tests and the phone context bar). */
export function transformEdit(
  doc: ComicDoc,
  page: Page,
  plans: readonly LetterPlan[],
  lineId: string,
  field: Field,
  value: number,
  balloons: ReadonlyMap<string, Balloon>
): EditResult {
  const scene = sceneFor(doc, page, plans);
  const ref = { kind: 'balloon' as const, id: lineId };
  if (field === 'rot') {
    const r = rotateEdit(doc, page, ref, value);
    // A line the software placed has no stored balloon yet: rotating it stores its drawn balloon with the angle.
    if (!r.ok && !page.balloons.some((b) => b.lineId === lineId) && balloons.has(lineId)) {
      const rot = Math.round(Math.max(-EDITOR_LIMITS.balloonRot, Math.min(EDITOR_LIMITS.balloonRot, value)) * 10) / 10;
      if (!rot) return r;
      return editOf(doc, [balloonOp(page, lineId, { rot, pinned: true }, balloons)], 'Rotate balloon');
    }
    return r;
  }
  const me = sceneObject(scene, ref);
  if (!me) return setBoxEdit(doc, page, ref, { x: 0, y: 0, w: 0, h: 0 }, scene);
  const to = { ...me.box, [field]: value };
  return setBoxEdit(doc, page, ref, to, scene);
}

export const TransformSection: React.FC<TransformSectionProps> = ({ doc, page, plans, H, lineIds, balloons, apply, editionLang, className }) => {
  const [units, setUnits] = useState<LengthUnit>(() => readUnits());
  const [refusal, setRefusal] = useState<string | null>(null);
  const aspect = H > 0 ? 1000 / H : 2 / 3;
  const id = lineIds.length === 1 ? lineIds[0] : undefined;
  const me = useMemo(() => (id ? sceneObject(sceneFor(doc, page, plans), { kind: 'balloon', id }) : undefined), [doc, page, plans, id]);
  const stored = id ? page.balloons.find((b) => b.lineId === id) : undefined;
  const locked = !!stored?.locked;

  if (!id) {
    return (
      <p data-testid="transform-many" className={cn('m-0 text-[11.5px] leading-snug', MUTED, className)}>
        Position and size are typed for one balloon at a time — Arrange lines several up.
      </p>
    );
  }
  if (!me) return null;

  const commit = (field: Field) => (value: number, how: NumberCommit) => {
    const r = transformEdit(doc, page, plans, id, field, value, balloons);
    if (r.ok === false) {
      setRefusal(r.reason);
      return;
    }
    setRefusal(null);
    const ops = field === 'rot' ? r.ops : pinKeepingSizeOps(r.ops, page, plans, [id], editionLang);
    apply(ops, { label: r.label, ...(how.via === 'step' ? { coalesce: `xform:${page.id}:${id}:${field}` } : {}) });
  };
  const { step, decimals } = unitStep(units);
  const sx = unitScale(units, 'x', aspect);
  const sy = unitScale(units, 'y', aspect);
  const unit = units === '%' ? '%' : units;
  const lengths: { field: Field; label: string; value: number; min: number; max: number; scale: number }[] = [
    { field: 'x', label: 'X', value: me.box.x, min: 0, max: sx, scale: sx },
    { field: 'y', label: 'Y', value: me.box.y, min: 0, max: sy, scale: sy },
    { field: 'w', label: 'W', value: me.box.w, min: 0.05 * sx, max: 0.95 * sx, scale: sx },
    { field: 'h', label: 'H (minimum)', value: me.box.h, min: 0.01 * sy, max: EDITOR_LIMITS.minHMax * sy, scale: sy }
  ];

  return (
    <section aria-label="Position and size" data-testid="transform-section" className={cn('min-w-0 space-y-1.5', className)}>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h4 className={cn('m-0', OVERLINE)}>Transform</h4>
        <Segmented<LengthUnit>
          label="Units"
          size="xs"
          value={units}
          onChange={(u) => {
            setUnits(u);
            writeUnits(u);
          }}
          options={LENGTH_UNITS.map((u) => ({ value: u, label: u, title: u === '%' ? '% of the page' : `${u} on the printed page` }))}
        />
      </div>
      <div className="grid min-w-0 grid-cols-2 gap-x-2 gap-y-1.5">
        {lengths.map((f) => (
          <NumberField
            key={`${f.field}-${units}`}
            label={f.label}
            value={f.value}
            scale={f.scale}
            min={Math.round(f.min * 100) / 100}
            max={Math.round(f.max * 100) / 100}
            step={step}
            decimals={decimals}
            unit={unit}
            disabled={locked}
            title={locked ? 'This balloon is locked. Unlock it to change it.' : undefined}
            testId={`xform-${f.field}`}
            onCommit={commit(f.field)}
          />
        ))}
        <NumberField
          label="Rotation"
          value={me.rot}
          min={-EDITOR_LIMITS.balloonRot}
          max={EDITOR_LIMITS.balloonRot}
          step={1}
          unit="°"
          disabled={locked || !!editionLang}
          title={editionLang ? 'Rotation is the same in every language. Change it in the original language.' : undefined}
          testId="xform-rot"
          onCommit={commit('rot')}
        />
      </div>
      {refusal && (
        <p role="status" data-testid="transform-refusal" className={cn('m-0 text-[11px] leading-snug', MUTED)}>
          {refusal}
        </p>
      )}
    </section>
  );
};

export default TransformSection;
