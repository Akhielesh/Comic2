/**
 * The colour layer "Ink, Paper & Colour" as one specimen (CL-6; docs/design/design-system.md § Colour layer): the seven
 * hues with their tag chip, text step and solid tile; the order charts take them in; the sequential and diverging
 * ramps; the two washes; the studio accents; and a comic's own tint on a card. Every piece is a studioDesign recipe, so
 * the specimen shows exactly what screens get, and VITE_DS_COLOUR=off turns it neutral like everything else. Shown by
 * the QA scenes `colour-layer` and `ds-gallery`; a live Gallery entry "Colour" can follow once the
 * Studio Gallery exists. Sample words only: no price, no spend control, no network.
 */
import React from 'react';
import { BookOpen, Image as ImageIcon, LayoutGrid, Languages, Palette, Shapes, Users } from 'lucide-react';
import { cn } from '../../../lib/utils';
import {
  ART_EDGE,
  ART_SCOPE,
  ART_SOFT_BG,
  CHART_DIV_BG,
  CHART_HUE_ORDER,
  CHART_PLOT_BG,
  CHART_SEQ_BG,
  chartHue,
  HUE_MARK,
  HUE_NAMES,
  HUE_SLOTS,
  HUE_SOLID,
  HUE_SOLID_TEXT_SLOTS,
  HUE_TEXT,
  hueChip,
  INK_TILE,
  OVERLINE,
  RADIUS_CONTROL,
  RADIUS_PANEL,
  STUDIO_MARK,
  STUDIO_SOFT_BG,
  WASH_EMPTY,
  WASH_HERO
} from '../../chat/studioDesign';

const STACK = 'flex min-w-0 flex-col gap-3';
const ROW = 'flex min-w-0 flex-wrap items-center gap-2';
const NOTE = 'm-0 text-[length:var(--ds-text-sm)] text-[var(--ds-muted)]';
const SOLID_WORDS = `inline-flex min-h-7 items-center px-2.5 text-[length:var(--ds-text-sm)] font-semibold ${RADIUS_CONTROL}`;
const TITLE = 'm-0 text-[length:var(--ds-text-md)] font-semibold text-[var(--ds-ink)]';
/** One icon per slot: the parts of a comic, in tab order (Story, Cast, Style, Pages, Assets, Languages, Read). */
const SLOT_ICONS = [BookOpen, Users, Palette, LayoutGrid, ImageIcon, Languages, Shapes] as const;
const PART_WORDS = ['Story', 'Cast', 'Style', 'Pages', 'Assets', 'Languages', 'Read'] as const;
/** Sample bar heights (percent of the plot), one per series in chart order. */
const BARS = [72, 54, 88, 40, 63, 31, 47] as const;

function Hues() {
  return (
    <div className={STACK}>
      <h3 className={TITLE}>Seven hues</h3>
      <p className={NOTE}>A mark, a tag chip (ink on the soft tint), the text step on an icon, and a solid tile. Words sit on a solid only where they read.</p>
      <ul aria-label="The seven hues" className="m-0 grid min-w-0 list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2">
        {HUE_SLOTS.map((slot, i) => {
          const Icon = SLOT_ICONS[i];
          return (
            <li key={slot} className={cn(ROW, 'flex-nowrap rounded-[var(--ds-radius-control)] border border-[var(--ds-hairline)] p-2')} data-qa-hue={slot}>
              <span aria-hidden="true" className={cn('size-3 shrink-0 rounded-full', HUE_MARK.dot[i])} />
              <span className="min-w-0 flex-1 truncate text-[length:var(--ds-text-sm)] text-[var(--ds-ink)]">
                {slot}. {HUE_NAMES[i]}
              </span>
              <span className={cn('inline-flex min-h-6 shrink-0 items-center px-2 text-[length:var(--ds-text-xs)] font-medium', RADIUS_CONTROL, hueChip(i))}>{PART_WORDS[i]}</span>
              <Icon aria-hidden="true" className={cn('size-4 shrink-0', HUE_TEXT[i])} />
              <span aria-hidden="true" className={cn('inline-flex size-8 shrink-0 items-center justify-center', RADIUS_CONTROL, HUE_SOLID[i])}>
                <Icon className="size-4" />
              </span>
            </li>
          );
        })}
      </ul>
      <p className={NOTE}>Words on a solid: ultramarine, violet and leaf (slots {HUE_SOLID_TEXT_SLOTS.join(', ')}) in light; every slot in dark.</p>
      <div className={ROW}>
        <span className={cn(SOLID_WORDS, HUE_SOLID[0])}>New</span>
        <span className={cn(SOLID_WORDS, HUE_SOLID[4])}>12</span>
        <span className={cn(SOLID_WORDS, HUE_SOLID[5])}>Done</span>
      </div>
      <div className={ROW} aria-label="Feature tiles: ink, magenta, leaf and sky" role="group">
        <span aria-hidden="true" className={cn('inline-flex size-14 items-center justify-center', RADIUS_PANEL, INK_TILE)}>
          <BookOpen className="size-6" />
        </span>
        {[1, 5, 6].map((i) => {
          const Icon = SLOT_ICONS[i];
          return (
            <span key={i} aria-hidden="true" className={cn('inline-flex size-14 items-center justify-center', RADIUS_PANEL, HUE_SOLID[i])}>
              <Icon className="size-6" />
            </span>
          );
        })}
      </div>
    </div>
  );
}

