import React, { useCallback, useRef, useState } from 'react';
import { cn } from '../../lib/utils';
import { DENSITY, FOCUS_RING, FONT_DISPLAY, RADIUS_CONTROL } from '../chat/studioDesign';
import { useComicTheme } from '../comicstudio/useComicTheme';
import { SAMPLE_LOOKS, sampleThumbnailUrl, type SampleLook } from '../comicstudio/library/sampleArt';
import { Button } from '../ds/Button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ds/Dialog';
import { prefersReducedMotion } from '../ds/useReducedMotion';
import { CONTACT_HREF } from '../layout/LegalMicroLinks';
import { getStylePreset } from '../../shared/comic/stylePresets';
import { ComicsHeader } from './ComicsHeader';
import { ComicSampleReader } from './ComicSampleReader';
import './comicsLanding.css';

export interface ComicsLandingProps {
  signedIn: boolean;
  onSignIn: () => void;
  onRequestAccess: () => void;
  onOpenComics: () => void;
  onBrowseGallery: () => void;
  onOpenPrivacy: () => void;
  onOpenTerms: () => void;
  onOpenAccount?: () => void;
  onStartCreating?: () => void;
}

const TEXT_LINK = cn('ds-link inline-flex items-center text-[var(--ds-muted)] hover:text-[var(--ds-ink)]', DENSITY.coarse, RADIUS_CONTROL, FOCUS_RING);
const FOOTER_LINK = cn(TEXT_LINK, DENSITY.coarseSquare, 'justify-center');
const LOOKS = SAMPLE_LOOKS.map((id) => ({ id, name: getStylePreset(id)?.name ?? id }));

function LookArtwork({ look }: { look: SampleLook }) {
  return (
    <div aria-hidden data-comic-art="" className="comics-look-art">
      <img className="comics-look-scene" src={sampleThumbnailUrl(look)} alt="" width={480} height={240} loading="lazy" decoding="async" />
    </div>
  );
}

function focusSection(id: string) {
  const section = document.getElementById(id);
  section?.scrollIntoView?.({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  section?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
}

export function ComicsLanding({ signedIn, onSignIn, onRequestAccess, onOpenComics, onBrowseGallery, onOpenPrivacy, onOpenTerms, onOpenAccount, onStartCreating }: ComicsLandingProps) {
  const { theme } = useComicTheme();
  const [look, setLook] = useState<SampleLook>(SAMPLE_LOOKS[0]);
  const [comparing, setComparing] = useState(false);
  const lookTrigger = useRef<HTMLButtonElement | null>(null);
  const showLooks = useCallback(() => focusSection('looks'), []);
  const goTop = useCallback(() => window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' }), []);

  return (
    <div data-testid="comics-landing" data-comic-theme={theme} className="comics-landing min-h-screen text-[var(--ds-ink)]">
      <ComicsHeader
        signedIn={signedIn}
        page="home"
        onGoHome={goTop}
        onSignIn={onSignIn}
        onRequestAccess={onRequestAccess}
        onOpenComics={onOpenComics}
        onBrowseGallery={onBrowseGallery}
        onShowSection={showLooks}
        onOpenAccount={onOpenAccount}
      />
      <main className="comics-shell-width comics-landing-column">
        <section aria-labelledby="comics-hero-title" className="comics-hero">
          <div className="comics-hero-copy">
            <h1 id="comics-hero-title" className={cn('comics-title', FONT_DISPLAY)}><span>Make your story</span>{' '}<span>a comic.</span></h1>
            <p className="comics-lead">Start with an idea or a script. Plan, draw and letter your pages with the Comic Director.</p>
            <div className="comics-hero-actions">
              <Button data-testid="comics-hero-cta" variant="default" size="lg" className="comics-primary-action comics-hero-cta" onClick={signedIn ? (onStartCreating ?? onOpenComics) : onSignIn}>
                Start creating
              </Button>
              <Button variant="outline" size="lg" className="comics-hero-cta" onClick={onBrowseGallery}>Browse the Library</Button>
            </div>
            {!signedIn && (
              <p className="comics-invitation">
                New accounts are by invitation.{' '}
                <button type="button" className={cn(TEXT_LINK, 'comics-invitation-link font-medium underline underline-offset-4')} onClick={onRequestAccess}>Request access</button>
              </p>
            )}
          </div>
          <ComicSampleReader look={SAMPLE_LOOKS[0]} story="last-tram" />
        </section>

        <section id="looks" aria-labelledby="comics-looks" className="comics-looks-section">
          <div className="comics-looks-heading">
            <h2 id="comics-looks" tabIndex={-1} className={cn('comics-looks-title focus:outline-none', FONT_DISPLAY)}>Find your look</h2>
            <p className="comics-looks-context">The Paper Boat · six looks</p>
          </div>
          <ul className="comics-looks">
            {LOOKS.map((preset) => (
              <li key={preset.id} className="min-w-0">
                <button
                  type="button"
                  aria-haspopup="dialog"
                  aria-label={`Preview ${preset.name}`}
                  onClick={(event) => {
                    lookTrigger.current = event.currentTarget;
                    setLook(preset.id);
                    setComparing(true);
                  }}
                  className={cn('comics-look', DENSITY.coarse, RADIUS_CONTROL, FOCUS_RING)}
                >
                  <LookArtwork look={preset.id} />
                  <span>{preset.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <Dialog open={comparing} onOpenChange={setComparing}>
        <DialogContent
          className="comics-style-dialog"
          data-comic-theme={theme}
          closeLabel="Close style comparison"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            lookTrigger.current?.focus({ preventScroll: true });
          }}
        >
          <div className="comics-style-dialog-heading">
            <DialogTitle>Compare styles</DialogTitle>
            <DialogDescription>The Paper Boat. One story, six ways to draw it.</DialogDescription>
          </div>
          <ComicSampleReader look={look} standalone />
          <ul className="comics-looks" aria-label="Comic styles">
            {LOOKS.map((preset) => (
              <li key={preset.id} className="min-w-0">
                <button type="button" aria-pressed={look === preset.id} onClick={() => setLook(preset.id)} className={cn('comics-look', DENSITY.coarse, RADIUS_CONTROL, FOCUS_RING)}>
                  <LookArtwork look={preset.id} />
                  <span>{preset.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>

      <footer className="comics-shell-width comics-landing-column">
        <nav aria-label="Comic Studio links" className="comics-footer-links">
          <button type="button" className={FOOTER_LINK} onClick={onBrowseGallery}>Library</button>
          <button type="button" className={FOOTER_LINK} onClick={onOpenPrivacy}>Privacy Policy</button>
          <button type="button" className={FOOTER_LINK} onClick={onOpenTerms}>Terms &amp; Conditions</button>
          <a href={CONTACT_HREF} className={FOOTER_LINK}>Contact</a>
        </nav>
      </footer>
    </div>
  );
}
