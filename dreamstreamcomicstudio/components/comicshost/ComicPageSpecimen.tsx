// A procedural comic page for the comics landing: three bordered panels cut from the library's own art
// (PresetThumb: a girl, her terrier and a paper boat on a canal at dusk, drawn per look from the preset's
// palette) with real lettering drawn by the studio's balloon geometry (bubbleGeometry, the classic lettering
// preset), so the page shows what Comic Studio makes, at no cost, with no image to load.
//
// Art content, not chrome: the page paper and the panel ink are the look's own palette (the lightest and the
// darkest colour), applied inline and the same in light and dark (a printed page on a dark table, as the studio
// board shows pages). The root carries `data-comic-art` (the landing's hue and font guards skip it) and is
// aria-hidden: whoever places it says in words what it shows. The lettering face (Comic Neue, a bundled
// woff2) is requested once per page load, lazily, outside the landing chunk; until it arrives the SVG text uses
// the face's fallback stack in the same fixed boxes, so nothing reflows. No timer, no network beyond that file.

import React, { useEffect } from 'react';
import { cn } from '../../lib/utils';
import type { LineKind } from '../../shared/comic/doc';
import { getStylePreset, type StylePreset } from '../../shared/comic/stylePresets';
import { bubbleGeometry, resolveTailStyle } from '../../shared/comic/lettering/shapes';
import { fontFamilyStack } from '../../shared/comic/lettering/fonts';
import type { BubbleShape } from '../../shared/comic/lettering/style';
import { PresetThumb } from '../comicstudio/library/procedural/PresetThumb';
import { resolvePreviewStyle } from '../comicstudio/library/procedural/BubblePreview';
import { luminance } from '../comicstudio/library/procedural/textures';

export type SpecimenLayout = 'opening' | 'chase';

export interface ComicPageSpecimenProps {
  /** A STYLE_PRESETS id; an unknown id draws the Ligne claire look. */
  look: string;
  layout?: SpecimenLayout;
  className?: string;
}

/** The six looks the landing's band shows, in order (their names come from the preset data). */
export const SPECIMEN_LOOKS = ['ligne-claire', 'manga-screentone', 'noir-ink', 'watercolor-storybook', 'indie-risograph', 'retro-pop'] as const;

const FALLBACK_LOOK = 'ligne-claire';

/** The page's coordinate space for the lettering (a 2:3 page). */
const VB_W = 200;
const VB_H = 300;

interface SpecimenPanel {
  /** Left / top / width / height, in percent of the page. */
  box: [number, number, number, number];
  /** Where the art sits in the panel: a vertical shift (percent of the panel), a zoom and its origin. */
  shift: string;
  zoom: number;
  origin: string;
}

/** Two layouts, three panels each: an establishing page and a chase page (one scene, cropped like a comic). */
const PANELS: Record<SpecimenLayout, readonly SpecimenPanel[]> = {
  opening: [
    { box: [5, 3.4, 90, 50], shift: '-34%', zoom: 1, origin: 'center' },
    { box: [5, 56.4, 43.25, 40.2], shift: '0%', zoom: 1.9, origin: '30% 56%' },
    { box: [51.75, 56.4, 43.25, 40.2], shift: '0%', zoom: 2.6, origin: '62% 84%' }
  ],
  chase: [
    { box: [5, 3.4, 43.25, 40.2], shift: '0%', zoom: 2.8, origin: '27% 45%' },
    { box: [51.75, 3.4, 43.25, 40.2], shift: '0%', zoom: 2.4, origin: '74% 46%' },
    // -46 %, not deeper: past it the preset's swatch stripe under the scene shows at the bottom edge.
    { box: [5, 46.6, 90, 50], shift: '-46%', zoom: 1, origin: 'center' }
  ]
};

export interface SpecimenLine {
  kind: Extract<LineKind, 'speech' | 'shout' | 'caption'>;
  /** The text box in page units (x, y, w, h on the 200 × 300 page). */
  box: { x: number; y: number; w: number; h: number };
  /** Where the tail points (page units); captions have none. */
  tip?: { x: number; y: number };
  seed?: number;
  shape: BubbleShape;
  /** Font size in page units. */
  size: number;
  /** One entry per line, already in the lettering's upper case. */
  text: readonly string[];
}

/** The lettering on each layout (exported so tests read the words the page draws). */
export const SPECIMEN_LINES: Record<SpecimenLayout, readonly SpecimenLine[]> = {
  opening: [
    { kind: 'caption', box: { x: 14, y: 14, w: 84, h: 16 }, shape: 'rect', size: 6.6, text: ['DUSK, BY THE OLD CANAL.'] },
    { kind: 'speech', box: { x: 38, y: 174, w: 56, h: 24 }, tip: { x: 30, y: 206 }, seed: 3, shape: 'squircle', size: 6.6, text: ['BISCUIT —', 'THE BOAT!'] },
    // The shout's tail leaves panel C toward the dog in panel B.
    { kind: 'shout', box: { x: 140, y: 175, w: 46, h: 18 }, tip: { x: 104, y: 190 }, seed: 9, shape: 'burst', size: 7.4, text: ['WOOF!'] }
  ],
  chase: [
    { kind: 'speech', box: { x: 44, y: 14, w: 50, h: 22 }, tip: { x: 34, y: 52 }, seed: 5, shape: 'squircle', size: 6.6, text: ['WAIT', 'FOR US!'] },
    { kind: 'caption', box: { x: 110, y: 262, w: 76, h: 16 }, shape: 'rect', size: 6.6, text: ['THE RAIN WAS COMING.'] }
  ]
};

