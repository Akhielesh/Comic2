/**
 * The home page's footer (Atlas public footer): the DreamStream lockup and one line, then Studios, Help and
 * Legal columns of `.ds-link` links (44 px tall on touch), and a bottom bar. Real links where a page has an
 * address (so a new-tab click works), with the app's own navigation on a plain click. The bottom padding
 * keeps the last line clear of the floating assistant and feedback buttons on a phone.
 */
import React from 'react';
import { ArrowUpRight } from 'lucide-react';
import { StudioLogo } from '../brand/StudioLogo';
import { followLiveLink, liveAppUrl, mainAppUrl } from '../../services/liveLink';
import { ATLAS_STUDIO_URL, CONTACT_EMAIL } from './content';
import { META, PAGE_COLUMN } from './landingStyles';
import { jumpTo } from './scrollToSection';
import { FOCUS_RING } from '../chat/studioDesign';

export interface HomeFooterProps {
  comicsHref: string | null;
  onOpenComics: () => void;
  onOpenChat: () => void;
  onOpenPrivacy: () => void;
  onOpenTerms: () => void;
}

const LINK = `ds-link inline-flex items-center gap-1 text-sm text-ds-muted hover:text-ds-ink coarse:min-h-[var(--ds-density-touch)] ${FOCUS_RING}`;

/** A plain click runs the app's navigation; a modified click (new tab) keeps the real address. */
const appClick = (go: () => void) => (event: React.MouseEvent<HTMLAnchorElement>) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  go();
};

export function HomeFooter({ comicsHref, onOpenComics, onOpenChat, onOpenPrivacy, onOpenTerms }: HomeFooterProps) {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-ds-hairline bg-ds-well">
      <div className={`${PAGE_COLUMN} grid gap-10 py-12 md:grid-cols-[1.4fr_1fr_1fr_1fr]`}>
        <div className="min-w-0">
          <StudioLogo studio="dreamstream" className="text-ds-ink" />
          <p className="mt-4 max-w-xs text-sm leading-6 text-ds-muted">
            Studios for comics, live video and answers, made for the browser.
          </p>
        </div>

        <nav aria-labelledby="footer-studios">
          <p id="footer-studios" className="ds-overline">
            Studios
          </p>
          <ul className="mt-4 flex flex-col gap-2.5">
            <li>
              {comicsHref ? (
                <a href={comicsHref} className={LINK}>
                  Comic Studio
                </a>
              ) : (
                <a href={mainAppUrl('/?view=dashboard')} onClick={appClick(onOpenComics)} className={LINK}>
                  Comic Studio
                </a>
              )}
            </li>
            <li>
              <a href={liveAppUrl('/live')} onClick={(e) => followLiveLink(e, '/live')} className={LINK}>
                Stream Studio
              </a>
            </li>
            <li>
              <a href={mainAppUrl('/?view=chat')} onClick={appClick(onOpenChat)} className={LINK}>
                Chat Studio
              </a>
            </li>
            <li>
              <a href={ATLAS_STUDIO_URL} className={LINK}>
                Atlas Studio
                <ArrowUpRight aria-hidden="true" className="size-3.5" />
                <span className="sr-only"> (its own site)</span>
              </a>
            </li>
          </ul>
        </nav>

        <nav aria-labelledby="footer-help">
          <p id="footer-help" className="ds-overline">
            Help
          </p>
          <ul className="mt-4 flex flex-col gap-2.5">
            <li>
              <a href="#home-faq" onClick={jumpTo('home-faq')} className={LINK}>
                Questions
              </a>
            </li>
            <li>
              <a href="#register-interest" onClick={jumpTo('register-interest')} className={LINK}>
                Register interest
              </a>
            </li>
            <li>
              <a href={`mailto:${CONTACT_EMAIL}`} className={LINK}>
                Contact us
              </a>
            </li>
          </ul>
        </nav>

        <nav aria-labelledby="footer-legal">
          <p id="footer-legal" className="ds-overline">
            Legal
          </p>
          <ul className="mt-4 flex flex-col gap-2.5">
            <li>
              <a href={mainAppUrl('/?view=privacy')} onClick={appClick(onOpenPrivacy)} className={LINK}>
                Privacy Policy
              </a>
            </li>
            <li>
              <a href={mainAppUrl('/?view=terms')} onClick={appClick(onOpenTerms)} className={LINK}>
                Terms of Service
              </a>
            </li>
          </ul>
        </nav>
      </div>
      <div className="border-t border-ds-hairline">
        <div className={`${PAGE_COLUMN} flex flex-col gap-1 pb-24 pt-5 medium:flex-row medium:items-center medium:justify-between medium:pb-6`}>
          <p className={META}>© {year} DreamStream Studio</p>
          <p className={META}>
            <a href={`mailto:${CONTACT_EMAIL}`} className={`ds-link ${FOCUS_RING}`}>
              {CONTACT_EMAIL}
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
