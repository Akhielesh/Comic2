import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Surface, SurfaceTitle, SurfaceSubtitle, useCompact } from './kit';
import type { IconSetArtifact } from '../../../apiTypes';

// Icon search results (Iconify) — a pickable grid of open-source SVG glyphs.
//  • detailed — a grid of tiles; each shows the glyph + its "set:name" id, click to copy.
//  • compact  — a single dense row of glyphs (a glance at the matches).
//
// The SVG `body` is server-sanitized (see server/src/ai/tools/icons.ts) and inlined
// here so each glyph inherits the theme via `currentColor` (text-[var(--ds-ink)]).

const IconGlyph: React.FC<{ body: string; width: number; height: number; className?: string }> = ({
  body,
  width,
  height,
  className = ''
}) => (
  <svg
    viewBox={`0 0 ${width || 24} ${height || 24}`}
    width="1em"
    height="1em"
    fill="currentColor"
    aria-hidden
    className={className}
    dangerouslySetInnerHTML={{ __html: body }}
  />
);

export const IconSetCard: React.FC<{ data: IconSetArtifact }> = ({ data }) => {
  const compact = useCompact();
  const icons = (data.icons ?? []).filter((i) => i && typeof i.body === 'string');
  const [copied, setCopied] = useState<string | null>(null);

  if (!icons.length) return null;

  const copy = (id: string) => {
    try {
      navigator.clipboard?.writeText(id);
      setCopied(id);
      window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 1200);
    } catch {
      /* clipboard unavailable — the id is still visible to copy by hand */
    }
  };

  const header = (
    <div className="min-w-0">
      <SurfaceTitle>{data.query ? `Icons · “${data.query}”` : 'Icons'}</SurfaceTitle>
      <SurfaceSubtitle>
        {icons.length} shown{typeof data.total === 'number' && data.total > icons.length ? ` of ${data.total.toLocaleString()}` : ''} · Iconify
      </SurfaceSubtitle>
    </div>
  );

  // ── Compact: one dense row of glyphs. ────────────────────────────────────────
  if (compact) {
    return (
      <Surface header={header}>
        <div className="flex flex-wrap gap-2 px-3 pb-3 pt-0.5 text-[18px] text-[var(--ds-ink)]">
          {icons.slice(0, 12).map((ic) => (
            <span key={ic.id} title={ic.id} className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--ds-well)]">
              <IconGlyph body={ic.body} width={ic.width} height={ic.height} />
            </span>
          ))}
        </div>
      </Surface>
    );
  }

  // ── Detailed: grid of tiles with copyable ids. ───────────────────────────────
  return (
    <Surface header={header}>
      <div className="grid grid-cols-3 gap-2 px-3 pb-3 pt-0.5 sm:grid-cols-4">
        {icons.map((ic) => {
          const isCopied = copied === ic.id;
          return (
            <button
              key={ic.id}
              type="button"
              onClick={() => copy(ic.id)}
              title={`Copy “${ic.id}”`}
              aria-label={`Copy icon id ${ic.id}`}
              className="group flex flex-col items-center gap-1.5 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2 py-2.5 text-[var(--ds-ink)] transition-colors duration-200 hover:bg-[var(--ds-hover)]"
            >
              <span className="text-[26px] leading-none">
                <IconGlyph body={ic.body} width={ic.width} height={ic.height} />
              </span>
              <span className="flex w-full items-center justify-center gap-1 text-[10px] tabular-nums text-[var(--ds-muted)]">
                {isCopied ? (
                  <>
                    <Check className="h-3 w-3 shrink-0" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3 shrink-0 opacity-0 transition-opacity duration-200 group-hover:opacity-70" />
                    <span className="truncate">{ic.id}</span>
                  </>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </Surface>
  );
};
