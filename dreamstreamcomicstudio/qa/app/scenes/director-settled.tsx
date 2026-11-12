// QA scene `director-settled` (PROGRAM3 SETTLE-UI; the scene contract is in qa/app/index.tsx): the Comic Studio
// Director chat as an admin sees it with settled cards on (shared/comic/settle.ts SETTLED_CARDS = 'admins').
//
//   ?surface=app&scene=director-settled          the history: heist-12p and three more turns, every card settled
//                                                 into its one line (the page the layout smoke measures)
//   ?surface=app&scene=director-settled&pane=1   the same chat one step earlier in the real ConversationPane, with
//                                                 the cards that stay live however old: the open "Render all" gate,
//                                                 the running renders and the last reply's open question
//
// The default page is the reply column itself (the pane's rows, `AssistantMessage` / `UserBubble`, fed the same
// settle index the pane builds), so the smoke measures the settled rows at 320 to 1440 px, light and dark, without
// the composer and the live cards, which the studio scenes measure. Lines it shows: "Not answered — you moved on",
// "Closed — a newer plan replaced it", "Approved · ≈ $0.42 · 6 images", "Kept yours (1) · used the director's (1)",
// "Drew 9 pages, the cover, … · Open the pages", a notice's words, "Setup confirmed · …", "You picked …".
//
// Over the browser-safe QA controller (components/comicstudio/testing/qaController.ts): nothing reaches the network
// and nothing spends; a tap on a link is recorded in window.__qaOps.

import React, { useMemo, useState } from 'react';
import { cn } from '../../../lib/utils';
import { CANVAS_BG, HEADING, INK, MUTED, OVERLINE } from '../../../components/chat/studioDesign';
import type { Card, ComicDoc, Msg, RenderState } from '../../../shared/comic/doc';
import { buildSettleIndex, gateClosedFor, gateStampOps, type GateCardStamped } from '../../../shared/comic/settle';
import { applyOps } from '../../../shared/comic/ops';
import { ConversationPane } from '../../../components/comicstudio/conversation/ConversationPane';
import { AssistantMessage, UserBubble } from '../../../components/comicstudio/conversation/MessageItem';
import { QA_NOW, makeQaDoc, qaConflictCard } from '../../../components/comicstudio/testing/qaFixtures';
import { useQaController, type QaSceneInit } from '../../../components/comicstudio/testing/qaController';
import type { QaAppScene } from '../index';

/**
 * heist-12p, then three more turns: an answered question, an approval a later gate followed (stamped `approved`), a
 * conflict the creator answered, a done renders card; and a last reply whose question is still open. The open
 * "Render all" gate and the running renders of heist-12p stay live.
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

const finished = <R extends RenderState>(r: R): R => (r.status === 'queued' || r.status === 'rendering' ? { ...r, status: 'ready' } : r);

/**
 * The same chat a little later: the creator approved "Render all" (stamped by the server as jobs.ts commitGate does),
 * every page finished, and the cover question was answered. Every card in it is settled.
 */
export const directorSettledHistoryDoc = (): ComicDoc => {
  const live = directorSettledDoc();
  const gate = live.gate;
  let doc: ComicDoc = {
    ...live,
    gate: gate ? { ...gate, status: 'approved' } : gate,
    pages: live.pages.map((p) => ({ ...p, render: finished(p.render) })),
    cast: live.cast.map((c) => ({ ...c, sheet: finished(c.sheet) })),
    style: { ...live.style, options: live.style.options.map((o) => ({ ...o, render: finished(o.render) })) },
    conversation: [
      ...live.conversation.map((m) => (m.id === 'ds_a3' ? { ...m, cards: (m.cards || []).map((c) => (c.id === 'ds_cover' ? { ...c, answered: ['k1'] } : c)) } : m)),
      { id: 'ds_u4', role: 'user', text: 'Back to back in the rain.', at: QA_NOW + 2_000 }
    ]
  };
  if (gate) doc = applyOps(doc, gateStampOps(doc, gate.id, gateClosedFor(gate, 'approved', 'user', QA_NOW + 1_500)), QA_NOW + 1_500);
  return doc;
};

/** The reply column: the pane's own rows, fed the settle index the pane builds (SETTLED_CARDS on for an admin). */
const History: React.FC = () => {
  const [init] = useState<QaSceneInit>(() => ({ doc: directorSettledHistoryDoc(), tab: 'pages', caps: { admin: true } }));
  const studio = useQaController(init);
  const doc = studio.doc;
  const settles = useMemo(() => (doc ? buildSettleIndex(doc) : undefined), [doc]);
  const lastUser = doc ? [...doc.conversation].reverse().find((m) => m.role === 'user')?.id : undefined;
  return (
    <div role="log" aria-label="Messages" className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6 px-4 pb-8 pt-2 sm:px-6">
      {(doc?.conversation || []).map((m) =>
        m.role === 'user' ? (
          <UserBubble key={m.id} text={m.text} attachments={m.attachments} urlFor={studio.urlFor} studio={studio} latest={m.id === lastUser} />
        ) : (
          <AssistantMessage key={m.id} msg={m} studio={studio} settles={settles} />
        )
      )}
    </div>
  );
};

/** One step earlier, in the real pane: the old cards are lines, the open gate, the running pages and the question are live. */
const LivePane: React.FC = () => {
  const [init] = useState<QaSceneInit>(() => ({ doc: directorSettledDoc(), tab: 'pages', caps: { admin: true } }));
  const studio = useQaController(init);
  return (
    <div className="min-h-0 flex-1">
      <ConversationPane studio={studio} />
    </div>
  );
};

const wantsPane = (): boolean => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('pane') === '1';

function DirectorSettledScene() {
  const [pane] = useState(wantsPane);
  return (
    <main aria-labelledby="director-settled-title" className={cn('flex min-w-0 flex-col', pane ? 'h-[100dvh] min-h-0' : 'min-h-[100dvh]', CANVAS_BG, INK)}>
      <header className="mx-auto flex w-full min-w-0 max-w-3xl shrink-0 flex-col gap-1 px-4 pb-2 pt-4 sm:px-6">
        <p className={cn('m-0', OVERLINE)}>Director chat</p>
        <h1 id="director-settled-title" className={cn('m-0 text-[length:var(--ds-text-lg)]', HEADING)}>
          Settled cards
        </h1>
        <p className={cn('m-0 text-[length:var(--ds-text-sm)]', MUTED)}>
          {pane
            ? 'One step earlier: the old cards are one line each, while the open approval, the pages still drawing and the last question stay live.'
            : 'Once the chat moves on, an old card is one line with no controls: what was chosen, or what happened.'}
        </p>
      </header>
      {pane ? <LivePane /> : <History />}
    </main>
  );
}

const scene: QaAppScene = { id: 'director-settled', title: 'Director chat: settled cards (admins)', Scene: DirectorSettledScene };
export default scene;
