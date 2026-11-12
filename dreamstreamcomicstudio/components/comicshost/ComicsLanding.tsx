// The front page of comics.dreamstreamstudio.ai: Comic Studio's own landing + sign-in entry.
// Atlas chrome (paper and ink, the --ds-* tokens and the studioDesign recipes, master plan D3) with comic art
// as the hero: procedural pages and a speech balloon drawn from the library seams (EmptyArt, LayoutGlyph), so
// there are no images to load and it reads correctly in light and dark. Bangers and Comic Neue stay inside
// art and lettering; the chrome never spells a hue. Sign-in itself reuses the existing auth UI (App's AuthPage)
// via onSignIn / onRequestAccess.
//
// The one "start making" call to action is the hero's (heroButton): the page's one spark fill (CL-3, DS-3 wave
// note 4; tests/config/sparkGuard.test.ts pins it). The header and closing buttons stay the ink primary.

import React, { useEffect, useState } from 'react';
import { ArrowRight, LayoutGrid, LogIn, Mail } from 'lucide-react';
import { EmptyArt, type EmptyArtVariant } from '../comicstudio/library/procedural/EmptyArt';
import { LayoutGlyph } from '../comicstudio/library/procedural/LayoutGlyph';
import { mainAppUrl } from '../../services/productHost';
import { SUPPORT_EMAIL } from '../legal/contacts';
import {
  ACCENT_FILL_HOVER,
  BENDAY,
  FOCUS_RING,
  FONT_DISPLAY,
  HEADER_GLASS,
  ON_ACCENT_TEXT,
  OVERLINE,
  RADIUS_CONTROL,
  RADIUS_PANEL,
  SHADOW_SOFT,
  SPARK_FILL,
  STICKY_HEADER
} from '../chat/studioDesign';
import { ComicsMark } from './ComicsMark';

export interface ComicsLandingProps {
  signedIn: boolean;
  onSignIn: () => void;
  onRequestAccess: () => void;
  /** Signed in: the comics dashboard. */
  onOpenComics: () => void;
  onBrowseGallery: () => void;
  onOpenPrivacy: () => void;
  onOpenTerms: () => void;
}

const FEATURES: { art: EmptyArtVariant; title: string; body: string }[] = [
  {
    art: 'studio',
    title: 'A director that listens',
    body: 'Tell it the idea in your own words. It asks what matters, explains every step and shows the cost before anything is drawn.'
  },
  {
    art: 'cast',
    title: 'Characters that stay themselves',
    body: 'Reference sheets and a locked style keep faces, outfits and colours consistent from the cover to the last page.'
  },
  {
    art: 'pages',
    title: 'Lettering you control',
    body: 'Balloons, captions and sound effects are real text. Restyle, move or rewrite them without redrawing a single panel.'
  },
  {
    art: 'reader',
    title: 'Read and share anywhere',
    body: 'A page-turning reader for phones, tablets and desktops, and read-only share links your readers can download from.'
  }
];

const STEPS: { title: string; body: string }[] = [
  { title: 'Prompt', body: 'Paste a script, an outline, notes or one line.' },
  { title: 'Plan', body: 'Agree on pages, cast, world and budget together.' },
  { title: 'Build', body: 'Lock the style, then the cover and every page.' },
  { title: 'Polish', body: 'Edit panels and lettering, read, share, export.' }
];

// Every target is 44 px tall at every pointer: this is the public front page, often opened on a phone.
const BUTTON_SHAPE = `inline-flex min-h-[44px] items-center justify-center gap-2 ${RADIUS_CONTROL} px-5 text-sm font-semibold motion-safe:transition-colors`;
/** The ink primary: the text-bearing accent with its on-accent label (white on ink, ink on paper in dark). */
const primaryButton = `${BUTTON_SHAPE} bg-[var(--ds-accent)] ${ON_ACCENT_TEXT} ${ACCENT_FILL_HOVER} ${FOCUS_RING}`;
/** The hero's call to action: the one "start making" button on the page, in the spark (CL-3). */
const heroButton = `${BUTTON_SHAPE} ${SPARK_FILL} ${FOCUS_RING}`;
const secondaryButton = `${BUTTON_SHAPE} border border-[var(--ds-hairline)] bg-[var(--ds-surface)] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] ${FOCUS_RING}`;
const quietLink = `inline-flex min-h-[44px] items-center ${RADIUS_CONTROL} px-2 text-sm text-[var(--ds-muted)] hover:text-[var(--ds-ink)] ${FOCUS_RING}`;

