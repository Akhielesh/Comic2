// QA scene `drawing-pages` (quick2 Q-PROG; the scene contract is in qa/app/index.tsx): the Director chat while a batch of
// pages draws, the way the creator sees it. Each section is one reply carrying the run's renders card, over its own
// synthetic comic, at one moment of the run:
//
//   eight pages, mid-run       3 drawn, pages 4 and 5 drawing, 6 to 8 waiting
//   eight pages, one failed    4 drawn, page 5 didn't draw, page 6 drawing, 7 and 8 waiting
//   eight pages, finished      every page drawn
//   finished with a failure    7 drawn, page 5 didn't draw
//   one page                   page 3 drawing on its own
//
// The real reply row (`AssistantMessage`) and card renderer, fed the settle index the pane builds; over the browser-safe
// QA controller (components/comicstudio/testing/qaController.ts): nothing reaches the network and nothing spends, and a
// tap (Retry, View, a thumbnail) is recorded in window.__qaOps.

import React, { useMemo, useState } from 'react';
import { cn } from '../../../lib/utils';
import { CANVAS_BG, HEADING, INK, MUTED, OVERLINE } from '../../../components/chat/studioDesign';
import type { Card, ComicDoc, Msg, RenderState } from '../../../shared/comic/doc';
import { buildSettleIndex } from '../../../shared/comic/settle';
import { AssistantMessage, UserBubble } from '../../../components/comicstudio/conversation/MessageItem';
import { QA_NOW, makeQaDoc, qaAsset, qaPageSize } from '../../../components/comicstudio/testing/qaFixtures';
import { useQaController, type QaSceneInit } from '../../../components/comicstudio/testing/qaController';
import type { QaAppScene } from '../index';

type Phase = 'drawn' | 'drawing' | 'queued' | 'failed';

/** How long ago the drawing pages started (the card's time reads against the real clock). */
const STARTED_AGO_MS = 12_000;

const renderFor = (phase: Phase, seed: string, w: number, h: number, now: number): RenderState => {
  switch (phase) {
    case 'drawn':
      return { status: 'ready', history: [], asset: qaAsset(seed, w, h), updatedAt: QA_NOW };
    case 'drawing':
      return { status: 'rendering', history: [], updatedAt: now - STARTED_AGO_MS };
    case 'queued':
      return { status: 'queued', history: [], updatedAt: now - STARTED_AGO_MS };
    default:
      return { status: 'failed', history: [], error: 'The image service is busy right now (429: rate limited).', updatedAt: now - 40_000 };
  }
};

/**
 * heist-12p with the pages from `from` (0-based) in the given phases and a two-message conversation: the ask and the
 * run's reply carrying its renders card.
 */
export const drawingDoc = (phases: Phase[], ask: string, now: number = Date.now(), from = 0): { doc: ComicDoc; card: Card } => {
  const base = makeQaDoc('heist-12p');
  const { w, h } = qaPageSize(base.format.pageAspect);
  const inRun = (i: number) => i >= from && i < from + phases.length;
  const pages = base.pages.map((p, i) => (inRun(i) ? { ...p, render: renderFor(phases[i - from], `drawing-${i + 1}`, w, h, now) } : p));
  const drawn = pages.filter((_, i) => inRun(i));
  const label = drawn.length === 1 ? `Drawing page ${drawn[0].n}` : `Drawing pages ${drawn[0].n}–${drawn[drawn.length - 1].n}`;
  const card: Card = { type: 'renders', id: 'dp_renders', label, targets: drawn.map((p) => ({ kind: 'page' as const, id: p.id })) };
  const conversation: Msg[] = [
    { id: 'dp_u', role: 'user', text: ask, at: QA_NOW + 1_000 },
    { id: 'dp_a', role: 'assistant', text: `${label}.`, at: QA_NOW + 2_000, cards: [card] }
  ];
  return { doc: { ...base, pages, conversation }, card };
};

