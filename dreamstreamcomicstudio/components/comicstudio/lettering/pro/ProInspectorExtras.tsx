// The Pro inspector's lazily loaded half (PE-INSPECT; master plan §2.4, §2.8; agent-editor plan §3 C2, C3, C7). Only
// proExtras.ts imports this module, with a dynamic import, and only while Pro Edit is on — so the B9 scene engine
// (editor/scene, align, transform), the typed fields and the Pro lettering controls never ride in the page editor's
// Easy-path chunk. What it holds:
//   ProInspectorKeys   keys 1–6 (the kind) and ⌘⌥C / ⌘⌥V (Copy / Paste style) while the inspector has a selection
//   NumberField        the typed field beside every slider (re-exported)
//   TransformSection   typed X, Y, W, H and rotation (re-exported)
//   NamedStyles        saved styles (re-exported; only while Pro fields are writable)
//   ProStackButtons    Forward, Backward, Duplicate
//   ProAlign           align to the selection, panel or page; space across and down
//   ProStyleClipboard  Copy style / Paste style
//   ProSfxPicker       the 5 Pro SFX effects PE-LETTER draws (only while Pro fields are writable)
//   ProTextEffects     gradient, up to 3 outlines, glow, warp (only while Pro fields are writable)
// Every edit is free, labelled and undoable, through the inspector's `apply` (studio.patch); never editActionFor, never
// studio.act.

import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ClipboardCopy, ClipboardPaste, CopyPlus, Plus, X } from 'lucide-react';
import type { Balloon, ComicDoc, Line, Page } from '../../../../shared/comic/doc';
import type { DocOp } from '../../../../shared/comic/ops';
import type { LetterPlan } from '../../../../shared/comic/lettering/layout';
import { WARP_STYLES, type FillGradient, type Glow, type LetterStylePatch, type ProSfxEffect, type StrokeLayer, type WarpStyle } from '../../../../shared/comic/lettering/style';
import { PRO_LETTER_LIMITS } from '../../../../shared/comic/limits';
import { WARP_SCRIPT_NOTE } from '../../../../shared/comic/pro/types';
import type { EditResult } from '../../../../shared/comic/editor/scene';
import type { PatchOptions } from '../../types';
import { cn } from '../../../../lib/utils';
import { MUTED, RADIUS_CONTROL } from '../../../chat/studioDesign';
import { Segmented } from '../../board/ui';
import { isTypingTarget, kindForKey } from '../../editor/inspector/keys';
import { setStyleClip, styleClip, styleClipboardKey, useStyleClip } from '../../editor/inspector/styleClipboard';
import { PRO_SFX_DRAWN, proFieldsWritable, stripProFields, writablePatch } from '../../editor/inspector/proGate';
import { ColorField } from '../ColorField';
import { NumberField, type NumberCommit } from '../NumberField';
import { kindWord } from '../LetteringInspector';
import { PANEL_BTN, PANEL_LABEL, PRO_SFX_LABEL, Toggle } from '../ProLetteringPanel';
import { FILL_SWATCHES, TEXT_SWATCHES } from '../panelTypes';
import { duplicateLineOps, kindOps, pinKeepingSizeOps, zOrderOps, type AlignEdge } from '../styleOps';
import { alignToEdit, copyStyleOf, distributeToEdit, pasteStyleOps, type AlignTo } from '../proStyleOps';

export { NumberField, type NumberCommit, type NumberFieldProps } from '../NumberField';
export { TransformSection } from '../TransformSection';
export { NamedStyles } from '../NamedStyles';
export { warpAllowed } from '../../editor/inspector/proGate';

type Apply = (ops: DocOp[], opts?: PatchOptions) => void;

// ── Keys 1–6 and ⌘⌥C / ⌘⌥V ───────────────────────────────────────────────────

/**
 * The inspector's Pro Edit keys while it is open on a selection: 1–6 set the kind, ⌘⌥C / ⌘⌥V copy and paste a style.
 * Never while typing (a field, a select, editable text anywhere on the page) and never with ⌘ / Ctrl / Alt held for the
 * kind keys. The latest props are read through a ref, so the listener is added once per mount.
 */
