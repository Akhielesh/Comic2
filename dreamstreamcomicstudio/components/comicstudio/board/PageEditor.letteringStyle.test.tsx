// The page editor's side panel, Lettering section (declutter DX-0): in Lettering mode it is the first section (the
// thing you came to change), it prints no price word (nothing beside it costs), and a translated edition shows the
// styles disabled with one line saying the style belongs to the original language. A pick is one labelled patch whose
// arrow run coalesces into one undo entry.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { lineSourceHash } from '../../../shared/comic/i18n';
import type { ComicDoc } from '../../../shared/comic/doc';
import { presetOps } from '../lettering/styleOps';
import { EDITION_LETTERING_NOTE, LETTERING_STYLE_UNDO } from '../lettering/PresetGallery';
import { PageEditor } from './PageEditor';
import { SAMPLE_NOW, makeSampleDoc, makeStudio } from './__fixtures__/sampleDoc';

const allowance = vi.hoisted(() => ({ status: null as unknown }));
vi.mock('../../usage/useUsageAllowance', () => ({ useUsageAllowance: () => allowance.status }));

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(SAMPLE_NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const open = (doc: ComicDoc = makeSampleDoc()) => {
  const studio = makeStudio(doc, { focusedPageId: 'pg_1' });
  render(<PageEditor studio={studio} doc={doc} pageId="pg_1" />);
  return studio;
};
const letteringSection = () => document.querySelector<HTMLElement>('section[aria-labelledby="pe-lettering"]')!;
const aiSection = () => document.querySelector<HTMLElement>('section[aria-labelledby="pe-ai"]')!;
const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('page editor › Lettering style', () => {
  it('in Lettering mode the Lettering section leads the side panel; in Mark up it goes back to its place', () => {
    open();
    expect(letteringSection()).toBeTruthy();
    expect(aiSection()).toBeTruthy();
    expect(before(letteringSection(), aiSection())).toBe(true);
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Editing mode' })).getByRole('radio', { name: /Mark up/ }));
    expect(before(aiSection(), letteringSection())).toBe(true);
  });

  it('prints no price word and no how-it-works sentence', () => {
    open();
    const section = letteringSection();
    expect(within(section).getByRole('radiogroup', { name: 'Lettering style' })).toBeInTheDocument();
    expect(within(section).queryByText(/free/i)).toBeNull();
    expect(within(section).queryByText(/no AI cost/i)).toBeNull();
    expect(within(section).getByRole('button', { name: /Reset all balloon styles/ })).toBeInTheDocument();
  });

  it('a pick is one labelled, coalescing, undoable patch', () => {
    const studio = open();
    (studio.patch as ReturnType<typeof vi.fn>).mockClear();
    fireEvent.click(within(letteringSection()).getByRole('radio', { name: /Manga/ }));
    expect(studio.patch).toHaveBeenCalledTimes(1);
    expect(studio.patch).toHaveBeenCalledWith(presetOps('manga'), { undo: true, ...LETTERING_STYLE_UNDO });
    expect(LETTERING_STYLE_UNDO).toEqual({ label: 'Change lettering style', coalesce: 'lettering-style' });
  });

  it('a translated edition: the styles are shown disabled with one line saying why', () => {
    const doc = makeSampleDoc((d) => {
      const line = d.pages[0].panels.flatMap((p) => p.lines).find((l) => l.id === 'pg_1_l2')!;
      d.i18n = {
        glossary: [],
        editions: { te: { lang: 'te', register: 'everyday', lines: { pg_1_l2: { text: 'పదండి!', status: 'reviewed', sourceHash: lineSourceHash(line), at: SAMPLE_NOW } }, balloons: {} } }
      };
    });
    const studio = open(doc);
    expect(within(letteringSection()).queryByText(EDITION_LETTERING_NOTE)).toBeNull();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Edit which language' })).getByRole('radio', { name: /తెలుగు/ }));
    const section = letteringSection();
    const radios = within(within(section).getByRole('radiogroup', { name: 'Lettering style' })).getAllByRole('radio');
    expect(radios.every((r) => (r as HTMLButtonElement).disabled)).toBe(true);
    expect(within(section).getByText(EDITION_LETTERING_NOTE)).toBeInTheDocument();
    (studio.patch as ReturnType<typeof vi.fn>).mockClear();
    fireEvent.click(within(section).getByRole('radio', { name: /Manga/ }));
    expect(studio.patch).not.toHaveBeenCalled();
  });
});