/** The one-page run: page 3 alone, drawing. */
const onePage = (now: number): ComicDoc => drawingDoc(['drawing'], 'Redraw page 3 with more rain.', now, 2).doc;

const SECTIONS: Array<{ id: string; title: string; doc: (now: number) => ComicDoc }> = [
  {
    id: 'mid',
    title: 'Eight pages, mid-run',
    doc: (now) => drawingDoc(['drawn', 'drawn', 'drawn', 'drawing', 'drawing', 'queued', 'queued', 'queued'], 'Draw all eight pages.', now).doc
  },
  {
    id: 'failed',
    title: 'Eight pages, one didn’t draw',
    doc: (now) => drawingDoc(['drawn', 'drawn', 'drawn', 'drawn', 'failed', 'drawing', 'queued', 'queued'], 'Draw all eight pages.', now).doc
  },
  {
    id: 'done',
    title: 'Eight pages, finished',
    doc: (now) => drawingDoc(['drawn', 'drawn', 'drawn', 'drawn', 'drawn', 'drawn', 'drawn', 'drawn'], 'Draw all eight pages.', now).doc
  },
  {
    id: 'done-failed',
    title: 'Finished, one didn’t draw',
    doc: (now) => drawingDoc(['drawn', 'drawn', 'drawn', 'drawn', 'failed', 'drawn', 'drawn', 'drawn'], 'Draw all eight pages.', now).doc
  },
  { id: 'one', title: 'One page', doc: onePage }
];

/** One reply over its own comic, through the real row and the settle index the pane builds. */
const Section: React.FC<{ id: string; title: string; doc: ComicDoc }> = ({ id, title, doc: initial }) => {
  const [init] = useState<QaSceneInit>(() => ({ doc: initial, tab: 'pages', img: 'svg' }));
  const studio = useQaController(init);
  const doc = studio.doc;
  const settles = useMemo(() => (doc ? buildSettleIndex(doc) : undefined), [doc]);
  return (
    <section aria-labelledby={`dp-${id}`} data-drawing-phase={id} className="flex min-w-0 flex-col gap-4">
      <h2 id={`dp-${id}`} className={cn('m-0', OVERLINE)}>
        {title}
      </h2>
      {(doc?.conversation || []).map((m) =>
        m.role === 'user' ? (
          <UserBubble key={m.id} text={m.text} attachments={m.attachments} urlFor={studio.urlFor} studio={studio} />
        ) : (
          <AssistantMessage key={m.id} msg={m} studio={studio} settles={settles} />
        )
      )}
    </section>
  );
};

function DrawingPagesScene() {
  const [now] = useState(() => Date.now());
  const docs = useMemo(() => SECTIONS.map((s) => ({ ...s, built: s.doc(now) })), [now]);
  return (
    <main aria-labelledby="drawing-pages-title" className={cn('flex min-h-[100dvh] min-w-0 flex-col', CANVAS_BG, INK)}>
      <header className="mx-auto flex w-full min-w-0 max-w-3xl shrink-0 flex-col gap-1 px-4 pb-2 pt-4 sm:px-6">
        <p className={cn('m-0', OVERLINE)}>Director chat</p>
        <h1 id="drawing-pages-title" className={cn('m-0 text-[length:var(--ds-text-lg)]', HEADING)}>
          Drawing several pages
        </h1>
        <p className={cn('m-0 text-[length:var(--ds-text-sm)]', MUTED)}>One run of pages as the chat shows it: while it draws, when a page fails, and once it is done.</p>
      </header>
      <div role="log" aria-label="Messages" className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-10 px-4 pb-10 pt-2 sm:px-6">
        {docs.map((s) => (
          <Section key={s.id} id={s.id} title={s.title} doc={s.built} />
        ))}
      </div>
    </main>
  );
}

const scene: QaAppScene = { id: 'drawing-pages', title: 'Director chat: drawing several pages', Scene: DrawingPagesScene };
export default scene;
