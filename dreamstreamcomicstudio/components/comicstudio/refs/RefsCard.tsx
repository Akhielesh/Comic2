// The live `refs` conversation card (refs.md §2.1, §6.6): "Added 5 photos to MAYA" with the photos
// that are still on that owner, Manage (opens the drawer) and the model-sheet offer with its price.
// Owner: P1-REFS. It renders CURRENT doc state: photos moved or removed since drop out, and an owner
// that no longer exists says so instead of showing stale thumbnails.

import React, { useState } from 'react';
import { Images, Sparkles } from 'lucide-react';
import type { Card } from '../../../shared/comic/doc';
import { refsOf } from '../../../shared/comic/refs';
import { effectiveRating } from '../../../shared/comic/safety';
import { byokFromDoc } from '../board/boardModel';
import type { CardProps } from '../extensions';
import { CardShell, GhostButton, PrimaryButton, plural } from '../conversation/ui';
import { SafetyVeil } from '../safety/SafetyVeil';
import { RefsDrawer } from './RefsDrawer';
import { ownerLabel, sheetHint } from './refsModel';
import { useCostFormat } from '../conversation/cost';

type RefsCardType = Extract<Card, { type: 'refs' }>;

export const RefsCard: React.FC<CardProps<RefsCardType>> = ({ card, studio }) => {
  const [open, setOpen] = useState(false);
  // Prices in the viewer's terms: governed users read a share of their usage, never dollars.
  const cost = useCostFormat(studio);
  const doc = studio.doc;
  const list = doc ? refsOf(doc, card.owner) : undefined;
  const name = ownerLabel(doc, card.owner);
  if (!doc) return null;
  if (!list) {
    return (
      <CardShell title="Photos" icon={<Images className="h-4 w-4" aria-hidden />}>
        <p className="text-[13px] text-[var(--ds-muted)]">That {card.owner.kind === 'place' ? 'place' : 'character'} is no longer in the story.</p>
      </CardShell>
    );
  }
  const wanted = new Set(card.paths || []);
  const here = list.filter((r) => wanted.has(r.path));
  const rating = effectiveRating(doc, studio.caps?.ratingCeiling).rating;
  const hint = sheetHint(doc, card.owner, byokFromDoc(doc), cost.approx);
  const character = card.owner.kind === 'character' ? doc.cast.find((c) => c.id === (card.owner as { id: string }).id) : undefined;
  const target = card.owner.kind === 'style' ? 'the style' : name;
  const title = here.length ? `${plural(here.length, 'photo')} on ${target}` : `Photos for ${target}`;

  return (
    <CardShell title={title} icon={<Images className="h-4 w-4" aria-hidden />} right={`${list.length} total`}>
      {here.length > 0 ? (
        <ul className="flex min-w-0 flex-wrap gap-2" aria-label={title}>
          {here.slice(0, 8).map((r) => {
            const i = list.indexOf(r);
            const src = studio.urlFor(r, { width: 160 });
            return (
              <li key={r.path} className="relative h-16 w-16 overflow-hidden rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)]">
                <SafetyVeil asset={r} rating={rating}>
                  {src ? <img src={src} alt={`Photo ${i + 1}${i === 0 ? ' (main)' : ''}`} className="h-full w-full object-cover" loading="lazy" decoding="async" /> : <span className="block h-full w-full" />}
                </SafetyVeil>
                {i === 0 && <span className="absolute left-0.5 top-0.5 rounded-full bg-black/55 px-1 text-[9px] font-semibold leading-4 text-white">★</span>}
              </li>
            );
          })}
          {here.length > 8 && <li className="flex h-16 w-16 items-center justify-center rounded-xl bg-[var(--ds-well)] text-[12px] font-semibold text-[var(--ds-ink)]">+{here.length - 8}</li>}
        </ul>
      ) : (
        <p className="text-[13px] text-[var(--ds-muted)]">These photos were moved or removed since.</p>
      )}
      <div className="mt-3 flex min-w-0 flex-wrap gap-2">
        <GhostButton className="min-h-[44px]" onClick={() => setOpen(true)}>
          Manage photos
        </GhostButton>
        {character && hint && (hint.missing || hint.changed) && (
          <PrimaryButton
            className="min-h-[44px]"
            disabled={studio.isRendering({ kind: 'sheet', id: character.id })}
            onClick={() => void studio.act({ type: 'render_sheets', characterIds: [character.id], ...(hint.changed ? { force: true } : {}) })}
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
            {hint.changed ? `Redraw ${name}'s sheet` : `Draw ${name}'s sheet`}
            {hint.price && <span className="font-normal opacity-90"> {hint.price}</span>}
          </PrimaryButton>
        )}
      </div>
      <RefsDrawer studio={studio} owner={card.owner} open={open} onClose={() => setOpen(false)} />
    </CardShell>
  );
};

export default RefsCard;
