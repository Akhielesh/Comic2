import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./DictationButton', () => ({ DictationButton: () => null }));
vi.mock('../../services/chatApi', () => ({ enhancePrompt: vi.fn() }));
import { enhancePrompt } from '../../services/chatApi';
import { ChatComposer } from './ChatComposer';
import { setComposerDraftAccount } from '../../services/composerDrafts';
const props = { busy: false, features: { reasoning: false, webSearch: false, vision: false, structured: false, longContext: false, contextLength: 8000 }, reasoningLevel: 'medium' as const, webSearch: false, dreamstreamAccess: false, enabledTools: [], toolsSupported: false, mcpServers: [], enabledMcpServers: [], onReasoningChange: vi.fn(), onWebToggle: vi.fn(), onDreamstreamToggle: vi.fn(), onToggleConnector: vi.fn(), onToggleMcpServer: vi.fn(), onStop: vi.fn() };
const scope = { accountId: 'alice', surface: 'chat', conversationId: 'test-chat' };
const box = () => screen.getByPlaceholderText(/Message the model/);
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
beforeEach(() => { setComposerDraftAccount(null); sessionStorage.clear(); setComposerDraftAccount('alice'); });
describe('Chat draft submission races', () => {
  it('retains refused and failed sends across unmount, without accepting a rapid second submission', async () => {
    let finish!: (ok: boolean) => void;
    const send = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const view = render(<ChatComposer {...props} draftScope={scope} onSend={send} />);
    type('Keep my question');
    fireEvent.keyDown(box(), { key: 'Enter' }); fireEvent.keyDown(box(), { key: 'Enter' });
    expect(send).toHaveBeenCalledTimes(1); expect(box()).toHaveValue('Keep my question');
    await act(async () => finish(false));
    view.unmount(); render(<ChatComposer {...props} draftScope={scope} onSend={send} />);
    expect(box()).toHaveValue('Keep my question');
  });
  it('success clears only its captured revision and does not erase newer typing', async () => {
    let finish!: (ok: boolean) => void;
    const send = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    render(<ChatComposer {...props} draftScope={scope} onSend={send} />);
    type('First'); fireEvent.keyDown(box(), { key: 'Enter' }); type('A new question');
    await act(async () => finish(true)); expect(box()).toHaveValue('A new question');
    fireEvent.keyDown(box(), { key: 'Enter' }); await act(async () => finish(true)); expect(box()).toHaveValue('');
  });
  it('prompt polish cannot overwrite a draft typed while it was running', async () => {
    let finish!: (value: { enhanced: string }) => void;
    vi.mocked(enhancePrompt).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<ChatComposer {...props} draftScope={scope} onSend={vi.fn()} />);
    type('Original prompt'); fireEvent.click(screen.getByTitle(/Improve my prompt/)); type('More recent thought');
    await act(async () => finish({ enhanced: 'Polished original' })); expect(box()).toHaveValue('More recent thought');
  });
  it('a suggested follow-up appends to a restored draft instead of overwriting it', () => {
    const view = render(<ChatComposer {...props} draftScope={scope} onSend={vi.fn()} />);
    type('Unfinished thought'); view.unmount();
    render(<ChatComposer {...props} draftScope={scope} onSend={vi.fn()} seedText="Suggested question" />);
    expect(box()).toHaveValue('Unfinished thought\n\nSuggested question');
  });
});
