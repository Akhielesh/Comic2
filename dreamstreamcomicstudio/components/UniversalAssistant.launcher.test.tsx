// The reader hides only the assistant's floating launcher (it sat over the art on phones): the component stays mounted
// and an open panel is not closed by it. Every other view keeps the launcher.
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
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