function Charts() {
  return (
    <div className={STACK}>
      <h3 className={TITLE}>Charts take the hues in this order</h3>
      <p className={NOTE}>Ultramarine, magenta, leaf and sky first: the four that stay apart for colour-blind readers. A legend always names them.</p>
      <ul aria-label="Chart series legend" className="m-0 flex min-w-0 list-none flex-wrap gap-x-4 gap-y-1 p-0">
        {CHART_HUE_ORDER.map((slot, i) => (
          <li key={slot} className="inline-flex items-center gap-2 text-[length:var(--ds-text-sm)] text-[var(--ds-ink)]">
            <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', chartHue('dot', i))} />
            Series {i + 1}
          </li>
        ))}
      </ul>
      <div className={cn('min-w-0 border border-[var(--ds-hairline)] p-3', RADIUS_CONTROL, CHART_PLOT_BG)}>
        <svg viewBox="0 0 140 60" role="img" aria-label="Sample bars, one per series" className="block h-24 w-full max-w-md">
          {BARS.map((h, i) => (
            <rect key={i} x={4 + i * 19} y={60 - (h * 56) / 100} width={14} height={(h * 56) / 100} rx={2} className={chartHue('fill', i) ?? undefined} />
          ))}
        </svg>
      </div>
      <div className={STACK}>
        <span className={OVERLINE}>Sequential: how much</span>
        <div className="flex min-w-0" aria-hidden="true">
          {CHART_SEQ_BG.map((bg) => (
            <span key={bg} className={cn('h-6 min-w-0 flex-1', bg)} />
          ))}
        </div>
        <span className={OVERLINE}>Diverging: below, even, above</span>
        <div className="flex min-w-0" aria-hidden="true">
          {CHART_DIV_BG.map((bg) => (
            <span key={bg} className={cn('h-6 min-w-0 flex-1', bg)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Washes() {
  return (
    <div className={STACK}>
      <h3 className={TITLE}>Washes</h3>
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <div className={cn('min-w-0 border border-[var(--ds-hairline)] p-5', RADIUS_PANEL, WASH_HERO)} data-qa-wash="hero">
          <p className="m-0 text-[length:var(--ds-text-lg)] font-semibold text-[var(--ds-ink)]">The hero wash</p>
          <p className={NOTE}>Behind the landing headline, once per page.</p>
        </div>
        <div className={cn('min-w-0 border border-[var(--ds-hairline)] p-5', RADIUS_PANEL, WASH_EMPTY)} data-qa-wash="empty">
          <p className="m-0 text-[length:var(--ds-text-lg)] font-semibold text-[var(--ds-ink)]">The empty-state wash</p>
          <p className={NOTE}>Behind an empty screen, never a working view.</p>
        </div>
      </div>
    </div>
  );
}

const STUDIOS = [
  { id: 'chat', label: 'Chat' },
  { id: 'live', label: 'Live' },
  { id: 'models', label: 'Models' },
  { id: 'atlas', label: 'Atlas' },
  { id: 'comic', label: 'Comic Studio (none: each comic has its own)' }
] as const;

function Studios() {
  return (
    <div className={STACK}>
      <h3 className={TITLE}>Studio accents</h3>
      <ul aria-label="Studio accents" className="m-0 flex min-w-0 list-none flex-wrap gap-2 p-0">
        {STUDIOS.map((s) => (
          <li key={s.id} data-ds-studio={s.id} className={cn('inline-flex min-h-9 min-w-0 items-center gap-2 px-3 text-[length:var(--ds-text-sm)] text-[var(--ds-ink)]', RADIUS_CONTROL, STUDIO_SOFT_BG)}>
            <span aria-hidden="true" className={cn('h-4 w-0.5 shrink-0 rounded-full', STUDIO_MARK)} />
            <span className="min-w-0">{s.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ArtTint() {
  return (
    <div className={STACK}>
      <h3 className={TITLE}>A comic’s own colour</h3>
      <div
        className={cn('flex min-w-0 max-w-sm flex-col gap-1 border p-4', RADIUS_PANEL, ART_SCOPE, ART_SOFT_BG, ART_EDGE)}
        style={{ '--ds-art': 'var(--ds-hue-3)' } as React.CSSProperties}
        data-qa-art=""
      >
        <p className="m-0 font-semibold text-[var(--ds-ink)]">The Harbor Lights</p>
        <p className={NOTE}>Its card takes a soft wash and an edge of the cover’s colour; the words stay ink.</p>
      </div>
    </div>
  );
}

/** The whole specimen (one section; the caller gives it its heading level and frame). */
export function ColourSpecimen() {
  return (
    <div className="flex min-w-0 flex-col gap-6" data-qa-colour-specimen="">
      <Hues />
      <Charts />
      <Washes />
      <Studios />
      <ArtTint />
    </div>
  );
}

export default ColourSpecimen;
