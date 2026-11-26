// The Pages header when every page left to draw is held back (the server's plan check, PD-1: a page whose words do
// not fit its panels is left out of "Render all", never refused). There is nothing to spend, so there is no draw
// button and no price: one muted line that says which pages and why, and the way on — the free "Use the layout that
// fits" when one exists (shared/comic/layoutFit.ts, the breakdown card's own fix), and the page itself, to fit its
// words or draw it anyway (an explicit draw, which the plan check never holds back). Muted ink, no colour.

import React, { useMemo } from 'react';
import { LayoutTemplate, PenLine } from 'lucide-react';
import type { ComicDoc } from '../../../shared/comic/doc';
import { layoutFitFix } from '../../../shared/comic/layoutFit';
import type { DocOp } from '../../../shared/comic/ops';
import { splitHeldBack } from '../../../shared/comic/pagePlanCheck';
import { heldBackPages } from './boardModel';
import { GhostButton } from './ui';

export const HeldBackNote: React.FC<{
  doc: ComicDoc;
  ids: readonly string[] | undefined;
  onOpenPage: (pageId: string) => void;
  /** Apply a free fix (a doc patch: nothing is drawn or spent). */
  onFix: (ops: DocOp[], label: string) => void;
}> = ({ doc, ids, onOpenPage, onFix }) => {
  const { pages, sentence } = heldBackPages(doc, ids);
  const first = pages[0];
  // The layout that fits the first held-back page, when re-arranging its panels is enough (and really fits).
  const fix = useMemo(() => {
    if (!first) return null;
    const layout = splitHeldBack(doc, [first.id]).heldBack[0]?.layoutFix;
    return layoutFitFix(doc, first, layout);
  }, [doc, first]);
  if (!first) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5" data-held-back>
      <p className="min-w-0 basis-full text-[12px] leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere]">
        {sentence}. Fit the words, or draw {pages.length === 1 ? 'it' : 'them'} anyway from the page.
      </p>
      {fix && (
        <GhostButton size="sm" onClick={() => onFix(fix, 'Use the layout that fits')}>
          <LayoutTemplate className="h-3.5 w-3.5" aria-hidden /> Use the layout that fits page {first.n}
          <span className="text-[var(--ds-muted)]">· Free</span>
        </GhostButton>
      )}
      <GhostButton size="sm" onClick={() => onOpenPage(first.id)}>
        <PenLine className="h-3.5 w-3.5" aria-hidden /> Open page {first.n}
      </GhostButton>
    </div>
  );
};
