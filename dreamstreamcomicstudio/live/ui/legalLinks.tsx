import React from 'react';
import { mainAppUrl } from '@/services/liveLink';
import { cx } from './primitives';

// The legal pages live in the main app: absolute links on Stream Studio's own host.
export const LIVE_LEGAL_LINKS = [
  { label: 'Privacy', href: mainAppUrl('/?view=privacy') },
  { label: 'Terms', href: mainAppUrl('/?view=terms') },
  { label: 'Support', href: 'mailto:contact@dreamstream.com?subject=Stream%20Studio%20support' },
] as const;

type LiveLegalLinksProps = {
  className?: string;
  compact?: boolean;
};

export function LiveLegalLinks({ className, compact = false }: LiveLegalLinksProps) {
  return (
    <nav className={cx('legal-links', compact && 'compact', className)} aria-label="Legal and support links">
      {LIVE_LEGAL_LINKS.map((link) => (
        <a key={link.label} href={link.href}>
          {link.label}
        </a>
      ))}
    </nav>
  );
}
