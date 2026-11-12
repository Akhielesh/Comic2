/**
 * ComicCard — one card for a comic everywhere (redesign plan §2 "Card", §4, §6.2–§6.3): the Library's own comics,
 * Discover's public ones, a shelf, the studio Home hero, a list row and the reader's end card. It replaces the
 * dashboard card, the gallery card, the profile card and the Library inspector header.
 *
 * The structure is fixed so every card behaves the same:
 *   - the cover is a MediaTile holding a CoverImage (2:3, reserved, revealed on decode);
 *   - the title is an `<h3>` (or the level the screen asks for) holding exactly ONE primary control — a button,
 *     or a link with `href` — named by the title. A heading inside a button is invalid HTML and broke `cardFor` in
 *     the dashboard tests; a button inside a heading is valid and is what screen-reader users navigate by. A
 *     pointer tap anywhere else on the card (the cover, the meta) hands the click to that one control, so the whole
 *     card opens it without a second tab stop or an overlay that would sit over the corner controls;
 *   - Read and Open are their own buttons in the footer, OUTSIDE the heading;
 *   - the on-art chip (status, rating) sits top-left, the corner slot (selection checkbox, Save) top-right;
 *   - meta is one InlineMeta line; amounts arrive formatted — the card never prints money.
 *
 * Variants: `owner` and `public` (grid cards), `rail` (a narrow shelf card), `hero` (cover beside a big title and
 * a two-line logline), `row` (a 72 px list row with a 48 × 64 cover) and `end` (the reader's end card: compact,
 * Read only). Hover lifts the card on pointers that really hover (LIFT; never under reduced motion).
 */
import React from 'react';
import { BookOpen, PenLine } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button, buttonClasses } from './Button';
import { CoverImage, type CoverImageProps } from './CoverImage';
import { InlineMeta } from './InlineMeta';
import { MediaTile } from './MediaTile';
import { Progress } from './Progress';
import { FONT_DISPLAY, LIFT, RADIUS_PANEL, TEXT_2XL } from './recipes';

export type ComicCardVariant = 'owner' | 'public' | 'rail' | 'hero' | 'row' | 'end';

export interface ComicCardAction {
  onClick?: () => void;
  href?: string;
  /** Visible words ("Read", "Open", "Edit", "Continue"). */
  label?: string;
  disabled?: boolean;
}

export interface ComicCardProps {
  variant?: ComicCardVariant;
  title: string;
  /** The primary control: opens the comic (the studio for your own, the reader for a public one). */
  onOpen?: () => void;
  href?: string;
  /** The accessible name of the primary control; the title by default. */
  openLabel?: string;
  /** Footer actions, outside the heading. */
  read?: ComicCardAction;
  open?: ComicCardAction;
  /** More footer controls (Pin, ⋯): the screen passes them; the card places them after Read and Open. */
  actions?: React.ReactNode;
  cover?: CoverImageProps;
  /** Facts ("Comic", "4 of 6 pages", "Edited Tue"). */
  meta?: ReadonlyArray<React.ReactNode>;
  /** "@name" on public cards (only when the creator is public). */
  creator?: string | null;
  /** The hero's two-line logline. */
  description?: string | null;
  /** Top-left over the art (a status chip, the RatingBadge on art). */
  chip?: React.ReactNode;
  /** Top-right over the art (the selection checkbox, Save). */
  corner?: React.ReactNode;
  /** A progress bar under the meta ("Pages drawn"). */
  progress?: { value: number; max: number; label?: string; valueText?: string };
  headingLevel?: 2 | 3 | 4;
  selected?: boolean;
  /** The comic's own tint for the cover box. */
  artColor?: string | null;
  className?: string;
}

/** The card surface: opaque, hairline, the panel radius; the primary control's ::after covers it. */
export const COMIC_CARD = `group/card relative flex min-w-0 flex-col ${RADIUS_PANEL} border border-[var(--ds-hairline)] bg-[var(--ds-surface)] text-[var(--ds-ink)]`;
/** The primary control inside the heading (the card's focus outline shows its focus). */
export const COMIC_CARD_PRIMARY = 'min-w-0 cursor-pointer text-left text-inherit no-underline bg-transparent p-0 focus-visible:outline-none';
/** Clicks on these never open the card: they are controls of their own. */
const OWN_CONTROLS = 'a,button,input,select,textarea,label,summary,[role="checkbox"],[role="switch"],[role="menuitem"],[data-card-ignore]';

const actionButton = (a: ComicCardAction | undefined, fallback: string, Icon: React.ComponentType<{ className?: string }>, variant: 'outline' | 'ghost') => {
  if (!a || (!a.onClick && !a.href)) return null;
  const label = a.label ?? fallback;
  const key = fallback.toLowerCase();
  if (a.href && !a.disabled) {
    return (
      <a href={a.href} data-card-action={key} className={buttonClasses({ variant, size: 'sm', className: 'relative no-underline' })}>
        <Icon aria-hidden="true" />
        {label}
      </a>
    );
  }
  return (
    <Button type="button" variant={variant} size="sm" onClick={a.onClick} disabled={a.disabled} data-card-action={key} className="relative">
      <Icon aria-hidden="true" />
      {label}
    </Button>
  );
};

