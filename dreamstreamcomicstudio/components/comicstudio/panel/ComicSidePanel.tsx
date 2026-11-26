// The one side panel of Comic Studio (SH-C1): the same panel on My comics, New comic, Images and inside a comic, docked
// beside the work on wide screens (open, or a slim rail) and in a drawer on phones (the shells own the docking:
// ComicWorkspaceFrame and ComicStudioShell). From the top:
//   1. Where you are: My comics, then the place itself (the comic, New comic or Images) as the current page.
//   2. Inside a comic: the comic's own section (ComicSection: its stage and next step, Ask the Director, the board).
//   3. Your comics: every comic once, grouped Needs you, In progress, Finished, Recent (PanelComics).
//   4. Go to: New comic, Images, Chat, Library, the studio guide, Report a problem. On a tall window this group stays
//      at the foot and the rest scrolls; on a short one the whole panel scrolls.
// Ink only: no hue, no ultramarine, no wash, no spark, no price (tests/config/sparkGuard and colourUseGuard hold the
// panel to the ink-only navigation rule). New comic is the All comics view's one fill, an outline on its own view, and
// a plain row anywhere else, so every view keeps one fill.

import React from 'react';
import { ArrowLeft, BookOpen, Bug, CircleHelp, Image as ImageIcon, Layers, MessageCircle, Plus } from 'lucide-react';
import type { Project } from '../../../types';
import type { StageFacts } from '../../../shared/comic/stage';
import { cn } from '../../../lib/utils';
import { CLIP_TEXT } from '../../chat/studioDesign';
import { openFeedbackReport } from '../../../services/openFeedbackReport';
import { PanelComics } from './PanelComics';
import { PANEL_FILL, PANEL_OUTLINE, PANEL_ROW, PANEL_ROW_CURRENT, PANEL_ROW_IDLE, PANEL_ROW_INK, PANEL_ROW_SHORT, RAIL_ITEM } from './panelStyles';

/** The id the shells' toggles point at (aria-controls). */
export const PANEL_ID = 'studio-project-navigation';
/** The panel's one name, everywhere it is docked or drawn. */
export const PANEL_LABEL = 'Project navigation';

/** Where the person is: All comics (My comics), New comic, Images, or inside a comic. */
export type PanelPlace = 'all' | 'new' | 'images' | 'comic';

/** App's destinations and the comic list (App.tsx and ProjectDashboard fill them; every entry uses App's routing). */
export interface ComicPanelLinks {
  projects: Project[];
  accountId?: string;
  disabled?: boolean;
  /** Outside a comic, the view that is open. */
  activeView?: 'new' | 'all' | 'images';
  onNewComic(): void;
  onImages?(): void;
  onChat?(): void;
  onAllComics(): void;
  onLibrary(): void;
  onReport?(): void;
  onOpenProject(id: string): void;
  /** Open a Comic Studio comic (App's openComicStudio); onOpenProject otherwise. */
  onOpenStudioWork?(id: string): void;
}

export interface ComicSidePanelProps {
  place: PanelPlace;
  links?: ComicPanelLinks;
  /** Back to My comics; links.onAllComics by default (the studio passes its own Back). */
  onMyComics?: () => void;
  /** The comic you are in (place 'comic'). */
  comic?: { id: string; title: string; facts: StageFacts | null };
  /** Section 2: the comic's own (ComicSection), built by the studio for this mode. */
  comicSection?: React.ReactNode;
  /** The slim rail. */
  compact?: boolean;
  id?: string;
  className?: string;
}

interface Destination {
  key: string;
  label: string;
  icon: React.ReactNode;
  onClick?: () => void;
  href?: string;
  current?: boolean;
  /** Its own look (New comic's fill or outline); the row's ink otherwise. */
  look?: string;
  fill?: boolean;
  /** Also in the slim rail. */
  rail?: boolean;
}

const HERE: Readonly<Record<Exclude<PanelPlace, 'all'>, string>> = { comic: 'Untitled comic', new: 'New comic', images: 'Images' };

