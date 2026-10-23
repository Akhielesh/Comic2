// Story, Cast, Style and Read tabs: edits become the right DocOps, spend actions the
// right StudioActions — and every price is printed for THIS user (governed users never see
// dollars; their own key / admins do).

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import { getStylePreset } from '../../../shared/comic/stylePresets';
import { formatUsd } from '../../../shared/comic/models';
import type { ReaderRequest } from '../types';
import { CastTab, castDetailPatch } from './CastTab';
import { ReaderTab, liveShareUrl } from './ReaderTab';
import { StoryTab, languageChipText } from './StoryTab';
import { StyleTab } from './StyleTab';
import { byokFromDoc, estimateOne, presetOps } from './boardModel';
import { SAMPLE_NOW, asset, makeSampleDoc, makeStudio } from './__fixtures__/sampleDoc';


beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(SAMPLE_NOW);
  // The platform library is unavailable in tests: every surface falls back to procedural art.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('offline');
    })
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** An own-key studio: prices are real dollars. */
const dollarStudio = (doc = makeSampleDoc(), overrides: Parameters<typeof makeStudio>[1] = {}) => makeStudio(doc, { caps: { ...DEFAULT_CAPS, byok: true }, ...overrides });

const edition = (lang: string) => ({ lang, lines: {}, balloons: {}, register: 'everyday' as const });

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

  it('the title wraps (a one-row textarea) and Enter commits it', () => {
    const studio = makeStudio();
    render(<StoryTab studio={studio} doc={studio.doc!} />);
    const title = screen.getByLabelText('Title');
    expect(title.tagName).toBe('TEXTAREA');
    title.focus();
    fireEvent.change(title, { target: { value: 'The Saffron Thief Returns' } });
    fireEvent.keyDown(title, { key: 'Enter' });
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'brief', patch: { title: 'The Saffron Thief Returns' } }]);
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

  it('adds and removes notes (the remove control is never hover-only)', () => {
    const studio = makeStudio();
    render(<StoryTab studio={studio} doc={studio.doc!} />);
    fireEvent.change(screen.getByLabelText('Add a note'), { target: { value: 'Keep Maya sympathetic' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'note_add', text: 'Keep Maya sympathetic' }]);
    const remove = screen.getByRole('button', { name: 'Remove note: No gore' });
    expect(remove.className).toContain('hover-reveal');
    expect(remove.className).toContain('tap-target');
    fireEvent.click(remove);
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'brief', patch: { notes: ['Ends on a cliffhanger'] } }]);
  });

  it('mounts the content-rating picker by the audience and writes settings.rating', () => {
    const studio = makeStudio();
    render(<StoryTab studio={studio} doc={studio.doc!} />);
    const picker = screen.getByRole('radiogroup', { name: 'Content rating' });
    expect(screen.getByTestId('rating-picker')).toContainElement(picker);
    fireEvent.click(within(picker).getByRole('radio', { name: /^PG:/ }));
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'settings', patch: { rating: 'PG' } }], { label: 'Rating PG' });
  });

  it('a kids audience disables PG-13 and says why', () => {
    const doc = makeSampleDoc((d) => (d.brief.audience = 'kids 4-8'));
    const studio = makeStudio(doc);
    render(<StoryTab studio={studio} doc={doc} />);
    expect(screen.getByRole('radio', { name: /^PG-13:/ })).toBeDisabled();
  });

  it('summarizes the format, the language by its own name plus its editions', () => {
    const studio = makeStudio();
    render(<StoryTab studio={studio} doc={studio.doc!} />);
    const format = screen.getByRole('group', { name: 'Format summary' });
    ['Comic', '6 pages', '2:3', 'Overlay lettering', 'Left to right', 'Standard quality', 'English'].forEach((t) => expect(format).toHaveTextContent(t));
    const withEditions = makeSampleDoc((d) => {
      d.i18n = { editions: { te: edition('te'), hi: edition('hi') }, glossary: [] };
    });
    expect(languageChipText(withEditions).label).toBe('English · తెలుగు, हिन्दी');
  });

  it('the language chip opens the Languages tab when there is dialogue to translate', () => {
    const studio = makeStudio();
    render(<StoryTab studio={studio} doc={studio.doc!} />);
    fireEvent.click(screen.getByTestId('language-chip'));
    expect(studio.setTab).toHaveBeenCalledWith('languages');
  });

  it('shows the source script clamped, expandable', () => {
    const studio = makeStudio();
    render(<StoryTab studio={studio} doc={studio.doc!} />);
    const script = screen.getByLabelText('Source script', { selector: 'pre' });
    expect(script).not.toHaveTextContent('LINE 30:');
    fireEvent.click(screen.getByRole('button', { name: 'Show all 30 lines' }));
    expect(script).toHaveTextContent('LINE 30:');
  });

  it('breaks spend down truthfully for an own-key user, labeling your-key spend', () => {
    const studio = dollarStudio();
    render(<StoryTab studio={studio} doc={studio.doc!} />);
    const spend = screen.getByRole('region', { name: 'Spend' });
    expect(spend).toHaveTextContent('$0.42');
    expect(within(spend).getByLabelText('Spend by kind')).toHaveTextContent('Pages');
    const recent = within(spend).getByLabelText('Recent spend');
    expect(within(recent).getAllByText('your key')).toHaveLength(1);
    expect(within(recent).getByText('est.')).toBeInTheDocument();
  });

  it('governed users see their spend as usage, never dollars (own-key spend stays theirs, in dollars)', () => {
    const doc = makeSampleDoc((d) => (d.spend.savedUsd = 0.05));
    const studio = makeStudio(doc, { caps: { ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 80, exhausted: false, pctPerStandardPage: 1 } } });
    render(<StoryTab studio={studio} doc={doc} />);
    const spend = screen.getByRole('region', { name: 'Spend' });
    expect(spend).toHaveTextContent(/% of your usage/);
    expect(within(spend).getByLabelText('Spend by kind')).not.toHaveTextContent('$');
    // The one own-key entry ($0.0655) is the user's own money with the provider.
    expect(spend).toHaveTextContent('on your own key');
    expect(screen.getByTestId('saved-by-software')).toHaveTextContent(/Saved by software: .*% of your usage/);
    expect(screen.getByTestId('saved-by-software')).not.toHaveTextContent('$');
  });
});

