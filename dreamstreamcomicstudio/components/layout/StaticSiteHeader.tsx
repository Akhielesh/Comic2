import React, { useEffect, useId, useRef, useState } from 'react';
import { Bot, Mail, Sparkles, BookOpen, Compass, Palette, LayoutGrid, MessageSquare, Cpu, Menu, X, Radio, ExternalLink } from 'lucide-react';
import { cn } from '../../lib/utils';
import { DENSITY, FOCUS_RING, NAV_ROW, OVERLINE, SEGMENTED_TRACK } from '../chat/studioDesign';
import { AppHeader, HEADER_INNER } from '../ds/AppHeader';
import { Button } from '../ds/Button';
import { IconButton } from '../ds/IconButton';
import { BrandLockup } from './BrandLockup';
import { NavDropdown } from './NavDropdown';
import { NotificationBell } from '../NotificationBell';
import { UserAvatar } from '../UserAvatar';
import { TokenAvailabilityPill } from '../TokenAvailabilityPill';
import { useProductAccess } from '../../services/productAccess';
import { comicsEntryUrl } from '../../services/productHost';
import { openLiveApp } from '../../services/liveLink';

interface StaticSiteHeaderProps {
  isAuthenticated: boolean;
  /** Admins are never confined to specific studios (product_access). */
  isAdmin?: boolean;
  currentView?: string;
  onGoHome: () => void;
  onViewComics: () => void;
  onEnterStudio: () => void;
  onSignIn: () => void;
  onRequestAccess?: () => void;
  /** Jump to the "stay updated" capture (used by the Live "coming soon" product). */
  onNotify?: () => void;
  onOpenProfile: () => void;
  onNavigate: (view: string, id?: string) => void;
}

/** The announcement line above the home page's header row: quiet well, muted words, the ink link. */
export const ANNOUNCEMENT = 'border-b border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] px-4 py-1 text-center text-xs leading-5 text-[var(--ds-muted)]';
export const ANNOUNCEMENT_LINK = `inline-flex items-center rounded-[var(--ds-radius-sm,0.25rem)] font-medium text-[var(--ds-ink)] underline underline-offset-4 hover:no-underline ${DENSITY.coarse}`;
/** The phone menu toggle: 44 px square below the desktop breakpoint, at every pointer. */
export const MENU_TOGGLE = 'size-11 lg:hidden';
/** A row of the phone menu: the nav row recipe, 44 px under a coarse pointer. */
export const MENU_ROW = `${NAV_ROW} text-[length:var(--ds-text-base)] ${DENSITY.coarse}`;

/**
 * The site header on every page outside the studio and the readers (Atlas chrome; master plan D3: Atlas
 * chrome with the comic art as the page's hero, never in the chrome). Built on the shared AppHeader: sticky,
 * plain at rest and frosted once the page scrolls under it. Wide screens get the products in a nav track
 * (each with its hover menu); below 1024 px a 44 px toggle opens the same products as a menu inside the
 * header, which Escape closes.
 */