/** The sticky header frosts once the page scrolls under it (HEADER_GLASS reads data-scrolled). No timer, no fetch. */
const useScrolled = (): boolean => {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const read = () => setScrolled(window.scrollY > 4);
    read();
    window.addEventListener('scroll', read, { passive: true });
    return () => window.removeEventListener('scroll', read);
  }, []);
  return scrolled;
};

/** Three overlapping comic pages with a speech balloon — pure SVG/CSS, decorative: the comic art is the hero. */
const HeroArt: React.FC = () => (
  <div aria-hidden className={`relative mx-auto h-[260px] w-full max-w-[300px] sm:h-[320px] sm:max-w-[360px] ${BENDAY}`} data-testid="comics-hero-art">
    {[
      { panels: 3, cls: 'left-[4%] top-[10%] -rotate-6' },
      { panels: 5, cls: 'left-[28%] top-[2%] rotate-3' },
      { panels: 4, cls: 'left-[16%] top-[22%] -rotate-1' }
    ].map((page, i) => (
      <div
        key={i}
        className={`absolute ${page.cls} ${RADIUS_CONTROL} border border-[var(--ds-hairline)] bg-[var(--ds-raised)] p-2 text-[var(--ds-ink)] shadow-[shadow:var(--ds-shadow-lift)]`}
      >
        <LayoutGlyph panels={page.panels} aspect="2:3" size={120} />
      </div>
    ))}
    {/* The balloon is stroked in the spark (CL-3): a style stroke, because an SVG attribute does not resolve var(). */}
    <svg viewBox="0 0 120 84" className="absolute right-[2%] top-[4%] w-[120px] text-[var(--ds-ink)] sm:right-0 sm:w-[140px]" focusable="false" data-testid="comics-hero-balloon">
      <path
        d="M16 4h88a12 12 0 0 1 12 12v34a12 12 0 0 1-12 12H52l-20 18V62H16A12 12 0 0 1 4 50V16A12 12 0 0 1 16 4z"
        style={{ fill: 'var(--ds-raised)', stroke: 'var(--ds-spark)' }}
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path d="M24 26h72M24 40h48" style={{ stroke: 'var(--ds-muted)' }} strokeWidth="5" strokeLinecap="round" fill="none" />
    </svg>
  </div>
);

