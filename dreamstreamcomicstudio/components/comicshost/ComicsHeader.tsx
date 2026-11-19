import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Menu as MenuIcon, X } from 'lucide-react';
import type { ComicsHeaderCurrent } from './hostRouting';
import { cn } from '../../lib/utils';
import { ARROW_NUDGE, DENSITY, FOCUS_RING, OVERLAY, RADIUS_CONTROL, RADIUS_ROUND } from '../chat/studioDesign';
import { AppearanceButton, AppearanceSegmented } from '../account/AppearanceControl';
import { AccountMenu } from '../account/AccountMenu';
import { AppHeader } from '../ds/AppHeader';
import { Button } from '../ds/Button';
import { IconButton } from '../ds/IconButton';
import { BrandLockup } from '../layout/BrandLockup';
import { ComicsMark } from './ComicsMark';
import './comicsShell.css';

export type ComicsSectionId = 'features' | 'looks' | 'models' | 'pricing';

/** The landing's in-page links, in page order (the header's nav from expanded and its menu below that). */
const SECTION_LINKS: ReadonlyArray<{ id: ComicsSectionId; label: string }> = [
  { id: 'features', label: 'Features' },
  { id: 'looks', label: 'Looks' },
  { id: 'models', label: 'Models' },
  { id: 'pricing', label: 'Pricing' }
];

export interface ComicsHeaderProps {
  signedIn: boolean;
  /** 'home' shows the in-page section links; 'other' (sign-in, Privacy, Terms, Library) shows the Library only. */
  page: 'home' | 'other';
  /** On `page="other"`, the view under the header: 'auth' hides "Sign in" and "Register interest", 'gallery' marks the Library link. */
  current?: ComicsHeaderCurrent;
  onGoHome: () => void;
  onSignIn: () => void;
  /** Signed out: on the landing, its "Register your interest" section; elsewhere, the sign-in card's Register interest tab. */
  onRequestAccess: () => void;
  onOpenComics: () => void;
  // Signed in, the header's AccountMenu opens Settings through components/account/accountNav.ts, which App answers with
  // the page as Back's destination (navtheme NT-2a): the header takes no account handler of its own.
  onBrowseGallery: () => void;
  onShowSection?: (id: ComicsSectionId) => void;
}

/** The header's text links (the lg nav): muted, ink on hover and when it is the current page, the underline draws in. */
const NAV_LINK = cn(
  'ds-link inline-flex items-center justify-center text-[length:var(--ds-text-base)] text-[var(--ds-muted)] hover:text-[var(--ds-ink)] aria-[current=page]:text-[var(--ds-ink)]',
  RADIUS_CONTROL,
  DENSITY.coarseSquare,
  FOCUS_RING
);
/** A row in the phone menu. */
const MENU_ROW = cn(
  'flex w-full items-center px-3 py-2.5 text-left text-[length:var(--ds-text-base)] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-overlay-hover)]',
  RADIUS_CONTROL,
  DENSITY.coarse,
  FOCUS_RING
);

interface MenuEntry {
  label: string;
  run: () => void;
  /** A hairline above it (the access row after the links). */
  separated?: boolean;
  current?: boolean;
  /** Classes on the row's item (show/hide by width). */
  className?: string;
}