export const StaticSiteHeader: React.FC<StaticSiteHeaderProps> = ({
  isAuthenticated,
  isAdmin = false,
  currentView,
  onGoHome,
  onViewComics,
  onEnterStudio,
  onSignIn,
  onRequestAccess,
  onNotify,
  onOpenProfile,
  onNavigate,
}) => {
  const isHome = currentView === 'home';
  const notify = onNotify ?? (() => onNavigate('home'));
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  // Run an action then close the mobile menu.
  const go = (fn: () => void) => () => { fn(); setMobileOpen(false); };

  useEffect(() => {
    if (!mobileOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMobileOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  // Per-account studio confinement (product_access): null = unrestricted → show all.
  // Confined accounts only see the product groups in their active set (admins are never
  // gated; marketing pages and the Models catalog stay visible to everyone).
  const allowedProducts = useProductAccess();
  const confined = !isAdmin && allowedProducts !== null;
  const showComic = !confined || allowedProducts!.has('comic_studio');
  const showChat = !confined || allowedProducts!.has('chat_studio');
  const showLive = !confined || allowedProducts!.has('stream_studio');
  // Comic Studio's own address (comics.dreamstreamstudio.ai) — offered on the production main site only.
  // Separate host = separate sign-in, so the in-app "Studio" entry stays for signed-in people.
  const comicsAppHref = comicsEntryUrl();
  const openComicsApp = () => { if (comicsAppHref) window.location.href = comicsAppHref; };

  // Same products as the desktop nav, flattened for the mobile menu (<1024px).
  const mobileGroups: { heading: string; items: { label: string; onClick: () => void }[] }[] = [
    ...(showComic ? [{ heading: 'Comic', items: [
      { label: 'How It Works', onClick: () => onNavigate('how-it-works') },
      { label: 'Comic Studio', onClick: onEnterStudio },
      { label: 'Library', onClick: onViewComics },
      ...(comicsAppHref ? [{ label: 'Comic Studio app', onClick: openComicsApp }] : []),
    ] }] : []),
    ...(showChat ? [{ heading: 'Chat Studio', items: [
      { label: 'Open Chat Studio', onClick: () => onNavigate('chat') },
      { label: 'Model Catalog', onClick: () => onNavigate('models') },
    ] }] : []),
    { heading: 'Live', items: showLive
      ? [{ label: 'Open Stream Studio', onClick: () => { void openLiveApp('/live.html'); } }]
      : [{ label: 'Get notified', onClick: notify }] },
    { heading: 'Models', items: [
      { label: 'Browse Models', onClick: () => onNavigate('models') },
    ] },
  ];

  // Announcement banner — home page only.
  const banner = isHome ? (
    <div data-slot="announcement" className={ANNOUNCEMENT}>
      <p className="m-0 inline-flex flex-wrap items-center justify-center gap-x-2">
        <Sparkles size={12} aria-hidden="true" className="shrink-0" />
        Chat Studio is live — converse with Claude, Gemini &amp; 100+ models
        <button type="button" onClick={() => onNavigate('chat')} className={`${ANNOUNCEMENT_LINK} ${FOCUS_RING}`}>
          Try it free →
        </button>
      </p>
    </div>
  ) : null;

  // Centre nav — desktop only (≥1024px). The four products, each with its own hover menu.
  const nav = (
    <nav aria-label="Products" className={cn(SEGMENTED_TRACK, 'hidden items-center lg:flex')}>
      {showComic && (
        <NavDropdown
          label="Comic"
          icon={<BookOpen size={14} aria-hidden="true" />}
          items={[
            { label: 'How It Works', description: 'The 8-step studio workflow', icon: <Compass size={16} />, onClick: () => onNavigate('how-it-works') },
            { label: 'Studio', description: 'Turn your script into a comic', icon: <Palette size={16} />, onClick: onEnterStudio },
            { label: 'Library', description: 'Browse public comics from creators', icon: <LayoutGrid size={16} />, onClick: onViewComics },
            ...(comicsAppHref
              ? [{ label: 'Comic Studio', description: 'Its own home at comics.dreamstreamstudio.ai', icon: <ExternalLink size={16} />, onClick: openComicsApp }]
              : []),
          ]}
        />
      )}
      {showChat && (
        <NavDropdown
          label="Chat Studio"
          icon={<Bot size={14} aria-hidden="true" />}
          items={[
            { label: 'Open Chat Studio', description: 'Chat with Claude, Gemini & 100+ models', icon: <MessageSquare size={16} />, onClick: () => onNavigate('chat') },
            { label: 'Model Catalog', description: 'Compare every available model', icon: <Cpu size={16} />, onClick: () => onNavigate('models') },
          ]}
        />
      )}
      {showLive ? (
        <NavDropdown
          label="Live"
          icon={<Radio size={14} aria-hidden="true" />}
          items={[
            { label: 'Open Stream Studio', description: 'Go live from your camera — chat, lobby & recording', icon: <Radio size={16} />, onClick: () => { void openLiveApp('/live.html'); } },
          ]}
        />
      ) : (
        <NavDropdown
          label="Live"
          icon={<Radio size={14} aria-hidden="true" />}
          variant="muted"
          badge="Coming soon"
          caption="In the workshop"
          items={[
            { label: 'Get notified', description: 'Be first to know when Live launches', icon: <Mail size={16} />, onClick: notify },
          ]}
        />
      )}
      <NavDropdown
        label="Models"
        icon={<Cpu size={14} aria-hidden="true" />}
        items={[
          { label: 'Browse Models', description: 'Specs, pricing & benchmarks', icon: <Cpu size={16} />, onClick: () => onNavigate('models') },
          { label: 'Use in Chat Studio', description: 'Start a conversation with any model', icon: <MessageSquare size={16} />, onClick: () => onNavigate('chat') },
        ]}
      />
    </nav>
  );

  // Auth controls, then the phone menu toggle (<1024px) at the thumb's edge.
  const actions = (
    <>
      {isAuthenticated ? (
        <>
          <div className="hidden sm:block">
            <TokenAvailabilityPill />
          </div>
          <NotificationBell onNavigate={onNavigate} />
          <button
            type="button"
            onClick={onOpenProfile}
            aria-label="Your profile and settings"
            data-slot="profile-button"
            className={`${cn('inline-flex shrink-0 items-center justify-center rounded-full', DENSITY.coarseSquare)} ${FOCUS_RING}`}
          >
            <UserAvatar />
          </button>
        </>
      ) : (
        <>
          <Button variant="ghost" size="sm" onClick={onSignIn} className="hidden sm:inline-flex">
            Sign In
          </Button>
          {/* New signups are invite-only — collect interest instead of opening registration.
              Compact label on phones so the header never overflows a ~360px viewport. */}
          <Button size="sm" onClick={onRequestAccess ?? onSignIn}>
            <Mail aria-hidden="true" />
            <span className="hidden sm:inline">Request Access</span>
            <span className="sm:hidden">Join</span>
          </Button>
        </>
      )}
      <IconButton
        ref={toggleRef}
        label={mobileOpen ? 'Close menu' : 'Open menu'}
        title={null}
        onClick={() => setMobileOpen((o) => !o)}
        aria-expanded={mobileOpen}
        aria-controls={mobileOpen ? menuId : undefined}
        // A hook, not a slot: IconButton owns data-slot ("icon-button") and writes it after the props.
        data-menu-toggle=""
        className={MENU_TOGGLE}
      >
        {mobileOpen ? <X size={20} /> : <Menu size={20} />}
      </IconButton>
    </>
  );

  return (
    <AppHeader brand={<BrandLockup onClick={onGoHome} />} nav={nav} actions={actions} banner={banner}>
      {/* Mobile product menu (<1024px) — restores the nav that the desktop bar hides. */}
      {mobileOpen && (
        <div id={menuId} data-slot="site-menu" className="max-h-[75vh] overflow-auto border-t border-[var(--ds-hairline)] bg-[var(--ds-canvas)] lg:hidden">
          <nav aria-label="Menu" className={cn(HEADER_INNER, 'space-y-3 py-3')}>
            {mobileGroups.map((g) => (
              <div key={g.heading}>
                <p className={cn('m-0 px-2.5', OVERLINE)}>{g.heading}</p>
                <div className="mt-1 grid">
                  {g.items.map((it) => (
                    <button key={it.label} type="button" onClick={go(it.onClick)} className={`${MENU_ROW} ${FOCUS_RING}`}>
                      {it.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {!isAuthenticated && (
              <button type="button" onClick={go(onSignIn)} className={`${MENU_ROW} ${FOCUS_RING}`}>
                Sign In
              </button>
            )}
          </nav>
        </div>
      )}
    </AppHeader>
  );
};
