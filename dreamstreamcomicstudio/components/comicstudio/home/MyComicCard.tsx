// One comic in My comics (SH-B), in the Atlas language: the cover, the title, where the comic stands (its saved stage,
// shared/comic/stage.ts, in ink marks and words), one status line, the next step one tap away, Read once a page is
// drawn, and a quiet ⋯ menu that keeps every older action (rename, featured, details, duplicate, delete).
//
// Structure (ComicCard's rule): an <article> named by its title; the title's <h3> holds the ONE primary control (open
// the comic). A pointer tap anywhere else on the card that is not a control of its own is handed to it. The next step,
// Read and ⋯ sit beside the heading and each other, never inside a button, so no control is nested in another.
//
// Nothing here spends or shows a price: the next step only opens a place in the studio (a board tab, the
// conversation, the Share sheet), and the card carries no colour, wash or spark: ink, muted ink and the cover only.
//
// Layout: below 640 px a row (the cover beside the words, the buttons under both); from 640 px the cover on top
// (4:3, framed from the top). The cover box is sized before anything loads and its picture loads lazily, so nothing
// moves. 44 px targets on a coarse pointer.

import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, BookOpen, Copy, Info, MoreHorizontal, Pencil, Star, Trash2 } from 'lucide-react';
import type { Project } from '../../../types';
import { cn } from '../../../lib/utils';
import { Button, buttonClasses } from '../../ds/Button';
import { COMIC_CARD, COMIC_CARD_FOCUS, COMIC_CARD_PRIMARY, handCardClickToPrimary } from '../../ds/ComicCard';
import { revealKeyOf, RevealImage } from '../../ds/CoverImage';
import { IconButton } from '../../ds/IconButton';
import { INPUT_CLASSES } from '../../ds/Input';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../ds/Menu';
import { Progress } from '../../ds/Progress';
import { Skeleton } from '../../ds/Skeleton';
import { CHIP, CLIP_TEXT, LIFT, MUTED, WRAP_TEXT } from '../../chat/studioDesign';
import { COMIC_STAGES, type StageView } from '../../../shared/comic/stage';
import { EmptyArt } from '../library/procedural/EmptyArt';
import { StageMark } from '../stage/StageStrip';
import { coverCandidates, PROJECT_NAME_MAX, type MyComicCardModel, type MyComicNext } from './homeModel';
import type { TaskDestination } from './workspaceTaskTarget';

export const DUPLICATE_UNAVAILABLE_FOR_STUDIO = "Duplicate isn't available for studio comics yet";

/** What a card asks of the page. Every handler takes the comic's id, so one stable set serves every card. */
export interface MyComicCardActions {
  /** Open the comic, at `destination` when one is given (a board tab, the conversation, the Share sheet). */
  open(id: string, destination: TaskDestination | null): void;
  read(id: string): void;
  startRename(id: string): void;
  /** The new title, or null when the rename was cancelled. */
  finishRename(id: string, value: string | null): void;
  toggleFeatured(id: string): void;
  details(id: string): void;
  duplicate(id: string): void;
  askDelete(id: string): void;
}

/** The studio URL a next step deep-links to (a new tab opens it there too): `/?view=studio&id=…&task=…`. */
export const studioHref = (id: string, destination: TaskDestination | null): string =>
  '/?' + new URLSearchParams({ view: 'studio', id, ...(destination ? { task: destination } : {}) }).toString();

/** Below 640 px: a row, the cover in a 6 rem column and the buttons under both. From 640 px: the cover on top. */
export const MY_COMIC_CARD = 'grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-3 overflow-hidden p-3 sm:flex sm:flex-col sm:gap-0 sm:p-0';
/** The cover box: 3:4 beside the words on a phone, 4:3 across the top from 640 px. Its size is set before it loads. */
export const MY_COMIC_COVER =
  'relative block aspect-[3/4] w-full self-start overflow-hidden rounded-[var(--ds-radius-sm)] bg-[var(--ds-well)] sm:aspect-[4/3] sm:rounded-none sm:border-b sm:border-[var(--ds-hairline)]';

/** The five stages as ink marks (StageStrip's), then the stage's word. Screen readers hear "Stage 4 of 5: Drawing". */
export function StageLine({ view, className }: { view: StageView; className?: string }) {
  const at = COMIC_STAGES.indexOf(view.stage) + 1;
  return (
    <p data-slot="stage-line" className={cn('m-0 flex min-w-0 items-center gap-2 text-[length:var(--ds-text-sm)] leading-5', className)}>
      <span aria-hidden="true" className="inline-flex shrink-0 items-center gap-0.5">
        {view.steps.map((step) => (
          <span
            key={step.stage}
            data-stage-mark={step.done ? 'done' : step.current ? 'current' : 'upcoming'}
            className={cn('flex h-2.5 w-2.5 items-center justify-center', step.done || step.current ? 'text-[var(--ds-ink)]' : MUTED)}
          >
            <StageMark done={step.done} current={step.current} />
          </span>
        ))}
      </span>
      <span className="sr-only">{view.complete ? 'Every stage done:' : `Stage ${at} of ${COMIC_STAGES.length}:`} </span>
      <span className={cn('font-medium text-[var(--ds-ink)]', CLIP_TEXT)}>{view.word}</span>
    </p>
  );
}

