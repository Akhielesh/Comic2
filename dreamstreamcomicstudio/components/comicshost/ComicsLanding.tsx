// The front page of comics.dreamstreamstudio.ai: Comic Studio's own landing and sign-in entry, in the Atlas
// public composition (design values only, from Atlas's public page: a centred hero over a dot grid, the product
// proof, a band, a steps rail, a bento, an inverse panel, a three-column footer) on the DreamStream tokens and
// recipes, with the colour layer "Ink, Paper & Colour": text stays ink on paper; the hero carries the one hero wash
// (magenta, ultramarine and orange, full bleed behind the headline and the calls to action, down to the drawn
// pages); the four feature tiles are solid 56 px tiles in ink, magenta, leaf and sky with one label colour (no
// ultramarine tile, so the one blue "Start creating" keeps its meaning); the spark is only on that one creation call to action (signed out; none signed in). Every
// colour reads a token, so VITE_DS_COLOUR=off (a build-time switch) turns the wash off and the tiles neutral.
//
// The header is ComicsHeader (the app's AppHeader, the same object and height as the studio's header). The proof
// is a replica of the studio's own screen (StudioPreview: the Director's plan card beside drawn pages) and every
// comic page is ComicPageSpecimen — the library's procedural art, bordered panels and real lettering — so the page
// shows the product instead of placeholders, with no image, no request and no timer. Sign-in itself is the app's
// AuthPage (onSignIn / onRequestAccess). Motion is the shared vocabulary (styles/ds-motion.css: the hero staggers
// in, the proof rises in, sections reveal on scroll, cards lift, arrows nudge), all of it still under reduced
// motion. No price, cost or model name anywhere on the page.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, BookOpen, Download, Link2, MessageSquareText, Printer, SlidersHorizontal, Users } from 'lucide-react';
import { cn } from '../../lib/utils';
import { mainAppUrl } from '../../services/productHost';
import {
  ARROW_NUDGE,
  CANVAS_BG,
  CTA_LG,
  DENSITY,
  DISPLAY_CARD_TITLE,
  DISPLAY_HERO,
  DISPLAY_SECTION,
  FOCUS_RING,
  FOCUS_RING_FLUSH,
  HUE_SOLID,
  INK_TILE,
  INVERSE_ACTION,
  INVERSE_ACTION_QUIET,
  INVERSE_SURFACE,
  LIFT,
  OVERLINE,
  OVERLINE_DISPLAY,
  PUBLIC_BODY,
  PUBLIC_LEAD,
  RADIUS_FEATURE,
  RADIUS_HERO,
  RADIUS_PANEL,
  RADIUS_ROUND,
  SHADOW_HERO,
  WASH_HERO
} from '../chat/studioDesign';
import { HEADER_INNER } from '../ds/AppHeader';
import { Button } from '../ds/Button';
import { prefersReducedMotion } from '../ds/useReducedMotion';
import { BrandLockup } from '../layout/BrandLockup';
import { CONTACT_HREF } from '../layout/LegalMicroLinks';
import { ComicPageSpecimen, SPECIMEN_LOOKS, specimenPreset } from './ComicPageSpecimen';
import { ComicsHeader, type ComicsSectionId } from './ComicsHeader';
import { ComicsMark } from './ComicsMark';
import { StudioPreview } from './StudioPreview';

export interface ComicsLandingProps {
  signedIn: boolean;
  /** "Start creating", the header's "Sign in" and the access panel's "Sign in". */
  onSignIn: () => void;
  /** The hero's second action, the header (lg), the menu, the access panel and the footer. */
  onRequestAccess: () => void;
  /** Signed in: the comics dashboard (hero, header "My comics", access panel, footer). */
  onOpenComics: () => void;
  /** The public Library, everywhere it is offered (and the signed-in hero's second action). */
  onBrowseGallery: () => void;
  onOpenPrivacy: () => void;
  onOpenTerms: () => void;
}

