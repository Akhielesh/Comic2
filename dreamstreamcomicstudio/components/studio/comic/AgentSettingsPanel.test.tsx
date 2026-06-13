// Behavior test for the Agent Settings panel: edits normalize + persist via onChange.

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentSettingsPanel } from './AgentSettingsPanel';

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

describe('AgentSettingsPanel', () => {
  it('changes the confirm policy and persists a normalized settings object', () => {
    mockMatchMedia(true);
    const onChange = vi.fn();
    render(<AgentSettingsPanel open settings={undefined} onChange={onChange} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Auto spend'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.confirmPolicy).toBe('never');
    expect(Array.isArray(next.outputTargets)).toBe(true);
    expect(next.outputTargets.length).toBeGreaterThan(0);
  });

  it('does not render when closed', () => {
    mockMatchMedia(true);
    render(<AgentSettingsPanel open={false} onChange={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