/** The stage row for any card: the marks and word, a same-size placeholder while the stage read runs, or plain words. */
export function CardStageLine({ model, className }: { model: MyComicCardModel; className?: string }) {
  if (model.stage) return <StageLine view={model.stage} className={className} />;
  if (model.pending) {
    return (
      <p data-slot="stage-line" className={cn('m-0 flex h-5 items-center', className)}>
        <Skeleton shape="text" className="h-3.5 w-28" />
      </p>
    );
  }
  return <p data-slot="stage-line" className={cn('m-0 text-[length:var(--ds-text-sm)] leading-5', MUTED, CLIP_TEXT, className)}>{model.stageWord}</p>;
}

/** Where a status line's parts meet ("6 of 12 pages drawn · edited 2 hours ago"; homeModel and the stage's words). */
const STATUS_SEPARATOR = ' · ';

/**
 * The status line, never cut (its words are the only place the edit time and the out-of-date count show): its parts sit
 * on one line while they fit, and otherwise a part moves to the next line whole, so a 328 px phone card reads
 * "6 of 12 pages drawn ·" over "edited 2 hours ago". A part wider than the card wraps inside itself.
 */
export function CardStatus({ text, className }: { text: string; className?: string }) {
  const parts = text.split(STATUS_SEPARATOR);
  return (
    <p data-slot="card-status" className={cn('m-0 min-w-0 text-[length:var(--ds-text-sm)] leading-5 tabular-nums', MUTED, className)}>
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 ? ' ' : null}
          <span data-slot="status-part" className={cn('inline-block max-w-full', WRAP_TEXT)}>
            {i < parts.length - 1 ? `${part}\u00a0·` : part}
          </span>
        </React.Fragment>
      ))}
    </p>
  );
}

/** A next step's own height: it grows to a second line rather than cut its words (they say what happens next). */
const NEXT_GROWS: Record<'sm' | 'default', string> = { sm: 'h-auto min-h-8 py-1.5', default: 'h-auto min-h-9 py-1.5' };

/**
 * The next step: a link to the studio place (so a new tab opens it there) that, on a plain click, opens the comic in this
 * tab at that place. Classic comics open their own editor (a button: they have no studio URL). It never starts a step.
 * Its words never end in an ellipsis: on the narrowest card they wrap inside the button.
 */
export function NextStep({ id, title, next, kind, onOpen, size = 'sm', className }: { id: string; title: string; next: MyComicNext; kind: MyComicCardModel['kind']; onOpen: MyComicCardActions['open']; size?: 'sm' | 'default'; className?: string }) {
  const hintId = useId();
  const name = `${next.label}, ${title}`;
  const content = (
    <>
      <span data-slot="button-label" className={cn(WRAP_TEXT, 'whitespace-normal text-left leading-5')}>
        {next.label}
      </span>
      {next.destination ? <ArrowRight aria-hidden="true" /> : null}
    </>
  );
  const hint = (
    <span id={hintId} hidden>
      {next.hint}
    </span>
  );
  if (kind !== 'studio') {
    return (
      <>
        <Button type="button" variant="outline" size={size} aria-label={name} aria-describedby={hintId} data-card-next="" className={className} onClick={() => onOpen(id, null)}>
          <Pencil aria-hidden="true" />
          {next.label}
        </Button>
        {hint}
      </>
    );
  }
  return (
    <>
      <a
        href={studioHref(id, next.destination)}
        aria-label={name}
        aria-describedby={hintId}
        data-card-next={next.destination ?? 'open'}
        className={buttonClasses({ variant: 'outline', size, className: cn('no-underline', NEXT_GROWS[size], className) })}
        onClick={(event) => {
          // A new tab or window (a modifier, or the middle button through auxclick) follows the link itself.
          if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onOpen(id, next.destination);
        }}
      >
        {content}
      </a>
      {hint}
    </>
  );
}

