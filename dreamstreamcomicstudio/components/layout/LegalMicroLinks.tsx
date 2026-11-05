import React from 'react';
import { StudioMark } from '../brand';
import { cn } from '../../lib/utils';
import { FOCUS_RING } from '../chat/studioDesign';
import { CONTACT_HREF, copyrightLine, isPlainClick, PRIVACY_HREF, TERMS_HREF } from './siteLinks';

interface LegalMicroLinksProps {
  onOpenPrivacy: () => void;
  onOpenTerms: () => void;
  onOpenFaq: () => void;
  className?: string;
  /** Inside another footer (SiteFooter's bottom bar): no landmark and no top rule of its own. */
  bare?: boolean;
}

/**
 * A footer link (Atlas's FOOTER_LINK): the underline draws in on hover and hugs the text, and under a coarse
 * pointer the link grows to a 44 px tall hit area without spreading the row apart.
 */
export const FOOTER_LINK = cn(
  'ds-link inline-block rounded-[var(--ds-radius-sm)] bg-origin-content text-ds-muted transition-colors duration-[var(--ds-motion-fast)] ease-[var(--ds-ease)] hover:text-ds-ink coarse:py-3',
  FOCUS_RING
);

/** The FAQ lives on the home page (App's handleOpenFaq scrolls to it). */
const FAQ_HREF = '/#home-faq';

const inApp = (open: () => void) => (e: React.MouseEvent<HTMLAnchorElement>) => {
  if (!isPlainClick(e)) return;
  e.preventDefault();
  open();
};

/**
 * The one legal and contact block every page ends with: "© <year> DreamStream Studio", the Privacy Policy and
 * Terms of Service (named as the pages title themselves), the FAQ and the contact address. Real links, so a
 * new tab lands on the page; a plain click opens it in the app.
 */
export const LegalMicroLinks: React.FC<LegalMicroLinksProps> = ({ onOpenPrivacy, onOpenTerms, onOpenFaq, className, bare = false }) => {
  const Root = bare ? 'div' : 'footer';
  return (
    <Root className={cn(!bare && 'border-t border-ds-hairline bg-ds-canvas', className)}>
      <div
        className={cn(
          'mx-auto flex w-full max-w-6xl flex-col gap-x-6 gap-y-2 py-4 text-[13px] leading-5 sm:flex-row sm:items-center sm:justify-between',
          !bare && 'px-4 sm:px-6'
        )}
      >
        <p className="flex items-center gap-2 text-ds-muted">
          <StudioMark studio="dreamstream" className="size-4 text-ds-ink" />
          <span>{copyrightLine()}</span>
        </p>
        <nav aria-label="Legal and contact">
          <ul className="flex flex-wrap items-center gap-x-5 gap-y-1 coarse:gap-y-0">
            <li>
              <a href={PRIVACY_HREF} onClick={inApp(onOpenPrivacy)} className={FOOTER_LINK}>
                Privacy Policy
              </a>
            </li>
            <li>
              <a href={TERMS_HREF} onClick={inApp(onOpenTerms)} className={FOOTER_LINK}>
                Terms of Service
              </a>
            </li>
            <li>
              <a href={FAQ_HREF} onClick={inApp(onOpenFaq)} className={FOOTER_LINK}>
                FAQ
              </a>
            </li>
            <li>
              <a href={CONTACT_HREF} className={FOOTER_LINK}>
                Contact
              </a>
            </li>
          </ul>
        </nav>
      </div>
    </Root>
  );
};
