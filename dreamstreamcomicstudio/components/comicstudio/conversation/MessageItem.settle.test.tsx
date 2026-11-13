// Settled cards in the conversation (PROGRAM3 SETTLE-UI; bug B2: every card in every old Director message stayed live
// and could still spend). The QA studio's heist-12p conversation, as everyone sees it with SETTLED_CARDS = 'all' (R00):
// no settled card keeps an enabled control, the cards that must stay live (the open gate, the running renders) keep
// theirs, and settled rows mount no image.

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssetRef, Card, ComicDoc, Msg } from '../../../shared/comic/doc';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import { buildSettleIndex, settleKey } from '../../../shared/comic/settle';
import type { PendingUserMessage } from '../studioReducer';
import { makeQaDoc } from '../testing/qaFixtures';
import scene, { directorSettledDoc } from '../../../qa/app/scenes/director-settled';
import { ConversationPane } from './ConversationPane';
import { __resetEntrances } from './MessageItem';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices } from './testing/fixtures';

beforeEach(() => {
  showDollarPrices();
  __resetEntrances();
});
afterEach(resetUsageStatus);

const ADMIN = { ...DEFAULT_CAPS, admin: true };
const ENABLED_CONTROLS = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[role="button"]:not([aria-disabled="true"])',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[contenteditable="true"]'
].join(', ');

/** Every card the shared rule reads as settled, by id (folded breakdowns render nothing at all). */
const settledIds = (doc: ComicDoc): string[] => {
  const index = buildSettleIndex(doc);
  const out: string[] = [];
  for (const m of doc.conversation) for (const c of m.cards || []) {
    const s = index.get(settleKey(m.id, c.id));
    if (s?.state === 'settled' && s.outcome !== 'folded') out.push(c.id);
  }
  return out;
};

const slot = (container: HTMLElement, id: string) => container.querySelector(`[data-card-slot="${id}"]`) as HTMLElement | null;