export function ComicCard({
  variant = 'owner',
  title,
  onOpen,
  href,
  openLabel,
  read,
  open,
  actions,
  cover,
  meta,
  creator,
  description,
  chip,
  corner,
  progress,
  headingLevel = 3,
  selected = false,
  artColor,
  className
}: ComicCardProps) {
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4';
  const hero = variant === 'hero';
  const row = variant === 'row';
  const compact = variant === 'rail' || variant === 'end';
  const name = openLabel ?? title;
  const primaryRef = React.useRef<HTMLAnchorElement & HTMLButtonElement>(null);
  const interactive = !!(onOpen || href);
  const onCardClick = (e: React.MouseEvent<HTMLElement>) => {
    if (!interactive || e.defaultPrevented) return;
    const target = e.target as Element | null;
    if (!target || target.closest(OWN_CONTROLS)) return;
    // A drag-to-select of the title or the meta is reading, not opening.
    const selection = typeof window !== 'undefined' ? window.getSelection?.() : null;
    if (selection && !selection.isCollapsed && selection.toString().trim()) return;
    primaryRef.current?.click();
  };

  const primary = href ? (
    <a ref={primaryRef} href={href} aria-label={openLabel} data-card-primary="" className={COMIC_CARD_PRIMARY}>
      {title}
    </a>
  ) : onOpen ? (
    <button ref={primaryRef} type="button" onClick={onOpen} aria-label={openLabel} data-card-primary="" className={COMIC_CARD_PRIMARY}>
      {title}
    </button>
  ) : (
    <span>{title}</span>
  );

  const coverBox = (
    <MediaTile aspect="2 / 3" artColor={artColor ?? cover?.artColor} chip={chip} menu={corner} lift={false} className={cn(row ? 'w-12 shrink-0' : hero ? 'w-[120px] shrink-0 sm:w-[168px]' : 'w-full', row && 'rounded-[var(--ds-radius-sm)]')}>
      <CoverImage alt="" {...cover} artColor={artColor ?? cover?.artColor} sizes={cover?.sizes ?? (row ? '48px' : hero ? '168px' : undefined)} className="h-full" />
    </MediaTile>
  );

  const readButton = actionButton(read, 'Read', BookOpen, variant === 'end' || variant === 'public' ? 'outline' : 'ghost');
  const openButton = variant === 'end' ? null : actionButton(open, 'Open', PenLine, 'outline');
  const footer = readButton || openButton || actions ? (
    <div data-slot="card-footer" className={cn('relative flex min-w-0 flex-wrap items-center gap-1.5', row ? 'shrink-0' : 'mt-auto pt-2')}>
      {readButton}
      {openButton}
      {actions}
    </div>
  ) : null;

  const text = (
    <div className={cn('flex min-w-0 flex-1 flex-col gap-1', row ? 'justify-center' : hero ? 'justify-center gap-2' : 'px-3 pb-3 pt-2.5')}>
      <Heading
        className={cn(
          'm-0 min-w-0 font-semibold text-[var(--ds-ink)]',
          hero ? cn(TEXT_2XL, FONT_DISPLAY, 'line-clamp-2') : compact ? 'line-clamp-2 text-[13px] leading-5' : 'line-clamp-2 text-[length:var(--ds-text-base)] leading-5'
        )}
      >
        {primary}
      </Heading>
      {creator ? <p className="m-0 truncate text-[12px] leading-4 text-[var(--ds-muted)]">{creator}</p> : null}
      {hero && description ? <p className="m-0 line-clamp-2 text-[length:var(--ds-text-base)] leading-6 text-[var(--ds-muted)]">{description}</p> : null}
      {meta?.length ? <InlineMeta items={meta} wrap={hero} /> : null}
      {progress ? (
        <Progress
          value={progress.value}
          max={progress.max}
          label={progress.label ?? 'Pages drawn'}
          valueText={progress.valueText ?? `${progress.value} of ${progress.max}`}
          size="sm"
          className="mt-1"
        />
      ) : null}
      {!row ? footer : null}
    </div>
  );

  return (
    <article
      data-slot="comic-card"
      data-variant={variant}
      data-selected={selected || undefined}
      aria-label={name}
      onClick={interactive ? onCardClick : undefined}
      className={cn(
        COMIC_CARD,
        interactive && cn(LIFT, 'cursor-pointer'),
        'has-[[data-card-primary]:focus-visible]:outline has-[[data-card-primary]:focus-visible]:outline-2 has-[[data-card-primary]:focus-visible]:outline-offset-2 has-[[data-card-primary]:focus-visible]:outline-[color:var(--ds-focus)]',
        row ? 'flex-row items-center gap-3 p-3' : hero ? 'flex-row items-stretch gap-4 p-4' : 'overflow-hidden',
        variant === 'rail' && 'w-full',
        className
      )}
    >
      {coverBox}
      {text}
      {row ? footer : null}
    </article>
  );
}
