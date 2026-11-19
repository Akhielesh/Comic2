// "Read": the public Library (a real link, handled in the app on a plain click), the featured comics through their
// share links (flagship.ts), and a short clip of the reader on a phone. Every action here is an outline control: the
// page's one filled action per view is the hero's (and, further down, the form's).
import React from 'react';
import { ArrowRight, BookOpen } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { ARROW_NUDGE, FONT_DISPLAY } from '../../chat/studioDesign';
import { buttonClasses } from '../../ds/Button';
import { FEATURED } from './flagship';
import { READ } from './landingCopy';
import { landingMedia } from './landingMedia';
import { LandingFigure, SectionHead } from './parts';

/** The public Library's address in the app (the comics host serves it at this URL). */
export const LIBRARY_HREF = '/?view=gallery';

const OUTLINE_LINK = buttonClasses({ variant: 'outline', size: 'lg', className: 'group landing-link-button' });

export const ReadSection: React.FC<{ onBrowseGallery: () => void }> = ({ onBrowseGallery }) => (
  <section id="read" aria-labelledby="landing-read" className="landing-section">
    <div className="landing-read">
      <div className="landing-read-copy">
        <SectionHead id="landing-read" eyebrow={READ.eyebrow} title={READ.title}>
          <p className="landing-lead">{READ.line}</p>
        </SectionHead>
        <ul className="landing-featured" aria-label={READ.featured}>
          {FEATURED.map((comic) => (
            <li key={comic.href} className="landing-comic ds-reveal">
              <BookOpen aria-hidden className="landing-comic-icon" />
              <div className="landing-comic-body">
                <h3 className={cn('landing-comic-title', FONT_DISPLAY)}>{comic.title}</h3>
                <p className="landing-body">{comic.line}</p>
                {comic.english ? <p className="landing-note">{READ.englishEdition}</p> : null}
                <a href={comic.href} className={OUTLINE_LINK} data-featured-comic={comic.title}>
                  {`${READ.readIn} ${comic.title}`}
                  <ArrowRight aria-hidden className={ARROW_NUDGE} />
                </a>
              </div>
            </li>
          ))}
        </ul>
        <a
          href={LIBRARY_HREF}
          data-testid="landing-read-library"
          className={OUTLINE_LINK}
          onClick={(e) => {
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            onBrowseGallery();
          }}
        >
          {READ.library}
          <ArrowRight aria-hidden className={ARROW_NUDGE} />
        </a>
      </div>
      <div className="landing-read-media">
        <LandingFigure media={landingMedia('reader')} />
      </div>
    </div>
  </section>
);
