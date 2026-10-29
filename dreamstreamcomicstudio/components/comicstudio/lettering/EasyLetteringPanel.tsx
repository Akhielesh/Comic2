// Easy lettering panel (lettering.md §7.3; owner: "users with just Easy must also be able to do all
// this"): big friendly controls, at most one row per concern — comic style presets, balloon type,
// text size / font / colour, bubble colour + see-through + outline, tail on/off, edit / duplicate /
// delete, and "Ask AI about this balloon". Every control is free software (no render, no AI).

import React, { useState } from 'react';
import { Copy, Minus, PencilLine, Plus, Send, Trash2 } from 'lucide-react';
import type { DocOp } from '../../../shared/comic/ops';
import type { LetterStylePatch } from '../../../shared/comic/lettering/style';
import type { PatchOptions } from '../types';
import { ColorField, withAlpha } from './ColorField';
import { FontPicker } from './FontPicker';
import { EasyShapePicker } from './ShapePicker';
import { PresetGallery } from './PresetGallery';
import { paintOf } from './svgMarkup';
import {
  deleteLinesOps,
  duplicateLineOps,
  easyShapeOf,
  easyShapeOps,
  hasVisibleTail,
  presetOps,
  sharedValue,
  sizeStepOps,
  styleScopeOps,
  tailToggleOps
} from './styleOps';
import { BORDER_SWATCHES, FILL_SWATCHES, TEXT_SWATCHES, paletteOf, type LetteringPanelProps } from './panelTypes';
import { cx } from '../board/ui';

const ROW = 'space-y-1.5';
const ROW_LABEL = 'text-[11.5px] font-medium text-[var(--ds-muted)]';
// Touch (coarse pointers): every control is a REAL 44 px box (not a 32 px box with an ::after hit area —
// neighbouring ::after areas overlapped and stole each other's taps; P1-QA easy-lettering-small-targets).
const SMALL_BTN =
  'inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-2 text-[12px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] disabled:opacity-40 coarse:h-11 coarse:min-w-11 coarse:px-3 coarse:text-[13px]';

type SeeThrough = 'solid' | 'soft' | 'see' | 'clear';
const SEE_ALPHA: Record<Exclude<SeeThrough, 'clear'>, number> = { solid: 1, soft: 0.85, see: 0.6 };
const SEE_OPTIONS: { value: SeeThrough; label: string; title: string }[] = [
  { value: 'solid', label: 'Solid', title: 'Nothing shows through the bubble' },
  { value: 'soft', label: 'Soft', title: 'The art shows through a little (85 %)' },
  { value: 'see', label: 'See-through', title: 'The art shows through (60 %)' },
  { value: 'clear', label: 'Clear', title: 'No fill: just the outline and the text' }
];
/** Checkerboard behind the opacity previews. */
const CHECKER: React.CSSProperties = {
  backgroundImage: 'linear-gradient(45deg,#ccc 25%,transparent 25%),linear-gradient(-45deg,#ccc 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ccc 75%),linear-gradient(-45deg,transparent 75%,#ccc 75%)',
  backgroundSize: '6px 6px',
  backgroundPosition: '0 0,0 3px,3px -3px,-3px 0',
  backgroundColor: '#fff'
};
const seeThroughOf = (fill: string | undefined): SeeThrough | 'mixed' => {
  if (fill === undefined) return 'mixed';
  if (fill === 'none') return 'clear';
  const a = paintOf(fill)?.opacity ?? 1;
  return a >= 0.95 ? 'solid' : a >= 0.72 ? 'soft' : 'see';
};

