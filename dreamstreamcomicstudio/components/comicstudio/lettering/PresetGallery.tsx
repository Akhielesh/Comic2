// Lettering style gallery (lettering.md §4, §7.3; declutter DX-0). Each style is a picture drawn by the real engine
// (planLettering → svgMarkup): a caption, a speech balloon and a shout, the kinds where the styles differ most, so the
// picture is exact and costs nothing. A tile shows the style's name; its blurb is the tile's hint (the native title
// and the accessible description), never printed. Two views:
//   grid   ds/PresetGrid + PresetTile (Style › Lettering, the page editor's side panel, the Pro inspector's empty
//          state): the drawing fills a 4:3 art box; columns follow the container (2 below 400 px, 3 below 640, else 4);
//          the arrow keys move and choose (radio semantics);
//   chips  the Easy balloon panel's one row (56 px drawings, 12 px names never cut).
// The honest states: a style id this build does not list is the first tile ("Custom style", drawn by the engine's
// fallback), chosen; a Pro style the Director set while people cannot pick Pro styles is the first tile, drawn and
// chosen, its hint saying so (switching away drops it from the grid; Undo brings it back); `disabled` (a translated
// edition) still shows the styles, but no tile can be chosen.

import React, { useId, useMemo } from 'react';
import { Check } from 'lucide-react';
import { createEmptyDoc, type Balloon, type ComicDoc, type Line, type Page } from '../../../shared/comic/doc';
import { dirOf } from '../../../shared/comic/languages';
import { planLettering, type LetterPlan, type Measure } from '../../../shared/comic/lettering/layout';
import { fontsForDoc } from '../../../shared/comic/lettering/fonts';
import { LETTERING_PRESETS, LETTERING_PRESET_IDS, type LetteringPresetId, type LetterStylePatch } from '../../../shared/comic/lettering/style';
import { PresetGrid, type PresetOption } from '../../ds/PresetGrid';
import { FOCUS_RING, RADIUS_CONTROL, RADIUS_PILL } from '../../chat/studioDesign';
import { letteringNodes, planOutline } from './svgMarkup';
import { svgNodeToReact } from './LetteringSvg';
import { useLetteringFontsReady } from './useLetteringFontsReady';
import { cx, useElementSize } from '../board/ui';
import { proFieldsWritable, proLooks } from '../editor/inspector/proSwitch';

const PREVIEW_ASPECT = 1.6;
/** The sample page's aspect (width / height): what a test plans the sample with. */
export const PRESET_PREVIEW_ASPECT = PREVIEW_ASPECT;

/** The name a style id this build does not list is shown under (never the raw id). */
export const CUSTOM_STYLE_NAME = 'Custom style';
/** The hint of a style a newer version of the app (or an older comic) set: it stays until another is picked. */
export const CUSTOM_STYLE_HINT = 'A lettering style this version of the app does not list. Pick another style to change it; Undo brings it back.';
/** The hint of a Pro style the Director chose while people pick from the base styles only (liveturn LET-3). */
export const DIRECTOR_STYLE_HINT = 'Chosen by the Director. Pick another style to change it; Undo brings it back.';
/** A translated edition: the styles are shown, disabled, with this one line (page editor and Pro inspector). */
export const EDITION_LETTERING_NOTE = 'The lettering style belongs to the original language. Switch to it to change the style.';
/**
 * Every whole-comic style pick: one labelled undo entry, and a run of picks within the undo window (arrowing through
 * the grid) folds into that one entry (useUndo's coalesce key).
 */
export const LETTERING_STYLE_UNDO = { label: 'Change lettering style', coalesce: 'lettering-style' } as const;

/**
 * The sample lines, one of each kind the styles differ most on, at pinned positions (page fractions) packed so the
 * three fill a 4:3 tile at the largest size: the caption across the top (wide enough that no style breaks the word),
 * the shout under it and the speech balloon beside the shout (two lines each, the tail pointing down). The drawing is
 * cropped to the lettering, so only how tightly the three sit matters, not where on the page they are.
 */
const SAMPLE_LINES: Line[] = [
  { id: 'pv_caption', kind: 'caption', text: 'Meanwhile…' },
  { id: 'pv_speech', kind: 'speech', text: 'Hi there!' },
  { id: 'pv_shout', kind: 'shout', text: 'Look out!' }
];
const SAMPLE_BALLOONS: Balloon[] = [
  { lineId: 'pv_caption', x: 0.02, y: 0.02, w: 0.17, pinned: true },
  { lineId: 'pv_speech', x: 0.185, y: 0.14, w: 0.09, tailX: 0.21, tailY: 0.33, pinned: true },
  { lineId: 'pv_shout', x: 0.02, y: 0.165, w: 0.11, pinned: true }
];
/** Right-to-left: the reader starts at the right, so the sample mirrors (positions and tail). */
const mirrored = (b: Balloon): Balloon => ({
  ...b,
  x: Math.round((1 - b.x - b.w) * 1000) / 1000,
  ...(b.tailX !== undefined ? { tailX: Math.round((1 - b.tailX) * 1000) / 1000 } : {})
});

