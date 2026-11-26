// The Pages header when every page left to draw is held back (the server's plan check, PD-1: a page whose words do
// not fit its panels is left out of "Render all", never refused). There is nothing to spend, so there is no draw
// button and no price: one muted line that says which pages and why, and the way on — open the page to fit its words
// (or draw it anyway from there, an explicit draw the plan check never holds back). Muted ink, no colour.

import React from 'react';
import { PenLine } from 'lucide-react';
import type { ComicDoc, Page } from '../../../shared/comic/doc';
import { heldBackPages } from './boardModel';
import { GhostButton } from './ui';

export const HeldBackNote: React.FC<{ doc: ComicDoc; ids: readonly string[] | undefined; onOpenPage: (pageId: string) => void }> = ({ doc, ids, onOpenPage }) => {
  const { pages, sentence } = heldBackPages(doc, ids);
  if (!pages.length) return null;
  const first: Page = pages[0];
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5" data-held-back>
      <p className="min-w-0 basis-full text-[12px] leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere] sm:basis-auto">
        {sentence}. Fit the words, or draw {pages.length === 1 ? 'it' : 'them'} anyway from the page.
      </p>
      <GhostButton size="sm" onClick={() => onOpenPage(first.id)}>
        <PenLine className="h-3.5 w-3.5" aria-hidden /> Open page {first.n}
      </GhostButton>
    </div>
  );
};
