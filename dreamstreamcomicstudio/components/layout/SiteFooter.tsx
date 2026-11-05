import React from 'react';
import { ArrowUpRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import { OVERLINE } from '../chat/studioDesign';
import { BrandLockup } from './BrandLockup';
import { FOOTER_LINK, LegalMicroLinks } from './LegalMicroLinks';
import { isPlainClick } from './siteLinks';
import { useSiteEntries, type SiteEntry } from './studioEntries';

interface SiteFooterProps {
  onNavigate: (view: string, id?: string) => void;
  onEnterStudio: () => void;
  onOpenPrivacy: () => void;
  onOpenTerms: () => void;
  onOpenFaq: () => void;
  isAdmin?: boolean;
  /** The "tell me when it opens" capture, for a confined account without Stream Studio. */
  onNotify?: () => void;
  className?: string;
}

const FooterLink: React.FC<{ entry: SiteEntry }> = ({ entry }) => (
  <a
    href={entry.href}
    rel={entry.external ? 'noopener' : undefined}
    onClick={(e) => {
      if (!entry.onClick || !isPlainClick(e)) return;
      e.preventDefault();
      void entry.onClick();
    }}
    className={FOOTER_LINK}
  >
    {entry.label}
    {entry.external ? <ArrowUpRight aria-hidden="true" className="ml-0.5 inline size-3 align-[-1px]" /> : null}
  </a>
);

/**
 * The public pages' full footer (Atlas's public footer): the lockup and one line on DreamStream, the studios
 * (the same rows and confinement as the header's switcher) and the public pages, then the shared legal and
 * contact row (LegalMicroLinks), so the copyright, legal names and contact address match every other page.
 */
export const SiteFooter: React.FC<SiteFooterProps> = ({ onNavigate, onEnterStudio, onOpenPrivacy, onOpenTerms, onOpenFaq, isAdmin = false, onNotify, className }) => {
  const { studios, pages } = useSiteEntries({
    isAdmin,
    onGoHome: () => onNavigate('home'),
    onEnterStudio,
    onViewComics: () => onNavigate('gallery'),
    onNavigate,
    onNotify: onNotify ?? (() => onNavigate('home'))
  });
  const studioLinks = studios.filter((s) => s.id !== 'dreamstream');

  return (
    <footer className={cn('border-t border-ds-hairline bg-ds-canvas text-sm', className)}>
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 pb-8 pt-12 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr]">
        <div className="space-y-4">
          <BrandLockup clickable={false} />
          <p className="max-w-sm leading-6 text-ds-muted">
            Comic, Chat and Stream Studio under one DreamStream account. New accounts are invite-only for now.
          </p>
        </div>
        <div className="space-y-3">
          <p className={OVERLINE}>Studios</p>
          <ul className="space-y-2 coarse:space-y-0">
            {studioLinks.map((entry) => (
              <li key={entry.id}>
                <FooterLink entry={entry} />
              </li>
            ))}
          </ul>
        </div>
        <div className="space-y-3">
          <p className={OVERLINE}>Explore</p>
          <ul className="space-y-2 coarse:space-y-0">
            {pages.map((entry) => (
              <li key={entry.id}>
                <FooterLink entry={entry} />
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="border-t border-ds-hairline">
        <LegalMicroLinks bare onOpenPrivacy={onOpenPrivacy} onOpenTerms={onOpenTerms} onOpenFaq={onOpenFaq} className="mx-auto w-full max-w-6xl px-4 sm:px-6" />
      </div>
    </footer>
  );
};
