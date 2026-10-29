// QualityPanel (conversation/panels/QualityPanel.tsx, owned by this package; its test lives here so W-M adds no
// file to the conversation folder) under the model lock (models.md §3.1 rule 6, §3.6 A and E): after the lock every
// tier is the LOCKED model at that tier's size (never a model change), a tier change asks once in place ("Draw new
// pages at {res}?"), and the footer carries the lock line whose link opens the model picker.

import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetUsageStatus, showDollarPrices } from '../conversation/testing/fixtures';
import { OPEN_MODEL_PICKER_EVENT } from './openPicker';
import { freshDoc, lakeDoc } from './testing/fixtures';
import { QualityPanel } from '../conversation/panels/QualityPanel';

beforeEach(() => showDollarPrices());
afterEach(() => resetUsageStatus());

const tierRadio = (name: RegExp) => within(screen.getByRole('radiogroup', { name: 'Quality' })).getByRole('radio', { name });

describe('QualityPanel with a locked comic', () => {
  it('every tier draws on the locked model (Pro is Nano Banana 2.1 at its size, priced as such)', () => {
    render(<QualityPanel doc={lakeDoc()} patch={vi.fn()} />);
    expect(tierRadio(/^Draft/)).toHaveTextContent('Nano Banana 2.1 · 1K');
    expect(tierRadio(/^Standard/)).toHaveTextContent('Nano Banana 2.1 · 2K');
    expect(tierRadio(/^Pro/)).toHaveTextContent('Nano Banana 2.1 · 2K');
    expect(tierRadio(/^Pro/)).not.toHaveTextContent('Nano Banana Pro');
    // (0.0504 + 0.003) × 1.3 = 0.069 → $0.07, not Nano Banana Pro's $0.18.
    expect(tierRadio(/^Pro/)).toHaveTextContent('$0.07/page');
  });

  it('a tier change asks once (E) and applies only on "Use {Tier}"', () => {
    const patch = vi.fn();
    const onDone = vi.fn();
    render(<QualityPanel doc={lakeDoc()} patch={patch} onDone={onDone} />);
    fireEvent.click(tierRadio(/^Standard/));
    const dialog = screen.getByRole('alertdialog', { name: 'Draw new pages at 2K?' });
    expect(dialog).toHaveAccessibleDescription(
      'Same model (Nano Banana 2.1), so characters stay consistent. The 5 pages already drawn stay at 1K unless you redraw them.'
    );
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(patch).not.toHaveBeenCalled();
    expect(screen.getByRole('radiogroup', { name: 'Quality' })).toBeInTheDocument();

    fireEvent.click(tierRadio(/^Standard/));
    fireEvent.click(screen.getByRole('button', { name: 'Use Standard' }));
    expect(patch).toHaveBeenCalledWith([{ op: 'settings', patch: { quality: 'standard' } }]);
    expect(onDone).toHaveBeenCalled();
  });

  it('no confirm when the size does not change (Standard → Pro are both 2K on the locked model)', () => {
    const doc = lakeDoc();
    doc.settings = { ...doc.settings, quality: 'standard' };
    const patch = vi.fn();
    render(<QualityPanel doc={doc} patch={patch} />);
    fireEvent.click(tierRadio(/^Pro/));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(patch).toHaveBeenCalledWith([{ op: 'settings', patch: { quality: 'pro' } }]);
  });

  it('the lock line names the model, labels the lock and its "Change…" opens the picker (closing the panel)', () => {
    const onDone = vi.fn();
    const seen: unknown[] = [];
    const onOpen = (e: Event) => {
      seen.push((e as CustomEvent).detail);
      e.preventDefault();
    };
    window.addEventListener(OPEN_MODEL_PICKER_EVENT, onOpen);
    try {
      render(<QualityPanel doc={lakeDoc()} patch={vi.fn()} onDone={onDone} />);
      expect(screen.getByText('Drawn with Nano Banana 2.1 · locked for this comic')).toBeInTheDocument();
      expect(screen.getByRole('img', { name: 'Model locked so every page matches' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Change…' }));
      expect(seen).toEqual([{}]);
      expect(onDone).toHaveBeenCalled();
    } finally {
      window.removeEventListener(OPEN_MODEL_PICKER_EVENT, onOpen);
    }
  });
});

describe('QualityPanel before the lock', () => {
  it('applies a tier at once and says which model the comic will lock to', () => {
    const patch = vi.fn();
    render(<QualityPanel doc={freshDoc()} patch={patch} />);
    expect(screen.getByText('Will draw with Nano Banana 2.1 · locks when the first image is drawn')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose model…' })).toBeInTheDocument();
    fireEvent.click(tierRadio(/^Draft/));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(patch).toHaveBeenCalledWith([{ op: 'settings', patch: { quality: 'draft' } }]);
  });

  it('a pre-lock choice applies to every tier', () => {
    const doc = freshDoc();
    doc.settings = { ...doc.settings, imageModelOverride: 'nano-banana-pro' };
    render(<QualityPanel doc={doc} patch={vi.fn()} />);
    expect(screen.getByText('Will draw with Nano Banana Pro · locks when the first image is drawn')).toBeInTheDocument();
    expect(tierRadio(/^Draft/)).toHaveTextContent('Nano Banana Pro · 1K');
  });
});