const STEPS: ReadonlyArray<{ title: string; body: string }> = [
  { title: 'Tell it the idea', body: 'Paste a script, an outline, notes or a single line. The Comic Director asks what matters.' },
  // The studio's own words (the Director's plan card). Never "nothing is drawn until you say so": small image runs
  // can start without a gate under the creator's confirm setting.
  { title: 'Agree the plan', body: 'Pages, cast, setting and look, settled together. Drawn pages are only redrawn when you ask.' },
  { title: 'Lock the look', body: 'Character sheets and a locked style keep faces and outfits the same from cover to last page.' },
  { title: 'Polish and share', body: 'Change panels and lettering in Easy or Pro, then read it, share a link or export it.' }
];

/**
 * The feature bento. Each card leads with a solid 56 px tile in its own colour (ink, magenta, leaf, sky: the landing's
 * four), an icon only on it (white in light, ink in dark; words on magenta and sky would fall under 4.5:1).
 */
const FEATURES: ReadonlyArray<{ icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>; tile: string; title: string; body: string }> = [
  {
    icon: Users,
    tile: INK_TILE,
    title: 'Characters that stay themselves',
    body: 'Reference sheets and a locked style keep faces, outfits and colours consistent from the cover to the last page.'
  },
  {
    icon: MessageSquareText,
    tile: HUE_SOLID[1],
    title: 'Lettering you control',
    body: 'Balloons, captions and sound effects are real text. Move, restyle or rewrite them without redrawing a panel.'
  },
  { icon: SlidersHorizontal, tile: HUE_SOLID[5], title: 'Easy or Pro', body: 'Talk it through in Easy, or switch to Pro for finer control of panels and lettering.' },
  // What the studio's own Reader tab offers (board/ReaderTab.tsx: Print, the PDF, the pages as images).
  { icon: Printer, tile: HUE_SOLID[6], title: 'Print it or keep it', body: 'When it’s finished, print it, save a PDF, or download the pages as images in one ZIP.' }
];

const PROMISES: ReadonlyArray<{ icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>; text: string }> = [
  { icon: BookOpen, text: 'A page-turning reader that fits phones, tablets and desktops.' },
  { icon: Link2, text: 'Share a read-only link, or list it in the Library.' },
  { icon: Download, text: 'Readers can download it only if you allow it.' }
];

/** A footer link: muted, ink on hover, the underline draws in; 44 px tall under a coarse pointer. */
const FOOTER_LINK = cn('ds-link inline-flex items-center text-left text-[var(--ds-muted)] hover:text-[var(--ds-ink)]', DENSITY.coarseSquare, FOCUS_RING);
/** The bottom bar's one way off the product, in ink. */
const FOOTER_LINK_INK = cn('ds-link inline-flex items-center text-[var(--ds-ink)]', DENSITY.coarseSquare, FOCUS_RING);
/** A section heading that section links move focus to (programmatic focus only: no ring on a heading). */
const FOCUS_TARGET = 'focus:outline-none';
const SECTION = 'scroll-mt-[var(--header-h)]';

/**
 * Whether a horizontal scroller really overflows, read on mount and whenever it or the window resizes (no timer, no
 * polling). The looks band is a tab stop only then: a region that does not scroll gives the keyboard nothing to do.
 */
const useOverflowsX = <T extends HTMLElement>(): [React.RefObject<T | null>, boolean] => {
  const ref = useRef<T>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window === 'undefined') return undefined;
    const read = () => setOverflows(el.scrollWidth - el.clientWidth > 1);
    read();
    window.addEventListener('resize', read);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    observer?.observe(el);
    return () => {
      window.removeEventListener('resize', read);
      observer?.disconnect();
    };
  }, []);
  return [ref, overflows];
};