export const ComicsLanding: React.FC<ComicsLandingProps> = ({
  signedIn,
  onSignIn,
  onRequestAccess,
  onOpenComics,
  onBrowseGallery,
  onOpenPrivacy,
  onOpenTerms
}) => {
  const scrolled = useScrolled();
  return (
    <div className="min-h-screen overflow-x-hidden bg-[var(--ds-canvas)] text-[var(--ds-ink)]" data-testid="comics-landing">
      <header className={STICKY_HEADER} data-scrolled={scrolled ? 'true' : 'false'}>
        <div aria-hidden className={HEADER_GLASS} />
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-2 px-4 sm:px-6">
          <div className="flex min-h-[44px] min-w-0 items-center gap-2.5">
            <ComicsMark size={36} className="shrink-0" />
            {/* Below the medium screen (600 px) the mark stands alone, so Library and Sign in stay whole and the name is
                never cut; it stays for screen readers. Named screens only: this config's raw screens disable min-[…]/max-[…]. */}
            <span className="min-w-0 leading-tight sr-only medium:not-sr-only" data-testid="comics-wordmark">
              <span className={`block truncate ${OVERLINE}`}>DreamStream</span>
              <span className="block truncate text-base font-semibold">Comic Studio</span>
            </span>
          </div>
          <nav className="flex shrink-0 items-center gap-1 sm:gap-2" aria-label="Comic Studio">
            {/* The public shelf, at every width (redesign M3). */}
            <button type="button" onClick={onBrowseGallery} className={quietLink}>
              Library
            </button>
            {signedIn ? (
              <button type="button" onClick={onOpenComics} className={primaryButton}>
                My comics
              </button>
            ) : (
              <>
                <button type="button" onClick={onRequestAccess} className={`hidden sm:inline-flex ${quietLink}`}>
                  Request access
                </button>
                <button type="button" onClick={onSignIn} className={primaryButton}>
                  <LogIn size={16} aria-hidden /> Sign in
                </button>
              </>
            )}
          </nav>
        </div>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-12 pt-10 sm:px-6 sm:pt-16 lg:grid-cols-[1.1fr_0.9fr] lg:pb-20">
          <div className="min-w-0">
            <p className={OVERLINE}>Comic Studio</p>
            <h1 className={`mt-3 break-words text-[2rem] font-semibold leading-[1.1] tracking-tight sm:text-5xl ${FONT_DISPLAY}`}>
              Talk it through.
              <br />
              Get a finished comic.
            </h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-[var(--ds-muted)] sm:text-lg">
              Tell the Comic Director your idea: a script, an outline or a single line. It plans every page with you, keeps your cast
              on-model and letters every balloon. Change anything in Easy or Pro mode.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              {signedIn ? (
                <>
                  <button type="button" onClick={onOpenComics} className={heroButton} data-variant="create" data-testid="comics-hero-cta">
                    Open my comics <ArrowRight size={16} aria-hidden />
                  </button>
                  <button type="button" onClick={onBrowseGallery} className={secondaryButton}>
                    <LayoutGrid size={16} aria-hidden /> Browse the Library
                  </button>
                </>
              ) : (
                <>
                  <button type="button" onClick={onSignIn} className={heroButton} data-variant="create" data-testid="comics-hero-cta">
                    Sign in to your studio <ArrowRight size={16} aria-hidden />
                  </button>
                  <button type="button" onClick={onRequestAccess} className={secondaryButton}>
                    <Mail size={16} aria-hidden /> Request access
                  </button>
                </>
              )}
            </div>
            {!signedIn && (
              <p className="mt-4 text-sm text-[var(--ds-muted)]">
                New accounts are invite-only during the beta. Already have a DreamStream account? It works here too.
              </p>
            )}
          </div>
          <HeroArt />
        </section>

        <section aria-labelledby="comics-features" className="border-t border-[var(--ds-hairline-soft)] bg-[var(--ds-sidebar)]">
          <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:py-16">
            <h2 id="comics-features" className={`text-xl font-semibold sm:text-2xl ${FONT_DISPLAY}`}>
              Built for stories, not prompts
            </h2>
            <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {FEATURES.map((f) => (
                <li key={f.title} className={`min-w-0 ${RADIUS_PANEL} border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-5 ${SHADOW_SOFT}`}>
                  <EmptyArt variant={f.art} />
                  <h3 className="mt-3 text-base font-semibold">{f.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-[var(--ds-muted)]">{f.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="comics-steps" className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:py-16">
          <h2 id="comics-steps" className={`text-xl font-semibold sm:text-2xl ${FONT_DISPLAY}`}>
            From idea to pages in four steps
          </h2>
          <ol className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <li key={s.title} className={`flex min-w-0 gap-3 ${RADIUS_PANEL} border border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] p-4`}>
                {/* The step number in ink: a count, not a call to action. */}
                <span
                  aria-hidden
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface)] text-sm font-semibold text-[var(--ds-ink)] tabular-nums"
                >
                  {i + 1}
                </span>
                <span className="min-w-0">
                  <span className="block font-semibold">{s.title}</span>
                  <span className="mt-0.5 block text-sm text-[var(--ds-muted)]">{s.body}</span>
                </span>
              </li>
            ))}
          </ol>
          <div className="mt-8 flex flex-wrap gap-3">
            <button type="button" onClick={signedIn ? onOpenComics : onSignIn} className={primaryButton}>
              {signedIn ? 'Start a comic' : 'Sign in to start'} <ArrowRight size={16} aria-hidden />
            </button>
            <button type="button" onClick={onBrowseGallery} className={secondaryButton}>
              See what people made
            </button>
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--ds-hairline-soft)]">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="text-[var(--ds-muted)]">Comic Studio is part of DreamStream.</p>
          <nav aria-label="DreamStream" className="-mx-2 flex flex-wrap items-center gap-x-1">
            <a href={mainAppUrl('/')} className={quietLink}>
              DreamStream home
            </a>
            <a href={mainAppUrl('/?view=chat')} className={quietLink}>
              Chat Studio
            </a>
            <a href={mainAppUrl('/live.html')} className={quietLink}>
              Stream Studio
            </a>
            <button type="button" onClick={onOpenPrivacy} className={quietLink}>
              Privacy
            </button>
            <button type="button" onClick={onOpenTerms} className={quietLink}>
              Terms
            </button>
            <a href={`mailto:${SUPPORT_EMAIL}`} className={quietLink}>
              Contact
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
};

export default ComicsLanding;
