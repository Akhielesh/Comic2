import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { BoardTab } from '../types';
import { BoardPane } from './BoardPane';
import { SAMPLE_NOW, makeSampleDoc, makeStudio } from './__fixtures__/sampleDoc';

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(SAMPLE_NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('BoardPane', () => {
  it('shows the five tabs with live counts', () => {
    render(<BoardPane studio={makeStudio()} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Story', 'Cast3', 'Style✓', 'Pages1/6', 'Read']);
    expect(screen.getByRole('tab', { name: /Pages/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('switches tabs by click and with the arrow keys (wrapping, Home/End)', () => {
    const studio = makeStudio(makeSampleDoc(), { tab: 'pages' });
    render(<BoardPane studio={studio} />);
    fireEvent.click(screen.getByRole('tab', { name: /Story/ }));
    expect(studio.setTab).toHaveBeenLastCalledWith('story');
    const pages = screen.getByRole('tab', { name: /Pages/ });
    fireEvent.keyDown(pages, { key: 'ArrowRight' });
    expect(studio.setTab).toHaveBeenLastCalledWith('read');
    fireEvent.keyDown(pages, { key: 'ArrowLeft' });
    expect(studio.setTab).toHaveBeenLastCalledWith('style');
    fireEvent.keyDown(pages, { key: 'Home' });
    expect(studio.setTab).toHaveBeenLastCalledWith('story');
    fireEvent.keyDown(pages, { key: 'End' });
    expect(studio.setTab).toHaveBeenLastCalledWith('read');
  });

  it.each<[BoardTab, RegExp | string]>([
    ['story', 'Notes the comic follows'],
    ['cast', /Cast · 3/],
    ['style', 'Your style'],
    ['pages', 'Plan draft — review the scripts, then render'],
    ['read', /Page 1 · 1\/2/]
  ])('renders the %s tab', (tab, marker) => {
    render(<BoardPane studio={makeStudio(makeSampleDoc(), { tab })} />);
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getAllByText(marker).length).toBeGreaterThan(0);
  });

  it('answers an open spend gate right on the board', () => {
    const doc = makeSampleDoc((d) => {
      d.gate = {
        id: 'gate_1',
        action: { type: 'render_pages' },
        title: 'Draw 3 pages',
        summary: '3 pages',
        estimateUsd: 0.2,
        imageCount: 3,
        model: 'Nano Banana 2.1',
        createdAt: SAMPLE_NOW,
        status: 'open',
        reason: 'policy'
      };
    });
    const studio = makeStudio(doc);
    render(<BoardPane studio={studio} />);
    const banner = screen.getByRole('region', { name: 'Waiting for your approval' });
    expect(banner).toHaveTextContent('Draw 3 pages');
    expect(banner).toHaveTextContent('≈ $0.20');
    fireEvent.click(within(banner).getByRole('button', { name: 'Approve' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'approve_gate', gateId: 'gate_1' });
  });

  it('declines a gate', () => {
    const doc = makeSampleDoc((d) => {
      d.gate = { id: 'g2', action: { type: 'render_cover' }, title: 'Cover', summary: '', estimateUsd: 0.07, imageCount: 1, model: 'x', createdAt: 0, status: 'open', reason: 'budget' };
    });
    const studio = makeStudio(doc);
    render(<BoardPane studio={studio} />);
    expect(screen.getByRole('region', { name: 'Waiting for your approval' })).toHaveTextContent('over your budget cap');
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'decline_gate', gateId: 'g2' });
  });

  it('opens the page editor for the focused page', () => {
    render(<BoardPane studio={makeStudio(makeSampleDoc(), { focusedPageId: 'pg_5' })} />);
    expect(screen.getByRole('dialog', { name: 'Page 5 editor' })).toBeInTheDocument();
  });

  it('closes a focused page that left the plan', () => {
    const studio = makeStudio(makeSampleDoc(), { focusedPageId: 'pg_gone' });
    render(<BoardPane studio={studio} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(studio.openPage).toHaveBeenCalledWith(null);
  });

  it('shows skeletons while loading and a retry on a load error', () => {
    const { unmount } = render(<BoardPane studio={makeStudio(null, { loading: true })} />);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    unmount();
    const studio = makeStudio(null, { loadError: "This comic doesn't exist or you don't have access to it." });
    render(<BoardPane studio={studio} />);
    expect(screen.getByRole('alert')).toHaveTextContent("This comic doesn't exist");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(studio.refresh).toHaveBeenCalled();
  });
});