/** A tiny doc with one panel and sample lines, lettered with `presetId` (+ optional base patch). */
export function previewDoc(presetId: LetteringPresetId, opts: { lang?: string; base?: LetterStylePatch; lines?: Line[]; balloons?: Balloon[] } = {}): { doc: ComicDoc; page: Page } {
  const doc = createEmptyDoc('lettering-preview', 'Preview', 0);
  const lang = opts.lang || 'en';
  doc.format = { ...doc.format, language: lang, lettering: 'overlay' };
  doc.letterStyle = { presetId, ...(opts.base ? { base: opts.base } : {}) };
  const lines: Line[] = opts.lines ?? SAMPLE_LINES.map((l) => ({ ...l }));
  const rtl = dirOf(lang) === 'rtl';
  const balloons: Balloon[] = opts.balloons ?? SAMPLE_BALLOONS.map((b) => (rtl ? mirrored(b) : { ...b }));
  const page: Page = {
    id: 'pv_page',
    n: 1,
    summary: '',
    layout: 'Row 1: one wide panel.',
    panels: [{ id: 'pv_panel', n: 1, size: 'wide', shot: 'medium', action: '', castIds: [], lines }],
    render: { status: 'none', history: [] },
    balloons
  };
  doc.pages = [page];
  return { doc, page };
}

/**
 * Plans drawn inside a viewBox cropped to their outlines (thumbnails, font previews). `fill`: the drawing takes the
 * whole box it sits in, scaled to fit (a style tile's art); otherwise it is `height` px tall at its own width.
 */
