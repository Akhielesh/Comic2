// The front page of comics.dreamstreamstudio.ai: Comic Studio's own landing + sign-in entry.
// Calm-studio language (--ds-* tokens, one terracotta accent, glass cards) and procedural art
// from the library seams (EmptyArt, LayoutGlyph) — no images to load, correct in light and dark.
// Sign-in itself reuses the existing auth UI (App's AuthPage) via onSignIn / onRequestAccess.

import React from 'react';
import { ArrowRight, LayoutGrid, LogIn, Mail } from 'lucide-react';
import { EmptyArt, type EmptyArtVariant } from '../comicstudio/library/procedural/EmptyArt';
import { LayoutGlyph } from '../comicstudio/library/procedural/LayoutGlyph';
import { mainAppUrl } from '../../services/productHost';
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

const focusRing =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#D97757]';
const primaryButton = `inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full bg-[var(--ds-accent)] px-5 text-sm font-semibold text-white motion-safe:transition-colors hover:bg-[var(--ds-accent-hover)] ${focusRing}`;
const secondaryButton = `inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface)] px-5 text-sm font-semibold text-[var(--ds-ink)] motion-safe:transition-colors hover:bg-[var(--ds-hover)] ${focusRing}`;
const quietLink = `inline-flex min-h-[44px] items-center rounded-lg px-2 text-sm text-[var(--ds-muted)] hover:text-[var(--ds-ink)] ${focusRing}`;

/** Three overlapping comic pages with a speech balloon — pure SVG/CSS, decorative. */
const HeroArt: React.FC = () => (
  <div aria-hidden className="relative mx-auto h-[260px] w-full max-w-[300px] sm:h-[320px] sm:max-w-[360px]" data-testid="comics-hero-art">
    {[
      { panels: 3, cls: 'left-[4%] top-[10%] -rotate-6' },
      { panels: 5, cls: 'left-[28%] top-[2%] rotate-3' },
      { panels: 4, cls: 'left-[16%] top-[22%] -rotate-1' }
    ].map((page, i) => (
      <div
        key={i}
        className={`absolute ${page.cls} rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-raised)] p-2 text-[var(--ds-ink)] shadow-[0_8px_24px_rgba(0,0,0,0.08)]`}
      >
        <LayoutGlyph panels={page.panels} aspect="2:3" size={120} />
      </div>
    ))}
    <svg viewBox="0 0 120 84" className="absolute right-[2%] top-[4%] w-[120px] sm:right-0 sm:w-[140px]" focusable="false">
      <path
        d="M16 4h88a12 12 0 0 1 12 12v34a12 12 0 0 1-12 12H52l-20 18V62H16A12 12 0 0 1 4 50V16A12 12 0 0 1 16 4z"
        style={{ fill: 'var(--ds-raised)' }}
        stroke="#D97757"
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
}) => (
  <div className="min-h-screen overflow-x-hidden bg-[var(--ds-canvas)] text-[var(--ds-ink)]" data-testid="comics-landing">
    <header className="sticky top-0 z-40 border-b border-[var(--ds-hairline-soft)] bg-[var(--ds-surface-strong)] backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-2 px-4 sm:px-6">
        <div className="flex min-h-[44px] min-w-0 items-center gap-2.5">
          <ComicsMark size={36} className="shrink-0" />
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--ds-muted)]">DreamStream</span>
            <span className="block truncate text-base font-semibold">Comic Studio</span>
          </span>
        </div>
        <nav className="flex shrink-0 items-center gap-1 sm:gap-2" aria-label="Comic Studio">
          <button type="button" onClick={onBrowseGallery} className={`hidden sm:inline-flex ${quietLink}`}>
            Gallery
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
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#D97757]">Comic Studio</p>
          <h1 className="mt-3 break-words text-[2rem] font-semibold leading-[1.1] tracking-tight sm:text-5xl">
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
                <button type="button" onClick={onOpenComics} className={primaryButton}>
                  Open my comics <ArrowRight size={16} aria-hidden />
                </button>
                <button type="button" onClick={onBrowseGallery} className={secondaryButton}>
                  <LayoutGrid size={16} aria-hidden /> Browse the gallery
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={onSignIn} className={primaryButton}>
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
          <h2 id="comics-features" className="text-xl font-semibold sm:text-2xl">
            Built for stories, not prompts
          </h2>
          <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f) => (
              <li key={f.title} className="min-w-0 rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                <EmptyArt variant={f.art} />
                <h3 className="mt-3 text-base font-semibold">{f.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-[var(--ds-muted)]">{f.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="comics-steps" className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:py-16">
        <h2 id="comics-steps" className="text-xl font-semibold sm:text-2xl">
          From idea to pages in four steps
        </h2>
        <ol className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex min-w-0 gap-3 rounded-2xl border border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] p-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#D97757]/10 text-sm font-semibold text-[#D97757] tabular-nums">
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
          <a href="mailto:contact@dreamstreamstudio.ai" className={quietLink}>
            Contact
          </a>
        </nav>
      </div>
    </footer>
  </div>
);

export default ComicsLanding;
