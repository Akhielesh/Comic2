// Settled cards in the conversation (PROGRAM3 SETTLE-UI; bug B2: every card in every old Director message stayed live
// and could still spend). The QA studio's heist-12p conversation, as an admin sees it with SETTLED_CARDS = 'admins':
// no settled card keeps an enabled control, the cards that must stay live (the open gate, the running renders) keep
// theirs, and settled rows mount no image.

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssetRef, Card, ComicDoc, Msg } from '../../../shared/comic/doc';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import { buildSettleIndex, settleKey } from '../../../shared/comic/settle';
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

  it('control: with settled cards off (not an admin in S2) o1 keeps its four tiles and Done, enabled', () => {
    const doc = makeQaDoc('heist-12p');
    const { container } = render(<ConversationPane studio={makeFakeStudio({ doc, caps: DEFAULT_CAPS })} />);
    expect(slot(container, 'o1')!.querySelector('[data-settled]')).toBeNull();
    expect(slot(container, 'o1')!.querySelectorAll(ENABLED_CONTROLS).length).toBeGreaterThanOrEqual(5);
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

  it('control: with settled cards off, both bubbles still offer it', () => {
    const doc = makeSampleDoc({ conversation });
    render(<ConversationPane studio={makeFakeStudio({ doc, caps: DEFAULT_CAPS })} />);
    expect(screen.getAllByRole('button', { name: /Unassigned · Assign/ })).toHaveLength(2);
  });
});
