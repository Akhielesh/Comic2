import React, { useCallback, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import {
  ARROW_NUDGE, CANVAS_BG, CTA_LG, DENSITY, DISPLAY_HERO, DISPLAY_SECTION, FOCUS_RING, PUBLIC_LEAD,
  RADIUS_CONTROL, WASH_HERO
} from '../chat/studioDesign';
import { useComicTheme } from '../comicstudio/useComicTheme';
import { SAMPLE_LOOKS, sampleThumbnailUrl, type SampleLook } from '../comicstudio/library/sampleArt';
import { HEADER_INNER } from '../ds/AppHeader';
import { Button } from '../ds/Button';
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
}

const TEXT_LINK = cn(
  'ds-link inline-flex items-center text-[var(--ds-muted)] hover:text-[var(--ds-ink)]',
  DENSITY.coarse,
  RADIUS_CONTROL,
  FOCUS_RING
);

const LOOKS = SAMPLE_LOOKS.map((id) => ({ id, name: getStylePreset(id)?.name ?? id }));

function focusSection(id: string) {
  const section = document.getElementById(id);
  section?.scrollIntoView?.({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  section?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
}

export function ComicsLanding({
  signedIn,
  onSignIn,
  onRequestAccess,
  onOpenComics,
  onBrowseGallery,
  onOpenPrivacy,
  onOpenTerms
}: ComicsLandingProps) {
  const { theme } = useComicTheme();
  const [look, setLook] = useState<SampleLook>(SAMPLE_LOOKS[0]);
  const showLooks = useCallback(() => focusSection('looks'), []);
  const goTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, []);

  return (
    <div data-testid="comics-landing" data-comic-theme={theme} className={cn(CANVAS_BG, 'min-h-screen text-[var(--ds-ink)]')}>
      <ComicsHeader
        signedIn={signedIn}
        page="home"
        onGoHome={goTop}
        onSignIn={onSignIn}
        onRequestAccess={onRequestAccess}
        onOpenComics={onOpenComics}
        onBrowseGallery={onBrowseGallery}
        onShowSection={showLooks}
      />
      <main className={HEADER_INNER}>
        <section aria-labelledby="comics-hero-title" className={cn('comics-hero grid items-center gap-8 py-8 sm:py-10 lg:gap-10', theme === 'atlas' && WASH_HERO)}>
          <div className="ds-stagger min-w-0">
            <h1 id="comics-hero-title" className={cn(DISPLAY_HERO, 'comics-title')}>
              <span>Make your story</span>{' '}<span>a comic.</span>
            </h1>
            <p className={cn(PUBLIC_LEAD, 'mt-4 max-w-[30rem] medium:mt-5')}>
              Start with an idea or a script. Plan, draw and letter your pages with the Comic Director.
            </p>
            <div className="mt-6 flex flex-wrap gap-2.5 medium:mt-8">
              <Button
                data-testid="comics-hero-cta"
                variant={signedIn ? 'default' : 'create'}
                size="lg"
                className={cn(CTA_LG, 'group')}
                onClick={signedIn ? onOpenComics : onSignIn}
              >
                {signedIn ? 'My comics' : 'Start creating'}
                <ArrowRight aria-hidden className={ARROW_NUDGE} />
              </Button>
              <Button variant="outline" size="lg" className={CTA_LG} onClick={onBrowseGallery}>Browse the Library</Button>
            </div>
            {!signedIn && (
              <p className="mt-3 text-[length:var(--ds-text-sm)] text-[var(--ds-muted)] medium:mt-4">
                New accounts are by invitation.{' '}
                <button type="button" className={cn(TEXT_LINK, 'font-medium underline underline-offset-4')} onClick={onRequestAccess}>
                  Request access
                </button>
              </p>
            )}
          </div>
          <ComicSampleReader look={look} />
        </section>

        <section id="looks" aria-labelledby="comics-looks" className="scroll-mt-[var(--header-h)] border-t border-[var(--ds-hairline)] pb-7 pt-6 medium:pb-8">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <h2 id="comics-looks" tabIndex={-1} className={cn(DISPLAY_SECTION, 'focus:outline-none')}>Find your look</h2>
            <button type="button" className={cn(TEXT_LINK, 'text-[length:var(--ds-text-sm)] lg:hidden')} onClick={() => focusSection('comic-sample')}>
              View sample
            </button>
          </div>
          <ul className="comics-looks mt-4 grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
            {LOOKS.map((preset) => (
              <li key={preset.id} className="min-w-0">
                <button
                  type="button"
                  aria-pressed={look === preset.id}
                  aria-controls="comic-sample"
                  onClick={() => setLook(preset.id)}
                  className={cn('comics-look group flex w-full flex-col gap-1.5 text-left text-[length:var(--ds-text-sm)] text-[var(--ds-muted)] aria-pressed:font-semibold aria-pressed:text-[var(--ds-ink)]', DENSITY.coarse, RADIUS_CONTROL, FOCUS_RING)}
                >
                  <div aria-hidden data-comic-art="" className={cn('comics-look-art relative aspect-[2/1] w-full overflow-hidden', RADIUS_CONTROL)}>
                    <img
                      className="comics-look-scene"
                      src={sampleThumbnailUrl(preset.id)}
                      alt=""
                      width={480}
                      height={240}
                      loading="lazy"
                      decoding="async"
                    />
                  </div>
                  <span className="px-0.5">{preset.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className={HEADER_INNER}>
        <nav aria-label="Comic Studio links" className="flex flex-wrap gap-x-6 border-t border-[var(--ds-hairline)] py-3 text-[length:var(--ds-text-sm)]">
          <button type="button" className={TEXT_LINK} onClick={onBrowseGallery}>Library</button>
          <button type="button" className={TEXT_LINK} onClick={onOpenPrivacy}>Privacy Policy</button>
          <button type="button" className={TEXT_LINK} onClick={onOpenTerms}>Terms &amp; Conditions</button>
          <a href={CONTACT_HREF} className={TEXT_LINK}>Contact</a>
        </nav>
      </footer>
    </div>
  );
}
