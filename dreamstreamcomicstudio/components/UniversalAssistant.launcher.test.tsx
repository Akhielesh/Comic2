// The reader hides only the assistant's floating launcher (it sat over the art on phones): the component stays mounted
// and an open panel is not closed by it. Every other view keeps the launcher.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { UniversalAssistantResponse } from '../apiTypes';

const auth = vi.hoisted(() => ({ user: null as null | { id: string } }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));
afterEach(() => { auth.user = null; vi.clearAllMocks(); });
vi.mock('../services/geminiService', () => ({ queryUniversalAssistant: vi.fn() }));
vi.mock('../services/db', () => ({
  getUsageLimits: vi.fn(async () => null),
  getUserProfile: vi.fn(async () => null),
  loadArtifactsForProject: vi.fn(async () => [])
}));
vi.mock('../services/telemetry', () => ({ captureError: vi.fn(), captureEvent: vi.fn() }));
vi.mock('../services/feedback', () => ({ detectSentiment: vi.fn(() => null), submitFeedback: vi.fn() }));

const { UniversalAssistant } = await import('./UniversalAssistant');

describe('UniversalAssistant launcher', () => {
  it('shows the launcher by default', () => {
    render(<UniversalAssistant currentView="gallery" projects={[]} />);
    expect(screen.getByRole('button', { name: 'Open assistant' })).toBeInTheDocument();
  });

  it('hides only the launcher with hideLauncher; an already open panel stays open', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const { rerender } = render(<UniversalAssistant currentView="gallery" projects={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open assistant' }));
    expect(await screen.findByRole('button', { name: 'Close assistant' })).toBeInTheDocument();
    rerender(<UniversalAssistant currentView="reader" projects={[]} hideLauncher />);
    // The same mounted component keeps its open panel: nothing was unmounted or closed.
    expect(screen.getByRole('button', { name: 'Close assistant' })).toBeInTheDocument();
    // Closing it in the reader leaves no launcher behind.
    fireEvent.click(screen.getByRole('button', { name: 'Close assistant' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close assistant' })).toBeNull());
    expect(screen.queryByRole('button', { name: 'Open assistant' })).toBeNull();
  });

  it('with hideLauncher and nothing open, no launcher is drawn', () => {
    render(<UniversalAssistant currentView="reader" projects={[]} hideLauncher />);
    expect(screen.queryByRole('button', { name: 'Open assistant' })).toBeNull();
  });
});

it('sends general questions without comic context and drops a pending reply when starting over', async () => {
  auth.user = { id: 'account-a' };
  Element.prototype.scrollIntoView = vi.fn();
  const { queryUniversalAssistant } = await import('../services/geminiService');
  const query = vi.mocked(queryUniversalAssistant);
  let finish!: (value: UniversalAssistantResponse) => void;
  query.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  render(<UniversalAssistant currentView="chat" projects={[]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open assistant' }));
  const box = screen.getByPlaceholderText('Ask a question…');
  fireEvent.change(box, { target: { value: 'How do rainbows form?' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  await waitFor(() => expect(query).toHaveBeenCalledTimes(1));
  const [, history, context, options] = query.mock.calls[0];
  expect(history).toEqual([]);
  expect(context).toEqual({ view: 'chat' });
  expect(options?.expectedAccountId).toBe('account-a');
  fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
  expect(options?.signal?.aborted).toBe(true);
  await act(async () => finish({ text: 'A previous reply.', model: 'fixture', policy: { scope: 'conversation', offTopicBlocked: false } }));
  expect(screen.queryByText('A previous reply.')).not.toBeInTheDocument();
});
