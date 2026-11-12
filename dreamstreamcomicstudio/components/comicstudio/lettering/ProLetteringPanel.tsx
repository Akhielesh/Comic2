// Pro lettering panel (lettering.md §7.4): Text · Bubble · Tail · Arrange · Apply. Full typography
// (font, size, weight, italic, case, spacing, line height, alignment, colour + opacity, outline, shadow,
// SFX effects), the whole bubble library (shape, fill colour + opacity + transparent, border colour /
// width / style, padding), tails, stacking / lock / link / align / distribute, and "Apply this style
// to…" any scope. Edits apply to the selection; sliders coalesce into one undo entry. All free.

import React, { useState } from 'react';
import { AlignCenter, AlignLeft, AlignRight, ArrowDownToLine, ArrowUpToLine, Link2, Link2Off, Lock, LockOpen, PencilLine, Trash2 } from 'lucide-react';
import { SCRIPTS } from '../../../shared/comic/languages';
import { languageSpec } from '../../../shared/comic/languages';
import { FONT_REGISTRY } from '../../../shared/comic/lettering/fonts';
import { SFX_EFFECTS, type BorderStyle, type BubbleShape, type LetterStyle, type LetterStylePatch, type ProSfxEffect, type SfxEffect, type TextCase } from '../../../shared/comic/lettering/style';
import type { Line } from '../../../shared/comic/doc';
import type { DocOp } from '../../../shared/comic/ops';
import type { PatchOptions } from '../types';
import { ColorField } from './ColorField';
import { FontPicker } from './FontPicker';
import { ProShapePicker, ShapePicker, TailPicker } from './ShapePicker';
import type { NumberCommit, NumberFieldProps } from './NumberField';
import { useProExtras } from './pro/proExtras';
import { proFieldsWritable } from '../editor/inspector/proSwitch';
import {
  aimAtSpeakerOps,
  alignOps,
  balloonOp,
  canLinkToPrevious,
  isLinked,
  clearStyleOps,
  deleteLinesOps,
  distributeOps,
  fitWidthOps,
  linkOps,
  lockOps,
  pinKeepingSizeOps,
  resetPositionOps,
  sharedValue,
  speakerMarkFor,
  styleScopeOps,
  zOrderOps,
  type AlignEdge,
  type StyleScope
} from './styleOps';
import { measureForGeneration } from './measure';
import { fontLoadGeneration } from './fontLoader';
import { BORDER_SWATCHES, FILL_SWATCHES, TEXT_SWATCHES, paletteOf, type LetteringPanelProps } from './panelTypes';
import { SEGMENTED_ACTIVE, TONE_TEXT } from '../../chat/studioDesign';
import { Segmented, cx } from '../board/ui';
import { LINE_KIND_LABEL, castName } from '../board/boardModel';

type Tab = 'text' | 'bubble' | 'tail' | 'arrange' | 'apply';
const TABS: { id: Tab; label: string }[] = [
  { id: 'text', label: 'Text' },
  { id: 'bubble', label: 'Bubble' },
  { id: 'tail', label: 'Tail' },
  { id: 'arrange', label: 'Arrange' },
  { id: 'apply', label: 'Apply' }
];
const LABEL = 'text-[11.5px] font-medium text-[var(--ds-muted)]';
/** The panel's label ink and size (the Pro extras' rows read the same). */
export const PANEL_LABEL = LABEL;
// The button's shape without an ink (`cx` does not merge: a tone stacked on the neutral ink loses to
// it). BTN is the neutral button; Delete is BTN_SHAPE + TONE_TEXT.danger (statusInkGuard.test.ts).
const BTN_SHAPE =
  'inline-flex h-8 items-center justify-center gap-1 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-2 text-[12px] font-medium hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] disabled:cursor-not-allowed disabled:opacity-40 coarse:h-11 coarse:min-w-11 coarse:px-3';