export const ProInspectorKeys: React.FC<{ doc: ComicDoc; page: Page; lineIds: readonly string[]; apply: Apply }> = (props) => {
  const live = useRef(props);
  live.current = props;
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      const { doc, page, lineIds, apply } = live.current;
      const kind = kindForKey(e);
      if (kind) {
        const ops = kindOps(page, lineIds, kind);
        e.preventDefault();
        if (ops.length) apply(ops, { label: `Make it ${kindWord(kind)}` });
        return;
      }
      const clip = styleClipboardKey(e);
      if (!clip) return;
      e.preventDefault();
      if (clip === 'copy') {
        const c = lineIds.length === 1 ? copyStyleOf(doc, page, lineIds[0], proFieldsWritable()) : undefined;
        if (c) setStyleClip(c);
        return;
      }
      const held = styleClip();
      if (!held) return;
      const ops = pasteStyleOps(doc, page, lineIds, held, { linkable: proFieldsWritable(), clean: writablePatch });
      if (ops.length) apply(ops, { label: 'Paste style' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return null;
};

// ── Arrange: Forward, Backward, Duplicate ────────────────────────────────────

/**
 * Forward / Backward (one step in the lettering band) and Duplicate. A duplicate carries the line's every field — but
 * while Pro fields are not writable (collisions C-9) it never copies the saved-style link (`styleId`) or a Pro key a
 * newer build kept on the line, so the copy the editor shows is the copy the server stores.
 */
export const ProStackButtons: React.FC<{
  page: Page;
  ids: readonly string[];
  one?: Line;
  plans: readonly LetterPlan[];
  balloons: ReadonlyMap<string, Balloon>;
  /** A translated edition: stacking and copies belong to the original (the reason is the title). */
  inOriginal?: string;
  run(ops: DocOp[], label: string): void;
}> = ({ page, ids, one, plans, balloons, inOriginal, run }) => (
  <>
    <button type="button" className={PANEL_BTN} disabled={!!inOriginal} title={inOriginal} onClick={() => run(zOrderOps(page, ids, 'forward', plans, balloons), 'Bring forward')}>
      <ArrowUp className="h-3.5 w-3.5" aria-hidden /> Forward
    </button>
    <button type="button" className={PANEL_BTN} disabled={!!inOriginal} title={inOriginal} onClick={() => run(zOrderOps(page, ids, 'backward', plans, balloons), 'Send backward')}>
      <ArrowDown className="h-3.5 w-3.5" aria-hidden /> Backward
    </button>
    {one && (
      <button
        type="button"
        className={PANEL_BTN}
        disabled={!!inOriginal}
        title={inOriginal ?? 'A copy of this balloon, just beside it'}
        onClick={() => run(duplicateLineOps(page, one.id, balloons, undefined, proFieldsWritable() ? undefined : { keepLink: false, clean: stripProFields }), 'Duplicate balloon')}
      >
        <CopyPlus className="h-3.5 w-3.5" aria-hidden /> Duplicate
      </button>
    )}
  </>
);

// ── Align and distribute ─────────────────────────────────────────────────────

const ALIGN_TO: { value: AlignTo; label: string; title: string }[] = [
  { value: 'selection', label: 'Selection', title: 'Line them up with each other' },
  { value: 'panel', label: 'Panel', title: 'Line them up with their panel' },
  { value: 'page', label: 'Page', title: 'Line them up with the page (its safe area)' }
];
const EDGES: AlignEdge[] = ['left', 'center', 'right', 'top', 'middle', 'bottom'];

/** What an align lines up with: the chosen target, but one balloon has no "selection" to line up with — its panel. */
export const alignModeFor = (alignTo: AlignTo, count: number): AlignTo => (alignTo === 'selection' && count < 2 ? 'panel' : alignTo);

/**
 * Align to the selection, panel or page (editor/align.ts) and space three or more across or down. One balloon aligns
 * to its panel by default (the control shows Panel); a refusal ("Everything you picked is locked") is said in words.
 */
export const ProAlign: React.FC<{
  doc: ComicDoc;
  page: Page;
  plans: readonly LetterPlan[];
  ids: readonly string[];
  H: number;
  locked: boolean;
  editionLang?: string;
  apply: Apply;
}> = ({ doc, page, plans, ids, H, locked, editionLang, apply }) => {
  const [alignTo, setAlignTo] = useState<AlignTo>('selection');
  const [note, setNote] = useState<string | null>(null);
  const mode = alignModeFor(alignTo, ids.length);
  const aspect = 1000 / H;
  const engine = (r: EditResult) => {
    if (r.ok === false) {
      setNote(r.reason);
      return;
    }
    setNote(null);
    // An edition's own positions are drags; the original keeps each balloon's drawn size when it is pinned.
    apply(editionLang ? r.ops : pinKeepingSizeOps(r.ops, page, plans, ids, editionLang), { label: r.label });
  };
  return (
    <div className="space-y-1" data-testid="pro-align">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p className={PANEL_LABEL}>Align to</p>
        <Segmented<AlignTo> label="Align to" size="xs" value={mode} onChange={setAlignTo} options={ALIGN_TO.map((o) => ({ ...o, disabled: o.value === 'selection' && ids.length < 2 }))} />
      </div>
      <div className="grid grid-cols-3 gap-1">
        {EDGES.map((edge) => (
          <button key={edge} type="button" className={PANEL_BTN} disabled={locked} onClick={() => engine(alignToEdit(doc, page, plans, ids, edge, mode, aspect))}>
            {edge === 'center' ? 'Centre' : edge[0].toUpperCase() + edge.slice(1)}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-1">
        <button type="button" className={PANEL_BTN} disabled={ids.length < 3} title="Equal gaps from left to right" onClick={() => engine(distributeToEdit(doc, page, plans, ids, 'h'))}>
          Space across
        </button>
        <button type="button" className={PANEL_BTN} disabled={ids.length < 3} title="Equal gaps from top to bottom" onClick={() => engine(distributeToEdit(doc, page, plans, ids, 'v'))}>
          Space down
        </button>
      </div>
      {note && (
        <p role="status" data-testid="arrange-note" className={cn('text-[11px] leading-snug', MUTED)}>
          {note}
        </p>
      )}
    </div>
  );
};

// ── Copy style / Paste style ─────────────────────────────────────────────────

/** Copy this balloon's look (⌘⌥C) and give the selection the copied look (⌘⌥V); the Pro fields only while writable. */
export const ProStyleClipboard: React.FC<{ doc: ComicDoc; page: Page; ids: readonly string[]; one?: Line; sharedLocked: boolean; apply: Apply }> = ({ doc, page, ids, one, sharedLocked, apply }) => {
  const clip = useStyleClip();
  const writable = proFieldsWritable();
  return (
    <div className="grid grid-cols-2 gap-1.5" data-testid="style-clipboard">
      <button
        type="button"
        className={PANEL_BTN}
        disabled={!one}
        title={one ? 'Copy this balloon’s look (⌘⌥C)' : 'Select one balloon to copy its look'}
        onClick={() => {
          const c = one ? copyStyleOf(doc, page, one.id, writable) : undefined;
          if (c) setStyleClip(c);
        }}
      >
        <ClipboardCopy className="h-3.5 w-3.5" aria-hidden /> Copy style
      </button>
      <button
        type="button"
        className={PANEL_BTN}
        disabled={!clip || sharedLocked}
        title={clip ? 'Give the selection the copied look (⌘⌥V)' : 'Copy a balloon’s style first'}
        onClick={() => {
          if (!clip) return;
          const ops = pasteStyleOps(doc, page, ids, clip, { linkable: writable, clean: writablePatch });
          if (ops.length) apply(ops, { label: 'Paste style' });
        }}
      >
        <ClipboardPaste className="h-3.5 w-3.5" aria-hidden /> Paste style
      </button>
    </div>
  );
};

// ── Pro SFX effects ──────────────────────────────────────────────────────────

/** The 5 Pro SFX effects PE-LETTER draws in S2 (a Pro field: rendered only while writable). */
export const ProSfxPicker: React.FC<{ value: string | undefined; onPick(effect: ProSfxEffect): void }> = ({ value, onPick }) =>
  proFieldsWritable() ? (
    <div role="radiogroup" aria-label="Pro sound effect style" data-testid="pro-sfx" className="grid grid-cols-3 gap-1">
      {PRO_SFX_DRAWN.map((e) => (
        <button
          key={e}
          type="button"
          role="radio"
          aria-checked={value === e}
          onClick={() => onPick(e)}
          className={cn(PANEL_BTN, 'px-1', value === e && 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)]')}
        >
          {PRO_SFX_LABEL[e]}
        </button>
      ))}
    </div>
  ) : null;

// ── Pro text effects ─────────────────────────────────────────────────────────

/** The text effects' starting colours: the lettering palette's own swatches (content colours), never new literals. */
export const PRO_EFFECT_DEFAULTS = {
  /** The gradient's start without a solid text colour, and every other outline. */
  ink: TEXT_SWATCHES[0],
  /** The first outline (white around dark letters). */
  paper: TEXT_SWATCHES[1],
  /** The gradient's end. */
  gradientTo: TEXT_SWATCHES[2],
  /** The glow. */
  glow: FILL_SWATCHES[2]
} as const;

const WARP_LABEL: Record<WarpStyle, string> = { none: 'None', arc: 'Arc', bulge: 'Bulge', wave: 'Wave', rise: 'Rise', flag: 'Flag' };

/**
 * Pro text effects (master plan §2.3 "Text styling"; drawn by PE-LETTER): a two-stop gradient fill, up to three stacked
 * outlines, a glow and a warp. Every control writes a Pro field, so the section exists only while they are writable.
 * Warp is offered only for scripts it shapes correctly; others read WARP_SCRIPT_NOTE.
 */
export const ProTextEffects: React.FC<{
  gradient: FillGradient | null | undefined;
  strokes: StrokeLayer[] | undefined;
  glow: Glow | null | undefined;
  warp: WarpStyle | undefined;
  warpAmount: number | undefined;
  warpOk: boolean;
  textColor: string | undefined;
  palette: string[];
  style(patch: LetterStylePatch, label: string, scrubKey?: string): void;
}> = ({ gradient, strokes = [], glow, warp = 'none', warpAmount = 0, warpOk, textColor, palette, style }) => {
  if (!proFieldsWritable()) return null;
  const D = PRO_EFFECT_DEFAULTS;
  const step = (key: string) => (how: NumberCommit) => (how.via === 'step' ? key : undefined);
  const solid = textColor && /^#/.test(textColor) ? textColor.slice(0, 7) : D.ink;
  const setStrokes = (next: StrokeLayer[], label: string, key?: string) => style({ strokes: next.slice(0, PRO_LETTER_LIMITS.strokes) }, label, key);
  return (
    <div className={cn('space-y-2.5 border border-[var(--ds-hairline)] p-2', RADIUS_CONTROL)} data-testid="pro-text-effects">
      <p className={PANEL_LABEL}>Text effects</p>
      <div className="space-y-1.5">
        <Toggle
          label="Gradient fill"
          on={!!gradient}
          onChange={(on) => style({ fillGradient: on ? { from: solid, to: D.gradientTo, angle: 90 } : null }, on ? 'Gradient fill' : 'No gradient fill')}
        />
        {gradient && (
          <>
            <ColorField label="Gradient from" value={gradient.from} swatches={[...TEXT_SWATCHES, ...palette]} onChange={(c) => style({ fillGradient: { ...gradient, from: c } }, 'Gradient colour')} />
            <ColorField label="Gradient to" value={gradient.to} swatches={[...TEXT_SWATCHES, ...palette]} onChange={(c) => style({ fillGradient: { ...gradient, to: c } }, 'Gradient colour')} />
            <NumberField label="Gradient angle" value={gradient.angle} min={0} max={360} step={5} unit="°" onCommit={(a, how) => style({ fillGradient: { ...gradient, angle: a } }, 'Gradient angle', step('ga')(how))} />
          </>
        )}
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <p className={PANEL_LABEL}>Outlines</p>
          <button
            type="button"
            className={PANEL_BTN}
            disabled={strokes.length >= PRO_LETTER_LIMITS.strokes}
            title={strokes.length >= PRO_LETTER_LIMITS.strokes ? `Up to ${PRO_LETTER_LIMITS.strokes} outlines` : 'Add an outline around the letters'}
            onClick={() => setStrokes([...strokes, { color: strokes.length % 2 ? D.ink : D.paper, w: 0.08 + strokes.length * 0.06 }], 'Add outline')}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add outline
          </button>
        </div>
        {strokes.map((st, i) => (
          <div key={i} className="flex min-w-0 items-end gap-1.5" data-testid={`stroke-${i}`}>
            <ColorField className="min-w-0 flex-1" label={`Outline ${i + 1}`} value={st.color} swatches={[D.paper, D.ink, ...palette]} onChange={(c) => setStrokes(strokes.map((x, j) => (j === i ? { ...x, color: c } : x)), 'Outline colour')} />
            <NumberField
              className="w-[5.5rem] shrink-0"
              label={`Outline ${i + 1} width`}
              value={st.w}
              scale={100}
              min={0}
              max={PRO_LETTER_LIMITS.strokeWMax * 100}
              step={1}
              unit="%"
              onCommit={(w, how) => setStrokes(strokes.map((x, j) => (j === i ? { ...x, w } : x)), 'Outline width', step(`sw${i}`)(how))}
            />
            <button type="button" aria-label={`Remove outline ${i + 1}`} className={cn(PANEL_BTN, 'px-1.5')} onClick={() => setStrokes(strokes.filter((_, j) => j !== i), 'Remove outline')}>
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        ))}
      </div>
      <div className="space-y-1.5">
        <Toggle label="Glow" on={!!glow} onChange={(on) => style({ glow: on ? { color: D.glow, size: 0.15 } : null }, on ? 'Glow' : 'No glow')} />
        {glow && (
          <>
            <ColorField label="Glow colour" value={glow.color} swatches={[D.glow, D.paper, ...palette]} onChange={(c) => style({ glow: { ...glow, color: c } }, 'Glow colour')} />
            <NumberField label="Glow size" value={glow.size} scale={100} min={0} max={PRO_LETTER_LIMITS.glowSizeMax * 100} step={1} unit="%" onCommit={(z, how) => style({ glow: { ...glow, size: z } }, 'Glow size', step('gs')(how))} />
          </>
        )}
      </div>
      <div className="space-y-1">
        <p className={PANEL_LABEL}>Warp</p>
        {warpOk ? (
          <>
            <Segmented<WarpStyle> label="Warp" size="xs" className="w-full" value={warp} onChange={(w) => style({ warp: w, ...(w !== 'none' && !warpAmount ? { warpAmount: 0.5 } : {}) }, 'Warp')} options={WARP_STYLES.map((w) => ({ value: w, label: WARP_LABEL[w] }))} />
            {warp !== 'none' && (
              <NumberField label="Warp amount" value={warpAmount} scale={100} min={-PRO_LETTER_LIMITS.warpAmountMax * 100} max={PRO_LETTER_LIMITS.warpAmountMax * 100} step={5} unit="%" onCommit={(a, how) => style({ warpAmount: a }, 'Warp amount', step('wa')(how))} />
            )}
          </>
        ) : (
          <p className={cn('text-[11px] leading-snug', MUTED)} data-testid="warp-script-note">
            {WARP_SCRIPT_NOTE}
          </p>
        )}
      </div>
    </div>
  );
};
