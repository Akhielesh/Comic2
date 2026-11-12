/**
 * The ds-gallery QA scene (qa/app/scenes/ds-gallery.tsx) keeps the scene contract (default export
 * `{ id, title, Scene }`, id = file name) and shows every primitive the barrel exports — the design
 * system's own "every visual is in the gallery" rule — in the page theme and, on a light page, in dark.
 */
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import scene from '../../qa/app/scenes/ds-gallery';
import { QaAppSurface } from '../../qa/app/index';
import { BENDAY, HUE_DOT, MAKING_DOT, MAKING_SWEEP, MAKING_TEXT, SPARK_RING_ON_ART, SPARK_SOFT_BG } from './recipes';
import { PROGRESS_MAKING } from './Progress';
import { expectClasses } from './ds.testkit';

const SLOTS = [
  'button', 'icon-button', 'field', 'input', 'textarea', 'select', 'segmented', 'tabs', 'tabs-list', 'switch', 'slider', 'progress', 'checkbox',
  'chip', 'badge', 'status-chip', 'card', 'section-card', 'metric-card', 'empty-state', 'loading-state', 'error-state', 'skeleton',
  'live-dot', 'count-up'
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

  it('is a whole page under the real harness: QaAppSurface mounts it bare, and it brings exactly one <main>', () => {
    const { container } = render(<QaAppSurface scene="ds-gallery" theme="light" skin={null} index={{ scenes: [scene], problems: [] }} />);
    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(container.querySelector('[data-qa-app-scene="ds-gallery"] > main[data-qa-scene="ds-gallery"]')).not.toBeNull();
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

  it('shows the colour layer as specimens in both panels: create, the tokens, making, selection on art, hues and Ben-Day (CL-0 #4)', () => {
    const { Scene } = scene;
    render(<Scene />);
    for (const panel of [screen.getByRole('region', { name: 'Page theme' }), screen.getByRole('region', { name: 'Dark theme' })]) {
      // Buttons renders Atlas's six and then the create extension, in every size.
      const createRow = panel.querySelector('[data-qa-variant="create"]') as HTMLElement;
      expect(createRow).not.toBeNull();
      expect(createRow.querySelectorAll('[data-slot="button"][data-variant="create"]').length).toBeGreaterThanOrEqual(4);
      const layer = within(panel).getByRole('heading', { name: 'Colour layer' }).closest('[data-slot="section-card"]') as HTMLElement;
      // One create fill in the section, on the Ben-Day hero, which holds its words and button above its own dots.
      const create = within(layer).getAllByRole('button').filter((b) => b.getAttribute('data-variant') === 'create');
      expect(create.map((b) => b.textContent)).toEqual(['New comic']);
      const hero = layer.querySelector('[data-qa-benday]') as HTMLElement;
      expectClasses(hero, BENDAY);
      expect(hero).toContainElement(create[0]);
      expect(within(hero).getByRole('heading', { name: 'Make a comic from one sentence' })).toBeInTheDocument();
      // The tokens, each beside its name.
      const swatches = within(within(layer).getByRole('list', { name: 'Colour layer tokens' })).getAllByRole('listitem');
      expect(swatches.map((li) => li.textContent)).toEqual(['--ds-spark', '--ds-spark-soft', '--ds-hue-1', '--ds-hue-2', '--ds-hue-3', '--ds-hue-4', '--ds-hue-5']);
      expectClasses(swatches[1].querySelector('span')!, SPARK_SOFT_BG);
      HUE_DOT.forEach((dot, i) => expectClasses(swatches[i + 2].querySelector('span')!, dot));
      // The making state: dot and label side by side, the spark bar with its words, and a sweeping tile.
      const making = layer.querySelector('[data-qa-making]') as HTMLElement;
      expectClasses(making.querySelector('[data-slot="live-dot"]')!, MAKING_DOT);
      expectClasses(within(making).getByText('Drawing page 3 of 6'), MAKING_TEXT);
      const bar = within(layer).getByRole('progressbar', { name: 'Drawing pages' });
      expect(bar).toHaveAttribute('aria-valuetext', 'Drawing page 3 of 6');
      expectClasses(bar.querySelector('[data-slot="progress-bar"]')!, PROGRESS_MAKING);
      expectClasses(layer.querySelector('[data-qa-tile="making"]')!, MAKING_SWEEP);
      expectClasses(layer.querySelector('[data-qa-tile="selected"]')!, SPARK_RING_ON_ART);
      // A legend: a hue dot plus a word, slots 1-5 in order.
      const legend = within(within(layer).getByRole('list', { name: 'Hue legend' })).getAllByRole('listitem');
      expect(legend).toHaveLength(5);
      legend.forEach((li, i) => {
        expect(li.textContent).toMatch(/\S/);
        expectClasses(li.querySelector('span')!, HUE_DOT[i]);
      });
      // No price anywhere in the section (the spark never sits beside one).
      expect(layer.textContent).not.toMatch(/\$|¢|of your usage/);
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
