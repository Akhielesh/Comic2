// QA scene `cast-check` (PROGRAM5 P5-TRUTH item 7; the scene contract is in qa/app/index.tsx): the real Cast tab as an
// admin sees it with the free card check (shared/comic/world/lookLint.ts, CARD_LINT_STAGE = 'admins'). The heist-12p
// cast with three cards edited the way the Ramayana case's cards went wrong: a summary that names one skin colour while
// Skin names another, markings that say when they appear ("after the blessing"), and a fixed smile in the face.
// Synthetic text only. Over the browser-safe QA controller: nothing reaches the network and nothing spends.
// The scene is about card TEXT, so it is still: a sheet the fixture leaves drawing or queued is settled as a drawn one
// (the busy pill's pulsing dot belongs to the render-state scenes, studio-cast and studio-busy, not to this page).

import React, { useState } from 'react';
import { cn } from '../../../lib/utils';
import { CANVAS_BG, HEADING, INK, MUTED, OVERLINE } from '../../../components/chat/studioDesign';
import type { ComicDoc } from '../../../shared/comic/doc';
import { CastTab } from '../../../components/comicstudio/board/CastTab';
import { QA_NOW, makeQaDoc, qaAsset } from '../../../components/comicstudio/testing/qaFixtures';
import { useQaController, type QaSceneInit } from '../../../components/comicstudio/testing/qaController';
import type { QaAppScene } from '../index';

/** heist-12p with three cards that contradict themselves, change over time and hold a mood. */
export const castCheckDoc = (): ComicDoc => {
  const doc = makeQaDoc('heist-12p');
  /** A still sheet: one the fixture leaves drawing or queued is drawn here (the scene is about the card text). */
  const settled = (c: ComicDoc['cast'][number]): ComicDoc['cast'][number] =>
    c.sheet.status === 'rendering' || c.sheet.status === 'queued' ? { ...c, sheet: { status: 'ready', history: [], asset: qaAsset(`cast-check-sheet-${c.id}`, 1536, 1024), updatedAt: QA_NOW } } : c;
  const [first, second, third] = doc.cast;
  doc.cast = doc.cast.map((c) => {
    if (c === first) return settled({ ...c, look: { ...c.look, summary: `Green-skinned ${c.look.summary || 'lead'}`, skin: 'warm tan', face: 'serene calm smile' } });
    if (c === second) return settled({ ...c, kind: 'animal' as const, look: { ...c.look, markings: 'three pale stripes down its back after the blessing' } });
    if (c === third) return settled({ ...c, look: { ...c.look, face: 'a wide, friendly grin' } });
    return settled(c);
  });
  return doc;
};

function CastCheckScene() {
  const [init] = useState<QaSceneInit>(() => ({ doc: castCheckDoc(), tab: 'cast', caps: { admin: true } }));
  const studio = useQaController(init);
  return (
    <main aria-labelledby="cast-check-title" className={cn('flex min-h-[100dvh] min-w-0 flex-col', CANVAS_BG, INK)}>
      <header className="mx-auto flex w-full min-w-0 max-w-5xl shrink-0 flex-col gap-1 px-4 pb-2 pt-4 sm:px-6">
        <p className={cn('m-0', OVERLINE)}>Cast</p>
        <h1 id="cast-check-title" className={cn('m-0 text-[length:var(--ds-text-lg)]', HEADING)}>
          Card check
        </h1>
        <p className={cn('m-0 text-[length:var(--ds-text-sm)]', MUTED)}>A free note on a card that contradicts itself, says when it changes, or holds a mood in the face.</p>
      </header>
      <div className="mx-auto w-full min-w-0 max-w-5xl px-4 pb-8 sm:px-6">{studio.doc && <CastTab studio={studio} doc={studio.doc} />}</div>
    </main>
  );
}

const scene: QaAppScene = { id: 'cast-check', title: 'Cast: the free card check (admins)', Scene: CastCheckScene };
export default scene;
