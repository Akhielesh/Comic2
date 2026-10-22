// Lettering preset gallery (lettering.md §4, §7.3). Each preset is shown as a LIVE mini balloon drawn by
// the real engine (planLettering → svgMarkup), so the thumbnail is exact and costs nothing. Two views:
// `chips` (Easy inspector: one horizontal row) and `grid` (side panel / style tab: name + blurb).

import React, { useId, useMemo } from 'react';
import { Check } from 'lucide-react';
import { createEmptyDoc, type Balloon, type ComicDoc, type Line, type Page } from '../../../shared/comic/doc';
import { planLettering, type LetterPlan, type Measure } from '../../../shared/comic/lettering/layout';
import { fontsForDoc } from '../../../shared/comic/lettering/fonts';
import { LETTERING_PRESETS, LETTERING_PRESET_IDS, type LetteringPresetId, type LetterStylePatch } from '../../../shared/comic/lettering/style';
import { letteringNodes, planOutline } from './svgMarkup';
import { svgNodeToReact } from './LetteringSvg';
import { useLetteringFontsReady } from './useLetteringFontsReady';
import { cx } from '../board/ui';

const PREVIEW_ASPECT = 1.6;
const H = 1000 / PREVIEW_ASPECT;

/** A tiny doc with one panel and sample lines, lettered with `presetId` (+ optional base patch). */
export function previewDoc(presetId: LetteringPresetId, opts: { lang?: string; base?: LetterStylePatch; lines?: Line[]; balloons?: Balloon[] } = {}): { doc: ComicDoc; page: Page } {
  const doc = createEmptyDoc('lettering-preview', 'Preview', 0);
  doc.format = { ...doc.format, language: opts.lang || 'en', lettering: 'overlay' };
  doc.letterStyle = { presetId, ...(opts.base ? { base: opts.base } : {}) };
  const lines: Line[] = opts.lines ?? [
    { id: 'pv_speech', kind: 'speech', text: 'Hi there!' },
    { id: 'pv_sfx', kind: 'sfx', text: 'Pow!' }
  ];
  const balloons: Balloon[] = opts.balloons ?? [
    { lineId: 'pv_speech', x: 0.08, y: 0.1, w: 0.36, tailX: 0.16, tailY: 0.62, pinned: true },
    { lineId: 'pv_sfx', x: 0.56, y: 0.2, w: 0.34, pinned: true }
  ];
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

/** Plans drawn inside a viewBox cropped to their outlines (thumbnails, font previews). */
export const PlansPreview: React.FC<{ plans: LetterPlan[]; height?: number; className?: string; label?: string }> = ({ plans, height = 44, className, label }) => {
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
    y1 = Math.max(y1, o.y + o.h + (p.geometry.tail || p.geometry.bubbles.length ? 40 : 0));
  }
  const pad = 14;
  const vb = { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
  return (
    <svg
      viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
      height={height}
      width={(height * vb.w) / vb.h}
      className={cx('max-w-full', className)}
      role="img"
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {nodes.map((n, i) => svgNodeToReact(n, i))}
    </svg>
  );
};

const usePresetPlans = (lang: string, measure: Measure) =>
  useMemo(() => {
    const out = new Map<LetteringPresetId, LetterPlan[]>();
    for (const id of LETTERING_PRESET_IDS) {
      const { doc, page } = previewDoc(id, { lang });
      out.set(id, planLettering(doc, page, PREVIEW_ASPECT, measure));
    }
    return out;
  }, [lang, measure]);

const ALL_PRESET_FONTS = (lang: string) => [...new Set(LETTERING_PRESET_IDS.flatMap((id) => fontsForDoc(previewDoc(id, { lang }).doc)))];

export interface PresetGalleryProps {
  value: LetteringPresetId;
  onChange(id: LetteringPresetId): void;
  variant?: 'chips' | 'grid';
  /** Lettering language (previews use its script faces). */
  lang?: string;
}

export const PresetGallery: React.FC<PresetGalleryProps> = ({ value, onChange, variant = 'grid', lang = 'en' }) => {
  const fonts = useMemo(() => ALL_PRESET_FONTS(lang), [lang]);
  const { measure } = useLetteringFontsReady(fonts, { weights: [400, 500, 600, 700, 800] });
  const plans = usePresetPlans(lang, measure);
  if (variant === 'chips') {
    return (
      <div role="radiogroup" aria-label="Lettering style" className="-mx-1 flex gap-1.5 overflow-x-auto overscroll-x-contain px-1 pb-1 [scrollbar-width:thin]">
        {LETTERING_PRESET_IDS.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={value === id}
            title={LETTERING_PRESETS[id].blurb}
            onClick={() => onChange(id)}
            className={cx(
              'flex min-h-[44px] shrink-0 flex-col items-center gap-0.5 rounded-xl border px-1.5 py-1 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/50',
              value === id ? 'border-[#D97757]/60 bg-[#D97757]/10' : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] hover:bg-[var(--ds-hover)]'
            )}
          >
            <span className="grid h-9 place-items-center rounded-md bg-[var(--ds-reader-paper-back)] px-1">
              <PlansPreview plans={plans.get(id) || []} height={32} />
            </span>
            <span className="max-w-[5.5rem] truncate text-[10.5px] font-medium text-[var(--ds-ink)]">{LETTERING_PRESETS[id].name}</span>
          </button>
        ))}
      </div>
    );
  }
  return (
    <div role="radiogroup" aria-label="Lettering style" className="grid grid-cols-1 gap-2 medium:grid-cols-2">
      {LETTERING_PRESET_IDS.map((id) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          onClick={() => onChange(id)}
          className={cx(
            'flex min-w-0 items-center gap-2 rounded-xl border p-2 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/50',
            value === id ? 'border-[#D97757]/60 bg-[#D97757]/10' : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] hover:bg-[var(--ds-hover)]'
          )}
        >
          <span className="grid h-12 w-[4.5rem] shrink-0 place-items-center overflow-hidden rounded-lg bg-[var(--ds-reader-paper-back)]">
            <PlansPreview plans={plans.get(id) || []} height={40} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1 text-[12.5px] font-semibold text-[var(--ds-ink)]">
              <span className="truncate">{LETTERING_PRESETS[id].name}</span>
              {value === id && <Check className="h-3.5 w-3.5 shrink-0 text-[#D97757]" aria-hidden />}
            </span>
            <span className="line-clamp-2 text-[11px] leading-snug text-[var(--ds-muted)]">{LETTERING_PRESETS[id].blurb}</span>
          </span>
        </button>
      ))}
    </div>
  );
};

export default PresetGallery;
