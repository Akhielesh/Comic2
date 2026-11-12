// QA scene `director-settled` (PROGRAM3 SETTLE-UI; the scene contract is in qa/app/index.tsx): the Comic Studio
// conversation as an admin sees it with settled cards on (shared/comic/settle.ts SETTLED_CARDS = 'admins'). The
// heist-12p conversation runs on past its last reply, so almost every old card has settled into its one line ("Not
// answered — you moved on", "Closed — a newer plan replaced it", "Approved · ≈ $0.42 · 6 images", "Kept yours (1) ·
// used the director's (1)", a notice's words), while the cards that must stay live keep their controls however old:
// the open "Render all" gate and the running renders. The last reply asks a question that is still open.
//
// The real ConversationPane over the browser-safe QA controller (components/comicstudio/testing/qaController.ts):
// nothing reaches the network and nothing spends; a tap is recorded in window.__qaOps. The layout smoke measures it
// at 320 to 1440 px, light and dark, so a settled row never overflows a phone and its one link keeps a 44 px target.

import React, { useState } from 'react';
import { cn } from '../../../lib/utils';
import { CANVAS_BG, HEADING, INK, MUTED, OVERLINE } from '../../../components/chat/studioDesign';
import type { Card, ComicDoc, Msg } from '../../../shared/comic/doc';
import { gateClosedFor, type GateCardStamped } from '../../../shared/comic/settle';
import { ConversationPane } from '../../../components/comicstudio/conversation/ConversationPane';
import { QA_NOW, makeQaDoc, qaConflictCard } from '../../../components/comicstudio/testing/qaFixtures';
import { useQaController, type QaSceneInit } from '../../../components/comicstudio/testing/qaController';
import type { QaAppScene } from '../index';

/**
 * heist-12p, then three more turns: an answered question, an approval a later gate followed (stamped `approved`), a
 * conflict the creator answered, a done renders card; and a last reply whose question is still open.
 */
export const directorSettledDoc = (): ComicDoc => {
  const base = makeQaDoc('heist-12p');
  let at = QA_NOW + 1_000;
  const msgs: Msg[] = [];
  const user = (text: string) => msgs.push({ id: `ds_u${msgs.length}`, role: 'user', text, at: at++ });
  const reply = (text: string, cards: Card[]) => msgs.push({ id: `ds_a${msgs.length}`, role: 'assistant', text, at: at++, cards });
  const conflict = qaConflictCard(base);
  const drawn = base.pages.filter((p) => p.render.status === 'ready').slice(0, 2);
  const approved: GateCardStamped = {
    type: 'gate',
    id: 'ds_gate_old',
    gateId: 'ds_gate_old',
    closed: gateClosedFor({ estimateUsd: 0.42, imageCount: 6, model: 'Nano Banana 2.1' }, 'approved', 'user', QA_NOW)
  };
  user('Keep the rain. And give Maya her red scarf on every page, please.');
  reply('Done: her scarf is red on every page. Two things first.', [
    {
      type: 'options',
      id: 'ds_end',
      question: 'How should the chase end?',
      choices: [
        { id: 'e1', label: 'She catches him' },
        { id: 'e2', label: 'He gets away' },
        { id: 'e3', label: 'They team up' }
      ],
      answered: ['e3']
    },
    approved,
    ...(conflict ? [{ ...conflict, items: conflict.items.map((it, i) => ({ ...it, resolved: i === 0 ? ('mine' as const) : ('theirs' as const) })) }] : []),
    ...(drawn.length ? [{ type: 'renders' as const, id: 'ds_renders', label: 'Pages with the red scarf', targets: drawn.map((p) => ({ kind: 'page' as const, id: p.id })) }] : [])
  ]);
  user('They team up. Now the cover, with both of them on the rooftop.');
  reply('Here is how I would frame the cover.', [
    {
      type: 'options',
      id: 'ds_cover',
      question: 'Which cover?',
      allowCustom: true,
      choices: [
        { id: 'k1', label: 'Back to back in the rain' },
        { id: 'k2', label: 'Leaping between roofs' },
        { id: 'k3', label: 'Silhouettes at dawn' }
      ]
    }
  ]);
  return { ...base, conversation: [...base.conversation, ...msgs] };
};

function DirectorSettledScene() {
  const [init] = useState<QaSceneInit>(() => ({ doc: directorSettledDoc(), tab: 'pages', caps: { admin: true } }));
  const studio = useQaController(init);
  return (
    <main aria-labelledby="director-settled-title" className={cn('flex h-[100dvh] min-h-0 min-w-0 flex-col', CANVAS_BG, INK)}>
      <header className="flex min-w-0 shrink-0 flex-col gap-1 px-4 pb-2 pt-4 sm:px-6">
        <p className={cn('m-0', OVERLINE)}>Director chat</p>
        <h1 id="director-settled-title" className={cn('m-0 text-[length:var(--ds-text-lg)]', HEADING)}>
          Settled cards
        </h1>
        <p className={cn('m-0 text-[length:var(--ds-text-sm)]', MUTED)}>
          Once the chat moves on, an old card is one line with no controls. The open approval and the running pages stay live.
        </p>
      </header>
      <div className="min-h-0 flex-1">
        <ConversationPane studio={studio} />
      </div>
    </main>
  );
}

const scene: QaAppScene = { id: 'director-settled', title: 'Director chat: settled cards (admins)', Scene: DirectorSettledScene };
export default scene;
