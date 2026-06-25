import React from 'react';
import { cx } from './primitives';

export const LIVE_LEGAL_LINKS = [
  { label: 'Privacy', href: '/?view=privacy' },
  { label: 'Terms', href: '/?view=terms' },
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