const BTN = `${BTN_SHAPE} text-[var(--ds-ink)]`;
/** The panel's neutral button (the Pro extras' buttons read the same). */
export const PANEL_BTN = BTN;
const CASES: { value: TextCase; label: string }[] = [
  { value: 'upper', label: 'UPPER' },
  { value: 'as_typed', label: 'As typed' },
  { value: 'lower', label: 'lower' },
  { value: 'title', label: 'Title' }
];
const BORDERS: { value: BorderStyle; label: string }[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
  { value: 'double', label: 'Double' },
  { value: 'none', label: 'None' }
];
const SFX_LABEL: Record<SfxEffect, string> = { filled_stroke: 'Filled', outlined: 'Outlined', shadow: 'Shadow', skewed: 'Skewed', arched: 'Arched', pop: 'Pop' };
/** The Pro SFX effects (PE-LETTER draws them; the unions stay separate in S2, collisions B-4). halftone_fill is S3. */
export const PRO_SFX_LABEL: Record<ProSfxEffect, string> = {
  extrude3d: '3D extrude',
  outline_stack: 'Stacked outline',
  wobble: 'Wobble',
  shatter: 'Shatter',
  gradient: 'Gradient',
  halftone_fill: 'Halftone'
};

/** A typed field beside a slider (Pro Edit): display range, step and unit; stored × scale = shown. */
interface NumericSpec {
  scale: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
}
/** A NumericSpec with the typed field to draw it (the lazily loaded Pro extras' NumberField). */
type NumericField = NumericSpec & { Field: React.ComponentType<NumberFieldProps> };

/** A labelled slider with a live value; `mixed` when the selection disagrees. */
const Slider: React.FC<{
  label: string;
  value: number | undefined;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  disabled?: boolean;
  note?: string;
  onChange(v: number): void;
  /** Pro Edit: a typed field instead of the read-out (arrows step, Shift ×10, Enter commits one undo entry). */
  numeric?: NumericField;
  /** A typed value (`via: 'type'`, its own undo entry) or an arrow step (`via: 'step'`, coalesced). */
  onTyped?(v: number, how: NumberCommit): void;
}> = ({ label, value, min, max, step, format = (v) => String(Math.round(v * 100) / 100), disabled, note, onChange, numeric, onTyped }) => {
  const id = React.useId();
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className={LABEL}>
          {label}
        </label>
        {numeric ? (
          <numeric.Field
            label={label}
            hideLabel
            steppers={false}
            className="w-[4.75rem] shrink-0"
            value={value}
            scale={numeric.scale}
            min={numeric.min}
            max={numeric.max}
            step={numeric.step}
            unit={numeric.unit}
            disabled={disabled}
            testId={`num-${label}`}
            onCommit={(v, how) => (onTyped ? onTyped(v, how) : onChange(v))}
          />
        ) : (
          <span className="text-[11px] tabular-nums text-[var(--ds-muted)]">{value === undefined ? 'Mixed' : format(value)}</span>
        )}
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value ?? (min + max) / 2}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        onKeyDown={(e) => e.stopPropagation()}
        className="w-full accent-[var(--ds-accent)] disabled:opacity-40"
      />
      {note && <p className="text-[10.5px] leading-snug text-[var(--ds-muted)]">{note}</p>}
    </div>
  );
};

export const Toggle: React.FC<{ label: string; on: boolean; disabled?: boolean; title?: string; onChange(on: boolean): void }> = ({ label, on, disabled, title, onChange }) => (
  <button type="button" role="switch" aria-checked={on} disabled={disabled} title={title} onClick={() => onChange(!on)} className={cx(BTN, on && 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)]')}>
    <span aria-hidden className={cx('h-3 w-5 rounded-full p-px transition-colors', on ? 'bg-[var(--ds-accent-soft)]' : 'bg-[var(--ds-well-strong)]')}>
      <span className={cx('block h-2.5 w-2.5 rounded-full bg-white transition-transform motion-reduce:transition-none', on && 'translate-x-2')} />
    </span>
    {label}
  </button>
);

/** A line's OWN value of a style key, when every selected line agrees (Pro keys a build without their drawing
 *  cannot resolve still show what is stored). */