export const EasyLetteringPanel: React.FC<LetteringPanelProps> = ({ doc, page, lines, plans, placements, H, apply, onEditText, onAskAI, onDeselect }) => {
  const [ask, setAsk] = useState('');
  const ids = lines.map((l) => l.id);
  const one = lines.length === 1 ? lines[0] : undefined;
  const lang = doc.format?.language || 'en';
  const palette = paletteOf(doc);
  const style = (patch: LetterStylePatch, opts?: PatchOptions) => apply(styleScopeOps(doc, page, ids, patch, 'selection'), opts);
  const run = (ops: DocOp[], label: string) => ops.length && apply(ops, { label });

  const fill = sharedValue(doc, lines, 'fill');
  const see = seeThroughOf(fill);
  const border = sharedValue(doc, lines, 'border');
  const borderStyle = sharedValue(doc, lines, 'borderStyle');
  const textColor = sharedValue(doc, lines, 'textColor');
  const font = sharedValue(doc, lines, 'font');
  const tailOn = lines.every((l) => hasVisibleTail(doc, l, placements.balloons.get(l.id)));
  const sfxOnly = lines.every((l) => l.kind === 'sfx');
  const shape = one ? easyShapeOf(doc, one) : undefined;

  const setSee = (v: SeeThrough) => {
    if (v === 'clear') return style({ fill: 'none' }, { label: 'See-through bubble' });
    const base = fill && fill !== 'none' ? fill : '#ffffff';
    style({ fill: withAlpha(base, SEE_ALPHA[v]) }, { label: 'Bubble opacity' });
  };

  return (
    <div className="space-y-3.5" data-testid="easy-lettering">
      <section className={ROW} aria-label="Comic lettering style">
        <p className={ROW_LABEL}>Comic style (every balloon)</p>
        <PresetGallery variant="chips" value={doc.letterStyle?.presetId ?? 'classic'} onChange={(id) => run(presetOps(id), 'Change lettering style')} lang={lang} />
      </section>

      {!sfxOnly && (
        <section className={ROW} aria-label="Balloon type">
          <p className={ROW_LABEL}>Balloon type</p>
          <EasyShapePicker value={shape} onChange={(s) => run(easyShapeOps(doc, page, ids, s), 'Change balloon type')} />
        </section>
      )}

      <section className={ROW} aria-label="Text">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={ROW_LABEL}>Text</p>
          <div className="flex items-center gap-1.5">
            <button type="button" className={SMALL_BTN} aria-label="Smaller text" onClick={() => run(sizeStepOps(doc, page, ids, -0.1), 'Smaller text')}>
              <Minus className="h-3.5 w-3.5" aria-hidden />
            </button>
            <span className="w-10 text-center text-[11.5px] tabular-nums text-[var(--ds-muted)]" aria-live="polite">
              {(() => {
                const v = sharedValue(doc, lines, 'sizeScale');
                return v === undefined ? 'Mixed' : `${Math.round(v * 100)}%`;
              })()}
            </span>
            <button type="button" className={SMALL_BTN} aria-label="Bigger text" onClick={() => run(sizeStepOps(doc, page, ids, 0.1), 'Bigger text')}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        </div>
        <FontPicker simple value={font} lang={lang} onChange={(f) => style({ font: f }, { label: 'Change font' })} />
        <ColorField
          label="Text colour"
          simple
          value={textColor ?? '#111111'}
          swatches={[...TEXT_SWATCHES, ...palette]}
          allowAuto={sfxOnly}
          onChange={(c) => style({ textColor: c }, { label: 'Text colour' })}
        />
      </section>

      {!sfxOnly && (
        <section className={ROW} aria-label="Bubble">
          <ColorField
            label="Bubble colour"
            simple
            value={fill ?? '#ffffff'}
            swatches={[...FILL_SWATCHES, ...palette]}
            allowNone
            onChange={(c) => style({ fill: c === 'none' ? 'none' : withAlpha(c, see === 'soft' ? SEE_ALPHA.soft : see === 'see' ? SEE_ALPHA.see : 1) }, { label: 'Bubble colour' })}
          />
          {/* Wrapping chips (not a fixed segmented row): "See-through" never overlaps its neighbour at 320 px,
              and each chip previews the fill at that opacity over a checkerboard. */}
          <div role="radiogroup" aria-label="Bubble opacity" className="flex flex-wrap gap-1.5">
            {SEE_OPTIONS.map((o) => {
              const on = see === o.value;
              const swatch = o.value === 'clear' ? 'transparent' : withAlpha(fill && fill !== 'none' ? fill : '#ffffff', SEE_ALPHA[o.value]);
              return (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  title={o.title}
                  onClick={() => setSee(o.value)}
                  className={cx(SMALL_BTN, 'rounded-full', on && 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)]')}
                >
                  <span aria-hidden className="relative h-3.5 w-3.5 shrink-0 overflow-hidden rounded-full border border-[var(--ds-hairline)]" style={CHECKER}>
                    <span className="absolute inset-0" style={{ background: swatch }} />
                  </span>
                  {o.label}
                </button>
              );
            })}
          </div>
          <ColorField
            label="Outline"
            simple
            value={borderStyle === 'none' ? 'none' : border ?? '#111111'}
            swatches={[...BORDER_SWATCHES, ...palette]}
            allowNone
            onChange={(c) =>
              style(c === 'none' ? { borderStyle: 'none' } : { border: c, ...(borderStyle === 'none' ? { borderStyle: 'solid' } : {}) }, { label: 'Outline colour' })
            }
          />
        </section>
      )}

      <section className="flex flex-wrap items-center gap-1.5" aria-label="Balloon actions">
        {!sfxOnly && (
          <button
            type="button"
            className={cx(SMALL_BTN, tailOn && 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)]')}
            aria-pressed={tailOn}
            onClick={() => run(tailToggleOps(doc, page, ids, !tailOn, placements.balloons, H), tailOn ? 'Remove tail' : 'Add tail')}
          >
            Tail {tailOn ? 'on' : 'off'}
          </button>
        )}
        {one && (
          <button type="button" className={SMALL_BTN} onClick={() => onEditText(one.id)}>
            <PencilLine className="h-3.5 w-3.5" aria-hidden /> Edit text
          </button>
        )}
        {one && (
          <button type="button" className={SMALL_BTN} onClick={() => run(duplicateLineOps(page, one.id, placements.balloons), 'Duplicate balloon')}>
            <Copy className="h-3.5 w-3.5" aria-hidden /> Duplicate
          </button>
        )}
        <button
          type="button"
          className={cx(SMALL_BTN, 'text-red-600 dark:text-red-400')}
          onClick={() => {
            run(deleteLinesOps(page, ids), lines.length > 1 ? 'Delete balloons' : 'Delete balloon');
            onDeselect();
          }}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete
        </button>
      </section>

      {onAskAI && (
        <form
          className="flex min-w-0 items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const t = ask.trim();
            if (!t) return;
            onAskAI(t);
            setAsk('');
          }}
        >
          <label htmlFor={`ask-${page.id}`} className="sr-only">
            Ask the director about this balloon
          </label>
          <input
            id={`ask-${page.id}`}
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder={lines.length > 1 ? 'Ask AI about these balloons…' : 'Ask AI about this balloon…'}
            className="h-9 min-w-0 flex-1 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-3 text-[13px] text-[var(--ds-ink)] coarse:h-11 coarse:text-[16px] placeholder:text-[var(--ds-faint)] focus:border-[var(--ds-accent)] focus:outline-none"
          />
          <button type="submit" disabled={!ask.trim()} aria-label="Send to the director" className={SMALL_BTN}>
            <Send className="h-3.5 w-3.5" aria-hidden />
          </button>
        </form>
      )}
      {plans.length === 0 && <p className="text-[11px] text-[var(--ds-muted)]">Nothing to letter on this page yet.</p>}
    </div>
  );
};

export default EasyLetteringPanel;
