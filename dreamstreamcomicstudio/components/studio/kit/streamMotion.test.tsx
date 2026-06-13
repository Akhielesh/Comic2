// Smoke + reduced-motion coverage for the Agent Stream motion primitives.

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  StreamList,
  StreamItem,
  AgentThinking,
  ImageDevelop,
  SelectPop,
  CountUp,
  PanelGrid,
  PanelPop,
} from './streamMotion';

/** Install a matchMedia mock that reports `reduce` for the reduced-motion query. */
const mockMatchMedia = (reduce: boolean) => {
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
    onchange: null,
  });
};

afterEach(() => {
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

describe('Agent Stream motion primitives render children (animated path)', () => {
  it('StreamList + StreamItem render cards', () => {
    mockMatchMedia(false);
    render(
      <StreamList>
        <StreamItem><span>card-one</span></StreamItem>
        <StreamItem><span>card-two</span></StreamItem>
      </StreamList>,
    );
    expect(screen.getByText('card-one')).toBeInTheDocument();
    expect(screen.getByText('card-two')).toBeInTheDocument();
  });

  it('AgentThinking exposes a live status with its label', () => {
    mockMatchMedia(false);
    render(<AgentThinking label="Planning beats…" />);
    expect(screen.getByRole('status')).toHaveTextContent('Planning beats…');
  });

  it('ImageDevelop renders placeholder children and image alt', () => {
    mockMatchMedia(false);
    render(<ImageDevelop src="data:image/png;base64,x" alt="cast sheet" />);
    expect(screen.getByAltText('cast sheet')).toBeInTheDocument();
  });

  it('SelectPop forwards label + selected state', () => {
    mockMatchMedia(false);
    render(<SelectPop selected ariaLabel="Inked noir"><span>board</span></SelectPop>);
    const btn = screen.getByRole('button', { name: 'Inked noir' });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('board')).toBeInTheDocument();
  });

  it('PanelGrid + PanelPop render panels', () => {
    mockMatchMedia(false);
    render(
      <PanelGrid>
        <PanelPop><span>panel-a</span></PanelPop>
      </PanelGrid>,
    );
    expect(screen.getByText('panel-a')).toBeInTheDocument();
  });
});

describe('reduced motion degrades to static', () => {
  it('CountUp shows the final value immediately under reduced motion', () => {
    mockMatchMedia(true);
    render(<CountUp value={0.42} prefix="$" />);
    expect(screen.getByText('$0.42')).toBeInTheDocument();
  });

  it('StreamItem still renders its child under reduced motion', () => {
    mockMatchMedia(true);
    render(<StreamItem><span>static-card</span></StreamItem>);
    expect(screen.getByText('static-card')).toBeInTheDocument();
  });
});
