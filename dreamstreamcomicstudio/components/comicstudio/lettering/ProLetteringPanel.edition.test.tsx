// Pro panel → Arrange in a translated edition (bug hunt LE-3 / LE-4): Front / Back / Lock / Link change
// properties every language shares, so in an edition they are offered disabled with the reason — a tap
// can never half-apply (freeze the balloon in the edition) or silently do nothing.
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('./fontFiles', () => ({ FONT_FILES: {} }));
import { fireEvent, render, screen } from '@testing-library/react';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { estimateMeasure, planLettering } from '../../../shared/comic/lettering/layout';
import { resolvePlacements } from './useLetterPlans';
import { ProLetteringPanel } from './ProLetteringPanel';

const ASPECT = 2 / 3;

const panel = (extra: { editionLang?: string; sourceName?: string } = {}) => {
  const doc = makeSampleDoc((d) => {
    d.pages[0].balloons.push({ lineId: 'pg_1_l4', x: 0.5, y: 0.6, w: 0.2, linkTo: 'pg_1_l3' });
  });
  const page = doc.pages[0];
  const apply = vi.fn();
  render(
    <ProLetteringPanel
      doc={doc}
      page={page}
      lines={page.panels.flatMap((p) => p.lines).filter((l) => l.id === 'pg_1_l4')}
      plans={planLettering(doc, page, ASPECT, estimateMeasure)}
      placements={resolvePlacements(doc, page, ASPECT, estimateMeasure)}
      H={1000 / ASPECT}
      apply={apply}
      onEditText={vi.fn()}
      onDeselect={vi.fn()}
      {...extra}
    />
  );
  fireEvent.click(screen.getByRole('tab', { name: 'Arrange' }));
  return { apply };
};

describe('ProLetteringPanel → Arrange in a translated edition', () => {
  it('the original language: Front, Back, Lock and Unlink act', () => {
    const { apply } = panel();
    for (const name of [/Front/, /Back/, /^Lock$/, /Unlink/]) expect(screen.getByRole('button', { name })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /Unlink/ }));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('arrange-in-original')).toBeNull();
  });

  it('an edition: they are disabled and say where to change them; a tap patches nothing', () => {
    const { apply } = panel({ editionLang: 'te', sourceName: 'English' });
    for (const name of [/Front/, /Back/, /^Lock$/, /Unlink/]) {
      const b = screen.getByRole('button', { name });
      expect(b).toBeDisabled();
      expect(b).toHaveAttribute('title', expect.stringContaining('English'));
      fireEvent.click(b);
    }
    expect(apply).not.toHaveBeenCalled();
    expect(screen.getByTestId('arrange-in-original')).toHaveTextContent('Stacking, lock and connectors belong to English — switch to English to change them.');
  });
});
