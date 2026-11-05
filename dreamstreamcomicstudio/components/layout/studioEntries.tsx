/**
 * The studio switcher's rows (DreamStream, Comic, Chat, Stream, Atlas) and the public pages, built once for
 * the desktop "Studios" menu and the phone menu, so both always offer the same places under the same names.
 *
 * Per-account studio confinement (product_access) is kept exactly as it was: an account confined to some
 * studios sees only those (admins are never confined); How it works and the Library belong to Comic Studio;
 * the model catalog, Atlas Studio and the public pages stay visible to everyone; a confined account
 * without Stream Studio sees it as "Soon" with a way to be told when it opens.
 */
import React, { useId } from 'react';
import { StudioMark } from '../brand';
import { useProductAccess } from '../../services/productAccess';
import { comicsEntryUrl } from '../../services/productHost';
import { liveAppUrl, openLiveApp } from '../../services/liveLink';
import {
  ATLAS_STUDIO_URL,
  CHAT_HREF,
  COMIC_STUDIO_HREF,
  HOME_HREF,
  HOW_IT_WORKS_HREF,
  LIBRARY_HREF,
  MODELS_HREF
} from './siteLinks';

export type StudioEntryId = 'dreamstream' | 'comic' | 'comics-app' | 'chat' | 'stream' | 'atlas';
export type PageEntryId = 'how-it-works' | 'gallery' | 'models';

export interface SiteEntry<Id extends string = string> {
  id: Id;
  label: string;
  description?: string;
  href: string;
  /** In-app opening for a plain click (absent for a link that leaves the site). */
  onClick?: () => void | Promise<unknown>;
  external?: boolean;
  current?: boolean;
  badge?: string;
  busyLabel?: string;
}

export interface StudioEntryRow extends SiteEntry<StudioEntryId> {
  /** The studio's mark, for a row that draws one. */
  mark: 'dreamstream' | 'comic' | 'stream' | 'atlas' | 'chat';
}

/**
 * Chat Studio has no mark of its own: its tile is drawn like the marks (one tile in currentColor, the chat
 * glyph cut out through a mask), so it sits on white, black and on an ink-filled row alike.
 */
const ChatTile: React.FC<{ className?: string }> = ({ className = 'size-7' }) => {
  const maskId = `ds-chat-tile-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false" className={`${className} shrink-0`}>
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <rect width="64" height="64" rx="16" fill="#fff" />
          {/* lucide's message-square, 24 → 36 units, centred. */}
          <path
            d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
            transform="translate(14 15) scale(1.5)"
            fill="none"
            stroke="#000"
            strokeWidth="2.6"
            strokeLinejoin="round"
          />
        </mask>
      </defs>
      <rect width="64" height="64" rx="16" fill="currentColor" mask={`url(#${maskId})`} />
    </svg>
  );
};

/** A row's mark at the given size class (28 px by default), hidden from assistive tech. */
export const EntryMark: React.FC<{ mark: StudioEntryRow['mark']; className?: string }> = ({ mark, className = 'size-7' }) =>
  mark === 'chat' ? <ChatTile className={className} /> : <StudioMark studio={mark} className={`${className} shrink-0`} />;

export interface SiteEntriesInput {
  isAdmin: boolean;
  currentView?: string;
  onGoHome: () => void;
  onEnterStudio: () => void;
  onViewComics: () => void;
  onNavigate: (view: string, id?: string) => void;
  /** The "tell me when it opens" capture, for a confined account without Stream Studio. */
  onNotify: () => void;
}

export interface SiteEntries {
  studios: StudioEntryRow[];
  pages: SiteEntry<PageEntryId>[];
}

/** The studio rows and the public pages for this account and page. */
export function useSiteEntries({ isAdmin, currentView, onGoHome, onEnterStudio, onViewComics, onNavigate, onNotify }: SiteEntriesInput): SiteEntries {
  // null = unrestricted → every studio.
  const allowed = useProductAccess();
  const confined = !isAdmin && allowed !== null;
  const showComic = !confined || allowed!.has('comic_studio');
  const showChat = !confined || allowed!.has('chat_studio');
  const showStream = !confined || allowed!.has('stream_studio');
  // Comic Studio's own address, offered on the production main site only. A separate host is a separate
  // sign-in, so the in-app Comic Studio row stays for people signed in here.
  const comicsAppHref = comicsEntryUrl();

  const studios: StudioEntryRow[] = [
    {
      id: 'dreamstream',
      mark: 'dreamstream',
      label: 'DreamStream Studio',
      description: 'The home of every studio',
      href: HOME_HREF,
      onClick: onGoHome,
      current: currentView === 'home'
    },
    ...(showComic
      ? [
          {
            id: 'comic' as const,
            mark: 'comic' as const,
            label: 'Comic Studio',
            description: 'Turn a script into a finished comic',
            href: COMIC_STUDIO_HREF,
            onClick: onEnterStudio,
            current: currentView === 'dashboard'
          },
          ...(comicsAppHref
            ? [
                {
                  id: 'comics-app' as const,
                  mark: 'comic' as const,
                  label: 'Comic Studio app',
                  description: 'Its own home at comics.dreamstreamstudio.ai',
                  href: comicsAppHref,
                  external: true
                }
              ]
            : [])
        ]
      : []),
    ...(showChat
      ? [
          {
            id: 'chat' as const,
            mark: 'chat' as const,
            label: 'Chat Studio',
            description: 'Chat with leading AI models',
            href: CHAT_HREF,
            onClick: () => onNavigate('chat'),
            current: currentView === 'chat'
          }
        ]
      : []),
    showStream
      ? {
          id: 'stream',
          mark: 'stream',
          label: 'Stream Studio',
          description: 'Live events, baby monitor and family calls',
          href: liveAppUrl('/live.html'),
          // Signed in, the crossing can wait on the server for a hand-off: the row says so meanwhile.
          onClick: () => openLiveApp('/live.html'),
          busyLabel: 'Opening Stream Studio…'
        }
      : {
          id: 'stream',
          mark: 'stream',
          label: 'Stream Studio',
          description: 'Get told when it opens for you',
          href: HOME_HREF,
          onClick: onNotify,
          badge: 'Soon'
        },
    {
      id: 'atlas',
      mark: 'atlas',
      label: 'Atlas Studio',
      description: 'One search across your connected accounts',
      href: ATLAS_STUDIO_URL,
      external: true
    }
  ];

  const pages: SiteEntry<PageEntryId>[] = [
    ...(showComic
      ? [
          { id: 'how-it-works' as const, label: 'How it works', href: HOW_IT_WORKS_HREF, onClick: () => onNavigate('how-it-works'), current: currentView === 'how-it-works' },
          { id: 'gallery' as const, label: 'Library', href: LIBRARY_HREF, onClick: onViewComics, current: currentView === 'gallery' }
        ]
      : []),
    { id: 'models', label: 'Models', href: MODELS_HREF, onClick: () => onNavigate('models'), current: currentView === 'models' }
  ];

  return { studios, pages };
}
