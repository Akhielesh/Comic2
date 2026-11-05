// A message sent from outside the composer that the studio refuses goes to the message box instead of being lost
// (agent-editor plan §3 A1): the helper itself, then each call site — the page editor's "Ask the director about this
// balloon", the Pages tab's and the timeline's "Write this page with AI".

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { computeAccessibleName } from 'dom-accessibility-api';
import { COMPOSE_EVENT, keepRefusedInComposer, type ComposeRequest } from './composerBus';
import { PageEditor } from '../board/PageEditor';
import { PagesTab } from '../board/PagesTab';
import { BookTimeline } from '../timeline/BookTimeline';
import { SAMPLE_NOW, makeSampleDoc as makeBoardDoc, makeStudio } from '../board/__fixtures__/sampleDoc';
import { makeFakeStudio, makeSampleDoc as makeChatDoc, resetUsageStatus, showDollarPrices } from './testing/fixtures';
import type { SendOutcome } from '../types';

const allowance = vi.hoisted(() => ({ status: null as unknown }));
vi.mock('../../usage/useUsageAllowance', () => ({ useUsageAllowance: () => allowance.status }));

let composed: ComposeRequest[] = [];
const onCompose = (e: Event) => composed.push((e as CustomEvent<ComposeRequest>).detail);
/** Lets the send promise and the helper's `.then`s settle. */
const settle = () => act(async () => {});
const sendResolving = (outcome: SendOutcome | undefined) => vi.fn(async () => outcome);

beforeEach(() => {
  composed = [];
  window.addEventListener(COMPOSE_EVENT, onCompose);
  vi.spyOn(Date, 'now').mockReturnValue(SAMPLE_NOW);
});
afterEach(() => {
  window.removeEventListener(COMPOSE_EVENT, onCompose);
  vi.restoreAllMocks();
});

describe('keepRefusedInComposer', () => {
  it("a 'refused' send puts the words in the message box, after any draft", async () => {
    await keepRefusedInComposer(Promise.resolve('refused'), 'Write page 2 for me');
    expect(composed).toEqual([{ text: 'Write page 2 for me', append: true }]);
  });

  it('a send that fails outright keeps the words too', async () => {
    await keepRefusedInComposer(Promise.reject(new Error('offline')), 'Write page 2 for me');
    expect(composed).toEqual([{ text: 'Write page 2 for me', append: true }]);
  });

  it("'sent', 'queued', 'held' and an older controller's void leave the message box alone", async () => {
    for (const outcome of ['sent', 'queued', 'held', undefined]) await keepRefusedInComposer(Promise.resolve(outcome), 'Write page 2 for me');
    expect(composed).toEqual([]);
  });
});

describe('call sites', () => {
  it('page editor: a refused "Ask the director about this balloon" goes to the message box with its balloon prefix', async () => {
    const doc = makeBoardDoc();
    const send = sendResolving('refused');
    const studio = makeStudio(doc, { focusedPageId: 'pg_1', send });
    render(<PageEditor studio={studio} doc={doc} pageId="pg_1" />);
    const hit = document.querySelector<HTMLElement>('[data-testid="balloon-hit"][data-line-id="pg_1_l4"]')!;
    fireEvent.pointerDown(hit, { clientX: 5, clientY: 5, button: 0, pointerType: 'mouse' });
    fireEvent.pointerUp(window, { clientX: 5, clientY: 5 });
    const ask = screen.getByLabelText('Ask the director about this balloon');
    fireEvent.change(ask, { target: { value: 'make it shorter' } });
    fireEvent.submit(ask.closest('form')!);
    await settle();
    expect(send).toHaveBeenCalledWith('(about the selected balloon) make it shorter', { focus: 'selection' });
    expect(composed).toEqual([{ text: '(about the selected balloon) make it shorter', append: true }]);
  });

  it('page editor: an ask that went (or waits in Up next) does not touch the message box', async () => {
    const doc = makeBoardDoc();
    const studio = makeStudio(doc, { focusedPageId: 'pg_1', send: sendResolving('queued') });
    render(<PageEditor studio={studio} doc={doc} pageId="pg_1" />);
    const hit = document.querySelector<HTMLElement>('[data-testid="balloon-hit"][data-line-id="pg_1_l4"]')!;
    fireEvent.pointerDown(hit, { clientX: 5, clientY: 5, button: 0, pointerType: 'mouse' });
    fireEvent.pointerUp(window, { clientX: 5, clientY: 5 });
    const ask = screen.getByLabelText('Ask the director about this balloon');
    fireEvent.change(ask, { target: { value: 'make it shorter' } });
    fireEvent.submit(ask.closest('form')!);
    await settle();
    expect(composed).toEqual([]);
  });

  it('Pages tab: a refused "Write this page with AI" goes to the message box', async () => {
    const doc = makeBoardDoc((d) => {
      d.pages[1].panels = [];
    });
    const send = sendResolving('refused');
    const studio = makeStudio(doc, { send });
    render(<PagesTab studio={studio} doc={doc} />);
    fireEvent.click(within(screen.getByRole('article', { name: 'Page 2' })).getByRole('button', { name: 'Page 2 actions' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Page 2 actions' })).getByRole('menuitem', { name: /Write this page with AI/ }));
    await settle();
    const text = send.mock.calls[0][0] as string;
    expect(text).toMatch(/^Write page 2 for me/);
    expect(composed).toEqual([{ text, append: true }]);
  });

  it('Pages tab: a "Write this page with AI" that went leaves the message box alone', async () => {
    const doc = makeBoardDoc((d) => {
      d.pages[1].panels = [];
    });
    const studio = makeStudio(doc, { send: sendResolving('sent') });
    render(<PagesTab studio={studio} doc={doc} />);
    fireEvent.click(within(screen.getByRole('article', { name: 'Page 2' })).getByRole('button', { name: 'Page 2 actions' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Page 2 actions' })).getByRole('menuitem', { name: /Write this page with AI/ }));
    await settle();
    expect(studio.send).toHaveBeenCalledTimes(1);
    expect(composed).toEqual([]);
  });

  describe('timeline', () => {
    beforeEach(() => showDollarPrices());
    afterEach(() => resetUsageStatus());

    const writeFromTimeline = async (outcome: SendOutcome) => {
      const doc = makeChatDoc();
      doc.pages[1].panels = [];
      const studio = makeFakeStudio({ doc, tab: 'pages' });
      studio.send.mockImplementation(async () => outcome);
      render(<BookTimeline studio={studio} reorderActivation="immediate" />);
      const clip = screen.getAllByRole('option').find((o) => /^Page 2,/.test(computeAccessibleName(o)))!;
      fireEvent.keyDown(clip, { key: 'm' });
      fireEvent.click(within(screen.getByRole('menu', { name: 'Page 2 actions' })).getByRole('menuitem', { name: /Write this page with AI/ }));
      await settle();
      return studio;
    };

    it('a refused "Write this page with AI" goes to the message box', async () => {
      const studio = await writeFromTimeline('refused');
      const text = studio.send.mock.calls[0][0] as string;
      expect(text).toMatch(/^Write page 2 for me/);
      expect(composed).toEqual([{ text, append: true }]);
    });

    it('one that waits in Up next leaves the message box alone', async () => {
      const studio = await writeFromTimeline('queued');
      expect(studio.send).toHaveBeenCalledTimes(1);
      expect(composed).toEqual([]);
    });
  });
});