export const PlansPreview: React.FC<{ plans: LetterPlan[]; height?: number; fill?: boolean; className?: string; label?: string }> = ({ plans, height = 44, fill = false, className, label }) => {
  // Unique per instance: every preview uses the same sample line ids, and a translucent preset's mask
  // id must not collide with another preview's (or another gallery's) on the same screen.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const nodes = useMemo(() => letteringNodes(plans, { aspect: PREVIEW_ASPECT, idPrefix: `pv${uid}` }), [plans, uid]);
  if (!plans.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of plans) {
    const o = planOutline(p);
    x0 = Math.min(x0, o.x);
    y0 = Math.min(y0, o.y);
    x1 = Math.max(x1, o.x + o.w);
    // A filled tile crops to the tail's real tip (the drawing as large as the box allows); the strip previews keep
    // their room below any tail or thought trail.
    if (fill && p.tip && !p.geometry.bubbles.length) {
      x0 = Math.min(x0, p.tip.x);
      x1 = Math.max(x1, p.tip.x);
      y1 = Math.max(y1, o.y + o.h, p.tip.y);
    } else y1 = Math.max(y1, o.y + o.h + (p.geometry.tail || p.geometry.bubbles.length ? 40 : 0));
  }
  const pad = fill ? 8 : 14;
  const vb = { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
  return (
    <svg
      viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
      height={fill ? '100%' : height}
      width={fill ? '100%' : (height * vb.w) / vb.h}
      preserveAspectRatio={fill ? 'xMidYMid meet' : undefined}
      className={cx(fill ? 'block' : 'max-w-full', className)}
      role="img"
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {nodes.map((n, i) => svgNodeToReact(n, i))}
    </svg>
  );
};

const usePresetPlans = (lang: string, measure: Measure, ids: readonly LetteringPresetId[]) =>
  useMemo(() => {
    const out = new Map<LetteringPresetId, LetterPlan[]>();
    for (const id of ids) {
      const { doc, page } = previewDoc(id, { lang });
      out.set(id, planLettering(doc, page, PREVIEW_ASPECT, measure));
    }
    return out;
  }, [lang, measure, ids]);

/** Every face the gallery draws, in ONE batch (a face per tile would re-plan every tile as each one lands). */
const ALL_PRESET_FONTS = (lang: string, ids: readonly LetteringPresetId[] = LETTERING_PRESET_IDS) => [...new Set(ids.flatMap((id) => fontsForDoc(previewDoc(id, { lang }).doc)))];

type ProLookRow = { id: string; name: string; blurb: string };
/** A style's name and blurb: a base style, else a Pro style (PE-LETTER's 16), else a style this build does not list. */
const lookOf = (id: LetteringPresetId, pro: readonly ProLookRow[]): { name: string; blurb: string } =>
  (Object.prototype.hasOwnProperty.call(LETTERING_PRESETS, id) ? LETTERING_PRESETS[id] : undefined) ?? pro.find((p) => p.id === id) ?? { name: CUSTOM_STYLE_NAME, blurb: CUSTOM_STYLE_HINT };

/** Columns by the container's width (PresetGrid's Up / Down step a row of this many). */
export const presetColumns = (width: number): number => (width < 400 ? 2 : width < 640 ? 3 : 4);

export interface PresetGalleryProps {
  /** The comic's style id (at runtime possibly a Pro id or one a newer build stored). */
  value: LetteringPresetId;
  onChange(id: LetteringPresetId): void;
  variant?: 'chips' | 'grid';
  /** Lettering language (previews use its script faces and reading direction). */
  lang?: string;
  /** Pro Edit: also offer the Pro styles (8 → 24) — only while Pro fields are writable. */
  pro?: boolean;
  /** Shown but not choosable (a translated edition: the style belongs to the original language). */
  disabled?: boolean;
}

export const PresetGallery: React.FC<PresetGalleryProps> = ({ value, onChange, variant = 'grid', lang = 'en', pro, disabled = false }) => {
  const writable = proFieldsWritable();
  const withPro = !!pro && writable;
  const allPro = useMemo(() => proLooks(), []);
  const offered = useMemo<readonly LetteringPresetId[]>(
    () => [...LETTERING_PRESET_IDS, ...((withPro ? allPro.map((l) => l.id) : []) as unknown as LetteringPresetId[])],
    [withPro, allPro]
  );
  // The comic's own style when the list does not hold it (a Pro style set for it, or one this build does not know):
  // first, drawn and chosen, so the grid never shows nothing chosen. Gone from the list once another is picked.
  const ids = useMemo<readonly LetteringPresetId[]>(() => (offered.includes(value) ? offered : [value, ...offered]), [offered, value]);
  const fonts = useMemo(() => ALL_PRESET_FONTS(lang, ids), [lang, ids]);
  const { measure } = useLetteringFontsReady(fonts, { weights: [400, 500, 600, 700, 800] });
  const plans = usePresetPlans(lang, measure, ids);
  const [sizeRef, size] = useElementSize<HTMLDivElement>();
  const hintId = useId();
  // A right-to-left sample starts at the top right (its caption sits there), so the chosen check takes the top-left
  // corner, which that sample leaves empty (a left-to-right sample leaves the top right empty).
  const rtl = dirOf(lang) === 'rtl';

  // A Pro style people cannot pick yet is one the Director chose: its hint says so (and how to change it).
  const hintOf = (id: LetteringPresetId): string => (!writable && !offered.includes(id) && allPro.some((p) => p.id === id) ? DIRECTOR_STYLE_HINT : lookOf(id, allPro).blurb);
  const pick = (id: LetteringPresetId) => {
    if (!disabled && id !== value) onChange(id);
  };

  if (variant === 'chips') {
    return (
      <div role="radiogroup" aria-label="Lettering style" aria-disabled={disabled || undefined} className="-mx-1 flex gap-1.5 overflow-x-auto overscroll-x-contain px-1 pb-1 [scrollbar-width:thin]">
        {ids.map((id, i) => {
          const look = lookOf(id, allPro);
          const hint = hintOf(id);
          const on = value === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              aria-describedby={hint ? `${hintId}-${i}` : undefined}
              title={hint || undefined}
              disabled={disabled}
              onClick={() => pick(id)}
              className={cx(
                'relative flex min-h-[44px] min-w-[6.5rem] shrink-0 flex-col items-center gap-1 border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-1.5 hover:bg-[var(--ds-hover)] disabled:cursor-not-allowed disabled:opacity-50',
                RADIUS_CONTROL,
                FOCUS_RING,
                on && 'border-[var(--ds-ink)] ring-1 ring-[var(--ds-ink)]'
              )}
            >
              <span className={cx('grid h-16 w-full place-items-center overflow-hidden bg-[var(--ds-reader-paper-back)] px-1', RADIUS_PILL)}>
                <PlansPreview plans={plans.get(id) || []} height={56} />
              </span>
              <span data-slot="preset-chip-name" className="px-0.5 text-[12px] font-medium leading-4 text-[var(--ds-ink)]">
                {look.name}
              </span>
              {on && (
                <span aria-hidden="true" data-slot="preset-chip-check" className={`absolute ${rtl ? 'left-1' : 'right-1'} top-1 inline-flex size-4 items-center justify-center rounded-full bg-[var(--ds-ink)] text-[var(--ds-canvas)] [&_svg]:size-2.5`}>
                  <Check strokeWidth={3} />
                </span>
              )}
              {hint ? (
                <span id={`${hintId}-${i}`} hidden>
                  {hint}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    );
  }

  const options: PresetOption<LetteringPresetId>[] = ids.map((id) => ({
    value: id,
    label: lookOf(id, allPro).name,
    hint: hintOf(id),
    ...(rtl ? { checkSide: 'left' as const } : {}),
    disabled,
    art: (
      <span className="block h-full w-full bg-[var(--ds-reader-paper-back)] p-1.5">
        <PlansPreview plans={plans.get(id) || []} fill />
      </span>
    )
  }));
  return (
    // Columns follow the CONTAINER, not the window (a 320 px side sheet on a landscape phone, a wide aside or tab).
    <div ref={sizeRef} className="min-w-0">
      <PresetGrid<LetteringPresetId> label="Lettering style" options={options} value={value} onChange={pick} columns={presetColumns(size.width)} aspect="4 / 3" />
    </div>
  );
};

export default PresetGallery;