/** The look's preset, or Ligne claire for an unknown id. */
export const specimenPreset = (look: string): StylePreset => (getStylePreset(look) ?? getStylePreset(FALLBACK_LOOK)) as StylePreset;

/** The page paper and the panel ink: the palette's lightest and darkest colours (art content). */
export const specimenInks = (preset: Pick<StylePreset, 'palette'>): { paper: string; ink: string } => {
  const palette = preset.palette.length ? preset.palette : [];
  let paper = palette[0];
  let ink = palette[0];
  for (const colour of palette) {
    if (luminance(colour) > luminance(paper)) paper = colour;
    if (luminance(colour) < luminance(ink)) ink = colour;
  }
  return { paper, ink };
};

// The lettering face, requested once per page load (a bundled woff2, never /api, never on a timer). The loader
// is a dynamic import, so it stays out of the landing chunk; it never rejects.
let letteringFace: Promise<unknown> | null = null;
const requestLetteringFace = (): void => {
  if (letteringFace || typeof document === 'undefined') return;
  letteringFace = import('../comicstudio/lettering/fontLoader').then((m) => m.ensureFonts(['comic-neue'], { weights: [700] })).catch(() => undefined);
};

/** One balloon or caption, drawn as the lettering engine draws it (stroke under fill: no seam where the tail joins). */
const Lettering: React.FC<{ line: SpecimenLine }> = ({ line }) => {
  const style = resolvePreviewStyle({}, line.kind);
  const { x, y, w, h } = line.box;
  const strokeW = Math.max(0.6, style.borderWidth || 1);
  const lineGap = line.size * 1.24;
  const firstY = h / 2 - ((line.text.length - 1) * lineGap) / 2;
  const text = (
    <text
      x={w / 2}
      y={firstY}
      textAnchor="middle"
      dominantBaseline="central"
      fontFamily={fontFamilyStack(style.font)}
      fontWeight={700}
      fontSize={line.size}
      fill={style.textColor}
    >
      {line.text.map((t, i) => (
        <tspan key={i} x={w / 2} dy={i === 0 ? 0 : lineGap}>
          {t}
        </tspan>
      ))}
    </text>
  );
  if (line.shape === 'rect') {
    return (
      <g transform={`translate(${x} ${y})`} data-specimen-line={line.kind}>
        <rect width={w} height={h} fill={style.fill} stroke={style.border} strokeWidth={strokeW} />
        {text}
      </g>
    );
  }
  const tail = resolveTailStyle(style.tail, line.kind, line.shape);
  const geo = bubbleGeometry(line.shape, w, h, {
    inset: { x: 3, y: 2.5 },
    seed: line.seed ?? 1,
    tip: line.tip && tail !== 'none' ? { x: line.tip.x - x, y: line.tip.y - y } : null,
    tail,
    tailWidth: style.tailWidth || 1,
    stroke: strokeW
  });
  return (
    <g transform={`translate(${x} ${y})`} data-specimen-line={line.kind}>
      <g fill={style.fill} stroke={style.border} strokeWidth={strokeW * 2} strokeLinejoin="round">
        {geo.tail && <path d={geo.tail} />}
        {geo.body && <path d={geo.body} />}
      </g>
      <g fill={style.fill} stroke="none">
        {geo.tail && <path d={geo.tail} />}
        {geo.body && <path d={geo.body} />}
      </g>
      {geo.inner && <path d={geo.inner} fill="none" stroke={style.border} strokeWidth={strokeW * 0.6} />}
      {text}
    </g>
  );
};

export const ComicPageSpecimen: React.FC<ComicPageSpecimenProps> = ({ look, layout = 'opening', className }) => {
  useEffect(requestLetteringFace, []);
  const preset = specimenPreset(look);
  const { paper, ink } = specimenInks(preset);
  return (
    <div
      data-comic-art=""
      data-specimen-look={preset.id}
      data-specimen-layout={layout}
      aria-hidden
      className={cn('relative aspect-[2/3] w-full overflow-hidden rounded-[var(--ds-radius-sm)] shadow-[shadow:var(--ds-shadow-panel)]', className)}
      style={{ backgroundColor: paper }}
    >
      {PANELS[layout].map((panel, i) => {
        const [left, top, width, height] = panel.box;
        return (
          <div
            key={i}
            data-specimen-panel={i + 1}
            className="absolute overflow-hidden border-[1.5px]"
            style={{ borderColor: ink, left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
          >
            <div className="absolute inset-x-0" style={{ top: panel.shift, transform: `scale(${panel.zoom})`, transformOrigin: panel.origin }}>
              <PresetThumb preset={preset} />
            </div>
          </div>
        );
      })}
      <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="absolute inset-0 size-full" focusable="false" aria-hidden>
        {SPECIMEN_LINES[layout].map((line, i) => (
          <Lettering key={i} line={line} />
        ))}
      </svg>
    </div>
  );
};

export default ComicPageSpecimen;