export const ComicsHeader: React.FC<ComicsHeaderProps> = ({
  signedIn,
  page,
  current = 'other',
  onGoHome,
  onSignIn,
  onRequestAccess,
  onOpenComics,
  onBrowseGallery,
  onShowSection
}) => {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const headerRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sections = page === 'home' && !!onShowSection;
  const home = page === 'home';
  const onLibrary = !home && current === 'gallery';
  const onSignInPage = !home && current === 'auth';

  // Close on Esc (focus back to the trigger) and on a press outside the header. Listeners only while open.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onPress = (e: PointerEvent) => {
      if (headerRef.current && e.target instanceof Node && !headerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPress);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPress);
    };
  }, [open]);

  const choose = (run: () => void) => () => {
    setOpen(false);
    run();
  };

  const menu: MenuEntry[] = [
    ...(!home ? [{ label: 'Home', run: onGoHome }] : []),
    ...(sections ? SECTION_LINKS.map((link) => ({ label: link.label, run: () => onShowSection!(link.id) })) : []),
    { label: 'Library', run: onBrowseGallery, current: onLibrary },
    ...(signedIn
      ? // Below 600 the header's My comics steps aside (comicsShell.css), so the menu carries it there and only there.
        [{ label: 'My comics', run: onOpenComics, separated: true, className: 'medium:hidden' }]
      : onSignInPage
        ? [] // the sign-in card itself switches between Sign in and Register interest
        : [{ label: 'Register interest', run: onRequestAccess, separated: true }])
  ];

  const brand = (
    <BrandLockup mark={<ComicsMark size={28} />} name="Comic" suffix="Studio" suffixAlways label="Comic Studio, home" onClick={onGoHome} />
  );

  // From lg: the section links on the landing, and the Library on every page (marked when it is the page).
  const nav = (
    <nav aria-label="Comic Studio" className="comics-header-nav hidden items-center gap-7 expanded:flex">
      {!home && (
        <button type="button" className={cn(NAV_LINK, 'gap-1.5')} onClick={onGoHome}>
          <ArrowLeft size={16} aria-hidden />
          Home
        </button>
      )}
      {sections &&
        SECTION_LINKS.map((link) => (
          <button key={link.id} type="button" className={NAV_LINK} onClick={() => onShowSection!(link.id)}>
            {link.label}
          </button>
        ))}
      <button
        type="button"
        aria-current={onLibrary ? 'page' : undefined}
        className={NAV_LINK}
        onClick={onBrowseGallery}
      >
        Library
      </button>
    </nav>
  );

  const actions = (
    <>
      {/* One overlay at a time: opening Appearance closes the menu (a press on the menu trigger closes Appearance, as
          any press outside it does). Signed in, Appearance lives in the account menu instead. */}
      {!signedIn && <AppearanceButton paper wrapperClassName="comics-header-theme" onOpenChange={(opened) => opened && setOpen(false)} />}
      {signedIn ? (
        <Button variant={home ? 'outline' : 'default'} className={cn(RADIUS_ROUND, 'comics-header-entry comics-header-my-comics', !home && 'comics-primary-action')} onClick={onOpenComics}>
          My comics
        </Button>
      ) : (
        <>
          {/* Not on the sign-in page: its card already switches to Register interest (pressing this there remounted the
              card and wiped what was typed). */}
          {!home && !onSignInPage && (
            <Button variant="ghost" className={cn(RADIUS_ROUND, 'hidden expanded:inline-flex')} onClick={onRequestAccess}>
              Register interest
            </Button>
          )}
          {/* The landing's join action stays one press away once the hero has scrolled off: a ghost, never a fill (the
              hero's button is the page's one filled action). Below lg the menu carries the same row. */}
          {home && (
            <Button variant="ghost" className={cn(RADIUS_ROUND, 'comics-header-register hidden lg:inline-flex')} onClick={onRequestAccess}>
              Register interest
            </Button>
          )}
          {onSignInPage ? null : (
            <Button variant={home ? 'outline' : 'default'} className={cn(RADIUS_ROUND, 'comics-header-entry group', !home && 'comics-primary-action')} onClick={onSignIn}>
              Sign in
              <ArrowRight aria-hidden className={cn('hidden medium:block', ARROW_NUDGE)} />
            </Button>
          )}
        </>
      )}
      <IconButton
        ref={triggerRef}
        label="Menu"
        variant="ghost"
        aria-expanded={open}
        aria-controls={menuId}
        className={cn(RADIUS_ROUND, 'comics-header-menu-toggle border border-[var(--ds-hairline)] expanded:hidden')}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <X aria-hidden /> : <MenuIcon aria-hidden />}
      </IconButton>
      {/* The account menu at the right end (navtheme NT-2a): the same one as the New comic frame's. */}
      {signedIn && <AccountMenu paper onOpenChange={(opened) => opened && setOpen(false)} />}
    </>
  );

  return (
    <AppHeader ref={headerRef} brand={brand} nav={nav} actions={actions} className="comics-header" innerClassName="comics-shell-width">
      <div className="comics-shell-width pointer-events-none absolute inset-x-0 top-full flex justify-end expanded:hidden">
        <div id={menuId} hidden={!open} data-slot="comics-menu" className={cn(OVERLAY, 'comics-header-menu ds-scale-in pointer-events-auto mt-2 w-72 origin-top-right p-1')}>
          <ul className="flex flex-col">
            {menu.map((entry) => (
              <li key={entry.label} className={cn(entry.separated && 'mt-1 border-t border-[var(--ds-hairline)] pt-1', entry.className)}>
                <button type="button" aria-current={entry.current ? 'page' : undefined} className={MENU_ROW} onClick={choose(entry.run)}>
                  {entry.label}
                </button>
              </li>
            ))}
            {/* Signed out, below 600 the header's Appearance button steps aside (comicsShell.css) and the choice lives
                here; it stays open while the person compares the looks. Signed in, the account menu holds it. */}
            {!signedIn && (
              <li className="comics-header-menu-theme mt-1 border-t border-[var(--ds-hairline)] px-2 pb-2 pt-2">
                <p aria-hidden="true" className="mb-2 text-[length:var(--ds-text-sm)] font-medium text-[var(--ds-muted)]">Appearance</p>
                <AppearanceSegmented paper fullWidth size="sm" />
              </li>
            )}
          </ul>
        </div>
      </div>
    </AppHeader>
  );
};

export default ComicsHeader;
