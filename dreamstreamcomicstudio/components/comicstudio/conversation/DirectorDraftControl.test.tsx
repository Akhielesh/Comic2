import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createEmptyDoc } from '../../../shared/comic/doc';
import { makeFakeStudio, makeSampleDoc } from './testing/fixtures';
import { DirectorDraftControl } from './DirectorDraftControl';

const empty = () => createEmptyDoc('project-17', 'The Moon Ferry', 10);
const open = () => fireEvent.click(screen.getByRole('button', { name: /^Drafting ·\s*(Hands-on|Director-led)$/ }));

describe('project Director drafting control', () => {
  it('reuses the composed idea, charges only on the explicit action, and sends the displayed revision', async () => {
    const doc = { ...empty(), rev: 7 };
    const studio = makeFakeStudio({ doc });
    render(<DirectorDraftControl studio={studio} readComposerDraft={() => 'A ferryman finds a second moon.'} />);
    open();
    expect(screen.getByLabelText('Idea for the Director')).toHaveValue('A ferryman finds a second moon.');
    expect(studio.send).not.toHaveBeenCalled();
    expect(studio.act).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Idea for the Director'), { target: { value: '  Two moons, one ferry.  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Draft page plan' }));
    await waitFor(() => expect(studio.act).toHaveBeenCalledWith({ type: 'start_director_draft', idea: 'Two moons, one ferry.', expectedRev: 7 }));
    expect(studio.patch).not.toHaveBeenCalled();
  });

  it('opening and reopening an already requested draft never starts it; hands-on is a distinct action', async () => {
    const doc = { ...empty(), directorDraft: { status: 'ready' as const, idea: 'Quiet harbor.' } };
    const studio = makeFakeStudio({ doc });
    render(<DirectorDraftControl studio={studio} readComposerDraft={() => 'Other unsent text'} />);
    open();
    expect(screen.getByLabelText('Idea for the Director')).toHaveValue('Quiet harbor.');
    expect(studio.act).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to hands-on' }));
    await waitFor(() => expect(studio.act).toHaveBeenCalledWith({ type: 'take_over_director_draft' }));
    expect(studio.send).not.toHaveBeenCalled();
  });

  it('opens the actual saved pages for review without approving a gate or overwriting existing artwork', () => {
    const doc = makeSampleDoc({ directorDraft: { status: 'review', idea: 'Existing plan', pageId: 'pg_1' } });
    const studio = makeFakeStudio({ doc });
    render(<DirectorDraftControl studio={studio} readComposerDraft={() => ''} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review page plan' }));
    expect(studio.setTab).toHaveBeenCalledWith('pages');
    open();
    expect(screen.queryByRole('button', { name: 'Draft page plan' })).toBeNull();
    expect(studio.act).not.toHaveBeenCalled();
    expect(studio.patch).not.toHaveBeenCalled();
  });

  it('opens the private reader straight from the completed book and shows the actual creative choices', () => {
    const doc = makeSampleDoc({ directorDraft: { status: 'review', idea: 'Existing plan' } });
    doc.pages = [doc.pages[0]];
    const studio = makeFakeStudio({ doc });
    render(<DirectorDraftControl studio={studio} readComposerDraft={() => ''} />);
    expect(screen.getByLabelText('See the Director’s choices')).toHaveTextContent('Noir ink');
    fireEvent.click(screen.getByRole('button', { name: 'Read comic' }));
    expect(studio.runClientAction).toHaveBeenCalledWith({ type: 'open_reader', immersive: true });
    expect(studio.act).not.toHaveBeenCalled();
  });

  it('retains an edited brief when another tab changes the comic and refreshes before retry', async () => {
    const studio = makeFakeStudio({ doc: { ...empty(), rev: 2 } });
    studio.act.mockResolvedValue({ ok: false, gated: false, aborted: false, error: 'This comic changed.' });
    render(<DirectorDraftControl studio={studio} readComposerDraft={() => 'A first idea.'} />);
    open();
    fireEvent.change(screen.getByLabelText('Idea for the Director'), { target: { value: 'Keep my revision.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Draft page plan' }));
    await waitFor(() => expect(studio.refresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('alert')).toHaveTextContent('This comic changed.');
    expect(screen.getByLabelText('Idea for the Director')).toHaveValue('Keep my revision.');
    expect(studio.act).toHaveBeenCalledTimes(1);
  });

  it('shows server progress and leaves interrupted projects available for an explicit retry', () => {
    const studio = makeFakeStudio({ doc: { ...empty(), directorDraft: { status: 'planning', idea: 'Harbor.' } } });
    const view = render(<DirectorDraftControl studio={studio} readComposerDraft={() => ''} />);
    expect(screen.getByRole('status')).toHaveTextContent('Planning pages');
    view.rerender(<DirectorDraftControl studio={{ ...studio, doc: { ...empty(), directorDraft: { status: 'interrupted', idea: 'Harbor.' } } }} readComposerDraft={() => ''} />);
    expect(screen.getByRole('status')).toHaveTextContent('Draft paused');
    open();
    expect(screen.getByLabelText('Idea for the Director')).toHaveValue('Harbor.');
    expect(screen.getByRole('button', { name: 'Draft page plan' })).toBeEnabled();
    expect(studio.act).not.toHaveBeenCalled();
  });
});
