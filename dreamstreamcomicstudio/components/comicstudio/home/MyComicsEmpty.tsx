// My comics with no comics yet (SH-B): the page's one warm moment. The empty-state wash (WASH_EMPTY, once on the page,
// tests/config/colourUseGuard.test.ts WASH_FILES), a line drawing in ink, what the studio does in one sentence, and one
// way to start. The action opens the idea form; it spends nothing, so the wash may sit behind it.

import React, { useId } from 'react';
import { Sparkles } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { Button } from '../../ds/Button';
import { HEADING, MUTED, RADIUS_PANEL, RISE_IN, TEXT_3XL, WASH_EMPTY } from '../../chat/studioDesign';
import { EmptyArt } from '../library/procedural/EmptyArt';

export function MyComicsEmpty({ onCreate }: { onCreate: () => void }) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      data-slot="my-comics-empty"
      className={cn('mx-auto flex max-w-3xl flex-col items-center px-4 py-16 text-center sm:px-8 sm:py-20', RADIUS_PANEL, WASH_EMPTY, RISE_IN)}
    >
      <span aria-hidden="true" className={cn('mb-6 block w-28 [&_svg]:h-auto [&_svg]:w-full', MUTED)}>
        <EmptyArt variant="studio" />
      </span>
      <h1 id={titleId} className={cn('m-0', TEXT_3XL, HEADING)}>
        No comics yet
      </h1>
      <p className={cn('m-0 mt-3 max-w-xl text-pretty text-[length:var(--ds-text-lg)] leading-7', MUTED)}>
        Describe your idea and the studio plans, draws and letters it with you.
      </p>
      <Button size="lg" className="mt-8" onClick={onCreate}>
        <Sparkles aria-hidden="true" /> Create a new comic
      </Button>
    </section>
  );
}