export function ComicSidePanel({ place, links, onMyComics, comic, comicSection, compact = false, id = PANEL_ID, className }: ComicSidePanelProps) {
  const disabled = links?.disabled;
  const myComics = onMyComics ?? links?.onAllComics;
  const onList = place === 'all';
  const here = place === 'all' ? null : place === 'comic' ? comic?.title.trim() || HERE.comic : HERE[place];
  const report = links?.onReport ?? (() => openFeedbackReport('bug'));

  // Section 1's own control: the way back to the list, or the list itself when it is open.
  const myComicsButton = myComics && (
    <button
      type="button"
      onClick={myComics}
      disabled={disabled}
      aria-current={onList ? 'page' : undefined}
      aria-label={onList ? 'My comics' : 'Back to My comics'}
      title={compact ? 'My comics' : undefined}
      className={cn(compact ? RAIL_ITEM : PANEL_ROW, onList ? PANEL_ROW_CURRENT : PANEL_ROW_IDLE)}
    >
      {onList ? <Layers className="h-4 w-4 shrink-0" aria-hidden /> : <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden />}
      {!compact && <span className={CLIP_TEXT}>My comics</span>}
    </button>
  );

  const newComicLook = place === 'all' ? PANEL_FILL : place === 'new' ? PANEL_OUTLINE : PANEL_ROW_INK;
  const destinations: Destination[] | undefined = links && ([
    { key: 'new', label: 'New comic', icon: <Plus className="h-4 w-4 shrink-0" aria-hidden />, onClick: links.onNewComic, current: place === 'new', look: newComicLook, fill: place === 'all', rail: true },
    links.onImages && { key: 'images', label: 'Images', icon: <ImageIcon className="h-4 w-4 shrink-0" aria-hidden />, onClick: links.onImages, current: place === 'images', rail: true },
    links.onChat && { key: 'chat', label: 'Chat', icon: <MessageCircle className="h-4 w-4 shrink-0" aria-hidden />, onClick: links.onChat, rail: true },
    { key: 'library', label: 'Library', icon: <BookOpen className="h-4 w-4 shrink-0" aria-hidden />, onClick: links.onLibrary, rail: true },
    { key: 'guide', label: 'Studio guide', icon: <CircleHelp className="h-4 w-4 shrink-0" aria-hidden />, href: '/?tour=1' },
    { key: 'report', label: 'Report a problem', icon: <Bug className="h-4 w-4 shrink-0" aria-hidden />, onClick: report }
  ] as Array<Destination | undefined>).filter((d): d is Destination => !!d);

  if (compact) {
    return (
      <nav id={id} aria-label={PANEL_LABEL} data-comic-panel="rail" className={cn('flex h-full min-h-0 flex-col items-center gap-1 overflow-y-auto overscroll-contain py-1.5', className)}>
        {myComicsButton}
        {comicSection}
        {destinations && (
          <div className="flex flex-col items-center gap-1 border-t border-[var(--ds-hairline)] pt-2">
            {destinations.filter((d) => d.rail).map((d) => (
              <button
                key={d.key}
                type="button"
                onClick={d.onClick}
                disabled={disabled}
                aria-label={d.label}
                title={d.label}
                aria-current={d.current ? 'page' : undefined}
                data-panel-fill={d.fill || undefined}
                className={cn(RAIL_ITEM, d.look ?? (d.current ? PANEL_ROW_CURRENT : PANEL_ROW_IDLE))}
              >
                {d.icon}
              </button>
            ))}
          </div>
        )}
      </nav>
    );
  }

  return (
    <nav
      id={id}
      aria-label={PANEL_LABEL}
      data-comic-panel="open"
      // Tall windows pin Go to at the foot (the middle scrolls); short ones scroll as one, so nothing is squeezed.
      className={cn('flex h-full min-h-0 min-w-0 flex-col overflow-y-auto overscroll-contain [@media(min-height:720px)]:overflow-hidden', className)}
    >
      <div className="flex min-w-0 flex-col gap-1 p-1.5 [@media(min-height:720px)]:min-h-0 [@media(min-height:720px)]:flex-1 [@media(min-height:720px)]:overflow-y-auto [@media(min-height:720px)]:overscroll-contain">
        <ol aria-label="Where you are" className="m-0 flex list-none flex-col gap-0.5 p-0" data-panel-here>
          {myComicsButton && <li className="min-w-0">{myComicsButton}</li>}
          {here && (
            <li aria-current="page" className="flex min-h-9 min-w-0 items-center px-3 text-sm font-semibold text-[var(--ds-ink)]" title={here}>
              <span className={CLIP_TEXT}>{here}</span>
            </li>
          )}
        </ol>
        {place === 'comic' && comicSection}
        {links && (
          <PanelComics
            projects={links.projects}
            accountId={links.accountId}
            disabled={disabled}
            current={comic}
            onOpenStudio={links.onOpenStudioWork ?? links.onOpenProject}
            onOpenProject={links.onOpenProject}
            onAllComics={onList ? undefined : links.onAllComics}
          />
        )}
      </div>
      {destinations && (
        <ul aria-label="Go to" className="m-0 flex shrink-0 list-none flex-col gap-0.5 border-t border-[var(--ds-hairline)] p-1.5 pt-2" data-panel-destinations>
          {destinations.map((d) => (
            <li key={d.key} className="min-w-0">
              {d.href ? (
                <a href={d.href} className={cn(PANEL_ROW, PANEL_ROW_SHORT, PANEL_ROW_INK)}>
                  {d.icon}
                  <span className={CLIP_TEXT}>{d.label}</span>
                </a>
              ) : (
                <button
                  type="button"
                  onClick={d.onClick}
                  disabled={disabled}
                  aria-current={d.current ? 'page' : undefined}
                  data-panel-fill={d.fill || undefined}
                  className={cn(PANEL_ROW, PANEL_ROW_SHORT, d.look ?? (d.current ? PANEL_ROW_CURRENT : PANEL_ROW_INK))}
                >
                  {d.icon}
                  <span className={CLIP_TEXT}>{d.label}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
