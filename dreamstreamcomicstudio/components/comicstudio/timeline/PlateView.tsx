// A software page (title, "The End", back cover) drawn from plates.ts as an SVG: crisp at any size,
// no layout shift, no overflow, React-escaped text. Used by the timeline clips, the plate editor and
// the studio reader (P2-READER-PUBLIC renders plate slots with it); exports use the same layout.

import React, { useId, useMemo } from 'react';
import { DEFAULT_BOOK, type ComicDoc } from '../../../shared/comic/doc';
import { TONE_TEXT } from '../../chat/studioDesign';
import { PLATE_COLORS, PLATE_FONTS, plateLayout, type PlateKind, type PlateLayout } from './plates';

export interface PlateViewProps {
  doc: ComicDoc;
  kind: PlateKind;
  /** Signed URL for a storage path (the back cover's art vignette). */
  urlFor?: (path: string) => string | undefined;
  className?: string;
  /** Hide from assistive tech when a parent already labels it (timeline clips). */
  decorative?: boolean;
  /** Precomputed layout (tests, exports). */
  layout?: PlateLayout;
}

export const PlateView: React.FC<PlateViewProps> = ({ doc, kind, urlFor, className, decorative, layout: given }) => {
  const layout = useMemo(() => given ?? plateLayout(doc, kind), [given, doc, kind]);
  const clipId = useId().replace(/:/g, '');
  const artUrl = layout.art ? urlFor?.(layout.art.path) : undefined;
  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      preserveAspectRatio="xMidYMid meet"
      className={className}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : layout.alt}
      focusable="false"
    >
      <rect x={0} y={0} width={layout.width} height={layout.height} fill={PLATE_COLORS.paper} />
      {layout.art && (
        <g>
          <clipPath id={`plate-art-${clipId}`}>
            <rect x={layout.art.x} y={layout.art.y} width={layout.art.w} height={layout.art.h} rx={14} />
          </clipPath>
          <rect x={layout.art.x} y={layout.art.y} width={layout.art.w} height={layout.art.h} rx={14} fill="#e9e2d4" />
          {artUrl && (
            <image
              href={artUrl}
              x={layout.art.x}
              y={layout.art.y}
              width={layout.art.w}
              height={layout.art.h}
              preserveAspectRatio="xMidYMid slice"
              clipPath={`url(#plate-art-${clipId})`}
            />
          )}
        </g>
      )}
      {layout.rules.map((r, i) => (
        <line key={i} x1={r.x1} y1={r.y1} x2={r.x2} y2={r.y2} stroke={PLATE_COLORS.accent} strokeWidth={3} strokeLinecap="round" />
      ))}
      {layout.texts.map((t) => (
        <text
          key={t.id}
          x={t.x}
          y={t.y}
          textAnchor="middle"
          direction={t.dir}
          fontFamily={PLATE_FONTS[t.font]}
          fontSize={t.fontSize}
          fontWeight={t.weight}
          fontStyle={t.italic ? 'italic' : undefined}
          fill={PLATE_COLORS[t.tone]}
        >
          {t.lines.map((line, i) => (
            <tspan key={i} x={t.x} dy={i === 0 ? 0 : t.lineGap}>
              {line}
            </tspan>
          ))}
        </text>
      ))}
    </svg>
  );
};

export default PlateView;

// ── Plate editor (ClipMenu "Edit text") ──────────────────────────────────────

/** Edits the free text of a software page: credits (The End) or the blurb (back cover). The title
 *  page shows the cover title/tagline (or the comic title/logline), edited where they live. */
export const PlateEditor: React.FC<{
  doc: ComicDoc;
  kind: PlateKind;
  urlFor?: (path: string) => string | undefined;
  onSave(patch: { credits?: string[]; blurb?: string | null }): void;
  onEditCover(): void;
  onClose(): void;
}> = ({ doc, kind, urlFor, onSave, onEditCover, onClose }) => {
  const book = doc.book;
  const [credits, setCredits] = React.useState((book?.credits || []).join('\n'));
  const [blurb, setBlurb] = React.useState(book?.blurb ?? '');
  const creditLines = credits
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const tooMany = creditLines.length > 8 || creditLines.some((l) => l.length > 120);
  const tooLong = blurb.length > 600;
  const field = 'mt-1 w-full rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-3 py-2 text-[16px] text-[var(--ds-ink)] focus:border-[#D97757]/50 focus:outline-none sm:text-[13px]';
  const preview = { ...doc, book: { ...(doc.book ?? DEFAULT_BOOK), credits: creditLines.slice(0, 8), blurb } };
  return (
    <div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)]">
      <div className="mx-auto w-full max-w-[180px] overflow-hidden rounded-lg border border-[var(--ds-hairline)]">
        <PlateView doc={preview} kind={kind} urlFor={urlFor} />
      </div>
      <div className="min-w-0 space-y-3 text-[13px] text-[var(--ds-ink)]">
        {kind === 'title' && (
          <>
            <p className="text-[var(--ds-muted)]">The title page shows the cover title and tagline (or the comic’s title and logline). Edit them where they live — free.</p>
            <button type="button" onClick={onEditCover} className="tap-target h-9 rounded-xl border border-[var(--ds-hairline)] px-3 font-medium hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45">
              Edit cover text
            </button>
          </>
        )}
        {kind === 'end' && (
          <label className="block">
            <span className="font-medium">Credits</span>
            <span className="block text-[12px] text-[var(--ds-muted)]">One line each, up to 8 lines of 120 characters.</span>
            <textarea rows={5} value={credits} onChange={(e) => setCredits(e.target.value)} className={field} aria-invalid={tooMany || undefined} />
            {tooMany && <span className={`text-[12px] ${TONE_TEXT.danger}`}>Up to 8 lines of 120 characters.</span>}
          </label>
        )}
        {kind === 'back_cover' && (
          <label className="block">
            <span className="font-medium">Back-cover blurb</span>
            <span className="block text-[12px] text-[var(--ds-muted)]">Empty uses the logline. Up to 600 characters ({blurb.length}/600).</span>
            <textarea rows={5} value={blurb} onChange={(e) => setBlurb(e.target.value)} className={field} aria-invalid={tooLong || undefined} />
          </label>
        )}
        {kind !== 'title' && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={kind === 'end' ? tooMany : tooLong}
              onClick={() => {
                onSave(kind === 'end' ? { credits: creditLines } : { blurb: blurb.trim() ? blurb.trim() : null });
                onClose();
              }}
              className="tap-target h-9 rounded-xl bg-[var(--ds-accent)] px-4 font-semibold text-white hover:bg-[var(--ds-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45 disabled:opacity-45"
            >
              Save · Free
            </button>
            <button type="button" onClick={onClose} className="tap-target h-9 rounded-xl border border-[var(--ds-hairline)] px-3 font-medium hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45">
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
