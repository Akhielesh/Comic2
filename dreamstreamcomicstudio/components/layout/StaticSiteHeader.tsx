import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, Menu, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { FOCUS_RING, HEADER_GLASS, STICKY_HEADER, Z } from '../chat/studioDesign';
import { buttonClasses, IconButton } from '../ds';
import { NotificationBell } from '../NotificationBell';
import { UserAvatar } from '../UserAvatar';
import { TokenAvailabilityPill } from '../TokenAvailabilityPill';
import { BrandLockup } from './BrandLockup';
import { MobileMenu } from './MobileMenu';
import { NavDropdown } from './NavDropdown';
import { EntryMark, useSiteEntries, type SiteEntry } from './studioEntries';
import { isPlainClick } from './siteLinks';
import { ThemeToggle } from './ThemeControls';
import { useDismiss } from './useDismiss';
import { DESKTOP_NAV_QUERY, useMediaQuery } from './useMediaQuery';

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
  /** Jump to the "stay updated" capture (a confined account's Stream Studio "Soon" row). */
  onNotify?: () => void;
  onOpenProfile: () => void;
  onNavigate: (view: string, id?: string) => void;
}

/** One public page in the desktop row: a real link with Atlas's drawn underline, held under the page on screen. */
const NavLink: React.FC<{ entry: SiteEntry }> = ({ entry }) => (
  <a
    href={entry.href}
    aria-current={entry.current ? 'page' : undefined}
    onClick={(e) => {
      if (!entry.onClick || !isPlainClick(e)) return;
      e.preventDefault();
      void entry.onClick();
    }}
    className={cn(
      'ds-link rounded-[var(--ds-radius-control)] bg-origin-content px-2.5 py-1.5 text-sm transition-colors duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)]',
      FOCUS_RING,
      entry.current ? 'font-medium text-ds-ink [background-size:100%_1px]' : 'text-ds-muted hover:text-ds-ink'
    )}
  >
    {entry.label}
  </a>
);

/**
 * The shared site header (Atlas PublicSiteChrome on the DreamStream tokens): sticky, 64 px, the page colour at
 * rest and frosted with the one header blur once content scrolls under it (STICKY_HEADER + HEADER_GLASS).
 *
 * - Left: the DreamStream lockup (home).
 * - Desktop (≥ 1024 px): "Studios", the studio switcher (DreamStream, Comic, Chat, Stream and Atlas Studio,
 *   each with its mark), then How it works, Library and Models.
 * - Right: the theme toggle (≥ 640 px), then the account (credits, notifications, avatar) or, signed out,
 *   "Sign in" and the ink "Request access" pill (phones keep one pill, "Sign in"); below 1024 px the menu
 *   button opens the same places in one panel (MobileMenu).
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
  onNavigate
}) => {
  const requestAccess = onRequestAccess ?? onSignIn;
  const notify = onNotify ?? (() => onNavigate('home'));
  const entries = useSiteEntries({ isAdmin, currentView, onGoHome, onEnterStudio, onViewComics, onNavigate, onNotify: notify });

  const headerRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuPanelRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const desktop = useMediaQuery(DESKTOP_NAV_QUERY);

  // Frosted only once something scrolls under it (Atlas's app header): at the top it is the plain page.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 2);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const closeMenu = useCallback((returnFocus = false) => {
    setMenuOpen(false);
    if (returnFocus) menuButtonRef.current?.focus();
  }, []);
  useDismiss(menuOpen, (reason) => closeMenu(reason === 'escape'), [headerRef]);
  // The desktop row replaces the menu: a window widened past it closes the panel.
  useEffect(() => {
    if (desktop) setMenuOpen(false);
  }, [desktop]);
  // While the panel is open the page under it does not scroll.
  useEffect(() => {
    if (!menuOpen) return;
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = previous;
    };
  }, [menuOpen]);
  // A page change (Back, a link elsewhere) closes it too.
  useEffect(() => setMenuOpen(false), [currentView]);

  const studiosActive = entries.studios.some((s) => s.current);

  return (
    <header
      ref={headerRef}
      // While the phone menu is open the header (with its scrim and panel) rises to the popover layer, above the
      // page's own fixed bars (the Feedback pill, the catalog's compare tray).
      className={cn(STICKY_HEADER, menuOpen && Z.popover, 'text-ds-ink')}
      data-scrolled={scrolled ? 'true' : undefined}
    >
      <div aria-hidden="true" className={HEADER_GLASS} />
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-2 px-4 sm:px-6">
        <BrandLockup onClick={onGoHome} compactOnPhone />

        <nav aria-label="Main" className="ml-6 hidden items-center gap-1 lg:flex">
          <NavDropdown
            label="Studios"
            align="start"
            active={studiosActive}
            panelClassName="w-[22rem]"
            items={entries.studios.map((s) => ({
              label: s.label,
              description: s.description,
              icon: <EntryMark mark={s.mark} className="mt-0.5 size-7" />,
              href: s.href,
              onClick: s.onClick,
              external: s.external,
              current: s.current,
              badge: s.badge,
              busyLabel: s.busyLabel,
              separated: s.id === 'atlas'
            }))}
          />
          {entries.pages.map((page) => (
            <NavLink key={page.id} entry={page} />
          ))}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
          <ThemeToggle className="hidden sm:inline-flex" />
          {isAuthenticated ? (
            <>
              <div className="hidden sm:block">
                <TokenAvailabilityPill />
              </div>
              <NotificationBell onNavigate={onNavigate} />
              <UserAvatar onClick={onOpenProfile} />
            </>
          ) : (
            <>
              <button type="button" onClick={onSignIn} className={buttonClasses({ variant: 'ghost', className: 'hidden rounded-full sm:inline-flex' })}>
                Sign in
              </button>
              {/* New sign-ups are invite-only: the pill asks for access. Phones keep the one pill, Sign in;
                  Request access is in the menu there. */}
              <button type="button" onClick={requestAccess} className={buttonClasses({ className: 'group hidden rounded-full sm:inline-flex' })}>
                Request access
                <ArrowRight aria-hidden="true" className="size-3.5 transition-transform duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)] motion-safe:group-hover:translate-x-0.5" />
              </button>
              <button type="button" onClick={onSignIn} className={buttonClasses({ className: 'rounded-full px-3.5 sm:hidden' })}>
                Sign in
              </button>
            </>
          )}
          <IconButton
            ref={menuButtonRef}
            label={menuOpen ? 'Close menu' : 'Open menu'}
            title={null}
            variant="outline"
            size="lg"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            onClick={() => setMenuOpen((open) => !open)}
            className="rounded-full lg:hidden"
          >
            {menuOpen ? <X className="size-4" /> : <Menu className="size-4" />}
          </IconButton>
        </div>
      </div>

      {menuOpen ? (
        <MobileMenu
          id={menuId}
          entries={entries}
          isAuthenticated={isAuthenticated}
          onSignIn={onSignIn}
          onRequestAccess={requestAccess}
          onClose={() => closeMenu()}
          panelRef={menuPanelRef}
        />
      ) : null}
    </header>
  );
};
