/**
 * InlineMeta — one quiet line of facts joined by a middle dot (Atlas WorkspacePrimitives InlineMeta): "Comic ·
 * 4 of 6 pages · Edited Tue", "Manga · 12 pp · EN ES +2". Empty items are dropped, so a screen passes what it has
 * without building the separators itself. The dots are decoration (screen readers hear the items as a list of
 * words); amounts arrive already formatted — this line never formats money. On one line it truncates; `wrap`
 * lets the items flow onto more lines instead (the inspector).
 */
import React from 'react';
import { cn } from '../../lib/utils';

export interface InlineMetaProps {
  /** The facts, in reading order; null, false, undefined and '' are skipped. */
  items: ReadonlyArray<React.ReactNode>;
  /** Flow onto several lines instead of truncating. */
  wrap?: boolean;
  as?: 'p' | 'span' | 'div';
  className?: string;
}

/** The line's type: 12 px muted, tabular numbers so counts line up across cards. */
export const INLINE_META = 'min-w-0 text-[12px] leading-4 tabular-nums text-[var(--ds-muted)]';

const present = (n: React.ReactNode) => n !== null && n !== undefined && n !== false && n !== '';

export function InlineMeta({ items, wrap = false, as: Tag = 'p', className }: InlineMetaProps) {
  const shown = items.filter(present);
  if (!shown.length) return null;
  return (
    <Tag data-slot="inline-meta" className={cn(INLINE_META, wrap ? 'flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5' : 'truncate', 'm-0', className)}>
      {shown.map((item, i) => (
        <React.Fragment key={i}>
          {i > 0 ? (
            <span aria-hidden="true" className={wrap ? undefined : 'px-1.5'}>
              ·
            </span>
          ) : null}
          <span className={wrap ? 'min-w-0' : undefined}>{item}</span>
        </React.Fragment>
      ))}
    </Tag>
  );
}