describe('the heist-12p conversation with settled cards on', () => {
  it('has NO enabled control inside any settled card', () => {
    const doc = makeQaDoc('heist-12p');
    const { container } = render(<ConversationPane studio={makeFakeStudio({ doc, caps: ADMIN })} />);
    const ids = settledIds(doc);
    // o1 (the look question nobody answered), cp1 (a newer book card replaced it), sc1 (the chat moved past it).
    expect(ids).toEqual(expect.arrayContaining(['o1', 'cp1', 'sc1']));
    for (const id of ids) {
      const s = slot(container, id);
      expect(s, `card ${id} is in the conversation`).not.toBeNull();
      expect(s!.querySelector('[data-settled]'), `card ${id} is a settled row`).not.toBeNull();
      expect(s!.querySelectorAll(ENABLED_CONTROLS), `card ${id} has no enabled control`).toHaveLength(0);
      expect(s!.querySelectorAll('img'), `card ${id} mounts no image`).toHaveLength(0);
      expect(s!.querySelectorAll('a').length, `card ${id} keeps at most one link`).toBeLessThanOrEqual(1);
    }
    expect(slot(container, 'o1')!.textContent).toBe('Not answered — you moved on');
    expect(slot(container, 'cp1')!.textContent).toBe('Closed — a newer plan replaced it');
  });

  it('a non-admin sees the same (R00 SF-1, settled cards for everyone): o1 is one line with no control left to tap', () => {
    const doc = makeQaDoc('heist-12p');
    const { container } = render(<ConversationPane studio={makeFakeStudio({ doc, caps: DEFAULT_CAPS })} />);
    expect(DEFAULT_CAPS.admin).not.toBe(true);
    const o1 = slot(container, 'o1')!;
    expect(o1.querySelector('[data-settled]')).not.toBeNull();
    expect(o1.textContent).toBe('Not answered — you moved on');
    expect(o1.querySelectorAll(ENABLED_CONTROLS)).toHaveLength(0);
    expect(slot(container, 'cp1')!.textContent).toBe('Closed — a newer plan replaced it');
  });

  it('a long chat: every old card is a line; the open gate and the running renders stay live however old', () => {
    const doc = directorSettledDoc();
    const { container } = render(<ConversationPane studio={makeFakeStudio({ doc, caps: ADMIN })} />);
    const ids = settledIds(doc);
    expect(ids.length).toBeGreaterThanOrEqual(15);
    for (const id of ids) {
      const s = slot(container, id)!;
      expect(s.querySelectorAll(ENABLED_CONTROLS), `card ${id} has no enabled control`).toHaveLength(0);
      expect(s.querySelectorAll('img'), `card ${id} mounts no image`).toHaveLength(0);
    }
    // The open "Render all" gate: still the one live approval.
    expect(within(slot(container, 'cg1')!).getByRole('button', { name: /^Approve ·/ })).toBeInTheDocument();
    // The running renders: still showing their progress.
    expect(slot(container, 'cr1')!.querySelector('[data-settled]')).toBeNull();
    // The last reply's question is open.
    expect(within(slot(container, 'ds_cover')!).getByRole('button', { name: /Back to back in the rain/ })).toBeEnabled();
    // The stamped approval reads its outcome, the answered question its answer, the conflict what was kept.
    expect(slot(container, 'ds_gate_old')!.textContent).toBe('Approved · ≈ $0.42 · 6 images');
    expect(slot(container, 'ds_end')!.textContent).toBe('You picked They team up');
    expect(slot(container, 'card_qa_conflict')!.textContent).toBe('Kept yours (1) · used the director’s (1)');
    expect(within(slot(container, 'ds_renders')!).getByRole('link', { name: 'Open the pages' })).toBeInTheDocument();
  });

  it('the QA scene’s history (the page the layout smoke measures): every card is a settled line, no control, no image', () => {
    const { container } = render(<scene.Scene />);
    const slots = [...container.querySelectorAll('[data-card-slot]')];
    expect(slots.length).toBeGreaterThanOrEqual(18);
    for (const s of slots) {
      expect(s.querySelector('[data-settled]'), `card ${s.getAttribute('data-card-slot')} is a settled row`).not.toBeNull();
      expect(s.querySelectorAll(ENABLED_CONTROLS), `card ${s.getAttribute('data-card-slot')} has no control`).toHaveLength(0);
    }
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelector('[data-card-slot="cg1"]')!.textContent).toMatch(/^Approved · ≈ \$[\d.]+ · \d+ images$/);
    expect(container.querySelector('[data-card-slot="ds_cover"]')!.textContent).toBe('You picked Back to back in the rain');
    expect(container.querySelector('[data-card-slot="cr1"]')!.textContent).toMatch(/^Drew \d+ pages, the cover/);
  });

  it('settled rows are quiet for the log (aria-live off) and stack 4 px apart inside a reply', () => {
    const doc = directorSettledDoc();
    const { container } = render(<ConversationPane studio={makeFakeStudio({ doc, caps: ADMIN })} />);
    for (const row of container.querySelectorAll('[data-settled]')) expect(row).toHaveAttribute('aria-live', 'off');
    // The a5 reply: cast, then the open gate, then settled rows back to back.
    const reply = slot(container, 'n1')!.parentElement!;
    expect(reply.className).toContain('[&>[data-settled-slot]+[data-settled-slot]]:!mt-1');
    expect(slot(container, 'n1')!.hasAttribute('data-settled-slot')).toBe(true);
    expect(slot(container, 'n2')!.hasAttribute('data-settled-slot')).toBe(true);
    expect(slot(container, 'cg1')!.hasAttribute('data-settled-slot')).toBe(false);
  });
});