/** Inline title editor: Enter saves, Escape cancels, leaving the field saves. Commits once; says how it ended. */
function TitleRenameInput({ initial, onDone }: { initial: string; onDone: (value: string | null, byKey: boolean) => void }) {
  const [draft, setDraft] = useState(initial);
  const doneRef = useRef(false);
  const finish = (value: string | null, byKey: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(value, byKey);
  };
  return (
    <input
      autoFocus
      aria-label="Comic title"
      value={draft}
      maxLength={PROJECT_NAME_MAX}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => finish(draft, false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(draft, true);
        else if (e.key === 'Escape') {
          e.stopPropagation();
          finish(null, true);
        }
      }}
      className={cn(INPUT_CLASSES, 'h-9 w-full px-2 text-[length:var(--ds-text-base)] font-semibold')}
    />
  );
}

/**
 * The cover: a box of fixed proportions (so nothing moves), the first picture that loads from the comic's candidates
 * (cover, first drawn panel, first Page Studio page, first look; each later one tried only if the one before fails), and
 * a line drawing when there is none. Decorative: the heading names the comic.
 */
function CardCover({ project, priority, needsYou, studio }: { project: Project; priority: boolean; needsYou: boolean; studio: boolean }) {
  const sources = coverCandidates(project);
  const empty = (
    <span data-slot="cover-empty" className={cn('absolute inset-0 flex items-center justify-center p-[14%] [&_svg]:h-auto [&_svg]:w-full [&_svg]:max-w-20', MUTED)}>
      <EmptyArt variant={studio ? 'studio' : 'reader'} />
    </span>
  );
  const picture = sources.reduceRight<React.ReactNode>(
    (fallback, src, i) => <RevealImage key={src} src={src} alt="" revealKey={revealKeyOf(null, src)} priority={priority && i === 0} fallback={fallback} className="object-top" />,
    empty
  );
  return (
    <span data-slot="my-comic-cover" className={MY_COMIC_COVER}>
      {picture}
      {needsYou ? (
        // Seen on the cover; heard after the title (the card says it there), so it is not read twice.
        <span aria-hidden="true" data-slot="needs-you" className={cn(CHIP, 'absolute left-1.5 top-1.5 border-[var(--ds-hairline)] bg-[var(--ds-raised)] text-[var(--ds-ink)] sm:left-2 sm:top-2')}>
          Needs you
        </span>
      ) : null}
    </span>
  );
}

export interface MyComicCardProps {
  project: Project;
  model: MyComicCardModel;
  renaming: boolean;
  /** One of the first cards on the page: its cover loads at once instead of lazily. */
  priority?: boolean;
  actions: MyComicCardActions;
}