const ownValue = <K extends keyof LetterStyle>(lines: readonly Line[], key: K): LetterStyle[K] | undefined => {
  if (!lines.length) return undefined;
  const vals = lines.map((l) => (l.style as Record<string, unknown> | undefined)?.[key as string]);
  const first = JSON.stringify(vals[0] ?? null);
  return vals.every((x) => JSON.stringify(x ?? null) === first) ? (vals[0] as LetterStyle[K]) : undefined;
};

/**
 * Editing a translated edition (LE-3 / LE-4): stacking, lock and the connector are SHARED by every
 * language and belong to the original, so the Arrange tab offers them disabled with the reason instead
 * of letting a tap half-apply (the edition would freeze the balloon) or do nothing silently. The page
 * editor passes these through the inspector when it edits an edition.
 */
export interface ProLetteringEditionProps {
  /** The edition being edited (unset = the original language). */
  editionLang?: string;
  /** The original's language name ("English") for the hint. */
  sourceName?: string;
  /**
   * Pro Edit (COMIC_PRO_EDITOR_V2 on; PE-INSPECT): typed fields beside every slider, Forward / Backward / Duplicate,
   * align to the selection, panel or page and distribute across, Copy / Paste style — and, only while Pro fields are
   * writable (PRO_EDIT_OPS_PATCHABLE), the Pro text effects, shapes, SFX effects, fonts and saved styles. Off = today.
   * Everything Pro beyond the switch's own checks is in the lazily loaded Pro extras (lettering/pro/proExtras.ts), so
   * the Easy path never loads it; the Balloon width slider gives way to the typed transform's W.
   */
  proEdit?: boolean;
}

