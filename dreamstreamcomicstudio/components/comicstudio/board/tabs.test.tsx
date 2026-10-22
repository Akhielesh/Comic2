// Story, Cast, Style and Read tabs: edits become the right DocOps, spend actions the
// right StudioActions.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { getStylePreset } from '../../../shared/comic/stylePresets';
import { CastTab } from './CastTab';
import { ReaderTab } from './ReaderTab';
import { StoryTab } from './StoryTab';
import { StyleTab } from './StyleTab';
import { presetOps } from './boardModel';
import { SAMPLE_NOW, makeSampleDoc, makeStudio } from './__fixtures__/sampleDoc';

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(SAMPLE_NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const edit = (field: HTMLElement, value: string) => {
  fireEvent.focus(field);
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
};

describe('StoryTab', () => {
  it('edits brief fields in place, only when they change', () => {
    const studio = makeStudio();
    render(<StoryTab studio={studio} doc={studio.doc!} />);
    edit(screen.getByLabelText('Genre'), 'Heist');
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'brief', patch: { genre: 'Heist' } }]);
    (studio.patch as ReturnType<typeof vi.fn>).mockClear();
    edit(screen.getByLabelText('Tone'), 'Warm, tense');
    expect(studio.patch).not.toHaveBeenCalled();
  });

  it('reverts on Escape without saving', () => {
    const studio = makeStudio();
    render(<StoryTab studio={studio} doc={studio.doc!} />);
    const title = screen.getByLabelText('Title');
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: 'Oops' } });
    fireEvent.keyDown(title, { key: 'Escape' });
    fireEvent.blur(title);
    expect(title).toHaveValue('The Saffron Thief');
    expect(studio.patch).not.toHaveBeenCalled();
  });

  it('never saves an empty title (reverts instead)', () => {
    const studio = makeStudio();
    render(<StoryTab studio={studio} doc={studio.doc!} />);
    const title = screen.getByLabelText('Title');
    edit(title, '   ');
    expect(studio.patch).not.toHaveBeenCalled();
    expect(title).toHaveValue('The Saffron Thief');
  });

  it('commits single-line fields on Enter and clears optional ones', () => {
    const studio = makeStudio();
    render(<StoryTab studio={studio} doc={studio.doc!} />);
    const audience = screen.getByLabelText('Audience');
    fireEvent.focus(audience);
    fireEvent.change(audience, { target: { value: '' } });
    fireEvent.keyDown(audience, { key: 'Enter' });
    fireEvent.blur(audience);
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'brief', patch: { audience: '' } }]);
  });

  it('edits themes as chips', () => {
    const studio = makeStudio();
    render(<StoryTab studio={studio} doc={studio.doc!} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove family' }));
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'brief', patch: { themes: ['loyalty'] } }]);
    const add = screen.getByLabelText('Add themes');
    fireEvent.change(add, { target: { value: 'Redemption' } });
    fireEvent.keyDown(add, { key: 'Enter' });
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'brief', patch: { themes: ['family', 'loyalty', 'Redemption'] } }]);
  });

  it('adds and removes notes', () => {
    const studio = makeStudio();
    render(<StoryTab studio={studio} doc={studio.doc!} />);
    fireEvent.change(screen.getByLabelText('Add a note'), { target: { value: 'Keep Maya sympathetic' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'note_add', text: 'Keep Maya sympathetic' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove note: No gore' }));
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'brief', patch: { notes: ['Ends on a cliffhanger'] } }]);
  });

  it('summarizes the format', () => {
    const studio = makeStudio();
    render(<StoryTab studio={studio} doc={studio.doc!} />);
    const format = screen.getByRole('group', { name: 'Format summary' });
    ['Comic', '6 pages', '2:3', 'Overlay lettering', 'Left to right', 'Standard quality'].forEach((t) => expect(format).toHaveTextContent(t));
  });

  it('shows the source script clamped, expandable', () => {
    const studio = makeStudio();
    render(<StoryTab studio={studio} doc={studio.doc!} />);
    const script = screen.getByLabelText('Source script', { selector: 'pre' });
    expect(script).not.toHaveTextContent('LINE 30:');
    fireEvent.click(screen.getByRole('button', { name: 'Show all 30 lines' }));
    expect(script).toHaveTextContent('LINE 30:');
  });

  it('breaks spend down truthfully, labeling your-key spend', () => {
    const studio = makeStudio();
    render(<StoryTab studio={studio} doc={studio.doc!} />);
    const spend = screen.getByRole('region', { name: 'Spend' });
    expect(spend).toHaveTextContent('$0.42');
    expect(within(spend).getByLabelText('Spend by kind')).toHaveTextContent('Pages');
    const recent = within(spend).getByLabelText('Recent spend');
    expect(within(recent).getAllByText('your key')).toHaveLength(1);
    expect(within(recent).getByText('est.')).toBeInTheDocument();
  });
});