function MyComicCardImpl({ project, model, renaming, priority = false, actions }: MyComicCardProps) {
  const id = project.id;
  const titleId = useId();
  const primaryRef = useRef<HTMLButtonElement>(null);
  const renameChosen = useRef(false);
  const focusTitleAfterRename = useRef(false);
  const { title } = model;
  const studio = model.kind === 'studio';

  // A rename ended from the keyboard puts focus back on the title; one ended by leaving the field leaves focus where the
  // person put it.
  useEffect(() => {
    if (renaming || !focusTitleAfterRename.current) return;
    focusTitleAfterRename.current = false;
    primaryRef.current?.focus();
  }, [renaming]);

  const onCardClick = (event: React.MouseEvent<HTMLElement>) => {
    if (!renaming) handCardClickToPrimary(event, primaryRef.current);
  };

  return (
    <article
      aria-labelledby={titleId}
      data-slot="my-comic-card"
      data-kind={model.kind}
      data-needs-you={model.needsYou || undefined}
      onClick={onCardClick}
      className={cn(COMIC_CARD, LIFT, COMIC_CARD_FOCUS, 'h-full cursor-pointer', MY_COMIC_CARD)}
    >
      <CardCover project={project} priority={priority} needsYou={model.needsYou} studio={studio} />
      <div className="flex min-w-0 flex-col gap-1 sm:px-3 sm:pt-3">
        <div className="flex min-w-0 items-start gap-1">
          <h3 id={titleId} className="m-0 min-w-0 flex-1 text-[length:var(--ds-text-base)] font-semibold leading-5 text-[var(--ds-ink)]">
            {renaming ? (
              <TitleRenameInput
                initial={project.name}
                onDone={(value, byKey) => {
                  focusTitleAfterRename.current = byKey;
                  actions.finishRename(id, value);
                }}
              />
            ) : (
              <button ref={primaryRef} type="button" data-card-primary="" className={cn(COMIC_CARD_PRIMARY, 'w-full py-0.5')} onClick={() => actions.open(id, null)}>
                <span data-user-content="" className="line-clamp-2 [overflow-wrap:anywhere]">
                  {title}
                </span>
              </button>
            )}
          </h3>
          {/* Right after the title, for anyone who moves by heading: the reason this comic is listed first. */}
          {model.needsYou ? <span className="sr-only">Needs you</span> : null}
          {model.featured ? <Star role="img" aria-label="Featured" className="mt-1.5 size-3.5 shrink-0 fill-current text-[var(--ds-ink)]" /> : null}
          <Menu modal={false}>
            {/* ⋯ is positioned, so it sits above the title's 44 px touch area where the two meet. */}
            <MenuTrigger asChild>
              <IconButton size="sm" label={`More for ${title}`} title="More" className={cn('relative -mr-1 -mt-0.5 shrink-0', MUTED, 'hover:text-[var(--ds-ink)]')}>
                <MoreHorizontal />
              </IconButton>
            </MenuTrigger>
            <MenuContent
              align="end"
              className="min-w-52"
              // Rename moves focus into the title field; the menu must not pull it back to ⋯ as it closes.
              onCloseAutoFocus={(event) => {
                if (!renameChosen.current) return;
                renameChosen.current = false;
                event.preventDefault();
              }}
            >
              <MenuItem
                onSelect={() => {
                  renameChosen.current = true;
                  actions.startRename(id);
                }}
              >
                <Pencil aria-hidden="true" />
                Rename
              </MenuItem>
              <MenuItem onSelect={() => actions.toggleFeatured(id)}>
                <Star aria-hidden="true" />
                {model.featured ? 'Unmark as featured' : 'Mark as featured'}
              </MenuItem>
              <MenuItem onSelect={() => actions.details(id)}>
                <Info aria-hidden="true" />
                Details
              </MenuItem>
              {studio ? (
                // A studio comic's content lives server-side (comic_docs): copying the listing row would make a comic with
                // no document, so not yet. The row stays, disabled, with the reason as its name.
                <MenuItem disabled aria-label={DUPLICATE_UNAVAILABLE_FOR_STUDIO} className="items-start">
                  <Copy aria-hidden="true" className="mt-0.5" />
                  <span className="flex min-w-0 flex-col">
                    <span>Duplicate</span>
                    <span className={cn('text-[length:var(--ds-text-sm)] leading-4', MUTED)}>Not yet for studio comics</span>
                  </span>
                </MenuItem>
              ) : (
                <MenuItem onSelect={() => actions.duplicate(id)}>
                  <Copy aria-hidden="true" />
                  Duplicate
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem variant="destructive" onSelect={() => actions.askDelete(id)}>
                <Trash2 aria-hidden="true" />
                Delete…
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
        <CardStageLine model={model} />
        <CardStatus text={model.status} />
        {model.building ? (
          <Progress
            value={model.building.progress}
            max={100}
            label="Building"
            valueText={`${Math.round(model.building.progress)}%${model.building.remaining ? `, about ${model.building.remaining} left` : ''}`}
            size="sm"
            className="mt-1"
          />
        ) : null}
      </div>
      {/* Always one of the two: a comic with no next step is one whose next step is reading it. */}
      <div data-slot="card-actions" className="col-span-2 flex min-w-0 flex-wrap items-center gap-2 sm:mt-auto sm:px-3 sm:pb-3 sm:pt-3">
        {model.next ? <NextStep id={id} title={title} next={model.next} kind={model.kind} onOpen={actions.open} className="min-w-0 flex-1 justify-between" /> : null}
        {model.canRead ? (
          <Button type="button" variant={model.next ? 'ghost' : 'outline'} size="sm" aria-label={`Read ${title}`} className={model.next ? undefined : 'flex-1'} onClick={() => actions.read(id)}>
            <BookOpen aria-hidden="true" />
            Read
          </Button>
        ) : null}
      </div>
    </article>
  );
}

/** Re-renders only when its comic, its words or its rename state change (150 cards stay smooth). */
export const MyComicCard = React.memo(MyComicCardImpl);

/** A card's footprint while the first stage read runs (the same box, cover and lines), so nothing moves when it lands. */
export function MyComicCardPlaceholder() {
  return (
    <div aria-hidden="true" data-slot="my-comic-placeholder" className={cn(COMIC_CARD, 'h-full', MY_COMIC_CARD)}>
      <Skeleton className="aspect-[3/4] w-full self-start rounded-[var(--ds-radius-sm)] sm:aspect-[4/3] sm:rounded-none" />
      <div className="flex min-w-0 flex-col gap-2 sm:px-3 sm:pt-3">
        <Skeleton shape="text" className="w-3/4" />
        <Skeleton shape="text" className="h-3.5 w-1/2" />
        <Skeleton shape="text" className="h-3.5 w-2/3" />
      </div>
      <div className="col-span-2 sm:px-3 sm:pb-3 sm:pt-3">
        <Skeleton className="h-8 w-full coarse:h-11" />
      </div>
    </div>
  );
}
