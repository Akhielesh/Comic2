import React from 'react';
import { cn } from '../../lib/utils';
import { DENSITY, FOCUS_RING } from '../chat/studioDesign';
import { HEADER_INNER } from '../ds/AppHeader';
import { SUPPORT_EMAIL } from '../legal/contacts';

interface LegalMicroLinksProps {
  onOpenPrivacy: () => void;
  onOpenTerms: () => void;
  onOpenFaq: () => void;
  className?: string;
}

/** The legal line's links: muted, ink on hover, a 44 × 44 target under a coarse pointer (short words like "FAQs" too), the ink focus ring. */
export const LEGAL_LINK = `inline-flex items-center justify-center rounded-[var(--ds-radius-sm,0.25rem)] text-[var(--ds-muted)] transition-colors duration-[var(--ds-motion-fast,120ms)] hover:text-[var(--ds-ink)] motion-reduce:transition-none ${DENSITY.coarseSquare}`;

/** The site's contact link: the one support address every DreamStream surface uses (D9; components/legal/contacts.ts). */
export const CONTACT_HREF = `mailto:${SUPPORT_EMAIL}`;

/** The quiet legal line under a page (Atlas GlobalFooter's small print): on the page, a hairline above. */
export const LegalMicroLinks: React.FC<LegalMicroLinksProps> = ({
  onOpenPrivacy,
  onOpenTerms,
  onOpenFaq,
  className = ''
}) => {
  const link = `${LEGAL_LINK} ${FOCUS_RING}`;
  return (
    <div data-slot="legal-links" className={cn('border-t border-[var(--ds-hairline)] bg-[var(--ds-canvas)]', className)}>
      <div className={cn(HEADER_INNER, 'flex flex-wrap items-center gap-x-4 gap-y-1 py-3 text-xs font-medium')}>
        <button type="button" onClick={onOpenPrivacy} className={link}>
          Privacy Policy
        </button>
        <button type="button" onClick={onOpenTerms} className={link}>
          Terms &amp; Conditions
        </button>
        <button type="button" onClick={onOpenFaq} className={link}>
          FAQs
        </button>
        <a href={CONTACT_HREF} className={link}>
          Contact
        </a>
      </div>
    </div>
  );
};