describe('CastTab', () => {
  it('renders a card per character, leads first', () => {
    const studio = makeStudio();
    render(<CastTab studio={studio} doc={studio.doc!} />);
    expect(screen.getAllByTestId('character-card').map((c) => c.getAttribute('aria-label'))).toEqual(['Maya', 'Arjun', 'Vendor']);
    expect(within(screen.getByRole('article', { name: 'Maya' })).getByRole('img', { name: 'Maya model sheet' })).toHaveAttribute(
      'src',
      'https://cdn.test/u/proj/sheets/maya-v2.png'
    );
  });

  it('changes tier and look fields with character ops', () => {
    const studio = makeStudio();
    render(<CastTab studio={studio} doc={studio.doc!} />);
    const arjun = screen.getByRole('article', { name: 'Arjun' });
    fireEvent.click(within(arjun).getByRole('radio', { name: 'Lead' }));
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'character', id: 'ch_arjun', patch: { tier: 'lead' } }]);
    fireEvent.click(within(arjun).getByRole('button', { name: /Look details/ }));
    edit(within(arjun).getByLabelText('Hair'), 'short, salt-and-pepper');
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'character', id: 'ch_arjun', patch: { look: { hair: 'short, salt-and-pepper' } } }]);
  });

  it('renders and re-rolls sheets', () => {
    const studio = makeStudio();
    render(<CastTab studio={studio} doc={studio.doc!} />);
    fireEvent.click(within(screen.getByRole('article', { name: 'Arjun' })).getByRole('button', { name: /Render sheet/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_sheets', characterIds: ['ch_arjun'], force: true });
    fireEvent.click(within(screen.getByRole('article', { name: 'Maya' })).getByRole('button', { name: /Re-roll sheet/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_sheets', characterIds: ['ch_maya'], force: true });
  });

  it('renders all missing lead/support sheets at once', () => {
    const studio = makeStudio();
    render(<CastTab studio={studio} doc={studio.doc!} />);
    fireEvent.click(screen.getByRole('button', { name: /Render 1 sheet/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_sheets', characterIds: ['ch_arjun'] });
  });

  it('restores an older sheet', () => {
    const studio = makeStudio();
    render(<CastTab studio={studio} doc={studio.doc!} />);
    fireEvent.click(within(screen.getByRole('article', { name: 'Maya' })).getByRole('button', { name: 'Restore version 1' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'restore_render', target: { kind: 'sheet', id: 'ch_maya' }, path: 'u/proj/sheets/maya-v1.png' });
  });

  it('confirms before removing a character', () => {
    const studio = makeStudio();
    render(<CastTab studio={studio} doc={studio.doc!} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Vendor' }));
    expect(studio.patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'character_remove', id: 'ch_vendor' }]);
  });

  it('removes an author reference image', () => {
    const studio = makeStudio();
    render(<CastTab studio={studio} doc={studio.doc!} />);
    fireEvent.click(within(screen.getByRole('article', { name: 'Maya' })).getByRole('button', { name: 'Remove reference' }));
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'character', id: 'ch_maya', patch: { refs: [] } }]);
  });

  it('edits places and renders a location sheet', () => {
    const studio = makeStudio();
    render(<CastTab studio={studio} doc={studio.doc!} />);
    const place = screen.getByRole('article', { name: 'Spice market' });
    edit(within(place).getByLabelText('Look'), 'Narrow lanes, hanging lamps');
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'place', id: 'pl_market', patch: { look: 'Narrow lanes, hanging lamps' } }]);
    fireEvent.click(within(place).getByRole('button', { name: /Render location sheet/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_sheets', characterIds: ['pl_market'], force: true });
  });

  it('adds a character', () => {
    const studio = makeStudio();
    render(<CastTab studio={studio} doc={studio.doc!} />);
    fireEvent.click(within(screen.getByRole('region', { name: /Cast/ })).getByRole('button', { name: 'Add' }));
    const op = (studio.patch as ReturnType<typeof vi.fn>).mock.calls[0][0][0];
    expect(op).toMatchObject({ op: 'character', patch: { name: 'New character 4', tier: 'support' } });
    expect(op.id).toMatch(/^ch_/);
  });
});

describe('StyleTab', () => {
  it('shows the locked board and edits the spec', () => {
    const studio = makeStudio();
    render(<StyleTab studio={studio} doc={studio.doc!} />);
    expect(screen.getByRole('img', { name: 'Locked style board' })).toHaveAttribute('src', 'https://cdn.test/u/proj/style/board.png');
    edit(screen.getByLabelText('Art direction'), 'Heavy brush inks, warm palette.');
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'style', patch: { spec: 'Heavy brush inks, warm palette.' } }]);
  });

  it('removes palette colors and avoid rules', () => {
    const studio = makeStudio();
    render(<StyleTab studio={studio} doc={studio.doc!} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove #e63946' }));
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'style', patch: { palette: ['#1d3557', '#f1faee'] } }]);
    fireEvent.click(screen.getByRole('button', { name: 'Allow photorealism' }));
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'style', patch: { avoid: [] } }]);
  });

  it('shows option states and picks a ready one', () => {
    const doc = makeSampleDoc((d) => (d.style.board = { path: 'u/other.png', source: 'generated', at: 0 }));
    const studio = makeStudio(doc);
    render(<StyleTab studio={studio} doc={doc} />);
    const options = screen.getAllByTestId('style-option');
    expect(options.map((o) => o.getAttribute('data-status'))).toEqual(['ready', 'rendering', 'failed']);
    fireEvent.click(within(options[0]).getByRole('button', { name: 'Use Heroic' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'pick_style', optionId: 'so_a' });
    fireEvent.click(within(options[2]).getByRole('button', { name: /Retry/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_style_options', directions: [{ name: 'Riso', spec: 'Two-color' }] });
  });

  it('marks the option that is the locked board as chosen', () => {
    const studio = makeStudio();
    render(<StyleTab studio={studio} doc={studio.doc!} />);
    expect(screen.getByRole('button', { name: 'Heroic is your style' })).toBeDisabled();
  });

  it('explores new directions', () => {
    const doc = makeSampleDoc((d) => (d.style.options = []));
    const studio = makeStudio(doc);
    render(<StyleTab studio={studio} doc={doc} />);
    fireEvent.click(screen.getByRole('button', { name: /Explore 3 directions/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_style_options' });
  });

  it('confirms before a preset replaces a locked style', () => {
    const studio = makeStudio();
    const doc = studio.doc!;
    render(<StyleTab studio={studio} doc={doc} />);
    fireEvent.click(screen.getByRole('button', { name: /^Noir ink/ }));
    expect(studio.patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Replace style' }));
    expect(studio.patch).toHaveBeenCalledWith(presetOps(doc, getStylePreset('noir-ink')!));
  });

  it('drafts a preset straight away when nothing is locked', () => {
    const doc = makeSampleDoc((d) => ((d.style.status = 'empty'), (d.style.board = undefined), (d.style.presetId = undefined)));
    const studio = makeStudio(doc);
    render(<StyleTab studio={studio} doc={doc} />);
    fireEvent.click(screen.getByRole('button', { name: /^Webtoon/ }));
    expect(studio.patch).toHaveBeenCalledWith(presetOps(doc, getStylePreset('webtoon-cel')!));
  });
});

describe('ReaderTab', () => {
  it('reads the comic with export actions', () => {
    const studio = makeStudio();
    render(<ReaderTab studio={studio} doc={studio.doc!} />);
    expect(screen.getByTestId('comic-reader')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Print$/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^PDF$/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^PNG$/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^Motion$/ })).toBeEnabled();
  });

  it('offers nothing to export until something is drawn', () => {
    const doc = makeSampleDoc((d) => d.pages.forEach((p) => (p.render = { status: 'none', history: [] })));
    render(<ReaderTab studio={makeStudio(doc)} doc={doc} />);
    expect(screen.getByText('Nothing to read yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Print$/ })).toBeNull();
  });

  it('reports a blocked print window', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const studio = makeStudio();
    render(<ReaderTab studio={studio} doc={studio.doc!} />);
    fireEvent.click(screen.getByRole('button', { name: /^Print$/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Allow pop-ups/);
    expect(open).toHaveBeenCalled();
  });
});
