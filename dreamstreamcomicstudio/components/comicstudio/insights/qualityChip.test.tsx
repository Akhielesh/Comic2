// models.md §4.1 L0: the header's quality chip reads "{Tier} · {Model}" with a lock glyph once the comic is
// locked — and nothing new is added to the header.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { makeLakeComic } from '../../../shared/comic/__fixtures__/lakeComic';
import { resolveImageJob } from '../../../shared/comic/models';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices } from '../conversation/testing/fixtures';

vi.mock('../board/BoardPane', () => ({ BoardPane: () => <div data-testid="board">Board</div> }));
vi.mock('../../studio/kit/useMediaQuery', () => ({ useIsWide: () => true, useMediaQuery: () => true }));

import { ComicStudioShell } from '../ComicStudio';
import { FormFactorProvider, formFactorFor } from '../mobile/useFormFactor';

const mountDesktop = (doc: ReturnType<typeof makeSampleDoc>) =>
  render(
    <FormFactorProvider value={formFactorFor({ w: 1440, h: 900 })}>
      <ComicStudioShell studio={makeFakeStudio({ doc })} onBack={vi.fn()} />
    </FormFactorProvider>
  );

beforeEach(() => showDollarPrices());
afterEach(() => resetUsageStatus());

describe('quality chip (L0)', () => {
  it('a locked comic: "{Tier} · {Model}" with the lock glyph, and the name says it is locked', () => {
    mountDesktop(makeLakeComic());
    const chip = within(screen.getByRole('banner')).getByTitle('Quality');
    expect(chip).toHaveTextContent('Draft · Nano Banana 2.1');
    expect(chip).toHaveAccessibleName('Quality: Draft · Nano Banana 2.1, locked for this comic');
    expect(chip.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2); // the lock glyph next to the chevron
  });

  it('before the first image: the model the first image will lock, no lock glyph', () => {
    const doc = makeSampleDoc();
    mountDesktop(doc);
    const chip = within(screen.getByRole('banner')).getByTitle('Quality');
    const model = resolveImageJob('page', doc.settings.quality, doc.settings.imageModelOverride).spec.nickname;
    expect(chip).toHaveTextContent(`Standard · ${model}`);
    expect(chip).toHaveAccessibleName(`Quality: Standard · ${model}`);
  });
});
