/**
 * The DreamStream home page (the main site's "/"; the comics host shows ComicsLanding instead).
 *
 * Atlas language (docs/design/atlas-skin.md, the bridge's §8 "simpler home"): monochrome, hue only for status;
 * a hero with the DreamStream mark, one band per studio with one motion moment each (Comic Studio, Stream
 * Studio with live events, the baby monitor and family calls, Chat Studio for members, Atlas Studio next
 * door), "Register interest", a short FAQ and the footer. Words live in components/landing/content.ts.
 *
 * Fast on purpose. App.tsx imports this file eagerly, so it stays light: plain token class strings (no class
 * merging library), no images, the hero's h1 as the largest paint. The four demos and the register-interest
 * form are lazy chunks, warmed when the page goes idle and shown when they near the viewport; their frames
 * keep their shape meanwhile, so nothing moves.
 */
import React, { useEffect } from 'react';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { followLiveLink, liveAppUrl, mainAppUrl } from '../services/liveLink';
import { comicsEntryUrl } from '../services/productHost';
import { ATLAS_STUDIO_URL, CHAT_ACCESS_NOTE, STREAM_ACCESS_NOTE, STUDIO_BANDS, type StudioBandId } from './landing/content';
import { HomeFaq } from './landing/HomeFaq';
import { HomeFooter } from './landing/HomeFooter';
import { HomeHero } from './landing/HomeHero';
import { PILL_ARROW, PILL_OUTLINE, PILL_PRIMARY, TEXT_LINK } from './landing/landingStyles';
import { preloadMoments } from './landing/MomentFrame';
import { preloadRegisterInterest, RegisterInterestSection } from './landing/RegisterInterestSection';
import { jumpTo } from './landing/scrollToSection';
import { StudioBand } from './landing/StudioBand';
import { whenIdle } from './landing/useNearViewport';
import './landing/landing.css';

interface HomePageProps {
  onEnterStudio: () => void;
  onViewComics: () => void;
  onOpenPrivacy: () => void;
  onOpenTerms: () => void;
  onNavigate?: (view: string, id?: string) => void;
  /** The sign-in page in "Request access" mode (App.tsx goToAuth('request-access')); optional. */
  onRequestAccess?: () => void;
}

const band = (id: StudioBandId) => STUDIO_BANDS.find((b) => b.id === id)!;

export const HomePage: React.FC<HomePageProps> = ({ onEnterStudio, onOpenPrivacy, onOpenTerms, onNavigate, onRequestAccess }) => {
  const { user } = useAuth();
  const signedIn = !!user;
  // Comic Studio has its own address on the production main site; elsewhere (and for an in-app jump to
  // the signed-in library) the app's own view.
  const comicsHref = comicsEntryUrl();
  const openChat = () => onNavigate?.('chat');

  // Warm the below-the-fold chunks once the page is idle, so a demo scrolled into view fills at once.
  useEffect(
    () =>
      whenIdle(() => {
        preloadMoments();
        preloadRegisterInterest();
      }),
    []
  );

  return (
    <div className="min-h-screen bg-ds-canvas text-ds-ink">
      <HomeHero signedIn={signedIn} />

      <div id="studios" className="scroll-mt-16">
        <StudioBand
          copy={band('comic-studio')}
          index={1}
          moment="comic"
          actions={
            <>
              {comicsHref ? (
                <a href={comicsHref} className={PILL_PRIMARY}>
                  Open Comic Studio
                  <ArrowRight aria-hidden="true" className={PILL_ARROW} />
                </a>
              ) : (
                <button type="button" onClick={onEnterStudio} className={PILL_PRIMARY}>
                  {signedIn ? 'Open your comics' : 'Open Comic Studio'}
                  <ArrowRight aria-hidden="true" className={PILL_ARROW} />
                </button>
              )}
              {comicsHref && signedIn ? (
                <button type="button" onClick={onEnterStudio} className={TEXT_LINK}>
                  Open my comics here
                </button>
              ) : null}
            </>
          }
        />

        <StudioBand
          copy={band('stream-studio')}
          index={2}
          moment="stream"
          stage
          tinted
          flip
          note={STREAM_ACCESS_NOTE}
          actions={
            <>
              <a href={liveAppUrl('/live')} onClick={(e) => followLiveLink(e, '/live')} className={PILL_PRIMARY}>
                Open Stream Studio
                <ArrowRight aria-hidden="true" className={PILL_ARROW} />
              </a>
              <a href={liveAppUrl('/live#/monitor')} onClick={(e) => followLiveLink(e, '/live#/monitor')} className={TEXT_LINK}>
                Baby monitor
              </a>
              <a href={liveAppUrl('/live#/calls')} onClick={(e) => followLiveLink(e, '/live#/calls')} className={TEXT_LINK}>
                Calls
              </a>
            </>
          }
        />

        <StudioBand
          copy={band('chat-studio')}
          index={3}
          moment="chat"
          note={signedIn ? undefined : CHAT_ACCESS_NOTE}
          actions={
            signedIn ? (
              <a href={mainAppUrl('/?view=chat')} onClick={clickTo(openChat)} className={PILL_PRIMARY}>
                Open Chat Studio
                <ArrowRight aria-hidden="true" className={PILL_ARROW} />
              </a>
            ) : (
              <>
                <a href={mainAppUrl('/?view=chat')} onClick={clickTo(openChat)} className={PILL_OUTLINE}>
                  Sign in to Chat Studio
                </a>
                <a href="#register-interest" onClick={jumpTo('register-interest')} className={TEXT_LINK}>
                  Register interest
                </a>
              </>
            )
          }
        />

        <StudioBand
          copy={band('atlas-studio')}
          index={4}
          moment="atlas"
          tinted
          flip
          actions={
            <a href={ATLAS_STUDIO_URL} className={PILL_OUTLINE}>
              Visit Atlas Studio
              <ArrowUpRight aria-hidden="true" className="size-4" />
              <span className="sr-only"> (its own site)</span>
            </a>
          }
        />
      </div>

      <RegisterInterestSection signedIn={signedIn} onRequestAccess={signedIn ? undefined : onRequestAccess} />
      <HomeFaq />
      <HomeFooter
        comicsHref={comicsHref}
        onOpenComics={onEnterStudio}
        onOpenChat={openChat}
        onOpenPrivacy={onOpenPrivacy}
        onOpenTerms={onOpenTerms}
      />
    </div>
  );
};

/** A plain click runs the app's navigation; a modified click (new tab) keeps the real address. */
function clickTo(go: () => void) {
  return (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    go();
  };
}
