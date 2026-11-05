// The destructive and warning buttons render in their tone, not in the neutral ink of the button they
// share a shape with (Atlas wave 8 review). `cx` joins class strings without merging them, and Tailwind
// emits `text-[var(--ds-danger-text)]` before `text-[var(--ds-ink)]`, so a tone stacked on a base that
// already has the ink rendered the Delete / Remove buttons in plain ink. Each button below must carry
// exactly ONE unvariant text colour, its tone; the neighbouring neutral buttons keep the ink.
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('./lettering/fontFiles', () => ({ FONT_FILES: {} }));
import { fireEvent, render, screen } from '@testing-library/react';
import { textColours } from '../../tests/config/textColours';
import { makeSampleDoc } from './board/__fixtures__/sampleDoc';
import { estimateMeasure, planLettering } from '../../shared/comic/lettering/layout';
import { resolvePlacements } from './lettering/useLetterPlans';
import { EasyLetteringPanel } from './lettering/EasyLetteringPanel';
import { ProLetteringPanel } from './lettering/ProLetteringPanel';
import { LetteringToolbar } from './lettering/LetteringToolbar';
import { RefActions } from './refs/RefTile';

const ASPECT = 2 / 3;
const DANGER = 'text-[var(--ds-danger-text)]';
const WARNING = 'text-[var(--ds-warning-text)]';
const INK = 'text-[var(--ds-ink)]';
const MUTED = 'text-[var(--ds-muted)]';
const inks = (el: HTMLElement) => textColours(el.className);

const panelProps = () => {
  const doc = makeSampleDoc();
  const page = doc.pages[0];
  const lines = page.panels.flatMap((p) => p.lines).slice(0, 1);
  return {
    doc,
    page,
    lines,
    plans: planLettering(doc, page, ASPECT, estimateMeasure),
    placements: resolvePlacements(doc, page, ASPECT, estimateMeasure),
    H: 1000 / ASPECT,
    apply: vi.fn(),
    onEditText: vi.fn(),
    onDeselect: vi.fn()
  };
};

describe('tone buttons carry their tone as their only ink', () => {
  it('Easy lettering: Delete is the danger ink; Edit text keeps the neutral ink', () => {
    render(<EasyLetteringPanel {...panelProps()} />);
    expect(inks(screen.getByRole('button', { name: /^Delete$/ }))).toEqual([DANGER]);
    expect(inks(screen.getByRole('button', { name: /Edit text/ }))).toEqual([INK]);
  });

  it('Pro lettering → Arrange: Delete is the danger ink; Edit text keeps the neutral ink', () => {
    render(<ProLetteringPanel {...panelProps()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Arrange' }));
    expect(inks(screen.getByRole('button', { name: /^Delete$/ }))).toEqual([DANGER]);
    expect(inks(screen.getByRole('button', { name: /Edit text/ }))).toEqual([INK]);
  });

  it('a reference photo: Remove is the danger ink; Use as main keeps the neutral ink', () => {
    render(
      <RefActions
        refAsset={{ path: 'refs/a.webp', source: 'upload', at: 1 }}
        index={1}
        owner={{ kind: 'character', id: 'c1' }}
        moveTargets={[]}
        onMakeMain={vi.fn()}
        onLabel={vi.fn()}
        onNote={vi.fn()}
        onCrop={vi.fn()}
        onTransfer={vi.fn()}
        onRemove={vi.fn()}
      />
    );
    expect(inks(screen.getByRole('button', { name: /Remove/ }))).toEqual([DANGER]);
    for (const b of screen.getAllByRole('button').filter((el) => !/Remove/.test(el.textContent || ''))) expect(inks(b)).toEqual([INK]);
  });

  it('lettering toolbar: Fix edges is the warning ink; the quiet buttons are muted and the picked kind is ink', () => {
    render(
      <LetteringToolbar
        addKind="speech"
        onAddKind={vi.fn()}
        canUndo
        canRedo={false}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        onTidy={vi.fn()}
        outsideCount={2}
        onFixEdges={vi.fn()}
        mode="easy"
        onModeChange={vi.fn()}
        canPro={false}
      />
    );
    expect(inks(screen.getByRole('button', { name: /Fix edges/ }))).toEqual([WARNING]);
    expect(inks(screen.getByRole('button', { name: /Tidy/ }))).toEqual([MUTED]);
    // The picked add-kind segment reads ink (SEGMENTED_ACTIVE), the others muted: chosen, not stacked
    // (the muted base used to win over the segment's ink).
    expect(inks(screen.getByRole('button', { name: 'Add speech balloon' }))).toEqual([INK]);
    expect(inks(screen.getByRole('button', { name: 'Add thought balloon' }))).toEqual([MUTED]);
  });
});
