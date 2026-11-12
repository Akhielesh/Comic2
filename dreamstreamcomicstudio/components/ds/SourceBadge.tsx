/**
 * SourceBadge — where something came from, in stored facts only (redesign plan §4; it replaces the font licence
 * pill): "OFL · Google Fonts", "CC0 · Freesound", "Made by DreamStream". It shows what the record says and nothing
 * it would have to guess: no licence inferred from a name, no "free" claimed for something the record does not
 * call free. A missing fact is left out, and with no facts at all the badge renders nothing.
 *
 * With `href` (the licence text) it is a link that opens in a new tab with no referrer.
 */
import React from 'react';
import { BadgeCheck } from 'lucide-react';
import { cn } from '../../lib/utils';
import { CHIP, CHIP_VARIANT, FOCUS_RING } from './recipes';

export interface SourceBadgeProps {
  /** The stored licence id or short name ("OFL", "Apache-2.0", "CC0"). */
  licence?: string | null;
  /** The stored source ("Google Fonts", "Freesound", "Made by DreamStream"). */
  source?: string | null;
  /** The stored link to the licence or the source page (https only). */
  href?: string | null;
  className?: string;
}

const clean = (s: string | null | undefined) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, 60) : '');
const safeHref = (href: string | null | undefined) => (typeof href === 'string' && /^https:\/\//i.test(href.trim()) ? href.trim() : null);

export function SourceBadge({ licence, source, href, className }: SourceBadgeProps) {
  const facts = [clean(licence), clean(source)].filter(Boolean);
  if (!facts.length) return null;
  const text = facts.join(' · ');
  const body = (
    <>
      <BadgeCheck aria-hidden="true" className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{text}</span>
    </>
  );
  const link = safeHref(href);
  if (link) {
    return (
      <a href={link} target="_blank" rel="noreferrer noopener" data-slot="source-badge" className={`${cn(CHIP, CHIP_VARIANT.outline, 'no-underline hover:text-[var(--ds-ink)]', className)} ${FOCUS_RING}`}>
        {body}
      </a>
    );
  }
  return (
    <span data-slot="source-badge" className={cn(CHIP, CHIP_VARIANT.outline, className)}>
      {body}
    </span>
  );
}
