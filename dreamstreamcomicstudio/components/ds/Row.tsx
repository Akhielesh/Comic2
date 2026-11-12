/**
 * Row — one line of a list (redesign plan §4; the Library's list view, the Outline, a Lettering line): a leading
 * thumbnail or icon, a title with an InlineMeta line under it, and trailing actions. At least 44 px tall under a
 * coarse pointer; the title truncates, the trailing actions never shrink.
 *
 * With `onOpen` (or `href`) the title becomes the row's one primary control, stretched over the whole row so a
 * tap anywhere opens it, while the trailing actions (placed later in the DOM, positioned) stay on top and keep
 * their own taps. The heading level is the caller's (`titleAs`), so a list of comics can keep h3 under a shelf's
 * h2.
 */
import React from 'react';
import { cn } from '../../lib/utils';
import { InlineMeta } from './InlineMeta';
import { DENSITY, RADIUS_CONTROL } from './recipes';

export interface RowProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  title: React.ReactNode;
  /** Facts under the title (InlineMeta items). */
  meta?: ReadonlyArray<React.ReactNode>;
  /** A thumbnail or icon before the text (decoration unless it carries its own label). */
  leading?: React.ReactNode;
  /** Actions after the text (a status chip, Read, ⋯). */
  trailing?: React.ReactNode;
  /** Makes the title the row's stretched primary control. */
  onOpen?: () => void;
  href?: string;
  /** The accessible name of the primary control (defaults to the title's text). */
  openLabel?: string;
  /** The title's element: a heading inside a list of cards, plain text by default. */
  titleAs?: 'h2' | 'h3' | 'h4' | 'span';
  as?: 'li' | 'div';
  selected?: boolean;
}

/** The stretched primary control: its ::after covers the row, so the whole row is one target. */
export const ROW_PRIMARY = `min-w-0 truncate text-left after:absolute after:inset-0 after:content-[''] ${RADIUS_CONTROL} focus-visible:outline-none`;

export function Row({ title, meta, leading, trailing, onOpen, href, openLabel, titleAs = 'span', as: Tag = 'div', selected, className, ...rest }: RowProps) {
  const TitleTag = titleAs;
  const primary = href ? (
    <a href={href} aria-label={openLabel} className={cn(ROW_PRIMARY, 'text-[var(--ds-ink)] no-underline')}>
      {title}
    </a>
  ) : onOpen ? (
    <button type="button" onClick={onOpen} aria-label={openLabel} className={cn(ROW_PRIMARY, 'bg-transparent p-0 text-[var(--ds-ink)]')}>
      {title}
    </button>
  ) : (
    <span className="min-w-0 truncate text-[var(--ds-ink)]">{title}</span>
  );
  const interactive = !!(href || onOpen);
  return (
    <Tag
      {...rest}
      data-slot="row"
      data-selected={selected || undefined}
      className={cn(
        'relative flex min-w-0 items-center gap-3 px-3 py-2',
        RADIUS_CONTROL,
        DENSITY.coarse,
        interactive && 'hover:bg-[var(--ds-hover)] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[color:var(--ds-focus)]',
        selected && 'bg-[var(--ds-active)]',
        className
      )}
    >
      {leading ? <span className="flex shrink-0 items-center">{leading}</span> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <TitleTag className="m-0 flex min-w-0 text-[length:var(--ds-text-base)] font-medium leading-5">{primary}</TitleTag>
        {meta?.length ? <InlineMeta items={meta} /> : null}
      </div>
      {trailing ? <div className="relative flex shrink-0 items-center gap-1">{trailing}</div> : null}
    </Tag>
  );
}
