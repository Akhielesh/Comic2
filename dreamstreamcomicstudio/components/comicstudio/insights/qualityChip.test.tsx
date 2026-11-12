// models.md §4.1 L0: the quality chip reads "{Tier} · {Model}" with a lock glyph once the comic is locked — and
// nothing new is added to the header. Declutter DC-1 (PROGRAM3 D22): the header chip shows below 1024 px only (an
// icon chip whose name carries the words); from 1024 the composer chip is the home on screen and the ⋯ Quality row
// carries the "{Tier} · {Model}" line and the lock glyph.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { makeLakeComic } from '../../../shared/comic/__fixtures__/lakeComic';
import { resolveImageJob } from '../../../shared/comic/models';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices } from '../conversation/testing/fixtures';

vi.mock('../board/BoardPane', () => ({ BoardPane: () => <div data-testid="board">Board</div> }));
vi.mock('../../studio/kit/useMediaQuery', () => ({ useIsWide: () => true, useMediaQuery: () => true }));

import { ComicStudioShell } from '../ComicStudio';
import { FormFactorProvider, formFactorFor } from '../mobile/useFormFactor';

const mountAt = (w: number, doc: ReturnType<typeof makeSampleDoc>) =>
  render(
    <FormFactorProvider value={formFactorFor({ w, h: 900 })}>
      <ComicStudioShell studio={makeFakeStudio({ doc })} onBack={vi.fn()} />
    </FormFactorProvider>
  );

/** The ⋯ menu's Quality row (desktops: the header has no chip there). */
const qualityRow = () => {
  fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: 'More' }));
  return within(screen.getByRole('menu', { name: 'More' })).getByRole('menuitem', { name: /Quality/ });
};

beforeEach(() => showDollarPrices());
afterEach(() => resetUsageStatus());

describe('quality chip (L0)', () => {
  it('a locked comic: "{Tier} · {Model}" with the lock glyph, and the name says it is locked', () => {
    // Below 1024: the header's icon chip, named in full, with the lock glyph next to the chevron.
    const medium = mountAt(900, makeLakeComic());
    const chip = within(screen.getByRole('banner')).getByTitle('Quality');
    expect(chip).toHaveAccessibleName('Quality: Draft · Nano Banana 2.1, locked for this comic');
    expect(chip.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2);
    medium.unmount();
    // From 1024: the ⋯ row reads the line, with the glyph and the words.
    mountAt(1440, makeLakeComic());
    expect(within(screen.getByRole('banner')).queryByTitle('Quality')).toBeNull();
    const row = qualityRow();
    expect(row).toHaveTextContent('Draft · Nano Banana 2.1');
    expect(row).toHaveAccessibleName(/Draft · Nano Banana 2\.1, locked for this comic/);
    expect(row.querySelectorAll('svg').length).toBeGreaterThanOrEqual(3); // icon, lock, chevron
  });

  it('before the first image: the model the first image will lock, no lock glyph', () => {
    const doc = makeSampleDoc();
    const model = resolveImageJob('page', doc.settings.quality, doc.settings.imageModelOverride).spec.nickname;
    const medium = mountAt(900, doc);
    const chip = within(screen.getByRole('banner')).getByTitle('Quality');
    expect(chip).toHaveAccessibleName(`Quality: Standard · ${model}`);
    expect(chip.querySelectorAll('svg')).toHaveLength(1); // the chevron only
    medium.unmount();
    mountAt(1440, doc);
    const row = qualityRow();
    expect(row).toHaveTextContent(`Standard · ${model}`);
    expect(row).not.toHaveAccessibleName(/locked/);
  });
});
