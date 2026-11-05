import React from 'react';
import { StudioLogo } from '../brand';
import { cn } from '../../lib/utils';
import { FOCUS_RING } from '../chat/studioDesign';
import { COMPANY_NAME, HOME_HREF, isPlainClick } from './siteLinks';

interface BrandLockupProps {
  /** Opens the home page inside the app (a plain click; a new-tab click follows `href`). */
  onClick?: () => void;
  /** false: the lockup alone, not a link. */
  clickable?: boolean;
  href?: string;
  className?: string;
  /** Phone width: the mark and "DreamStream" only, so the header row fits a 320 px screen. */
  compactOnPhone?: boolean;
}

/**
 * The DreamStream lockup (components/brand StudioLogo: the house mark and "DreamStream Studio" in Space
 * Grotesk, "Studio" muted) at the Atlas header size: a 32 px mark and a 17 px wordmark. Drawn in
 * currentColor, so it follows the theme; hovering the link plays the mark's pin drop.
 */
export const BrandLockup: React.FC<BrandLockupProps> = ({ onClick, clickable = true, href = HOME_HREF, className, compactOnPhone = false }) => {
  const logo = (
    <StudioLogo
      studio="dreamstream"
      className={cn(
        // "Studio" at 60 %, not the sheet's 55 %: 5.3:1 on white instead of 4.4:1 at this 17 px size.
        '[--ds-logo-gap:10px] [--ds-logo-mark-size:32px] [--ds-logo-text-size:17px] [&_.ds-logo-word-muted]:opacity-60',
        compactOnPhone && '[&_.ds-logo-word-muted]:hidden sm:[&_.ds-logo-word-muted]:inline'
      )}
    />
  );

  if (!clickable) return <span className={cn('inline-flex min-w-0 text-ds-ink', className)}>{logo}</span>;

  return (
    <a
      href={href}
      aria-label={`${COMPANY_NAME} home`}
      onClick={(e) => {
        if (!onClick || !isPlainClick(e)) return;
        e.preventDefault();
        onClick();
      }}
      className={cn('inline-flex min-w-0 shrink-0 items-center rounded-[var(--ds-radius-control)] text-ds-ink', FOCUS_RING, className)}
    >
      {logo}
    </a>
  );
};
