/**
 * SectionCard — Atlas WorkspacePrimitives SectionCard on the SECTION_* recipes. With an `icon` it is the
 * settings-style section: a labelled <section> whose header carries the 36 px icon tile, a 16 px title
 * (h2) and a muted description over a divider. Without one, a plain card with an optional title row.
 * `aside` (a count, a status chip) and `actions` sit beside the title while there is room and wrap under
 * it when there is not, so a long aside never squeezes the title on a phone.
 */
import React, { useId } from 'react';
import { cn } from '../../lib/utils';
import { SECTION_BODY, SECTION_CARD, SECTION_DESCRIPTION, SECTION_HEADER, SECTION_ICON_TILE, SECTION_TITLE } from './recipes';

export interface SectionCardProps {
  title?: string;
  description?: React.ReactNode;
  /** An icon element (decoration): turns on the settings-style header. */
  icon?: React.ReactNode;
  /** Shown opposite the title: a count, a status chip. */
  aside?: React.ReactNode;
  actions?: React.ReactNode;
  /** Anchor id (a scroll target); the card keeps clear of a sticky header. */
  id?: string;
  className?: string;
  contentClassName?: string;
  children: React.ReactNode;
}

export function SectionCard({ title, description, icon, aside, actions, id, className, contentClassName, children }: SectionCardProps) {
  const generated = useId().replace(/:/g, '');
  const headingId = id ? `${id}-heading` : `section-${generated}`;
  const trailing = aside || actions ? (
    <>
      {aside}
      {actions}
    </>
  ) : null;

  if (icon) {
    return (
      <section id={id} aria-labelledby={title ? headingId : undefined} data-slot="section-card" className={cn(SECTION_CARD, id && 'scroll-mt-36', className)}>
        <header className={SECTION_HEADER}>
          <div className={cn('flex min-w-0 flex-[1_1_16rem] gap-3.5', description ? 'items-start' : 'items-center')}>
            <span aria-hidden="true" className={cn(SECTION_ICON_TILE, '[&_svg]:size-4')}>
              {icon}
            </span>
            <div className="min-w-0">
              {title ? (
                <h2 id={headingId} className={cn(SECTION_TITLE, '[overflow-wrap:anywhere]')}>
                  {title}
                </h2>
              ) : null}
              {description ? <div className={SECTION_DESCRIPTION}>{description}</div> : null}
            </div>
          </div>
          {trailing ? <div className="flex w-full max-w-full flex-wrap items-center gap-2 sm:w-auto sm:ps-[3.125rem] sm:pt-1">{trailing}</div> : null}
        </header>
        <div className={cn(SECTION_BODY, contentClassName)}>{children}</div>
      </section>
    );
  }

  return (
    <section id={id} aria-labelledby={title ? headingId : undefined} data-slot="section-card" className={cn(SECTION_CARD, id && 'scroll-mt-36', className)}>
      {title || description || trailing ? (
        <header className="flex flex-col gap-3 border-b border-[color:color-mix(in_srgb,var(--ds-hairline)_60%,transparent)] px-5 pb-4 pt-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            {title ? (
              <h2 id={headingId} className={cn(SECTION_TITLE, '[overflow-wrap:anywhere]')}>
                {title}
              </h2>
            ) : null}
            {description ? <div className={cn(SECTION_DESCRIPTION, 'max-w-2xl')}>{description}</div> : null}
          </div>
          {trailing ? <div className="flex flex-wrap items-center gap-2">{trailing}</div> : null}
        </header>
      ) : null}
      <div className={cn('p-5', contentClassName)}>{children}</div>
    </section>
  );
}
