/**
 * The home hero (bridge §8; Atlas app/page.tsx): the dot-grid backdrop and the pointer spotlight, the
 * DreamStream mark (its point drops in like a pin as the page arrives), a status pill, the h1 in the
 * display face, a lead, two pill CTAs and a meta line; then a strip of the four studios, each with its own
 * mark (hover plays that studio's moment: the pin, the Grin's blink, the on-air arcs).
 *
 * Text and marks only, no image: the h1 is the largest paint, so LCP is a text paint in the self-hosted
 * display face. Everything is visible without script (the stagger only rises it in).
 */
import React from 'react';
import { ArrowRight } from 'lucide-react';
import { StudioMark } from '../brand/StudioMark';
import { FOCUS_RING } from '../chat/studioDesign';
import { STUDIO_BANDS } from './content';
import {
  BACKDROP_LAYER,
  HERO_LEAD,
  HERO_TITLE,
  META,
  PILL_ARROW,
  PILL_OUTLINE,
  PILL_PRIMARY
} from './landingStyles';
import { jumpTo } from './scrollToSection';
import { SpotlightGroup } from './SpotlightGroup';

export interface HomeHeroProps {
  signedIn: boolean;
}

const STRIP_CARD = `ds-spotlight ds-lift group flex min-h-[3.5rem] min-w-0 items-center gap-2.5 rounded-[var(--ds-radius-panel)] border border-ds-hairline bg-ds-surface px-3 py-2.5 text-left medium:gap-3 medium:px-3.5 medium:py-3 ${FOCUS_RING}`;

export function HomeHero({ signedIn }: HomeHeroProps) {
  return (
    <SpotlightGroup as="section" aria-labelledby="home-title" className="relative overflow-hidden">
      <div aria-hidden="true" className={`ds-grid-backdrop ${BACKDROP_LAYER}`} />
      <div aria-hidden="true" className={`ds-spotlight-grid ${BACKDROP_LAYER}`} />

      <div className="ds-stagger relative mx-auto flex w-full max-w-4xl flex-col items-center px-4 pb-10 pt-10 text-center sm:px-6 sm:pt-20">
        <span className="ds-logo ds-home-mark text-ds-ink">
          <StudioMark studio="dreamstream" className="size-12 sm:size-14" />
        </span>

        <a
          href="#register-interest"
          onClick={jumpTo('register-interest')}
          className={`group mt-6 inline-flex max-w-full items-center gap-2 rounded-full border border-ds-hairline bg-ds-canvas px-3.5 py-1.5 text-xs font-medium text-ds-muted transition-colors duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)] hover:text-ds-ink coarse:min-h-[var(--ds-density-touch)] ${FOCUS_RING}`}
        >
          <span aria-hidden="true" className="ds-live-dot ds-live-dot-settle shrink-0 text-ds-ink" />
          <span className="truncate">Private beta · Register interest</span>
          <ArrowRight aria-hidden="true" className="size-3 shrink-0 transition-transform duration-[var(--ds-motion-slow)] ease-[var(--ds-ease)] motion-safe:can-hover:group-hover:translate-x-0.5" />
        </a>

        <h1 id="home-title" className={`mt-6 max-w-3xl ${HERO_TITLE}`}>
          Make comics, go&nbsp;live, get&nbsp;answers.
        </h1>

        <p className={`mt-6 max-w-2xl !text-balance ${HERO_LEAD}`}>
          DreamStream is a family of studios in your browser: comics you direct by talking, live events and family
          calls, and an assistant that works with your apps.
        </p>

        <div className="mt-9 flex w-full flex-col items-stretch justify-center gap-3 medium:w-auto medium:flex-row medium:items-center">
          {signedIn ? (
            <>
              <a href="#studios" onClick={jumpTo('studios')} className={PILL_PRIMARY}>
                Explore the studios
                <ArrowRight aria-hidden="true" className={PILL_ARROW} />
              </a>
              <a href="#register-interest" onClick={jumpTo('register-interest')} className={PILL_OUTLINE}>
                Get studio updates
              </a>
            </>
          ) : (
            <>
              <a href="#register-interest" onClick={jumpTo('register-interest')} className={PILL_PRIMARY}>
                Register interest
                <ArrowRight aria-hidden="true" className={PILL_ARROW} />
              </a>
              <a href="#studios" onClick={jumpTo('studios')} className={PILL_OUTLINE}>
                Explore the studios
              </a>
            </>
          )}
        </div>

        <p className={`mt-5 ${META}`}>Runs in your browser, on phone or desktop · New accounts are invite-only during the beta</p>
      </div>

      <nav aria-label="Jump to a studio" className="relative mx-auto w-full max-w-5xl px-4 pb-16 sm:px-6 sm:pb-24">
        <ul className="ds-stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
          {STUDIO_BANDS.map((band) => (
            <li key={band.id} className="min-w-0">
              <a href={`#${band.id}`} onClick={jumpTo(band.id)} className={`${STRIP_CARD} w-full`}>
                <span className="ds-logo text-ds-ink">
                  <StudioMark studio={band.studio} className="size-6 medium:size-7" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold leading-5 text-ds-ink medium:text-sm">{band.name}</span>
                  <span className="hidden truncate text-xs text-ds-muted medium:block">{STRIP_LINE[band.id]}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </SpotlightGroup>
  );
}

const STRIP_LINE: Record<(typeof STUDIO_BANDS)[number]['id'], string> = {
  'comic-studio': 'Direct a comic',
  'stream-studio': 'Live, monitor, calls',
  'chat-studio': 'Members-only assistant',
  'atlas-studio': 'Search your accounts'
};
