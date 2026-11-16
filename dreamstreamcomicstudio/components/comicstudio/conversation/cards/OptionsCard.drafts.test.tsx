import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { OptionsCard } from './OptionsCard';
import { makeFakeStudio } from '../testing/fixtures';
import { ComposerDraftAccountContext, setComposerDraftAccount } from '../../../../services/composerDrafts';
import type { Card } from '../../../../shared/comic/doc';
import type { MessageSendOptions } from '../../useStudio';

const card: Extract<Card, { type: 'options' }> = { type: 'options', id: 'tone', question: 'Which tone?', allowCustom: true, multi: true, choices: [{ id: 'hope', label: 'Hopeful' }, { id: 'quiet', label: 'Quiet' }] };
const input = () => screen.getByLabelText('Your own answer');
const mount = (studio: ReturnType<typeof makeFakeStudio>, ownCard = card) => render(<ComposerDraftAccountContext.Provider value="alice"><OptionsCard card={ownCard} studio={studio} /></ComposerDraftAccountContext.Provider>);
beforeEach(() => { setComposerDraftAccount(null); sessionStorage.clear(); setComposerDraftAccount('alice'); });

describe('Director answer-card drafts', () => {
  it('restores typed answers and selected options per project and card after leaving the section', () => {
    const studio = makeFakeStudio();
    let view = mount(studio);
    fireEvent.change(input(), { target: { value: 'Tender, with a hopeful ending' } });
    fireEvent.click(screen.getByRole('button', { name: 'Quiet' }));
    view.unmount();
    view = mount(studio, { ...card, id: 'another-card' });
    expect(input()).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Quiet' })).toHaveAttribute('aria-pressed', 'false');
    view.unmount();
    view = mount(makeFakeStudio({ doc: { ...studio.doc!, id: 'another-project' } }));
    expect(input()).toHaveValue('');
    view.unmount();
    mount(studio);
    expect(input()).toHaveValue('Tender, with a hopeful ending');
    expect(screen.getByRole('button', { name: 'Quiet' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('keeps a failed answer after unmount and clears only the acknowledged revision', async () => {
    const studio = makeFakeStudio({ confirmsMessages: true });
    let receipt: ((accepted: boolean) => void) | undefined;
    studio.send.mockImplementation(async (_text, options: MessageSendOptions) => { receipt = options.onAccepted; return 'sent'; });
    let view = mount(studio);
    fireEvent.change(input(), { target: { value: 'My first answer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    view.unmount();
    await act(async () => receipt?.(false));
    view = mount(studio);
    expect(input()).toHaveValue('My first answer');
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    view.unmount();
    view = mount(studio);
    fireEvent.change(input(), { target: { value: 'A newer answer while waiting' } });
    await act(async () => receipt?.(true));
    expect(input()).toHaveValue('A newer answer while waiting');
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    view.unmount();
    await act(async () => receipt?.(true));
    mount(studio);
    expect(input()).toHaveValue('');
  });
});
