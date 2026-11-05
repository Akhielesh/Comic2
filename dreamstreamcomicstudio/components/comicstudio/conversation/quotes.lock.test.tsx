// Lock-aware quotes in the client's own call sites (A7 wave note 1): the style panel, the format panel and the renders
// card's retry quote price — and name — the comic's locked model, as the server gate re-quotes it (jobs.ts prices
// every image job on the run's pinned lock). The expected numbers come from the registry with an EXPLICIT lock, never
// through the helpers under test, so each assertion fails if a call site ignores the lock.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ComicDoc, ImageModelLock } from '../../../shared/comic/doc';
import { estimateJobs, getImageModel, styleDirectionsUsd } from '../../../shared/comic/models';
import { retryAllFailed } from './cards/RendersCard';
import { FormatPanel, redrawQuoteUsd } from './panels/FormatPanel';
import { quoteStyleOptions } from './panels/StylePanel';
import { makeSampleDoc, resetUsageStatus, showDollarPrices } from './testing/fixtures';

const PRO: ImageModelLock = { modelId: 'nano-banana-pro', lockedAt: 1, origin: 'user_change' };
const PRO_NAME = getImageModel('nano-banana-pro')!.nickname;

/** A Standard-tier comic switched to Nano Banana Pro, whose (stale) override still names Nano Banana 2.1. */
const proLocked = (overrides: Partial<ComicDoc> = {}): ComicDoc => {
  const doc = makeSampleDoc(overrides);
  return { ...doc, imageModel: { ...PRO }, settings: { ...doc.settings, quality: 'standard', imageModelOverride: 'nano-banana-2.1' } };
};
const onPro = (jobs: { kind: Parameters<typeof estimateJobs>[0][number]['kind']; count: number }[], byok = false) =>
  estimateJobs(jobs, 'standard', { byok, override: 'nano-banana-2.1', lock: PRO }).usd;
const unlocked = (jobs: { kind: Parameters<typeof estimateJobs>[0][number]['kind']; count: number }[], byok = false) =>
  estimateJobs(jobs, 'standard', { byok, override: 'nano-banana-2.1' }).usd;

beforeEach(() => showDollarPrices());
afterEach(() => resetUsageStatus());

describe('client quotes price the locked model (A7 note 1)', () => {
  it('the fixture really is priced differently on Pro (otherwise these tests prove nothing)', () => {
    for (const kind of ['page', 'cover', 'sheet', 'place', 'style_option'] as const) {
      expect(onPro([{ kind, count: 1 }]), kind).toBeGreaterThan(unlocked([{ kind, count: 1 }]));
    }
  });

  it('StylePanel: style boards are quoted on the locked model (the gate prices render_style_options on the pin)', () => {
    const doc = proLocked();
    expect(quoteStyleOptions(doc, 3, false, true)).toBe(onPro([{ kind: 'style_option', count: 3 }]));
    const withWriter = Math.round((onPro([{ kind: 'style_option', count: 3 }]) + styleDirectionsUsd(false)) * 10000) / 10000;
    expect(quoteStyleOptions(doc, 3, false)).toBe(withWriter);
  });

  it('FormatPanel: the redraw quote and the "to draw all N on …" line use the locked model and its price', () => {
    const doc = proLocked();
    expect(redrawQuoteUsd(doc, 2, false)).toBe(onPro([{ kind: 'page', count: 2 }]));
    expect(redrawQuoteUsd(doc, 2, true)).toBe(onPro([{ kind: 'page', count: 2 }], true));
    render(<FormatPanel doc={doc} patch={vi.fn()} />);
    const all = onPro([{ kind: 'page', count: doc.format.pageCount }]);
    const line = screen.getByText(/planning is free until you approve/);
    expect(line).toHaveTextContent(`on ${PRO_NAME}`);
    expect(line).toHaveTextContent(`≈ $${all.toFixed(2)} to draw`);
  });

  it('RendersCard: Retry quotes sheets, style options and the cover on the locked model', () => {
    const doc = proLocked();
    const optionId = doc.style.options[0]!.id;
    const sheetId = doc.cast.find((c) => c.tier !== 'extra')!.id;
    const r = retryAllFailed(doc, [{ target: { kind: 'sheet', id: sheetId } }, { target: { kind: 'style_option', id: optionId } }, { target: { kind: 'cover' } }], false);
    expect(r.actions.map((a) => [a.type, a.quotedUsd])).toEqual([
      ['render_sheets', onPro([{ kind: 'sheet', count: 1 }])],
      ['render_style_options', onPro([{ kind: 'style_option', count: 1 }])],
      ['render_cover', onPro([{ kind: 'cover', count: 1 }])]
    ]);
  });
});
