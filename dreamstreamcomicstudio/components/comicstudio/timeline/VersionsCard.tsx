// The `versions` conversation card (contract §13.2, posted by the director's list_versions): a live
// mini version stack for one image — thumbnails, what each cost, and "Use this" (free, instant).
// It renders LIVE doc state, so an old card always shows the image's versions as they are now.

import React from 'react';
import { Layers } from 'lucide-react';
import { getRender, targetLabel, type Card } from '../../../shared/comic/doc';
import type { CardProps } from '../extensions';
import { CardShell } from '../conversation/ui';
import { VersionStack } from './VersionStack';
import { versionCount } from './bookModel';

export type VersionsCardData = Extract<Card, { type: 'versions' }>;

export const VersionsCard: React.FC<CardProps<VersionsCardData>> = ({ card, studio }) => {
  const doc = studio.doc;
  if (!doc || !card?.target) return null;
  const exists = !!getRender(doc, card.target);
  const label = exists ? targetLabel(doc, card.target) : 'That image';
  const n = exists ? versionCount(doc, card.target) : 0;
  return (
    <CardShell title={`${label} · versions`} icon={<Layers className="h-4 w-4" aria-hidden />} right={n ? `${n} saved · switching is free` : undefined} aria-label={`${label} versions`}>
      {exists ? (
        <VersionStack studio={studio} target={card.target} compact />
      ) : (
        <p className="text-[13px] text-[var(--ds-muted)]">That image is no longer in the comic (it may have been deleted — check Media → Deleted).</p>
      )}
    </CardShell>
  );
};

export default VersionsCard;
