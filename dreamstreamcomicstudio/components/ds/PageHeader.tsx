/**
 * PageHeader — Atlas WorkspacePrimitives PageHeader: an optional overline (OVERLINE), the page title
 * (30 px, 32 px from `sm`, display face, tight tracking, balanced) and a muted description, with actions
 * that sit at the end on wide screens and wrap under the title on phones. Long titles break rather than
 * widen the page at 320 px.
 */
import React from 'react';
import { cn } from '../../lib/utils';
import { FONT_DISPLAY, OVERLINE, TEXT_3XL } from './recipes';

export const PAGE_TITLE = `m-0 min-w-0 text-balance font-semibold tracking-[-0.04em] text-[var(--ds-ink)] [overflow-wrap:anywhere] sm:text-[2rem] sm:leading-[1.15] ${TEXT_3XL} ${FONT_DISPLAY}`;

export interface PageHeaderProps {
  title: React.ReactNode;
  eyebrow?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** The title's heading level (h1 by default: one per page). */
  as?: 'h1' | 'h2';
  className?: string;
}

export function PageHeader({ title, eyebrow, description, actions, as: Heading = 'h1', className }: PageHeaderProps) {
  return (
    <div
      data-slot="page-header"
      className={cn(
        'flex min-w-0 flex-col gap-4 border-b border-[color:color-mix(in_srgb,var(--ds-hairline)_70%,transparent)] pb-6 md:flex-row md:items-end md:justify-between',
        className
      )}
    >
      <div className="min-w-0 space-y-2">
        {eyebrow ? <p className={cn(OVERLINE, 'm-0')}>{eyebrow}</p> : null}
        <div className="space-y-1.5">
          <Heading className={PAGE_TITLE}>{title}</Heading>
          {description ? <p className="m-0 max-w-3xl text-pretty text-[length:var(--ds-text-base)] leading-6 text-[var(--ds-muted)] sm:text-[15px]">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
