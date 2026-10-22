// `style_presets` card (contract §13.2, assets.md §9; owner P1-LIBRARY): the director's FREE visual
// chooser. Shows the suggested curated looks with the platform library's preview art (procedural
// thumbnails until/unless it is published), each with its name and one-line pitch. Tapping one runs
// the free `use_preset` action: the style is drafted instantly, nothing is drawn, nothing is spent.

import React from 'react';
import { Check, Loader2, Palette } from 'lucide-react';
import type { Card } from '../../../shared/comic/doc';
import { stylePreviewId } from '../../../shared/comic/library';
import { getStylePreset, type StylePreset } from '../../../shared/comic/stylePresets';
import type { CardProps } from '../extensions';
import { CardShell } from '../conversation/ui';
import { useAction } from '../conversation/cards/useAction';
import { LibraryImage } from './LibraryImage';
import { PresetThumb } from './procedural/PresetThumb';

type StylePresetsData = Extract<Card, { type: 'style_presets' }>;

/** The "saved by software" line (decisions-final #6). */
export const STYLE_PRESETS_FREE_NOTE = 'Free — done by the editor, no AI cost.';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

export const StylePresetsCard: React.FC<CardProps<StylePresetsData>> = ({ card, studio }) => {
  const { run, isPending, anyPending } = useAction(studio.act);
  const doc = studio.doc;
  const presets = (card.presetIds || []).map((id) => getStylePreset(id)).filter((p): p is StylePreset => !!p).slice(0, 6);
  const current = doc && doc.style.status !== 'empty' ? doc.style.presetId : undefined;
  const chosen = current && presets.some((p) => p.id === current) ? current : card.picked;
  const locked = doc?.style.status === 'locked';
  const drawn = doc ? doc.pages.filter((p) => p.render.status === 'ready').length : 0;

  if (!presets.length) {
    return (
      <CardShell title="Styles" icon={<Palette className="h-4 w-4" />} aria-label="Style presets">
        <p className="text-[13px] text-[var(--ds-muted)]">These styles aren't available anymore. Ask the director for fresh suggestions.</p>
      </CardShell>
    );
  }

  return (
    <CardShell
      title="Styles that fit"
      icon={<Palette className="h-4 w-4" />}
      right={<span className="rounded-full bg-[#D97757]/10 px-2 py-0.5 text-[11px] font-semibold text-[var(--ds-accent)]">Free</span>}
      aria-label="Style presets"
    >
      {card.note && <p className="mb-3 text-[13px] leading-snug text-[var(--ds-ink)] [overflow-wrap:anywhere]">{card.note}</p>}
      <div role="radiogroup" aria-label="Pick a style" className={cx('grid gap-2 sm:gap-2.5', presets.length <= 2 ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3')}>
        {presets.map((p) => {
          const on = chosen === p.id;
          const pending = isPending(`use:${p.id}`);
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={`${p.name}: ${p.tagline}`}
              disabled={anyPending}
              onClick={() => {
                if (!on) void run(`use:${p.id}`, { type: 'use_preset', presetId: p.id });
              }}
              className={cx(
                'group relative min-w-0 overflow-hidden rounded-xl border bg-[var(--ds-surface-strong)] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/50 disabled:cursor-wait',
                'motion-safe:transition-[transform,border-color,box-shadow] motion-safe:duration-200',
                on ? 'border-[#D97757]/60 ring-2 ring-[#D97757]/25' : 'border-[var(--ds-hairline)] hover:border-[#D97757]/35 motion-safe:hover:-translate-y-px'
              )}
            >
              <span className="relative block aspect-[4/5] w-full overflow-hidden bg-[var(--ds-well)]" aria-hidden>
                <LibraryImage
                  id={stylePreviewId(p.id)}
                  alt=""
                  sizes="(min-width: 640px) 180px, 45vw"
                  className="absolute inset-0 h-full w-full object-cover"
                  fallback={
                    <span className="absolute inset-0 block [&>*]:h-full [&>*]:w-full">
                      <PresetThumb preset={p} />
                    </span>
                  }
                />
                {(on || pending) && (
                  <span className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-[var(--ds-accent)] text-white shadow-sm">
                    {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  </span>
                )}
              </span>
              <span className="block px-2.5 py-2">
                <span className="block truncate text-[12.5px] font-semibold text-[var(--ds-ink)]">{p.name}</span>
                <span className="mt-0.5 line-clamp-2 block text-[11.5px] leading-snug text-[var(--ds-muted)]">{p.tagline}</span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-[11.5px] leading-snug text-[var(--ds-muted)]">
        {locked && drawn
          ? `Picking one replaces the locked style; the ${drawn === 1 ? 'drawn page shows' : `${drawn} drawn pages show`} as out of date until redrawn. `
          : ''}
        {STYLE_PRESETS_FREE_NOTE}
      </p>
    </CardShell>
  );
};

export default StylePresetsCard;