describe('CastTab', () => {
  it('renders a card per character, leads first, sheets from the ≤ 480w variant', () => {
    const doc = makeSampleDoc((d) => {
      d.cast[0].sheet.asset = asset('u/proj/sheets/maya-v2.png', { w: 1536, h: 1024, variants: [{ path: 'u/proj/sheets/maya-v2.480.webp', w: 480, h: 320 }] });
    });
    const studio = makeStudio(doc);
    render(<CastTab studio={studio} doc={doc} />);
    expect(screen.getAllByTestId('character-card').map((c) => c.getAttribute('aria-label'))).toEqual(['Maya', 'Arjun', 'Vendor']);
    const img = within(screen.getByRole('article', { name: 'Maya' })).getByRole('img', { name: 'Maya model sheet' });
    expect(img).toHaveAttribute('srcset', 'https://cdn.test/u/proj/sheets/maya-v2.480.webp 480w');
    expect(img).not.toHaveAttribute('data-heavy-img');
    expect(studio.urlFor).toHaveBeenCalledWith(expect.objectContaining({ path: 'u/proj/sheets/maya-v2.png' }), { width: expect.any(Number) });
  });

  it('an original with no variant is marked heavy for the image budget', () => {
    const studio = makeStudio();
    render(<CastTab studio={studio} doc={studio.doc!} />);
    expect(within(screen.getByRole('article', { name: 'Maya' })).getByRole('img', { name: 'Maya model sheet' })).toHaveAttribute('data-heavy-img', '');
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

  it('non-human cast: kind, Companion and ×count at a glance; species and markings in the details', () => {
    const doc = makeSampleDoc((d) => {
      d.cast.push({ id: 'ch_duck', name: 'Ducklings', tier: 'support', kind: 'animal', count: 3, look: { summary: 'Fluffy yellow ducklings', species: 'mallard duckling' }, refs: [], sheet: { status: 'none', history: [] } });
    });
    const studio = makeStudio(doc);
    render(<CastTab studio={studio} doc={doc} />);
    const card = screen.getByRole('article', { name: 'Ducklings' });
    const line = within(card).getByTestId('cast-kind');
    expect(line).toHaveTextContent('Animal');
    expect(line).toHaveTextContent('Companion');
    expect(line).toHaveTextContent('×3');
    expect(within(line).getByTitle('Drawn as a group: three Ducklings')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: /Look details/ }));
    expect(within(card).getByLabelText('Species')).toHaveValue('mallard duckling');
    expect(within(card).getByLabelText('Markings')).toBeInTheDocument();
    // People keep the human fields only.
    const arjun = screen.getByRole('article', { name: 'Arjun' });
    fireEvent.click(within(arjun).getByRole('button', { name: /Look details/ }));
    expect(within(arjun).queryByLabelText('Species')).toBeNull();
  });

  it('cast details are editable: what they are, how many, and how pages use their photo (undoable ops)', () => {
    const doc = makeSampleDoc((d) => {
      d.cast.push({ id: 'ch_duck', name: 'Ducklings', tier: 'support', kind: 'animal', count: 3, look: { summary: 'Fluffy yellow ducklings' }, refs: [], sheet: { status: 'none', history: [] } });
    });
    const studio = makeStudio(doc);
    render(<CastTab studio={studio} doc={doc} />);

    // A person becomes an animal.
    const arjun = screen.getByRole('article', { name: 'Arjun' });
    fireEvent.click(within(arjun).getByRole('button', { name: /Look details/ }));
    const arjunKind = within(arjun).getByLabelText('What they are');
    expect(arjunKind).toHaveValue('person');
    fireEvent.change(arjunKind, { target: { value: 'robot' } });
    expect(studio.patch).toHaveBeenLastCalledWith([{ op: 'character', id: 'ch_arjun', patch: { kind: 'robot' } }]);
    // No photos yet: likeness has nothing to choose between.
    expect(within(arjun).queryByLabelText('Their photo on pages')).toBeNull();

    // A group of three ducklings: back to one clears the key (null), a new size is stored.
    const duck = screen.getByRole('article', { name: 'Ducklings' });
    fireEvent.click(within(duck).getByRole('button', { name: /Look details/ }));
    const count = within(duck).getByLabelText('How many');
    expect(count).toHaveValue('3');
    expect(within(duck).getByText('Drawn as one group: three Ducklings.')).toBeInTheDocument();
    fireEvent.change(count, { target: { value: '5' } });
    expect(studio.patch).toHaveBeenLastCalledWith([{ op: 'character', id: 'ch_duck', patch: { count: 5 } }]);
    fireEvent.change(count, { target: { value: '1' } });
    expect(studio.patch).toHaveBeenLastCalledWith([{ op: 'character', id: 'ch_duck', patch: { count: null } }]);
    fireEvent.change(within(duck).getByLabelText('What they are'), { target: { value: 'person' } });
    expect(studio.patch).toHaveBeenLastCalledWith([{ op: 'character', id: 'ch_duck', patch: { kind: null } }]);

    // Maya has a photo: likeness is offered; 'automatic' is the default and clears the key.
    const maya = screen.getByRole('article', { name: 'Maya' });
    fireEvent.click(within(maya).getByRole('button', { name: /Look details/ }));
    const likeness = within(maya).getByLabelText('Their photo on pages');
    expect(likeness).toHaveValue('auto');
    fireEvent.change(likeness, { target: { value: 'sheet_only' } });
    expect(studio.patch).toHaveBeenLastCalledWith([{ op: 'character', id: 'ch_maya', patch: { likeness: 'sheet_only' } }]);
  });

  it('castDetailPatch: same value sends nothing, defaults clear, out-of-range values are refused', () => {
    const c = { id: 'c', name: 'Bots', tier: 'support' as const, kind: 'robot' as const, count: 2, likeness: 'sheet_only' as const, look: { summary: '' }, refs: [], sheet: { status: 'none' as const, history: [] } };
    expect(castDetailPatch(c, 'kind', 'robot')).toBeNull();
    expect(castDetailPatch(c, 'kind', 'dragon')).toBeNull();
    expect(castDetailPatch(c, 'kind', 'person')).toEqual({ kind: null });
    expect(castDetailPatch(c, 'count', '2')).toBeNull();
    expect(castDetailPatch(c, 'count', '13')).toBeNull();
    expect(castDetailPatch(c, 'count', '1')).toEqual({ count: null });
    expect(castDetailPatch(c, 'likeness', 'auto')).toEqual({ likeness: null });
    expect(castDetailPatch(c, 'likeness', 'sheet_and_photo')).toEqual({ likeness: 'sheet_and_photo' });
    expect(castDetailPatch({ ...c, likeness: undefined }, 'likeness', 'auto')).toBeNull();
  });

  it('renders and re-rolls sheets (the price is printed for this user)', () => {
    const studio = dollarStudio();
    const doc = studio.doc!;
    render(<CastTab studio={studio} doc={doc} />);
    const price = formatUsd(estimateOne(doc, 'sheet', byokFromDoc(doc)).usd);
    const arjun = screen.getByRole('article', { name: 'Arjun' });
    expect(arjun).toHaveTextContent(`≈ ${price}`);
    fireEvent.click(within(arjun).getByRole('button', { name: /Render sheet/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_sheets', characterIds: ['ch_arjun'], force: true });
    fireEvent.click(within(screen.getByRole('article', { name: 'Maya' })).getByRole('button', { name: /Re-roll sheet/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_sheets', characterIds: ['ch_maya'], force: true });
  });

  it('governed users read sheet prices as a share of their usage', () => {
    const studio = makeStudio(makeSampleDoc(), { caps: { ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 90, exhausted: false, pctPerStandardPage: 2 } } });
    render(<CastTab studio={studio} doc={studio.doc!} />);
    const arjun = screen.getByRole('article', { name: 'Arjun' });
    expect(arjun).toHaveTextContent(/% of your usage/);
    expect(arjun).not.toHaveTextContent('$');
  });

  it('renders all missing lead/support sheets at once', () => {
    const studio = makeStudio();
    render(<CastTab studio={studio} doc={studio.doc!} />);
    fireEvent.click(screen.getByRole('button', { name: /Render 1 sheet/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_sheets', characterIds: ['ch_arjun'] });
  });

  it('opens the sheet versions (v1 = oldest) in the shared version stack', () => {
    const studio = makeStudio();
    render(<CastTab studio={studio} doc={studio.doc!} />);
    fireEvent.click(within(screen.getByRole('article', { name: 'Maya' })).getByRole('button', { name: /Maya sheet: 2 versions/ }));
    const dialog = screen.getByRole('dialog', { name: 'Maya sheet · versions' });
    expect(within(dialog).getByRole('radio', { name: /^v2, current/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /^v1/ })).toBeInTheDocument();
  });

  it('confirms before removing a character and names the photos that go with them', () => {
    const studio = makeStudio();
    render(<CastTab studio={studio} doc={studio.doc!} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Maya' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('their reference photo goes with them');
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Vendor' }));
    expect(studio.patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'character_remove', id: 'ch_vendor' }], { label: 'Remove Vendor' });
  });

  it('photos live in the shared strip: always an Add tile, the drawer on tap (no hover-only remove)', () => {
    const studio = makeStudio();
    render(<CastTab studio={studio} doc={studio.doc!} />);
    const maya = screen.getByRole('article', { name: 'Maya' });
    const strip = within(maya).getByRole('group', { name: 'MAYA reference photos' });
    expect(within(strip).getByRole('button', { name: /Photo 1 \(main\)/ })).toBeInTheDocument();
    expect(within(strip).getByRole('button', { name: /Add photos to/ })).toBeInTheDocument();
    expect(within(maya).queryByRole('button', { name: 'Remove reference' })).toBeNull();
    // Arjun has no photos yet, but can add some right there.
    expect(within(screen.getByRole('article', { name: 'Arjun' })).getByRole('button', { name: /Add photos to/ })).toBeInTheDocument();
  });

  it('a sheet drawn from older photos says so softly, with a priced redraw', () => {
    const doc = makeSampleDoc((d) => {
      d.cast[0].sheet.refPaths = ['u/proj/refs/old.jpg'];
    });
    const studio = dollarStudio(doc);
    render(<CastTab studio={studio} doc={doc} />);
    const maya = screen.getByRole('article', { name: 'Maya' });
    expect(within(maya).getByText('From older photos')).toBeInTheDocument();
    const hint = within(maya).getByTestId('older-photos-hint');
    fireEvent.click(within(hint).getByRole('button', { name: 'Redraw sheet' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_sheets', characterIds: ['ch_maya'], force: true });
  });

  it('a failed sheet is calm: when and why, Details on demand, Retry', () => {
    const doc = makeSampleDoc((d) => {
      d.cast[1].sheet = { status: 'failed', history: [], error: 'OpenRouter 429: rate limited upstream', updatedAt: SAMPLE_NOW - 60_000 };
    });
    const studio = makeStudio(doc);
    render(<CastTab studio={studio} doc={doc} />);
    const arjun = screen.getByRole('article', { name: 'Arjun' });
    const failed = within(arjun).getByRole('group', { name: /Arjun sheet: failed .* · rate limited/ });
    expect(failed).not.toHaveTextContent('OpenRouter 429');
    fireEvent.click(within(failed).getByRole('button', { name: 'Details' }));
    expect(failed).toHaveTextContent('OpenRouter 429: rate limited upstream');
    expect(within(arjun).queryByRole('alert')).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: 'Add a character' }));
    const op = (studio.patch as ReturnType<typeof vi.fn>).mock.calls[0][0][0];
    expect(op).toMatchObject({ op: 'character', patch: { name: 'New character 4', tier: 'support' } });
    expect(op.id).toMatch(/^ch_/);
  });

  it('a blocked sheet is never an <img> and its URL is never requested', () => {
    const doc = makeSampleDoc((d) => {
      d.cast[0].sheet.asset = asset('u/proj/sheets/maya-v2.png', { w: 1536, h: 1024, safety: { assessed: 'X', by: 'check', at: SAMPLE_NOW } });
    });
    const studio = makeStudio(doc);
    render(<CastTab studio={studio} doc={doc} />);
    const maya = screen.getByRole('article', { name: 'Maya' });
    expect(within(maya).queryByRole('img', { name: 'Maya model sheet' })).toBeNull();
    expect(within(maya).getByRole('img', { name: 'Image withheld' })).toBeInTheDocument();
    expect(studio.urlFor).not.toHaveBeenCalledWith(expect.objectContaining({ path: 'u/proj/sheets/maya-v2.png' }), expect.anything());
  });

  it('shows the empty state with art when there is no cast yet', () => {
    const doc = makeSampleDoc((d) => (d.cast = []));
    render(<CastTab studio={makeStudio(doc)} doc={doc} />);
    expect(screen.getByText('No characters yet')).toBeInTheDocument();
    expect(document.querySelector('[data-empty-illustration="cast"] [data-empty-art="cast"]')).not.toBeNull();
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

  it('removes palette colors and avoid rules (removal is reachable on touch)', () => {
    const studio = makeStudio();
    render(<StyleTab studio={studio} doc={studio.doc!} />);
    const remove = screen.getByRole('button', { name: 'Remove #e63946' });
    expect(remove.className).toContain('hover-reveal');
    fireEvent.click(remove);
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'style', patch: { palette: ['#1d3557', '#f1faee'] } }]);
    fireEvent.click(screen.getByRole('button', { name: 'Allow photorealism' }));
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'style', patch: { avoid: [] } }]);
  });

  it('shows option states and picks a ready one; a failed option is calm with a priced Retry', () => {
    const doc = makeSampleDoc((d) => (d.style.board = { path: 'u/other.png', source: 'generated', at: 0 }));
    const studio = dollarStudio(doc);
    render(<StyleTab studio={studio} doc={doc} />);
    const options = screen.getAllByTestId('style-option');
    expect(options.map((o) => o.getAttribute('data-status'))).toEqual(['ready', 'rendering', 'failed']);
    fireEvent.click(within(options[0]).getByRole('button', { name: 'Use Heroic' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'pick_style', optionId: 'so_a' });
    expect(within(options[2]).getByRole('group', { name: /Riso style board: failed · the model declined/ })).toBeInTheDocument();
    fireEvent.click(within(options[2]).getByRole('button', { name: /Retry · ≈ \$/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_style_options', directions: [{ name: 'Riso', spec: 'Two-color' }] });
  });

  it('marks the option that is the locked board as chosen', () => {
    const studio = makeStudio();
    render(<StyleTab studio={studio} doc={studio.doc!} />);
    expect(screen.getByRole('button', { name: 'Heroic is your style' })).toBeDisabled();
  });

  it('explores new directions with an honest price', () => {
    const doc = makeSampleDoc((d) => (d.style.options = []));
    const studio = dollarStudio(doc);
    render(<StyleTab studio={studio} doc={doc} />);
    expect(screen.getByText(new RegExp(`≈ \\${formatUsd(estimateOne(doc, 'style_option', byokFromDoc(doc), 3).usd)} for 3 small boards`))).toBeInTheDocument();
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

  it('drafts a preset straight away when nothing is locked; preset tiles carry procedural art', () => {
    const doc = makeSampleDoc((d) => ((d.style.status = 'empty'), (d.style.board = undefined), (d.style.presetId = undefined)));
    const studio = makeStudio(doc);
    render(<StyleTab studio={studio} doc={doc} />);
    const webtoon = screen.getByRole('button', { name: /^Webtoon/ });
    expect(webtoon.querySelector('svg')).not.toBeNull();
    fireEvent.click(webtoon);
    expect(studio.patch).toHaveBeenCalledWith(presetOps(doc, getStylePreset('webtoon-cel')!));
  });

  it('the style references are visible (the old bug) with their count and an Add tile', () => {
    const doc = makeSampleDoc((d) => {
      d.style.refs = [asset('u/proj/refs/style-1.jpg', { source: 'upload' }), asset('u/proj/refs/style-2.jpg', { source: 'upload' })];
    });
    const studio = makeStudio(doc);
    render(<StyleTab studio={studio} doc={doc} />);
    expect(screen.getByRole('heading', { name: 'Your style references (2/8)' })).toBeInTheDocument();
    const strip = screen.getByRole('group', { name: /reference photos/ });
    expect(within(strip).getAllByRole('button', { name: /^Photo \d/ })).toHaveLength(2);
    expect(within(strip).getByRole('button', { name: /Add photos to/ })).toBeInTheDocument();
  });

  it('a ready option above the comic rating is veiled, never wrapped in the pick button (no button in a button)', () => {
    const doc = makeSampleDoc((d) => {
      d.brief.audience = 'kids 6-9';
      d.style.board = { path: 'u/other.png', source: 'generated', at: 0 };
      d.style.options[0].render.asset = { ...d.style.options[0].render.asset!, safety: { assessed: 'PG-13', by: 'check', at: SAMPLE_NOW } };
    });
    const studio = makeStudio(doc);
    render(<StyleTab studio={studio} doc={doc} />);
    const option = screen.getAllByTestId('style-option')[0];
    const show = within(option).getByRole('button', { name: 'Show' });
    expect(show.parentElement?.closest('button')).toBeNull();
    expect(within(option).queryByRole('button', { name: 'Choose Heroic' })).toBeNull();
    // Still pickable from its own button.
    fireEvent.click(within(option).getByRole('button', { name: 'Use Heroic' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'pick_style', optionId: 'so_a' });
  });

  it('picks the lettering preset for the whole comic (free, undoable)', () => {
    const studio = makeStudio();
    render(<StyleTab studio={studio} doc={studio.doc!} />);
    const gallery = screen.getByRole('radiogroup', { name: 'Lettering style' });
    fireEvent.click(within(gallery).getByRole('radio', { name: /Manga/ }));
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'letter_style', patch: { presetId: 'manga', keepOverrides: false, auto: null } }], { label: 'Change lettering style' });
  });
});

describe('ReaderTab', () => {
  it('reads the comic with full screen, Share & export and reader-look actions', () => {
    const studio = makeStudio();
    render(<ReaderTab studio={studio} doc={studio.doc!} />);
    expect(screen.getByTestId('comic-reader')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read full screen' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Share & export' }));
    const sheet = screen.getByTestId('share-export-sheet');
    for (const name of [/^Print/, /^PDF/, /^PNG pages/, /^Share…/, /^Preview as reader/]) expect(within(sheet).getByRole('button', { name })).toBeEnabled();
    expect(within(sheet).getByRole('group', { name: 'Motion comic format' })).toBeInTheDocument();
  });

  it('the root fills the board instead of forcing a 520 px height', () => {
    const studio = makeStudio();
    const { container } = render(<ReaderTab studio={studio} doc={studio.doc!} />);
    const root = container.querySelector('[data-reader-tab]') as HTMLElement;
    expect(root.className).toContain('h-full');
    expect(root.className).toContain('min-h-0');
    expect(root.className).not.toContain('min-h-[520px]');
  });

  it('offers nothing to export until something is drawn', () => {
    const doc = makeSampleDoc((d) => d.pages.forEach((p) => (p.render = { status: 'none', history: [] })));
    render(<ReaderTab studio={makeStudio(doc)} doc={doc} />);
    expect(screen.getByText('Nothing to read yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Share & export' })).toBeNull();
  });

  it('reports a blocked print window', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const studio = makeStudio();
    render(<ReaderTab studio={studio} doc={studio.doc!} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share & export' }));
    fireEvent.click(within(screen.getByTestId('share-export-sheet')).getByRole('button', { name: /^Print/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Allow pop-ups/);
    expect(open).toHaveBeenCalled();
  });

  it('"Read full screen" opens the immersive reader from the click; it closes back to the tab', () => {
    const studio = makeStudio();
    render(<ReaderTab studio={studio} doc={studio.doc!} />);
    fireEvent.click(screen.getByRole('button', { name: 'Read full screen' }));
    const reader = document.body.querySelector('.gesture-root');
    expect(reader).not.toBeNull();
  });

  it('a reader request (chip, card, director) opens the immersive reader once', () => {
    const request: ReaderRequest = { seq: 1, immersive: true, guided: false };
    const studio = makeStudio(makeSampleDoc(), { readerRequest: request });
    const { unmount } = render(<ReaderTab studio={studio} doc={studio.doc!} />);
    expect(document.body.querySelector('.gesture-root')).not.toBeNull();
    unmount();
    // Remounting the tab with the same (answered) request does not reopen it.
    render(<ReaderTab studio={studio} doc={studio.doc!} />);
    expect(document.body.querySelector('.gesture-root')).toBeNull();
  });

  it('"Preview as reader" opens the live link in a new tab once published', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const doc = makeSampleDoc((d) => {
      d.publication = { visibility: 'unlisted', status: 'live', slug: 'Ab3dEf6hIj9kLm2nOp5q', publishedRev: 3, publishedAt: SAMPLE_NOW, languages: ['en'] };
    });
    const studio = makeStudio(doc);
    render(<ReaderTab studio={studio} doc={doc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share & export' }));
    const sheet = screen.getByTestId('share-export-sheet');
    expect(within(sheet).getByRole('button', { name: /^Copy link/ })).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: /^Preview as reader/ }));
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/\/c\/Ab3dEf6hIj9kLm2nOp5q$/), '_blank', 'noopener,noreferrer');
  });

  it('share and export status still shows under StrictMode (the dev re-mount must not mute it)', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => undefined) } });
    const doc = makeSampleDoc((d) => {
      d.publication = { visibility: 'unlisted', status: 'live', slug: 'Ab3dEf6hIj9kLm2nOp5q', publishedRev: 3, publishedAt: SAMPLE_NOW, languages: ['en'] };
    });
    const studio = makeStudio(doc);
    render(
      <React.StrictMode>
        <ReaderTab studio={studio} doc={doc} />
      </React.StrictMode>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Share & export' }));
    fireEvent.click(within(screen.getByTestId('share-export-sheet')).getByRole('button', { name: /^Copy link/ }));
    expect(await screen.findByText(/Link copied — anyone with it can read/)).toBeInTheDocument();
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it('only an http(s) share link is ever opened or copied', () => {
    const doc = makeSampleDoc((d) => {
      d.publication = { visibility: 'unlisted', status: 'live', slug: 'Ab3dEf6hIj9kLm2nOp5q', publishedRev: 3, publishedAt: SAMPLE_NOW, languages: ['en'] };
    });
    expect(liveShareUrl({ doc, publication: { url: 'https://comics.example/c/Ab3dEf6hIj9kLm2nOp5q' } as never })).toBe('https://comics.example/c/Ab3dEf6hIj9kLm2nOp5q');
    const fallback = liveShareUrl({ doc, publication: { url: 'javascript:alert(1)' } as never });
    expect(fallback).toMatch(/^https?:\/\/.*\/c\/Ab3dEf6hIj9kLm2nOp5q$/);
    expect(liveShareUrl({ doc: makeSampleDoc(), publication: null as never })).toBeUndefined();
  });

  it('the reader look panel scrolls inside a capped height (never clipped on a short board)', () => {
    const studio = makeStudio();
    render(<ReaderTab studio={studio} doc={studio.doc!} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reader look' }));
    const panel = screen.getByRole('region', { name: 'Reader look' });
    expect(panel.className).toContain('max-h-[55%]');
    expect(panel.className).toContain('overflow-y-auto');
  });

  it('the reader look writes the reader op (free) and clears text with null', () => {
    const studio = makeStudio();
    render(<ReaderTab studio={studio} doc={studio.doc!} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reader look' }));
    const panel = screen.getByRole('region', { name: 'Reader look' });
    fireEvent.click(within(panel).getByRole('radio', { name: 'Fade' }));
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'reader', patch: { turn: 'fade' } }], { label: 'Change reader look' });
    fireEvent.click(within(panel).getByRole('switch', { name: 'Paper texture' }));
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'reader', patch: { paperTexture: false } }], { label: 'Change reader look' });
    edit(within(panel).getByLabelText('End card line'), 'By the Rao family');
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'reader', patch: { credits: 'By the Rao family' } }], { label: 'Change reader look' });
  });

  it('switches the reading language when the comic has editions, and exports that edition', () => {
    const doc = makeSampleDoc((d) => {
      d.i18n = { editions: { te: edition('te') }, glossary: [] };
    });
    const studio = makeStudio(doc);
    render(<ReaderTab studio={studio} doc={doc} />);
    const group = screen.getByRole('radiogroup', { name: 'Reading language' });
    fireEvent.click(within(group).getByRole('radio', { name: /తెలుగు/ }));
    // Untranslated lines are shown honestly in the original language.
    expect(screen.getByText(/still shown in English — not translated yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Share & export' }));
    expect(screen.getByTestId('share-export-sheet')).toHaveTextContent('Download · Telugu edition');
  });
});
