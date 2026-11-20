// QA scene `chat-moved-on` (Q-SETTLE): the Comic Studio chat after the creator answered by tapping, in the real
// ConversationPane over the browser-safe QA controller (nothing reaches the network, nothing spends).
//
//   ?surface=app&scene=chat-moved-on
//
// The director asked "Which look for the rooftop chase?" and offered next steps; the creator tapped "Check page 2"
// instead of picking a look, and the page check came back (a later assistant turn, no message from the creator) with
// three fixes, the free caption fix already applied. What it shows: the question the turn moved past is gone (its words
// stay), and the notice offers only what is still open — the caption fix reads Done, its paid alternatives for page 2
// are not offered — under the newest reply's chips.

import React, { useState } from 'react';
import { cn } from '../../../lib/utils';
import { CANVAS_BG, HEADING, INK, MUTED, OVERLINE } from '../../../components/chat/studioDesign';
import type { ComicDoc, Msg } from '../../../shared/comic/doc';
import { ConversationPane } from '../../../components/comicstudio/conversation/ConversationPane';
import { QA_NOW, makeQaDoc } from '../../../components/comicstudio/testing/qaFixtures';
import { useQaController, type QaSceneInit } from '../../../components/comicstudio/testing/qaController';
import type { QaAppScene } from '../index';

/** heist-12p's comic with a short chat: a question, then the result of a tapped next step (a page check). */
export const chatMovedOnDoc = (): ComicDoc => {
  const base = makeQaDoc('heist-12p');
  const at = QA_NOW + 10_000;
  const conversation: Msg[] = [
    { id: 'mo_u0', role: 'user', text: 'Make the rooftop chase feel colder, and check page 2.', at },
    {
      id: 'mo_a1',
      role: 'assistant',
      text: 'Two looks would make the chase feel colder.',
      at: at + 1,
      cards: [
        {
          type: 'options',
          id: 'mo_look',
          question: 'Which look for the rooftop chase?',
          allowCustom: true,
          choices: [
            { id: 'l1', label: 'Blue night ink' },
            { id: 'l2', label: 'Grey rain wash' }
          ]
        }
      ],
      nextSteps: [
        { label: 'Check page 2', action: { type: 'recheck_page', pageId: 'pg_2', quotedUsd: 0.004 }, usd: 0.004 },
        { label: 'Make it funnier', say: 'Make it funnier' }
      ]
    },
    // The tap on "Check page 2" ran the check: its result is the next message, with no message from the creator.
    {
      id: 'mo_a2',
      role: 'assistant',
      text: 'Page 2 checked.',
      at: at + 3,
      cards: [
        {
          type: 'notice',
          id: 'mo_qc',
          tone: 'warn',
          text: 'Check panels on page 2: the narration in panel 2 reads better as a caption.',
          fixes: [
            { label: 'Make the line in panel 2 a caption', free: true, action: { type: 'patch', ops: [{ op: 'line', pageId: 'pg_2', panelId: 'pg_2_p2', id: 'pg_2_p2_l1', patch: { kind: 'caption' } }] } },
            { label: 'Redraw panel 2', free: false, action: { type: 'edit_page', pageId: 'pg_2', panelN: 2, instruction: 'Redraw panel 2 with room for the caption.', quotedUsd: 0.0845 } },
            { label: 'Redraw page 2', free: false, action: { type: 'render_pages', pageIds: ['pg_2'], force: true, quotedUsd: 0.0845 } }
          ]
        }
      ],
      nextSteps: [
        { label: 'Read it', client: { type: 'open_reader' }, usd: 0 },
        { label: 'Make it funnier', say: 'Make it funnier' }
      ]
    }
  ];
  return { ...base, conversation };
};

const Pane: React.FC = () => {
  const [init] = useState<QaSceneInit>(() => ({ doc: chatMovedOnDoc(), tab: 'pages', caps: { admin: true } }));
  const studio = useQaController(init);
  return (
    <div className="min-h-0 flex-1">
      <ConversationPane studio={studio} />
    </div>
  );
};

function ChatMovedOnScene() {
  return (
    <main aria-labelledby="chat-moved-on-title" className={cn('flex h-[100dvh] min-h-0 min-w-0 flex-col', CANVAS_BG, INK)}>
      <header className="mx-auto flex w-full min-w-0 max-w-3xl shrink-0 flex-col gap-1 px-4 pb-2 pt-4 sm:px-6">
        <p className={cn('m-0', OVERLINE)}>Director chat</p>
        <h1 id="chat-moved-on-title" className={cn('m-0 text-[length:var(--ds-text-lg)]', HEADING)}>
          After an answer
        </h1>
        <p className={cn('m-0 text-[length:var(--ds-text-sm)]', MUTED)}>The creator tapped a next step instead of picking a look; the page check came back with one fix already in.</p>
      </header>
      <Pane />
    </main>
  );
}

const scene: QaAppScene = { id: 'chat-moved-on', title: 'Director chat: options settle once answered', Scene: ChatMovedOnScene };
export default scene;