export const ComicsLanding: React.FC<ComicsLandingProps> = ({
  signedIn,
  onSignIn,
  onRequestAccess,
  onOpenComics,
  onBrowseGallery,
  onOpenPrivacy,
  onOpenTerms
}) => {
  /** Scroll a section under the sticky header (smooth unless reduced motion), then move focus to its heading. */
  const showSection = useCallback((id: ComicsSectionId) => {
    const section = document.getElementById(id);
    if (!section) return;
    section.scrollIntoView?.({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    section.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  }, []);
  const [looksRef, looksOverflow] = useOverflowsX<HTMLDivElement>();
  const goTop = useCallback(() => {
    try {
      window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    } catch {
      /* no scrolling outside a browser */
    }
  }, []);

  return (
    <div data-testid="comics-landing" className={cn(CANVAS_BG, 'min-h-screen overflow-x-clip text-[var(--ds-ink)]')}>
      <ComicsHeader
        signedIn={signedIn}
        page="home"
        onGoHome={goTop}
        onSignIn={onSignIn}
        onRequestAccess={onRequestAccess}
        onOpenComics={onOpenComics}
        onBrowseGallery={onBrowseGallery}
        onShowSection={showSection}
      />

      <main>
        {/* 1 · Hero and the product proof */}
        <section data-testid="comics-hero" aria-labelledby="comics-hero-title" className="relative overflow-hidden">
          <div aria-hidden className="ds-grid-backdrop pointer-events-none absolute inset-0" />
          {/* The page's one wash (colourUseGuard WASH_FILES), full bleed behind the headline and the calls to action, so
              its three colours (ultramarine left, magenta right, orange low) meet behind the words and the orange rises
              to the top edge of the drawn pages. On the whole section the opaque proof hid the orange and stretched the
              other two into edge bands on phones. Text on it stays ink. */}
          <div data-testid="comics-hero-wash" className={cn(WASH_HERO, 'relative')}>
            <div className={cn(HEADER_INNER, 'relative')}>
              <div className="ds-stagger mx-auto flex max-w-5xl flex-col items-center pb-10 pt-12 text-center sm:pb-14 sm:pt-24">
                <p
                  className={cn(
                    RADIUS_ROUND,
                    'inline-flex items-center gap-2 border border-[var(--ds-hairline)] bg-[var(--ds-canvas)] px-3.5 py-1.5 text-[length:var(--ds-text-sm)] font-medium text-[var(--ds-muted)]'
                  )}
                >
                  <span aria-hidden className={cn(RADIUS_ROUND, 'size-1.5 bg-[var(--ds-ink)]')} />
                  In beta · new accounts by invite
                </p>
                <h1 id="comics-hero-title" className={cn(DISPLAY_HERO, 'mt-7 max-w-4xl text-[var(--ds-ink)]')}>
                  <span className="block">Talk it through.</span>
                  <span className="block">Get a finished comic.</span>
                </h1>
                <p className={cn(PUBLIC_LEAD, 'mt-5 max-w-2xl medium:mt-6')}>
                  Tell the Comic Director your idea — a script, an outline or one line. It plans every page with you, keeps your cast on-model and
                  letters every balloon.
                </p>
                <div className="mt-8 flex w-full flex-col gap-3 medium:mt-9 medium:w-auto medium:flex-row medium:justify-center">
                  {/* The one creation call to action: the spark signed out, the ink primary signed in (one element, so
                      the spark is spelled once in this file: tests/config/sparkGuard.test.ts). */}
                  <Button
                    data-testid="comics-hero-cta"
                    variant={signedIn ? 'default' : 'create'}
                    size="lg"
                    className={cn(CTA_LG, 'group w-full medium:w-auto')}
                    onClick={signedIn ? onOpenComics : onSignIn}
                  >
                    {signedIn ? 'Open your comics' : 'Start creating'}
                    <ArrowRight aria-hidden className={ARROW_NUDGE} />
                  </Button>
                  <Button variant="outline" size="lg" className={cn(CTA_LG, 'w-full medium:w-auto')} onClick={signedIn ? onBrowseGallery : onRequestAccess}>
                    {signedIn ? 'Browse the Library' : 'Request access'}
                  </Button>
                </div>
                {!signedIn && (
                  <p className="mt-5 max-w-md text-[length:var(--ds-text-sm)] leading-5 text-[var(--ds-muted)]">
                    New accounts are invite-only during the beta. Already have a DreamStream account? It works here too.
                  </p>
                )}
              </div>
            </div>
          </div>
          <figure
            data-testid="comics-proof"
            className="ds-rise-in relative px-4 pb-16 medium:px-6 sm:pb-20"
            style={{ animationDelay: 'calc(6 * var(--ds-motion-stagger))' }}
          >
            <div aria-hidden className={cn('mx-auto max-w-5xl overflow-hidden border border-[var(--ds-hairline)] bg-[var(--ds-surface)]', RADIUS_FEATURE, SHADOW_HERO)}>
              <StudioPreview />
            </div>
            <figcaption className="mx-auto mt-3 max-w-xl text-center text-[length:var(--ds-text-sm)] leading-5 text-[var(--ds-muted)]">
              Illustrated example. Your pages are drawn for your story, in the look you lock.
            </figcaption>
          </figure>
        </section>

        {/* 2 · The looks band: one scene in six looks (static; scrolls inside its own region when it does not fit) */}
        <section
          id="looks"
          aria-labelledby="comics-looks"
          className={cn(SECTION, 'border-y border-[var(--ds-hairline)] bg-[var(--ds-well)] py-10 sm:py-12 [contain-intrinsic-size:auto_30rem] [content-visibility:auto]')}
        >
          <h2 id="comics-looks" tabIndex={-1} className={cn(OVERLINE_DISPLAY, FOCUS_TARGET, 'text-center')}>
            One scene, six looks
          </h2>
          <p className={cn(PUBLIC_BODY, 'mx-auto mt-3 max-w-md px-4 text-center')}>Pick a look and lock it. Every page follows.</p>
          <div
            ref={looksRef}
            role="region"
            aria-label="Six looks"
            tabIndex={looksOverflow ? 0 : undefined}
            className={cn('ds-fade-edge-x mt-8 snap-x snap-mandatory overflow-x-auto', FOCUS_RING_FLUSH)}
          >
            <ul className="mx-auto flex w-max gap-4 px-4 pb-2 medium:px-6">
              {SPECIMEN_LOOKS.map((id) => (
                <li key={id} className="shrink-0 snap-center">
                  <figure className="w-[10.5rem] medium:w-44">
                    <ComicPageSpecimen look={id} layout="opening" />
                    <figcaption className="mt-2.5 text-center text-[length:var(--ds-text-sm)] font-medium text-[var(--ds-ink)]">{specimenPreset(id).name}</figcaption>
                  </figure>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* 3 · How it works: the steps rail, then the bento */}
        <section id="how-it-works" aria-labelledby="comics-how" className={cn(SECTION, 'py-16 sm:py-24')}>
          <div className={HEADER_INNER}>
            <div className="ds-reveal max-w-2xl">
              <p className={OVERLINE_DISPLAY}>How it works</p>
              <h2 id="comics-how" tabIndex={-1} className={cn(DISPLAY_SECTION, FOCUS_TARGET, 'mt-4 text-[var(--ds-ink)]')}>
                From one line to finished pages
              </h2>
            </div>
            <ol className="mt-12 grid gap-10 md:grid-cols-2 md:gap-x-6 lg:grid-cols-4">
              {STEPS.map((step, i) => (
                <li key={step.title} data-step={i + 1} className="ds-reveal relative border-t border-[var(--ds-ink)] pt-6">
                  <span aria-hidden className={cn(RADIUS_ROUND, 'absolute -top-[5px] left-0 size-2.5 bg-[var(--ds-ink)]')} />
                  <p aria-hidden className="text-[length:var(--ds-text-xs)] font-medium tabular-nums text-[var(--ds-muted)]">
                    {String(i + 1).padStart(2, '0')}
                  </p>
                  <h3 className={cn(DISPLAY_CARD_TITLE, 'mt-2 text-[var(--ds-ink)]')}>{step.title}</h3>
                  <p className={cn(PUBLIC_BODY, 'mt-2')}>{step.body}</p>
                </li>
              ))}
            </ol>
            <ul className="mt-12 grid gap-4 sm:mt-14 md:grid-cols-2">
              {FEATURES.map(({ icon: Icon, tile, title, body }) => (
                <li key={title} className={cn('group ds-reveal border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-6 medium:p-7', RADIUS_FEATURE, LIFT)}>
                  <span
                    aria-hidden
                    data-feature-tile
                    className={cn(
                      'flex size-14 items-center justify-center transition-transform duration-[var(--ds-motion-panel)] ease-[var(--ds-ease-spring)] can-hover:motion-safe:group-hover:-rotate-6 can-hover:motion-safe:group-hover:scale-105',
                      RADIUS_PANEL,
                      tile
                    )}
                  >
                    <Icon aria-hidden className="size-6" />
                  </span>
                  {/* Two lines tall in the two-column tablet grid (3.5rem at leading-7), so the bodies in a row start
                      level; from lg every title fits one line. */}
                  <h3 className={cn(DISPLAY_CARD_TITLE, 'mt-6 text-[var(--ds-ink)] md:min-h-14 lg:min-h-0')}>{title}</h3>
                  <p className={cn(PUBLIC_BODY, 'mt-2 max-w-xl')}>{body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* 4 · Read and share: what readers get, beside a page as the reader shows it */}
        <section id="read" aria-labelledby="comics-read" className={cn(SECTION, 'pb-16 sm:pb-24')}>
          <div className={cn(HEADER_INNER, 'grid items-center gap-12 lg:grid-cols-2')}>
            <div className="ds-reveal">
              <p className={OVERLINE_DISPLAY}>Read and share</p>
              <h2 id="comics-read" tabIndex={-1} className={cn(DISPLAY_SECTION, FOCUS_TARGET, 'mt-4 text-[var(--ds-ink)]')}>
                Made to be read, anywhere
              </h2>
              <ul className="mt-8 space-y-4">
                {PROMISES.map(({ icon: Icon, text }) => (
                  <li key={text} className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-3 text-[length:var(--ds-text-md)] leading-6 text-[var(--ds-ink)]">
                    <Icon aria-hidden className="mt-0.5 size-5" />
                    <span>{text}</span>
                  </li>
                ))}
              </ul>
            </div>
            <figure className={cn('ds-reveal flex flex-col items-center gap-4 border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-6 py-10 medium:px-10', RADIUS_HERO)}>
              <div aria-hidden className="w-full max-w-[13rem] medium:max-w-[15rem]">
                <ComicPageSpecimen look="watercolor-storybook" layout="chase" />
              </div>
              <div aria-hidden className="flex gap-1.5">
                {[0, 1, 2, 3].map((i) => (
                  <span key={i} className={i === 1 ? cn(RADIUS_ROUND, 'h-1.5 w-4 bg-[var(--ds-ink)]') : cn(RADIUS_ROUND, 'size-1.5 bg-[var(--ds-hairline)]')} />
                ))}
              </div>
              <figcaption className="sr-only">An illustrated page in the Storybook watercolor look, as the reader shows it.</figcaption>
            </figure>
          </div>
        </section>

        {/* 5 · The access panel (the inverse ink panel; a raised dark panel with a light rim in dark) */}
        <section id="access" aria-labelledby="comics-access" className={cn(HEADER_INNER, SECTION)}>
          <div
            className={cn(
              INVERSE_SURFACE,
              RADIUS_HERO,
              'ds-reveal grid gap-10 px-6 py-12 medium:px-10 sm:px-14 sm:py-20 md:grid-cols-[1.4fr_1fr] md:items-end'
            )}
          >
            <div>
              <h2 id="comics-access" tabIndex={-1} className={cn(DISPLAY_SECTION, FOCUS_TARGET)}>
                {signedIn ? (
                  'Pick up where you left off'
                ) : (
                  <>
                    Comic Studio is <span className="whitespace-nowrap">invite-only</span> while it’s in beta
                  </>
                )}
              </h2>
              <p className="mt-5 max-w-lg text-[length:var(--ds-text-md)] leading-7 text-[color:color-mix(in_srgb,var(--ds-canvas)_70%,transparent)]">
                {signedIn
                  ? 'Your comics and drafts are waiting in My comics.'
                  : 'Request access and we’ll be in touch. Already have a DreamStream account? It works here too.'}
              </p>
            </div>
            <div className="flex flex-col gap-3 medium:flex-row medium:flex-wrap md:justify-end">
              {signedIn ? (
                <Button variant="secondary" size="lg" className={cn(CTA_LG, INVERSE_ACTION, 'group')} onClick={onOpenComics}>
                  Open your comics
                  <ArrowRight aria-hidden className={ARROW_NUDGE} />
                </Button>
              ) : (
                <>
                  <Button variant="secondary" size="lg" className={cn(CTA_LG, INVERSE_ACTION, 'group')} onClick={onRequestAccess}>
                    Request access
                    <ArrowRight aria-hidden className={ARROW_NUDGE} />
                  </Button>
                  <Button variant="outline" size="lg" className={cn(CTA_LG, INVERSE_ACTION_QUIET)} onClick={onSignIn}>
                    Sign in
                  </Button>
                </>
              )}
            </div>
          </div>
        </section>
      </main>

      <footer className="mt-16 border-t border-[var(--ds-hairline)] bg-[var(--ds-canvas)] sm:mt-24">
        {/* Two link columns side by side from 320 px (the brand spans both), three columns from md. */}
        <div className={cn(HEADER_INNER, 'grid grid-cols-2 gap-x-6 gap-y-10 py-12 text-[length:var(--ds-text-base)] md:grid-cols-[1.4fr_1fr_1fr]')}>
          <div className="col-span-2 md:col-span-1">
            <BrandLockup mark={<ComicsMark size={28} />} name="Comic" suffix="Studio" suffixAlways clickable={false} />
            <p className="mt-4 max-w-sm leading-6 text-[var(--ds-muted)]">
              Talk through an idea with the Comic Director and get finished, lettered pages you can read and share.
            </p>
          </div>
          <nav aria-label="Comic Studio links">
            <p className={OVERLINE}>Comic Studio</p>
            <ul className="mt-3 space-y-1">
              <li>
                <button type="button" className={FOOTER_LINK} onClick={onBrowseGallery}>
                  Library
                </button>
              </li>
              <li>
                <button type="button" className={FOOTER_LINK} onClick={() => showSection('how-it-works')}>
                  How it works
                </button>
              </li>
              <li>
                {signedIn ? (
                  <button type="button" className={FOOTER_LINK} onClick={onOpenComics}>
                    My comics
                  </button>
                ) : (
                  <button type="button" className={FOOTER_LINK} onClick={onRequestAccess}>
                    Request access
                  </button>
                )}
              </li>
            </ul>
          </nav>
          <nav aria-label="Legal">
            <p className={OVERLINE}>Legal</p>
            <ul className="mt-3 space-y-1">
              <li>
                <button type="button" className={FOOTER_LINK} onClick={onOpenPrivacy}>
                  Privacy Policy
                </button>
              </li>
              <li>
                <button type="button" className={FOOTER_LINK} onClick={onOpenTerms}>
                  Terms &amp; Conditions
                </button>
              </li>
              <li>
                <a href={CONTACT_HREF} className={FOOTER_LINK}>
                  Contact
                </a>
              </li>
            </ul>
          </nav>
        </div>
        <div className="border-t border-[var(--ds-hairline)]">
          <p className={cn(HEADER_INNER, 'py-5 text-[length:var(--ds-text-sm)] text-[var(--ds-muted)]')}>
            Comic Studio · Part of{' '}
            <a href={mainAppUrl('/')} className={FOOTER_LINK_INK}>
              DreamStream Studio
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
};

export default ComicsLanding;