export const ProLetteringPanel: React.FC<LetteringPanelProps & ProLetteringEditionProps> = ({ doc, page, lines, plans, placements, H, apply, onEditText, onDeselect, editionLang, sourceName, proEdit }) => {
  const [tab, setTab] = useState<Tab>('text');
  const [scope, setScope] = useState<StyleScope>('kind_comic');
  const pro = useProExtras(!!proEdit);
  const ids = lines.map((l) => l.id);
  const one = lines.length === 1 ? lines[0] : undefined;
  const lang = one?.lang || doc.format?.language || 'en';
  const script = SCRIPTS[languageSpec(lang)?.script ?? 'Latn'];
  const palette = paletteOf(doc);
  const v = <K extends keyof LetterStyle>(key: K) => sharedValue(doc, lines, key);
  const style = (patch: LetterStylePatch, label: string, scrubKey?: string) =>
    apply(styleScopeOps(doc, page, ids, patch, 'selection'), { label, ...(scrubKey ? { coalesce: `style:${page.id}:${ids.join(',')}:${scrubKey}` } : {}) });
  const run = (ops: DocOp[], label: string, opts?: PatchOptions) => ops.length && apply(ops, { label, ...opts });
  const selPlans = plans.filter((p) => ids.includes(p.lineId));
  const anySfx = lines.some((l) => l.kind === 'sfx');
  const font = v('font');
  const weights = (font ? FONT_REGISTRY[font]?.weights : [400, 700]) || [400, 700];
  const textStroke = v('textStroke');
  const shadow = v('shadow');
  const locked = selPlans.length > 0 && selPlans.every((p) => p.locked);
  // Linked at either end (its own connector to the previous line, or the next line's into it).
  const linked = !!one && isLinked(page, one.id);
  const aspect = 1000 / H;
  const original = sourceName || 'the original';
  // Shared balloon properties are changed in the original only (the edition's own positions are drags).
  const sharedLocked = !!editionLang;
  const inOriginal = sharedLocked ? `Stacking, lock and connectors belong to ${original} — switch to ${original} to change them.` : undefined;

  const scopes: { id: StyleScope; label: string; disabled?: boolean }[] = [
    { id: 'selection', label: lines.length > 1 ? 'These balloons' : 'This balloon' },
    { id: 'kind_page', label: `All ${one ? LINE_KIND_LABEL[one.kind].toLowerCase() : 'lines'} on this page`, disabled: !one },
    { id: 'kind_comic', label: `All ${one ? LINE_KIND_LABEL[one.kind].toLowerCase() : 'lines'} in the comic`, disabled: !one },
    { id: 'speaker', label: one?.speakerId ? `All of ${castName(doc, one.speakerId)}’s lines` : 'All of this speaker’s lines', disabled: !one?.speakerId },
    { id: 'comic', label: 'The whole comic' }
  ];
  const overrides = one?.style && Object.keys(one.style).length ? one.style : undefined;
  // ── Pro Edit ──
  const writable = !!proEdit && proFieldsWritable();
  /** The typed field beside a slider: Pro Edit only, once the Pro extras are there (the read-out shows until then). */
  const num = (spec: NumericSpec): NumericField | undefined => (proEdit && pro ? { ...spec, Field: pro.NumberField } : undefined);
  /** A typed slider value: its own undo entry when typed, coalesced with the slider's key when stepped. */
  const typed = (key: string, label: string, patchOf: (x: number) => LetterStylePatch) => (x: number, how: NumberCommit) => style(patchOf(x), label, how.via === 'step' ? key : undefined);
  const pv = <K extends keyof LetterStyle>(key: K): LetterStyle[K] | undefined => (v(key) ?? ownValue(lines, key)) as LetterStyle[K] | undefined;

  return (
    <div className="space-y-3" data-testid="pro-lettering">
      <div role="tablist" aria-label="Lettering controls" className="flex gap-0.5 overflow-x-auto rounded-xl bg-[var(--ds-segment-track)] p-0.5 [scrollbar-width:none]">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`pl-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`pl-panel-${t.id}`}
            onClick={() => setTab(t.id)}
            className={cx(
              'min-w-0 flex-1 whitespace-nowrap rounded-[10px] px-2 py-1 text-[11.5px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]',
              tab === t.id ? SEGMENTED_ACTIVE : 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`pl-panel-${tab}`} aria-labelledby={`pl-tab-${tab}`} className="space-y-3">
        {tab === 'text' && (
          <>
            <FontPicker value={font} lang={lang} pro={proEdit} onChange={(f) => style({ font: f }, 'Change font')} />
            <Slider
              label="Size"
              value={v('sizeScale')}
              min={0.5}
              max={3.5}
              step={0.05}
              format={(x) => `${Math.round(x * 100)}%`}
              onChange={(x) => style({ sizeScale: x }, 'Text size', 'size')}
              numeric={num({ scale: 100, min: 50, max: 350, step: 5, unit: '%' })}
              onTyped={typed('size', 'Text size', (x) => ({ sizeScale: x }))}
            />
            <div className="space-y-1">
              <p className={LABEL}>Weight</p>
              <Segmented<string>
                label="Weight"
                size="xs"
                className="w-full"
                value={String(v('weight') ?? '')}
                onChange={(w) => style({ weight: Number(w) as LetterStyle['weight'] }, 'Text weight')}
                options={weights.filter((w) => w >= 400).map((w) => ({ value: String(w), label: w >= 800 ? 'Black' : w >= 700 ? 'Bold' : w >= 600 ? 'Semi' : w >= 500 ? 'Medium' : 'Regular' }))}
              />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Toggle
                label="Italic"
                on={!!v('italic')}
                disabled={!script.allowItalic}
                title={script.allowItalic ? undefined : `${languageSpec(lang)?.english ?? 'This script'} is never slanted`}
                onChange={(on) => style({ italic: on }, on ? 'Italic' : 'No italic')}
              />
              <Segmented<string>
                label="Alignment"
                size="xs"
                value={v('align') ?? ''}
                onChange={(a) => style({ align: a as LetterStyle['align'] }, 'Text alignment')}
                options={[
                  { value: 'left', label: <AlignLeft className="h-3.5 w-3.5" aria-label="Left" /> },
                  { value: 'center', label: <AlignCenter className="h-3.5 w-3.5" aria-label="Centre" /> },
                  { value: 'right', label: <AlignRight className="h-3.5 w-3.5" aria-label="Right" /> }
                ]}
              />
            </div>
            <div className="space-y-1">
              <p className={LABEL}>Case</p>
              <Segmented<string> label="Text case" size="xs" className="w-full" value={v('textCase') ?? ''} onChange={(c) => style({ textCase: c as TextCase }, 'Text case')} options={CASES} />
              {script.caseless && <p className="text-[10.5px] text-[var(--ds-muted)]">{languageSpec(lang)?.english} has no upper/lower case.</p>}
            </div>
            <Slider
              label="Letter spacing"
              value={v('letterSpacing')}
              min={-0.05}
              max={0.3}
              step={0.01}
              format={(x) => `${Math.round(x * 100)}%`}
              disabled={!script.allowLetterSpacing}
              note={script.allowLetterSpacing ? undefined : 'Spacing would break this script’s joined letters, so it stays off.'}
              onChange={(x) => style({ letterSpacing: x }, 'Letter spacing', 'spacing')}
              numeric={num({ scale: 1000, min: -50, max: 300, step: 10, unit: '‰' })}
              onTyped={typed('spacing', 'Letter spacing', (x) => ({ letterSpacing: x }))}
            />
            <Slider
              label="Line height"
              value={v('lineHeight')}
              min={0.9}
              max={1.8}
              step={0.05}
              onChange={(x) => style({ lineHeight: x }, 'Line height', 'lh')}
              numeric={num({ scale: 100, min: 90, max: 180, step: 5, unit: '%' })}
              onTyped={typed('lh', 'Line height', (x) => ({ lineHeight: x }))}
            />
            <ColorField label="Text colour" value={v('textColor') ?? '#111111'} swatches={[...TEXT_SWATCHES, ...palette]} allowAlpha allowAuto={anySfx} numeric={proEdit} onChange={(c, o) => style({ textColor: c }, 'Text colour', o?.scrub ? 'tc' : undefined)} />
            <div className="space-y-1.5">
              <Toggle label="Text outline" on={!!textStroke} onChange={(on) => style({ textStroke: on ? { color: '#ffffff', width: 0.12 } : null }, on ? 'Text outline' : 'No text outline')} />
              {textStroke && (
                <>
                  <ColorField label="Outline colour" value={textStroke.color} swatches={['#ffffff', '#111111', ...palette]} onChange={(c) => style({ textStroke: { ...textStroke, color: c } }, 'Text outline colour')} />
                  <Slider
                    label="Outline width"
                    value={textStroke.width}
                    min={0}
                    max={0.3}
                    step={0.01}
                    onChange={(x) => style({ textStroke: { ...textStroke, width: x } }, 'Text outline width', 'tsw')}
                    numeric={num({ scale: 100, min: 0, max: 30, step: 1, unit: '%' })}
                    onTyped={typed('tsw', 'Text outline width', (x) => ({ textStroke: { ...textStroke, width: x } }))}
                  />
                </>
              )}
            </div>
            <div className="space-y-1.5">
              <Toggle label="Drop shadow" on={!!shadow} onChange={(on) => style({ shadow: on ? { color: '#111111', dx: 0.05, dy: 0.05 } : null }, on ? 'Drop shadow' : 'No shadow')} />
              {shadow && (
                <>
                  <ColorField label="Shadow colour" value={shadow.color} swatches={['#111111', '#ffffff', ...palette]} allowAlpha onChange={(c) => style({ shadow: { ...shadow, color: c } }, 'Shadow colour')} />
                  <div className="grid grid-cols-2 gap-2">
                    <Slider label="Shadow x" value={shadow.dx} min={-0.3} max={0.3} step={0.01} onChange={(x) => style({ shadow: { ...shadow, dx: x } }, 'Shadow offset', 'sdx')} />
                    <Slider label="Shadow y" value={shadow.dy} min={-0.3} max={0.3} step={0.01} onChange={(x) => style({ shadow: { ...shadow, dy: x } }, 'Shadow offset', 'sdy')} />
                  </div>
                </>
              )}
            </div>
            {anySfx && (
              <div className="space-y-2 rounded-xl border border-[var(--ds-hairline)] p-2">
                <p className={LABEL}>Sound effect</p>
                <div role="radiogroup" aria-label="Sound effect style" className="grid grid-cols-3 gap-1">
                  {SFX_EFFECTS.map((e) => (
                    <button
                      key={e}
                      type="button"
                      role="radio"
                      aria-checked={v('sfxEffect') === e}
                      onClick={() => style({ sfxEffect: e, ...(e === 'arched' && !v('arc') ? { arc: 0.4 } : {}) }, 'Sound effect style')}
                      className={cx(BTN, 'px-1', v('sfxEffect') === e && 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)]')}
                    >
                      {SFX_LABEL[e]}
                    </button>
                  ))}
                </div>
                {writable && pro && <pro.ProSfxPicker value={pv('sfxEffect') as string | undefined} onPick={(e) => style({ sfxEffect: e as unknown as SfxEffect }, 'Sound effect style')} />}
                {v('sfxEffect') === 'arched' && <Slider label="Arc" value={v('arc')} min={-1} max={1} step={0.05} onChange={(x) => style({ arc: x }, 'Arc', 'arc')} />}
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <Slider
                      label="Rotate"
                      value={typeof v('rotate') === 'number' ? (v('rotate') as number) : undefined}
                      min={-30}
                      max={30}
                      step={1}
                      format={(x) => `${Math.round(x)}°`}
                      onChange={(x) => style({ rotate: x }, 'Rotate', 'rot')}
                    />
                  </div>
                  <button type="button" className={cx(BTN, v('rotate') === 'auto' && 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)]')} onClick={() => style({ rotate: 'auto' }, 'Automatic tilt')}>
                    Auto
                  </button>
                </div>
              </div>
            )}
            {writable && pro && (
              <pro.ProTextEffects
                gradient={pv('fillGradient')}
                strokes={pv('strokes')}
                glow={pv('glow')}
                warp={pv('warp')}
                warpAmount={pv('warpAmount')}
                warpOk={pro.warpAllowed(languageSpec(lang)?.script)}
                textColor={v('textColor')}
                palette={palette}
                style={style}
              />
            )}
          </>
        )}

        {tab === 'bubble' && (
          <>
            <ShapePicker value={v('shape')} onChange={(s) => style({ shape: s }, 'Bubble shape')} />
            {writable && <ProShapePicker value={ownValue(lines, 'shape') as string | undefined} onChange={(s) => style({ shape: s as unknown as BubbleShape }, 'Bubble shape')} />}
            <ColorField label="Fill colour" value={v('fill') ?? '#ffffff'} swatches={[...FILL_SWATCHES, ...palette]} allowAlpha allowNone numeric={proEdit} onChange={(c, o) => style({ fill: c }, 'Bubble fill', o?.scrub ? 'fill' : undefined)} />
            <ColorField label="Border colour" value={v('border') ?? '#111111'} swatches={[...BORDER_SWATCHES, ...palette]} allowAlpha numeric={proEdit} onChange={(c, o) => style({ border: c }, 'Border colour', o?.scrub ? 'border' : undefined)} />
            <Slider
              label="Border width"
              value={v('borderWidth')}
              min={0}
              max={4}
              step={0.1}
              format={(x) => `${Math.round(x * 100)}%`}
              onChange={(x) => style({ borderWidth: x }, 'Border width', 'bw')}
              numeric={num({ scale: 100, min: 0, max: 400, step: 10, unit: '%' })}
              onTyped={typed('bw', 'Border width', (x) => ({ borderWidth: x }))}
            />
            <div className="space-y-1">
              <p className={LABEL}>Border style</p>
              <Segmented<string> label="Border style" size="xs" className="w-full" value={v('borderStyle') ?? ''} onChange={(b) => style({ borderStyle: b as BorderStyle }, 'Border style')} options={BORDERS} />
            </div>
            <Slider
              label="Padding"
              value={v('padding')}
              min={0}
              max={3}
              step={0.05}
              format={(x) => `${Math.round(x * 100)}%`}
              onChange={(x) => style({ padding: x }, 'Padding', 'pad')}
              numeric={num({ scale: 100, min: 0, max: 300, step: 5, unit: '%' })}
              onTyped={typed('pad', 'Padding', (x) => ({ padding: x }))}
            />
          </>
        )}

        {tab === 'tail' && (
          <>
            <TailPicker value={v('tail')} shape={v('shape')} onChange={(t) => style({ tail: t }, 'Tail style')} />
            <Slider
              label="Tail width"
              value={v('tailWidth')}
              min={0.4}
              max={2}
              step={0.05}
              format={(x) => `${Math.round(x * 100)}%`}
              onChange={(x) => style({ tailWidth: x }, 'Tail width', 'tw')}
              numeric={num({ scale: 100, min: 40, max: 200, step: 5, unit: '%' })}
              onTyped={typed('tw', 'Tail width', (x) => ({ tailWidth: x }))}
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                className={BTN}
                disabled={!ids.some((id) => speakerMarkFor(page, id))}
                title={ids.some((id) => speakerMarkFor(page, id)) ? 'Point the tail at the speaker the page check found' : 'Available after the page’s quality check finds the speaker'}
                onClick={() => run(aimAtSpeakerOps(page, plans, ids, H, placements.balloons), 'Aim tail at speaker')}
              >
                Aim at speaker
              </button>
            </div>
            <p className="text-[11px] text-[var(--ds-muted)]">Drag the round handle on the page to aim the tail anywhere. Alt+arrow keys nudge it.</p>
          </>
        )}

        {tab === 'arrange' && (
          <>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" className={BTN} disabled={sharedLocked} title={inOriginal} onClick={() => run(zOrderOps(page, ids, 'front', plans, placements.balloons), 'Bring to front')}>
                <ArrowUpToLine className="h-3.5 w-3.5" aria-hidden /> Front
              </button>
              <button type="button" className={BTN} disabled={sharedLocked} title={inOriginal} onClick={() => run(zOrderOps(page, ids, 'back', plans, placements.balloons), 'Send to back')}>
                <ArrowDownToLine className="h-3.5 w-3.5" aria-hidden /> Back
              </button>
              {pro && <pro.ProStackButtons page={page} ids={ids} one={one} plans={plans} balloons={placements.balloons} inOriginal={inOriginal} run={(ops, label) => run(ops, label)} />}
              <button
                type="button"
                className={BTN}
                aria-pressed={locked}
                disabled={sharedLocked}
                title={inOriginal}
                onClick={() =>
                  run(locked ? lockOps(page, ids, false, placements.balloons) : pinKeepingSizeOps(lockOps(page, ids, true, placements.balloons), page, plans, ids, editionLang), locked ? 'Unlock balloon' : 'Lock balloon')
                }
              >
                {locked ? <LockOpen className="h-3.5 w-3.5" aria-hidden /> : <Lock className="h-3.5 w-3.5" aria-hidden />} {locked ? 'Unlock' : 'Lock'}
              </button>
              {one && (
                <button
                  type="button"
                  className={BTN}
                  disabled={sharedLocked || (!linked && !canLinkToPrevious(page, one.id))}
                  title={inOriginal ?? (linked ? 'Remove the connector' : 'Join to the previous balloon in this panel with a connector')}
                  onClick={() => run(linkOps(page, one.id, !linked, placements.balloons), linked ? 'Unlink balloons' : 'Link balloons')}
                >
                  {linked ? <Link2Off className="h-3.5 w-3.5" aria-hidden /> : <Link2 className="h-3.5 w-3.5" aria-hidden />} {linked ? 'Unlink' : 'Link to previous'}
                </button>
              )}
            </div>
            {inOriginal && (
              <p className="text-[11px] leading-snug text-[var(--ds-muted)]" data-testid="arrange-in-original">
                {inOriginal}
              </p>
            )}
            {/* Pro Edit: the typed transform above owns W (the outline's width), so a second, different width never shows. */}
            {one && !proEdit && (
              <Slider
                label="Balloon width"
                value={(selPlans[0]?.w ?? 0) / 1000}
                min={0.06}
                max={0.95}
                step={0.01}
                format={(x) => `${Math.round(x * 100)}%`}
                disabled={locked}
                onChange={(x) => run(pinKeepingSizeOps([balloonOp(page, one.id, { w: Math.round(x * 1000) / 1000, pinned: true }, placements.balloons)], page, plans, [one.id], editionLang), 'Balloon width', { coalesce: `w:${page.id}:${one.id}` })}
              />
            )}
            {pro && <pro.ProAlign doc={doc} page={page} plans={plans} ids={ids} H={H} locked={locked} editionLang={editionLang} apply={apply} />}
            {!proEdit && lines.length >= 2 && (
              <div className="space-y-1">
                <p className={LABEL}>Align</p>
                <div className="grid grid-cols-3 gap-1">
                  {(['left', 'center', 'right', 'top', 'middle', 'bottom'] as AlignEdge[]).map((edge) => (
                    <button key={edge} type="button" className={BTN} onClick={() => run(alignOps(page, plans, ids, edge, H, placements.balloons), 'Align balloons')}>
                      {edge[0].toUpperCase() + edge.slice(1)}
                    </button>
                  ))}
                </div>
                <button type="button" className={cx(BTN, 'w-full')} disabled={lines.length < 3} onClick={() => run(distributeOps(page, plans, ids, H, placements.balloons), 'Distribute balloons')}>
                  Distribute vertically
                </button>
              </div>
            )}
            <div className="flex flex-wrap gap-1.5">
              <button type="button" className={BTN} disabled={locked} onClick={() => run(fitWidthOps(doc, page, ids, placements.balloons), 'Fit width to text')}>
                Fit text
              </button>
              <button
                type="button"
                className={BTN}
                disabled={locked}
                title="Let the editor choose a spot again (free)"
                onClick={() => run(resetPositionOps(doc, page, ids, aspect, measureForGeneration(fontLoadGeneration())), 'Reset position')}
              >
                Reset position
              </button>
              {one && (
                <button type="button" className={BTN} onClick={() => onEditText(one.id)}>
                  <PencilLine className="h-3.5 w-3.5" aria-hidden /> Edit text
                </button>
              )}
              <button
                type="button"
                className={cx(BTN_SHAPE, TONE_TEXT.danger)}
                onClick={() => {
                  run(deleteLinesOps(page, ids), lines.length > 1 ? 'Delete balloons' : 'Delete balloon');
                  onDeselect();
                }}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete
              </button>
            </div>
          </>
        )}

        {tab === 'apply' && (
          <>
            <fieldset className="space-y-1">
              <legend className={LABEL}>Apply this balloon’s style to…</legend>
              {scopes.map((s) => (
                <label key={s.id} className={cx('flex items-center gap-2 rounded-lg px-1.5 py-1 text-[12.5px] text-[var(--ds-ink)]', s.disabled ? 'opacity-40' : 'hover:bg-[var(--ds-hover)]')}>
                  <input type="radio" name={`scope-${page.id}`} value={s.id} checked={scope === s.id} disabled={s.disabled} onChange={() => setScope(s.id)} className="accent-[var(--ds-accent)]" />
                  {s.label}
                </label>
              ))}
            </fieldset>
            <button
              type="button"
              className={cx(BTN, 'w-full')}
              disabled={!overrides || scope === 'selection'}
              title={overrides ? undefined : 'Style this balloon first (Text / Bubble / Tail), then spread it'}
              onClick={() => overrides && run(styleScopeOps(doc, page, ids, overrides, scope), 'Apply style')}
            >
              Apply
            </button>
            <button type="button" className={cx(BTN, 'w-full')} disabled={!lines.some((l) => l.style)} onClick={() => run(clearStyleOps(page, ids), 'Clear balloon styles')}>
              Clear this balloon’s own styles
            </button>
            {!overrides && <p className="text-[11px] text-[var(--ds-muted)]">This balloon uses the comic’s style. Change something in Text, Bubble or Tail first.</p>}
            {pro && <pro.ProStyleClipboard doc={doc} page={page} ids={ids} one={one} sharedLocked={sharedLocked} apply={apply} />}
            {writable && pro && <pro.NamedStyles doc={doc} page={page} lines={lines} apply={apply} editionLang={editionLang} />}
          </>
        )}
      </div>
    </div>
  );
};

export default ProLetteringPanel;
