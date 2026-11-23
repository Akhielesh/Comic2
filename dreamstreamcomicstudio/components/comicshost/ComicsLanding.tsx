// Public Comic Studio landing and member entry points.
import { ArrowRight, BookOpen, Compass } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';
import { DENSITY, FOCUS_RING, FONT_DISPLAY, RADIUS_CONTROL } from '../chat/studioDesign';
import { useComicTheme } from '../comicstudio/useComicTheme';
import { SAMPLE_LOOKS, sampleThumbnailUrl, type SampleLook } from '../comicstudio/library/sampleArt';
import { Button, buttonClasses } from '../ds/Button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ds/Dialog';
import { prefersReducedMotion } from '../ds/useReducedMotion';
import { openFeedbackReport } from '../../services/openFeedbackReport';
import { CONTACT_HREF } from '../layout/LegalMicroLinks';
import { getStylePreset } from '../../shared/comic/stylePresets';
import { ComicsHeader } from './ComicsHeader';
import { ComicSampleReader, SHELF_EDITIONS, STORIES } from './ComicSampleReader';
import { FeaturesSection } from './landing/FeaturesSection';
import { HowItWorks } from './landing/HowItWorks';
import { FOOTER, HERO, JOIN } from './landing/landingCopy';
import { ModelsSection, PricingSection } from './landing/ModelsPricing';
import { arriveAtSection, isLandingSectionId, showRegister, showSection, type LandingSectionId } from './landing/parts';
import { StudioDirectory } from './landing/StudioDirectory';
import { StudioGuideDialog, useStudioGuide } from './landing/StudioGuide';
import { ReadSection } from './landing/ReadSection';
import { FaqSection, RegisterSection } from './landing/RegisterFaq';
import './comicsLanding.css';
import './landing/landing.css';

export interface ComicsLandingProps {
  signedIn: boolean;
  tourAccountId?: string;
  onSignIn: () => void;
  onRequestAccess: () => void;
  onOpenComics: () => void;
  onBrowseGallery: () => void;
  onOpenPrivacy: () => void;
  onOpenTerms: () => void;
  onStartCreating?: () => void;
}

const TEXT_LINK = cn('ds-link inline-flex items-center text-[var(--ds-muted)] hover:text-[var(--ds-ink)]', DENSITY.coarse, RADIUS_CONTROL, FOCUS_RING);
/** A text button or link that stays a 44 px square target under a coarse pointer, however short its word. */
const SQUARE_LINK = cn(TEXT_LINK, DENSITY.coarseSquare, 'justify-center');
const FOOTER_LINK = SQUARE_LINK;
const LOOKS = SAMPLE_LOOKS.map((id) => ({ id, name: getStylePreset(id)?.name ?? id }));

/** The footer's links to this page's sections (signed in, the join link is left out). */
const PAGE_LINKS: ReadonlyArray<{ id: LandingSectionId; label: string; signedOutOnly?: boolean }> = [
  { id: 'features', label: FOOTER.features },
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'how-it-works', label: FOOTER.how },
  { id: 'models', label: FOOTER.models },
  { id: 'pricing', label: FOOTER.pricing },
  { id: 'read', label: FOOTER.read },
  { id: 'register', label: FOOTER.register, signedOutOnly: true },
  { id: 'faq', label: FOOTER.faq }
];

function LookArtwork({ look }: { look: SampleLook }) {
  return (
    <div aria-hidden data-comic-art="" className="comics-look-art">
      <img className="comics-look-scene" src={sampleThumbnailUrl(look)} alt="" width={480} height={240} loading="lazy" decoding="async" />
    </div>
  );
}

