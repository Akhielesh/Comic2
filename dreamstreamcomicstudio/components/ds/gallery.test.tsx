/**
 * The ds-gallery QA scene (qa/app/scenes/ds-gallery.tsx) keeps the scene contract (default export
 * `{ id, title, Scene }`, id = file name) and shows every primitive the barrel exports — the design
 * system's own "every visual is in the gallery" rule — in the page theme and, on a light page, in dark.
 */
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import scene from '../../qa/app/scenes/ds-gallery';

const SLOTS = [
  'button', 'icon-button', 'field', 'input', 'textarea', 'select', 'segmented', 'tabs', 'tabs-list', 'switch', 'slider', 'progress', 'checkbox',
  'chip', 'badge', 'status-chip', 'card', 'section-card', 'metric-card', 'empty-state', 'loading-state', 'error-state', 'skeleton'
];

describe('ds-gallery scene', () => {
  afterEach(() => {
    document.documentElement.classList.remove('dark');
    document.documentElement.removeAttribute('data-ds-skin');
  });

  it('keeps the QA scene contract', () => {
    expect(scene.id).toBe('ds-gallery');
    expect(scene.title).toMatch(/\S/);
    expect(typeof scene.Scene).toBe('function');
  });

  it('renders every primitive, in the page theme and in a dark panel', () => {
    const { Scene } = scene;
    render(<Scene />);
    expect(screen.getByRole('heading', { level: 1, name: 'DreamStream primitives' }).closest('[data-slot="page-header"]')).not.toBeNull();
    const page = screen.getByRole('region', { name: 'Page theme' });
    const dark = screen.getByRole('region', { name: 'Dark theme' });
    expect(dark).toHaveClass('dark');
    for (const panel of [page, dark]) {
      for (const slot of SLOTS) expect(panel.querySelector(`[data-slot="${slot}"]`), slot).not.toBeNull();
      // Every button variant and the busy state.
      for (const v of ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link']) expect(panel.querySelector(`[data-qa-variant="${v}"]`), v).not.toBeNull();
      expect(within(panel).getAllByRole('button', { name: 'Saving' })[0]).toHaveAttribute('aria-busy', 'true');
      expect(within(panel).getByRole('checkbox', { name: 'Select all pages' })).toHaveProperty('indeterminate', true);
    }
  });

  it('on a dark page there is one panel; on a skinned page the dark panel restates the skin', () => {
    const { Scene } = scene;
    document.documentElement.classList.add('dark');
    const { unmount } = render(<Scene />);
    expect(screen.queryByRole('region', { name: 'Dark theme' })).toBeNull();
    unmount();
    document.documentElement.classList.remove('dark');
    document.documentElement.setAttribute('data-ds-skin', 'atlas');
    render(<Scene />);
    expect(screen.getByRole('region', { name: 'Dark theme' })).toHaveAttribute('data-ds-skin', 'atlas');
  });

  it('the error boundary demo breaks on request and mends', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { Scene } = scene;
    render(<Scene />);
    const page = screen.getByRole('region', { name: 'Page theme' });
    fireEvent.click(within(page).getByRole('button', { name: 'Break this panel' }));
    expect(within(page).getByRole('heading', { name: 'This panel stopped working' })).toBeInTheDocument();
    fireEvent.click(within(page).getByRole('button', { name: 'Mend it' }));
    expect(within(page).getByText('This panel renders normally until you break it.')).toBeInTheDocument();
    spy.mockRestore();
  });
});
