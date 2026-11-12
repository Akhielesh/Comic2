// NamedStyles (PE-INSPECT; agent-editor plan §4 Wave 2 C-STYLES), the Pro switch flipped locally: save, rename,
// duplicate, use, and delete folds the patch back with no visual change; every write is one labelled undo entry.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { applyOp, type DocOp } from '../../../shared/comic/ops';
import { resolveLetterStyle, type LetterStyle } from '../../../shared/comic/lettering/style';
import type { ComicDoc, Line } from '../../../shared/comic/doc';
import { NamedStyles, suggestedStyleName } from './NamedStyles';
import { linesOf } from './styleOps';

vi.mock('../../../shared/comic/ops', async (orig) => ({ ...(await orig<Record<string, unknown>>()), PRO_EDIT_OPS_PATCHABLE: true }));

/** applyOp plus `letter_style {named}` (PE-LETTER's mergeNamedStyles; an S2b integration wave note for ops.ts). */
const applyNamed = (doc: ComicDoc, ops: DocOp[]): ComicDoc =>
  ops.reduce((d, op) => {
    const named = op.op === 'letter_style' ? (op.patch as { named?: Record<string, unknown> } | null)?.named : undefined;
    if (!named) return applyOp(d, op);
    const next = { ...(d.letterStyle?.named || {}) } as Record<string, unknown>;
    for (const [id, v] of Object.entries(named)) {
      if (v === null) delete next[id];
      else next[id] = v;
    }
    return { ...d, letterStyle: { ...(d.letterStyle ?? { presetId: 'classic' }), named: next } as ComicDoc['letterStyle'] };
  }, doc);
/** The PE-LETTER cascade, named right after the kind's patch. */
const looks = (doc: ComicDoc, line: Line): LetterStyle => {
  const named = line.styleId ? doc.letterStyle?.named?.[line.styleId] : undefined;
  if (!named) return resolveLetterStyle(doc, line);
  const ls = doc.letterStyle!;
  return resolveLetterStyle({ ...doc, letterStyle: { ...ls, kinds: { ...(ls.kinds || {}), [line.kind]: { ...(ls.kinds?.[line.kind] || {}), ...named.patch } } } }, line);
};
const allLooks = (doc: ComicDoc) => doc.pages.flatMap((p) => p.panels.flatMap((panel) => panel.lines.map((l) => looks(doc, l))));

const withStyles = () =>
  makeSampleDoc((d) => {
    const [l3, l4] = d.pages[0].panels[2].lines;
    l3.styleId = 'st_v';
    l4.styleId = 'st_v';
    l4.style = { textColor: '#111111' };
    d.letterStyle = { presetId: 'classic', named: { st_v: { name: 'Villain', patch: { textColor: '#e63946', fill: '#fff6c8' } } } };
  });

const mount = (doc: ComicDoc, lineIds: string[], extra: Partial<React.ComponentProps<typeof NamedStyles>> = {}) => {
  const page = doc.pages[0];
  const apply = vi.fn();
  render(<NamedStyles doc={doc} page={page} lines={linesOf(page, lineIds)} apply={apply} newStyleId={() => 'st_new'} {...extra} />);
  return { apply, page };
};

describe('NamedStyles', () => {
  it('lists the saved styles with how many balloons use each, the selection’s style checked', () => {
    mount(withStyles(), ['pg_1_l3']);
    const row = screen.getByRole('button', { name: /^Villain.*balloons?$/ });
    expect(row.getAttribute('aria-pressed')).toBe('true');
    expect(row.textContent).toContain('2 balloons');
    expect(screen.getByText('1 of 32')).toBeTruthy();
  });

  it('save: suggests the speaker’s name, then sends one labelled save', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[0].panels[2].lines[0].style = { fill: '#ffd84a' };
    });
    expect(suggestedStyleName(doc, linesOf(doc.pages[0], ['pg_1_l3'])[0])).toBe('Vendor');
    const { apply } = mount(doc, ['pg_1_l3']);
    fireEvent.click(screen.getByRole('button', { name: 'Save as style…' }));
    const input = screen.getByRole('textbox', { name: 'Style name' });
    fireEvent.change(input, { target: { value: 'Market cry' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][1]).toEqual({ label: 'Save style “Market cry”' });
    const after = applyNamed(doc, apply.mock.calls[0][0]);
    expect(after.letterStyle?.named?.st_new).toEqual({ name: 'Market cry', patch: { fill: '#ffd84a' } });
    expect(allLooks(after)).toEqual(allLooks(doc));
  });

  it('rename and duplicate', () => {
    const doc = withStyles();
    const { apply } = mount(doc, []);
    fireEvent.click(screen.getByRole('button', { name: 'Rename “Villain”' }));
    const input = screen.getByRole('textbox', { name: 'Rename “Villain”' });
    fireEvent.change(input, { target: { value: 'Big bad' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(apply.mock.calls[0]).toEqual([[{ op: 'letter_style', patch: { named: { st_v: { name: 'Big bad', patch: { textColor: '#e63946', fill: '#fff6c8' } } } } }], { label: 'Rename style “Villain”' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate “Villain”' }));
    expect(apply.mock.calls[1]).toEqual([[{ op: 'letter_style', patch: { named: { st_new: { name: 'Villain copy', patch: { textColor: '#e63946', fill: '#fff6c8' } } } } }], { label: 'Duplicate style “Villain”' }]);
  });

  it('delete folds the patch back into its balloons: one undo entry, no visual change', () => {
    const doc = withStyles();
    const { apply } = mount(doc, []);
    fireEvent.click(screen.getByRole('button', { name: 'Delete “Villain”' }));
    expect(apply).toHaveBeenCalledTimes(1);
    const [ops, opts] = apply.mock.calls[0];
    expect(opts).toEqual({ label: 'Delete style “Villain”' });
    const after = applyNamed(doc, ops);
    expect(after.letterStyle?.named).toEqual({});
    expect(after.pages[0].panels[2].lines.every((l) => !l.styleId)).toBe(true);
    expect(allLooks(after)).toEqual(allLooks(doc));
  });

  it('use links the selection; "Use no saved style" unlinks; a translated edition only lists', () => {
    const doc = withStyles();
    const { apply } = mount(doc, ['pg_1_l5']);
    fireEvent.click(screen.getByRole('button', { name: /^Villain.*balloons?$/ }));
    expect(apply.mock.calls[0]).toEqual([[{ op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l5', patch: { styleId: 'st_v' } }], { label: 'Use style “Villain”' }]);
    document.body.innerHTML = '';
    const linked = mount(doc, ['pg_1_l3']);
    fireEvent.click(screen.getByRole('button', { name: 'Use no saved style' }));
    expect(linked.apply.mock.calls[0][0]).toEqual([{ op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l3', patch: { styleId: null } }]);
    document.body.innerHTML = '';
    mount(doc, ['pg_1_l3'], { editionLang: 'hi' });
    const section = screen.getByTestId('named-styles');
    for (const b of within(section).getAllByRole('button')) expect((b as HTMLButtonElement).disabled).toBe(true);
  });

  it('its buttons are 44 px targets on touch', () => {
    mount(withStyles(), ['pg_1_l3']);
    for (const name of ['Rename “Villain”', 'Duplicate “Villain”', 'Delete “Villain”', 'Save as style…']) {
      expect(screen.getByRole('button', { name }).className).toContain('coarse:min-h-11');
    }
  });
});