export function ComicsLanding({ signedIn, tourAccountId, onSignIn, onRequestAccess, onOpenComics, onBrowseGallery, onOpenPrivacy, onOpenTerms, onStartCreating }: ComicsLandingProps) {
  const { theme } = useComicTheme();
  const guide = useStudioGuide(tourAccountId ?? (signedIn ? 'member' : 'guest'));
  const [look, setLook] = useState<SampleLook>(SAMPLE_LOOKS[0]);
  const [edition, setEdition] = useState<(typeof SHELF_EDITIONS)[number]>(SHELF_EDITIONS[0]);
  const [comparing, setComparing] = useState(false);
  const lookTrigger = useRef<HTMLButtonElement | null>(null);
  const goTop = useCallback(() => window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' }), []);

  // Arriving on a section link (…/#pricing, …/#faq): show that section once, after the fonts and layout settle.
  useEffect(() => {
    const id = (typeof window === 'undefined' ? '' : window.location.hash || '').replace(/^#/, '');
    if (id !== 'top' && isLandingSectionId(id)) return arriveAtSection(id);
    return undefined;
  }, []);

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
        onShowSection={showSection}
      />
      <main className="comics-shell-width comics-landing-column">
        <section id="top" aria-labelledby="comics-hero-title" className="comics-hero">
          <div className="comics-hero-copy">
            <h1 id="comics-hero-title" className={cn('comics-title', FONT_DISPLAY)}><span>Your story</span>{' '}<span>in panels.</span></h1>
            <p className="comics-lead">{HERO.lead}</p>
            <div className="comics-hero-actions">
              {signedIn ? (
                <>
                  <Button data-testid="comics-hero-cta" variant="default" size="lg" className="comics-primary-action comics-hero-cta" onClick={onStartCreating ?? onOpenComics}>
                    Start a comic <ArrowRight aria-hidden />
                  </Button>
                  <a href="/?view=images" className={buttonClasses({ variant: 'outline', size: 'lg', className: 'comics-hero-cta' })}>Create an image</a>
                </>
              ) : (
                <>
                  <Button data-testid="comics-hero-cta" variant="default" size="lg" className="comics-primary-action comics-hero-cta" onClick={onRequestAccess}>
                    {JOIN.action} <ArrowRight aria-hidden />
                  </Button>
                  <Button data-testid="comics-hero-read" variant="outline" size="lg" className="comics-hero-cta" onClick={onBrowseGallery}><BookOpen aria-hidden />Read comics</Button>
                </>
              )}
            </div>
            <button type="button" ref={guide.hero} className={cn('studio-guide-entry', DENSITY.coarse, FOCUS_RING)} aria-haspopup="dialog" onClick={guide.start}>
              <Compass aria-hidden />{guide.label}
            </button>
            {!signedIn && (
              <p className="comics-invitation">
                <span className="comics-invitation-line">{HERO.invitation}</span>
                Already a member?{' '}
                <button type="button" className={cn(SQUARE_LINK, 'comics-invitation-link font-medium underline underline-offset-4')} onClick={onSignIn}>Sign in</button>
              </p>
            )}
          </div>
          <div className="comics-shelf" data-edition={edition}>
            <div className="comics-shelf-options" role="group" aria-label="Choose a sample comic">
              {SHELF_EDITIONS.map((id) => (
                <button key={id} type="button" aria-pressed={edition === id} className={cn('comics-shelf-option', DENSITY.coarse, FOCUS_RING)} onClick={() => setEdition(id)}>
                  {STORIES[id].title}
                </button>
              ))}
            </div>
            <div className="comics-hero-press">
              <ComicSampleReader key={edition} look={SAMPLE_LOOKS[0]} story={edition} />
            </div>
          </div>
        </section>

        <FeaturesSection>
          <StudioDirectory signedIn={signedIn} onSignIn={onSignIn} onStartCreating={onStartCreating} onOpenComics={onOpenComics} onBrowseGallery={onBrowseGallery} />
        </FeaturesSection>

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

        <HowItWorks />
        <ModelsSection />
        <PricingSection />
        <ReadSection onBrowseGallery={onBrowseGallery} />
        <RegisterSection signedIn={signedIn} onSignUp={onRequestAccess} onSignIn={onSignIn} onOpenComics={onOpenComics} />
        <FaqSection />
      </main>

      <StudioGuideDialog guide={guide} theme={theme} signedIn={signedIn} onBrowse={onBrowseGallery}
        onStartComic={signedIn ? (onStartCreating ?? onOpenComics) : onRequestAccess} />
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
        <nav aria-label={FOOTER.pageNav} className="landing-page-links">
          {PAGE_LINKS.filter((link) => !(signedIn && link.signedOutOnly)).map((link) => (
            <a
              key={link.id}
              href={`#${link.id}`}
              className={FOOTER_LINK}
              onClick={(event) => {
                event.preventDefault();
                if (link.id === 'register') showRegister();
                else showSection(link.id);
              }}
            >
              {link.label}
            </a>
          ))}
        </nav>
        <nav aria-label="Comic Studio links" className="comics-footer-links">
          <button type="button" className={FOOTER_LINK} onClick={onBrowseGallery}>Library</button>
          <button type="button" className={FOOTER_LINK} onClick={onOpenPrivacy}>Privacy Policy</button>
          <button type="button" className={FOOTER_LINK} onClick={onOpenTerms}>Terms &amp; Conditions</button>
          <button type="button" className={FOOTER_LINK} aria-haspopup="dialog" onClick={guide.start}>Studio guide</button>
          <button type="button" className={FOOTER_LINK} onClick={() => openFeedbackReport()}>Send feedback</button>
          <a href={CONTACT_HREF} className={FOOTER_LINK}>Contact</a>
        </nav>
      </footer>
    </div>
  );
}