describe('the user bubble’s Assign', () => {
  const photo = (n: number): AssetRef => ({ path: `u/x/inbox/photo_${n}.webp`, source: 'upload', at: 1 });
  const conversation: Msg[] = [
    { id: 'u1', role: 'user', text: 'Here is Maya', at: 1, attachments: [photo(1)] },
    { id: 'a1', role: 'assistant', text: 'Got it.', at: 2, cards: [{ type: 'notice', id: 'n', tone: 'info', text: 'Saved.' } as Card] },
    { id: 'u2', role: 'user', text: 'And her partner', at: 3, attachments: [photo(2)] }
  ];

  it('shows only on the latest user message; an older unfiled photo reads "Not filed yet"', () => {
    const doc = makeSampleDoc({ conversation });
    const { container } = render(<ConversationPane studio={makeFakeStudio({ doc, caps: ADMIN })} />);
    const [older, latest] = [...container.querySelectorAll('[data-role="user"]')] as HTMLElement[];
    expect(within(older).queryByRole('button', { name: /assign/i })).toBeNull();
    expect(within(older).getByText('Not filed yet')).toBeInTheDocument();
    expect(within(latest).getAllByRole('button', { name: /assign/i }).length).toBeGreaterThan(0);
  });

  it('while this tab’s next message is sending, no committed bubble offers it (none is the latest any more)', () => {
    const doc = makeSampleDoc({ conversation });
    const pending: PendingUserMessage = { id: 'pm_1', text: 'One more of her in the rain', attachments: [], at: 4, status: 'sending' };
    const { container } = render(<ConversationPane studio={makeFakeStudio({ doc, caps: ADMIN, pendingMessage: pending, messageBusy: true })} />);
    const bubbles = [...container.querySelectorAll('[data-role="user"]')] as HTMLElement[];
    // u1, u2 and the bubble on its way.
    expect(bubbles).toHaveLength(3);
    for (const b of bubbles) expect(within(b).queryByRole('button', { name: /assign/i })).toBeNull();
    expect(within(bubbles[1]).getByText('Not filed yet')).toBeInTheDocument();
  });

  it('a sent photo is a 64 px tile: its 480w variant, lazy, never the original bare; a file the signer gave up on reads unavailable (PF-2 #1)', () => {
    const withVariant: AssetRef = { path: 'u/x/inbox/photo_v.png', w: 1536, h: 1536, source: 'upload', at: 1, variants: [{ path: 'u/x/inbox/photo_v_w480.webp', w: 480, h: 480 }] };
    const broken: AssetRef = { path: 'u/x/inbox/photo_b.png', w: 1536, h: 1536, source: 'upload', at: 1, variants: [{ path: 'u/x/inbox/photo_b_w480.webp', w: 480, h: 480 }] };
    const calls: Array<{ path: string; width?: number }> = [];
    const urlFor = (asset?: AssetRef | string | null, opts?: { width?: number }) => {
      if (!asset) return undefined;
      const path = typeof asset === 'string' ? asset : asset.path;
      calls.push({ path, width: opts?.width });
      const pick = typeof asset === 'object' && opts?.width && asset.variants?.length ? asset.variants[0].path : path;
      return `https://cdn.test/${pick}`;
    };
    const doc = makeSampleDoc({ conversation: [{ id: 'u1', role: 'user', text: 'Two photos', at: 1, attachments: [withVariant, broken] }] });
    const studio = { ...makeFakeStudio({ doc, caps: ADMIN, urlFor }), isUnsignable: (p: string) => p === 'u/x/inbox/photo_b_w480.webp' };
    const { container } = render(<ConversationPane studio={studio} />);
    const bubble = container.querySelector('[data-role="user"]') as HTMLElement;
    const imgs = [...bubble.querySelectorAll('img')];
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toHaveAttribute('src', 'https://cdn.test/u/x/inbox/photo_v_w480.webp');
    expect(imgs[0].getAttribute('srcset')).toBe('https://cdn.test/u/x/inbox/photo_v_w480.webp 480w');
    expect(imgs[0]).toHaveAttribute('loading', 'lazy');
    expect(imgs[0]).toHaveAttribute('decoding', 'async');
    expect(imgs[0]).not.toHaveAttribute('data-heavy-img');
    expect(within(bubble).getByRole('img', { name: 'Photo 2: preview unavailable' })).toBeInTheDocument();
    // The originals are never asked for without a width (the thumbnail guard's rule).
    expect(calls.filter((c) => c.path.startsWith('u/x/inbox/') && !c.path.includes('_w480') && !c.width)).toEqual([]);
  });

  it('a non-admin gets the same rule (R00 SF-1): only the latest bubble offers it', () => {
    const doc = makeSampleDoc({ conversation });
    render(<ConversationPane studio={makeFakeStudio({ doc, caps: DEFAULT_CAPS })} />);
    expect(screen.getAllByRole('button', { name: /Unassigned · Assign/ })).toHaveLength(1);
    expect(screen.getByText('Not filed yet')).toBeInTheDocument();
  });
});
