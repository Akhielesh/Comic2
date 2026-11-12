// The comics host's header: the same object as the app and studio headers (AppHeader — the --header-h row,
// the HEADER_INNER column and gutters, the glass that frosts once the page scrolls under it, the Z.header
// layer), with Comic Studio's lockup (the ink ComicsMark, "Comic Studio" on one line, a Beta chip). The landing
// shows its section links (How it works, Looks) and the Library from `lg` up; the sign-in, Privacy, Terms and
// Library views (signed out) use it with `page="other"`, where the lg nav keeps the Library, so every click off the
// landing stays in one product. The header owns its ink (AppHeader), so its labels and icons read in both themes
// whatever page sits under it.
//
// One fill per view (Ink & Spark): on the landing the hero carries the one filled call to action, so the header's
// "Sign in" / "My comics" is outline there; elsewhere it is the page's filled action. On the sign-in page itself the
// header offers no "Sign in".
//
// Below `lg` the links move into a menu: a disclosure under the trigger (aria-expanded / aria-controls), closed
// by choosing a row, Esc (focus returns to the trigger) or a press outside. It is drawn on the overlay recipe and
// enters with the shared scale-in (none under reduced motion). Every target is 44 px under a coarse pointer.

import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, Menu as MenuIcon, X } from 'lucide-react';
import type { ComicsHeaderCurrent } from './hostRouting';
import { cn } from '../../lib/utils';
import { ARROW_NUDGE, DENSITY, FOCUS_RING, OVERLAY, OVERLINE, RADIUS_CONTROL, RADIUS_ROUND } from '../chat/studioDesign';
import { AppHeader, HEADER_INNER } from '../ds/AppHeader';
import { Button } from '../ds/Button';
import { IconButton } from '../ds/IconButton';
import { BrandLockup } from '../layout/BrandLockup';
import { ComicsMark } from './ComicsMark';

export type ComicsSectionId = 'how-it-works' | 'looks';

export interface ComicsHeaderProps {
  signedIn: boolean;
  /** 'home' shows the in-page section links; 'other' (sign-in, Privacy, Terms, Library) shows the Library only. */
  page: 'home' | 'other';
  /** On `page="other"`, the view under the header: 'auth' hides "Sign in", 'gallery' marks the Library link. */
  current?: ComicsHeaderCurrent;
  onGoHome: () => void;
  onSignIn: () => void;
  onRequestAccess: () => void;
  onOpenComics: () => void;
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
    ...(sections
      ? [
          { label: 'How it works', run: () => onShowSection!('how-it-works') },
          { label: 'Looks', run: () => onShowSection!('looks') }
        ]
      : []),
    { label: 'Library', run: onBrowseGallery },
    ...(signedIn ? [] : [{ label: 'Request access', run: onRequestAccess, separated: true }])
  ];

  const brand = (
    <>
      <BrandLockup mark={<ComicsMark size={28} />} name="Comic" suffix="Studio" suffixAlways label="Comic Studio, home" onClick={onGoHome} />
      <span className={cn(OVERLINE, RADIUS_ROUND, 'hidden border border-[var(--ds-hairline)] px-2 py-0.5 medium:inline-flex')}>Beta</span>
    </>
  );

  // From lg: the section links on the landing, and the Library on every page (marked when it is the page).
  const nav = (
    <nav aria-label="Comic Studio" className="hidden items-center gap-7 lg:flex">
      {sections && (
        <>
          <button type="button" className={NAV_LINK} onClick={() => onShowSection!('how-it-works')}>
            How it works
          </button>
          <button type="button" className={NAV_LINK} onClick={() => onShowSection!('looks')}>
            Looks
          </button>
        </>
      )}
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
      {signedIn ? (
        <Button variant={home ? 'outline' : 'default'} className={RADIUS_ROUND} onClick={onOpenComics}>
          My comics
        </Button>
      ) : (
        <>
          <Button variant="ghost" className={cn(RADIUS_ROUND, 'hidden lg:inline-flex')} onClick={onRequestAccess}>
            Request access
          </Button>
          {onSignInPage ? null : (
            <Button variant={home ? 'outline' : 'default'} className={cn(RADIUS_ROUND, 'group')} onClick={onSignIn}>
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
        className={cn(RADIUS_ROUND, 'border border-[var(--ds-hairline)] lg:hidden')}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <X aria-hidden /> : <MenuIcon aria-hidden />}
      </IconButton>
    </>
  );

  return (
    <AppHeader ref={headerRef} brand={brand} nav={nav} actions={actions}>
      <div className={cn(HEADER_INNER, 'pointer-events-none absolute inset-x-0 top-full flex justify-end lg:hidden')}>
        <div id={menuId} hidden={!open} data-slot="comics-menu" className={cn(OVERLAY, 'ds-scale-in pointer-events-auto mt-2 w-60 origin-top-right p-1')}>
          <ul className="flex flex-col">
            {menu.map((entry) => (
              <li key={entry.label} className={cn(entry.separated && 'mt-1 border-t border-[var(--ds-hairline)] pt-1')}>
                <button type="button" className={MENU_ROW} onClick={choose(entry.run)}>
                  {entry.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </AppHeader>
  );
};

export default ComicsHeader;
