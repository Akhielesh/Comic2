// Mount smoke tests for the studio-redesign surfaces — they guard against regressions in the
// new components (they render without crashing and show their core affordances).

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContextUsageBar } from './ContextUsageBar';
import { LiveProgress } from './LiveProgress';
import { SuggestionsPanel } from './SuggestionsPanel';
import { PublishPanel } from './PublishPanel';
import { computeContextUsage } from './contextUsage';

describe('ContextUsageBar', () => {
  it('renders the token usage label', () => {
    const usage = computeContextUsage([{ content: 'x'.repeat(4000) }], [], 'openai/gpt-4o');
    render(<ContextUsageBar usage={usage} />);
    expect(screen.getByText(/\/128k/)).toBeInTheDocument();
  });
});

describe('LiveProgress', () => {
  it('strip shows a calm Fix-with-AI notice when stopped with an error', () => {
    const onFix = vi.fn();
    render(<LiveProgress phase="fixing" active={false} variant="strip" error="ReferenceError: x is not defined" onFix={onFix} />);
    expect(screen.getByRole('button', { name: /fix with ai/i })).toBeInTheDocument();
  });
  it('strip renders nothing when idle with no error', () => {
    const { container } = render(<LiveProgress phase="generating" active={false} variant="strip" error={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('SuggestionsPanel', () => {
  it('shows the heuristic fallback immediately (never empty)', () => {
    render(
      <SuggestionsPanel
        files={[{ path: '/App.tsx', content: 'export const App = () => null;' }]}
        title="Demo"
        fallback={['Add empty, loading and error states to every view.']}
        onPick={vi.fn()}
      />
    );
    expect(screen.getByText(/Suggested next/i)).toBeInTheDocument();
    expect(screen.getByText(/Add empty, loading/i)).toBeInTheDocument();
  });
});

describe('PublishPanel', () => {
  it('is hidden when closed', () => {
    const { container } = render(
      <PublishPanel open={false} onClose={vi.fn()} title="App" previewUrl={null} onDownloadZip={vi.fn()} onDeploy={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });
  it('shows provider choices and deploy steps when open', () => {
    render(
      <PublishPanel open onClose={vi.fn()} title="App" previewUrl={null} onDownloadZip={vi.fn()} onDeploy={vi.fn(async () => ({ status: 'unavailable' as const }))} />
    );
    expect(screen.getByText('Cloudflare Pages')).toBeInTheDocument();
    expect(screen.getByText('Vercel')).toBeInTheDocument();
    expect(screen.getByText('Supabase')).toBeInTheDocument();
    expect(screen.getByText(/Deploy steps/i)).toBeInTheDocument();
  });
  it('closes on Escape (keyboard accessible)', () => {
    const onClose = vi.fn();
    render(
      <PublishPanel open onClose={onClose} title="App" previewUrl={null} onDownloadZip={vi.fn()} onDeploy={vi.fn(async () => ({ status: 'unavailable' as const }))} />
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
  it('shows the deployed link when a URL is known', () => {
    render(
      <PublishPanel open onClose={vi.fn()} title="App" previewUrl={null} deployedUrl="https://app.pages.dev" onDownloadZip={vi.fn()} onDeploy={vi.fn(async () => ({ status: 'live' as const }))} />
    );
    expect(screen.getByText(/Deployed · live/i)).toBeInTheDocument();
  });
});
