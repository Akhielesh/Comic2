import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComicDoc } from '../../../shared/comic/doc';
import { lineSourceHash, textSourceHash } from '../../../shared/comic/i18n';
import { applyOps } from '../../../shared/comic/ops';
import { AUTO_CORRECTED_NOTE } from '../../../shared/comic/translationPlan';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices, showUsagePrices } from '../conversation/testing/fixtures';
import { registeredCard, registeredTabs } from '../features';
import { feature, languagesTabVisible } from './index';
import { LanguagesTab } from './LanguagesTab';
import { TranslationCard } from './TranslationCard';

vi.mock('../studioApi', async (orig) => {
  const real = await orig<typeof import('../studioApi')>();
  return { ...real, getTranslationQuote: vi.fn() };
});
const api = await import('../studioApi');
const quoteMock = vi.mocked(api.getTranslationQuote);

const allLines = (doc: ComicDoc) => doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines));

function withTelugu(doc = makeSampleDoc(), status: 'reviewed' | 'machine' = 'reviewed'): ComicDoc {
  let d = applyOps(doc, [{ op: 'edition', lang: 'te', patch: {} }]);
  const lines = Object.fromEntries(allLines(d).map((l) => [l.id, { text: `తెలుగు ${l.id}`, status, sourceHash: lineSourceHash(l), at: 1, gloss: `Means: ${l.text}` }]));
  d = applyOps(d, [{ op: 'translations', lang: 'te', lines }]);
  for (const field of ['brief.title', 'brief.logline'] as const) {
    const src = field === 'brief.title' ? d.brief.title : d.brief.logline || '';
    if (src) d = applyOps(d, [{ op: 'edition_text', lang: 'te', field, value: { text: `తెలుగు ${field}`, status: 'reviewed', sourceHash: textSourceHash(src), at: 1 } }]);
  }
  return d;
}

beforeEach(() => {
  // Admin / own-key wording (dollars); governed users have their own test.
  showDollarPrices();
  quoteMock.mockReset();
  quoteMock.mockImplementation(async (_id, langs) => ({
    perLanguage: langs.map((lang) => ({ lang, lines: 3, free: 1, upToDate: false, usd: 0.05, seconds: 12 })),
    usd: Math.round(0.05 * langs.length * 100) / 100,
    byok: false
  }));
});
afterEach(() => {
  vi.useRealTimers();
  resetUsageStatus();
});

describe('feature registration', () => {
  it('registers the translation card and the Languages tab (visible once there is dialogue)', () => {
    expect(feature.cards?.[0]).toMatchObject({ type: 'translation', Component: TranslationCard });
    expect(registeredCard('translation')?.Component).toBe(TranslationCard);
    const tab = registeredTabs().find((t) => t.id === 'languages');
    expect(tab).toMatchObject({ label: 'Languages', Component: LanguagesTab });
    expect(languagesTabVisible(makeSampleDoc())).toBe(true);
    expect(languagesTabVisible(makeSampleDoc({ pages: [] }))).toBe(false);
  });
});

describe('LanguagesTab', () => {
  it('empty state → pick Telugu → live quote → "Translate · ≈ $0.05" runs the quoted spend', async () => {
    const studio = makeFakeStudio();
    render(<LanguagesTab studio={studio} />);
    expect(screen.getByText(/Make this comic readable in Hindi, Telugu, Tamil and 16 more languages/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add a language' }));
    expect(screen.getByText('Popular in India')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search languages' }), { target: { value: 'తెలు' } });
    fireEvent.click(screen.getByRole('button', { name: /తెలుగు/ }));
    await waitFor(() => expect(quoteMock).toHaveBeenCalledWith('proj_1', ['te'], expect.anything()));
    const go = await screen.findByRole('button', { name: 'Translate · ≈ $0.05' });
    fireEvent.click(go);
    expect(studio.act).toHaveBeenCalledWith({ type: 'translate', languages: ['te'], quotedUsd: 0.05 });
  });

  it('governed users read every quote as a share of their usage — never dollars', async () => {
    showUsagePrices(1);
    const studio = makeFakeStudio({ doc: withTelugu(makeSampleDoc(), 'machine') });
    const { container } = render(<LanguagesTab studio={studio} />);
    const btn = await screen.findByRole('button', { name: /^(Translate missing|Finish the review) · (≈[\d.]+%|<0\.1%) of your usage$/ });
    expect(btn).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\$/);
  });

  it('governed users: the empty-state estimate has no dollar figure either (and admins keep it)', () => {
    showUsagePrices(1);
    const { container, unmount } = render(<LanguagesTab studio={makeFakeStudio()} />);
    expect(screen.getByText(/Make this comic readable in Hindi, Telugu, Tamil/).textContent).toMatch(/small share of your usage/);
    expect(container.textContent).not.toMatch(/\$/);
    unmount();
    showDollarPrices();
    render(<LanguagesTab studio={makeFakeStudio()} />);
    expect(screen.getByText(/Make this comic readable in Hindi, Telugu, Tamil/).textContent).toMatch(/about \$0\.05 per language/);
  });

  it('fails closed with readable sentences: before the usage status loads, the in-art notice has no dollars and no broken phrase', () => {
    resetUsageStatus();
    const doc = withTelugu(makeSampleDoc());
    doc.format = { ...doc.format, lettering: 'in_art' };
    const { container } = render(<LanguagesTab studio={makeFakeStudio({ doc })} />);
    const text = container.textContent || '';
    expect(text).not.toMatch(/\$/);
    expect(text).toMatch(/without text costs a little of your usage once/);
    expect(text).not.toMatch(/costs uses a little/);
  });

  it('a reviewed edition reads "Ready to publish"; a draft offers "Translate missing" with its price', async () => {
    let doc = withTelugu();
    const studio = makeFakeStudio({ doc });
    const { unmount } = render(<LanguagesTab studio={studio} />);
    expect(screen.getByText('Ready to publish')).toBeTruthy();
    expect(quoteMock).not.toHaveBeenCalled(); // nothing to price → no request
    unmount();
    const first = allLines(doc)[0];
    doc = applyOps(doc, [{ op: 'translation', lang: 'te', lineId: first.id, patch: null }]);
    const studio2 = makeFakeStudio({ doc });
    render(<LanguagesTab studio={studio2} />);
    expect(screen.getByText('Draft')).toBeTruthy();
    expect(screen.getByText('1 missing')).toBeTruthy();
    const btn = await screen.findByRole('button', { name: 'Translate missing · ≈ $0.05' });
    fireEvent.click(btn);
    expect(studio2.act).toHaveBeenCalledWith({ type: 'translate', languages: ['te'], quotedUsd: 0.05 });
  });

  it('in-art lettering: the quoted overlay conversion switches lettering, then redraws the drawn pages', async () => {
    const doc = withTelugu(makeSampleDoc());
    doc.format = { ...doc.format, lettering: 'in_art' };
    const studio = makeFakeStudio({ doc });
    render(<LanguagesTab studio={studio} />);
    expect(screen.getByText(/Translated editions need overlay lettering\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Convert to overlay lettering…' }));
    const confirm = screen.getByRole('button', { name: /^Redraw .* · ≈ \$/ });
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'format', patch: { lettering: 'overlay' } }], expect.anything());
    const call = studio.act.mock.calls.find((c) => c[0].type === 'render_pages')![0];
    const drawn = doc.pages.filter((p) => p.render.asset && p.panels.some((pn) => pn.lines.length)).map((p) => p.id);
    expect(call).toMatchObject({ type: 'render_pages', pageIds: drawn });
    expect(call.quotedUsd).toBeGreaterThan(0);
  });

  it('change the comic language: relabel is free; making a complete translation the original runs the swap', () => {
    const studio = makeFakeStudio({ doc: withTelugu() });
    render(<LanguagesTab studio={studio} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change…' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'New comic language' }), { target: { value: 'te' } });
    expect((screen.getByRole('button', { name: /just relabel/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Make the Telugu translation the original/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'swap_source_language', lang: 'te' });
  });

  it('relabel is offered only when it is honest: same-script languages yes, English lines → Hindi no (translate instead)', () => {
    const studio = makeFakeStudio({ doc: makeSampleDoc() });
    render(<LanguagesTab studio={studio} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change…' }));
    const select = screen.getByRole('combobox', { name: 'New comic language' });
    fireEvent.change(select, { target: { value: 'hi' } });
    expect((screen.getByRole('button', { name: /just relabel/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/relabelling would only mislabel them/)).toBeTruthy();
    fireEvent.change(select, { target: { value: 'es' } });
    const relabel = screen.getByRole('button', { name: /just relabel/ }) as HTMLButtonElement;
    expect(relabel.disabled).toBe(false);
    fireEvent.click(relabel);
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'format', patch: { language: 'es' } }], expect.anything());
  });

  it('remove asks first, then patches the edition away', () => {
    const studio = makeFakeStudio({ doc: withTelugu() });
    render(<LanguagesTab studio={studio} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove the Telugu translation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'edition', lang: 'te', patch: null }], expect.anything());
  });
});

describe('TranslationReview', () => {
  it('source, editable translation in its own language, gloss, fit; Enter saves an edit', () => {
    const doc = withTelugu();
    const studio = makeFakeStudio({ doc });
    render(<LanguagesTab studio={studio} />);
    fireEvent.click(screen.getByRole('button', { name: /^Review/ }));
    const first = allLines(doc)[0];
    const field = screen.getByRole('textbox', { name: `Telugu translation of: ${first.text} (page 1, panel 2)` }) as HTMLTextAreaElement;
    expect(field.getAttribute('lang')).toBe('te');
    expect(field.style.fontFamily).toContain('Noto Sans Telugu');
    expect(screen.getAllByText(`Means: ${first.text}`.slice(7)).length).toBeGreaterThan(0);
    fireEvent.change(field, { target: { value: 'కొత్త అనువాదం' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'translation', lang: 'te', lineId: first.id, patch: { text: 'కొత్త అనువాదం' } }], { label: 'Edit translation' });
    // The fit meter follows the DRAFT while typing (not the saved text).
    const row = field.closest('li') as HTMLElement;
    expect(within(row).getByText('Fits')).toBeTruthy();
    fireEvent.change(field, { target: { value: 'చాలా '.repeat(60).trim() } });
    expect(within(row).getByText(/too long$/)).toBeTruthy();
    // Esc reverts without saving
    studio.patch.mockClear();
    fireEvent.change(field, { target: { value: 'పొరపాటు' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(field.value).toBe(`తెలుగు ${first.id}`);
    expect(studio.patch).not.toHaveBeenCalled();
  });

  it('issues: Use suggestion / Looks right / Use the original (auto-corrected) call the review action', async () => {
    let doc = withTelugu();
    const [a, b] = allLines(doc);
    doc = applyOps(doc, [
      { op: 'translation', lang: 'te', lineId: a.id, patch: { issue: { severity: 'minor', note: 'Stiff.', suggestion: 'సహజంగా' } } },
      { op: 'translation', lang: 'te', lineId: b.id, patch: { issue: { severity: 'minor', note: `${AUTO_CORRECTED_NOTE}: wrong meaning`, suggestion: 'అసలు' } } }
    ]);
    const studio = makeFakeStudio({ doc });
    render(<LanguagesTab studio={studio} />);
    fireEvent.click(screen.getByRole('button', { name: /^Review/ }));
    // A row is busy (disabled) while its action is in flight; flush it before the next tap.
    const tap = async (el: HTMLElement) => {
      await act(async () => {
        fireEvent.click(el);
      });
    };
    await tap(screen.getByRole('button', { name: 'Use suggestion' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'accept_translation_issue', lang: 'te', lineId: a.id, useSuggestion: true });
    await tap(screen.getByRole('button', { name: 'Use the original' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'accept_translation_issue', lang: 'te', lineId: b.id, useSuggestion: true });
    await tap(screen.getAllByRole('button', { name: 'Looks right' })[0]);
    expect(studio.act).toHaveBeenCalledWith({ type: 'accept_translation_issue', lang: 'te', lineId: a.id, useSuggestion: false });
  });

  it('"Needs a look" filters to missing / unreviewed / flagged lines', () => {
    const doc = withTelugu(makeSampleDoc(), 'machine');
    render(<LanguagesTab studio={makeFakeStudio({ doc })} />);
    fireEvent.click(screen.getByRole('button', { name: /^Review/ }));
    const total = allLines(doc).filter((l) => l.text.trim()).length;
    fireEvent.click(screen.getByRole('radio', { name: `Needs a look (${total})` }));
    expect(screen.getAllByText('Waiting for review').length).toBe(total);
    expect(screen.getAllByRole('button', { name: 'Mark reviewed' }).length).toBe(total);
  });
});

describe('an edition whose only open work is lines the review flagged', () => {
  it('offers "Review 1 flagged" (the author decides), never a "Finish the review" run that would change nothing', async () => {
    let doc = withTelugu();
    const first = allLines(doc)[0];
    doc = applyOps(doc, [{ op: 'translation', lang: 'te', lineId: first.id, patch: { status: 'machine', issue: { severity: 'major', note: 'Wrong meaning.' } } }]);
    const studio = makeFakeStudio({ doc });
    render(<LanguagesTab studio={studio} />);
    expect(screen.getByText('Draft')).toBeTruthy();
    expect(screen.getByText('1 flagged')).toBeTruthy();
    expect(screen.queryByText('1 unreviewed')).toBeNull();
    expect(screen.getByText('1 line flagged by the review.')).toBeTruthy();
    // Without the fix: "Finish the review · free" is rendered, and tapping it runs a translate that says
    // "already up to date" — the row keeps offering it forever.
    expect(screen.queryByRole('button', { name: /^(Translate missing|Finish the review)/ })).toBeNull();
    expect(quoteMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Review 1 flagged' }));
    expect(screen.getByText('Wrong meaning.')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Looks right' }));
    });
    expect(studio.act).toHaveBeenCalledWith({ type: 'accept_translation_issue', lang: 'te', lineId: first.id, useSuggestion: false });
  });
});

describe('a stale_edited line (the author edited it, then the original changed)', () => {
  function staleEdited() {
    let doc = withTelugu();
    const first = allLines(doc)[0];
    doc = applyOps(doc, [{ op: 'translation', lang: 'te', lineId: first.id, patch: { text: 'నా అనువాదం', status: 'edited' } }]);
    const page = doc.pages.find((p) => p.panels.some((pn) => pn.lines.some((l) => l.id === first.id)))!;
    const panel = page.panels.find((pn) => pn.lines.some((l) => l.id === first.id))!;
    doc = applyOps(doc, [{ op: 'line', pageId: page.id, panelId: panel.id, id: first.id, patch: { text: `${first.text} Really.` } }]);
    return { doc, first };
  }

  it('the row points to the review (no translation to price); the Review tab offers "Keep my wording" and Enter on the unchanged wording means the same', async () => {
    const { doc, first } = staleEdited();
    const studio = makeFakeStudio({ doc });
    render(<LanguagesTab studio={studio} />);
    expect(screen.getByText('1 changed')).toBeTruthy();
    expect(screen.getByText('1 line changed since translating.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^(Translate missing|Finish the review)/ })).toBeNull();
    expect(quoteMock).not.toHaveBeenCalled(); // nothing for the translator or the reviewer → no price request
    // Without the fix there is no button at all: a dead end for an Easy user.
    fireEvent.click(screen.getByRole('button', { name: 'Review 1 changed' }));
    expect(screen.getByText('Original changed (your edit kept)')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep my wording' }));
    });
    expect(studio.act).toHaveBeenCalledWith({ type: 'accept_translation_issue', lang: 'te', lineId: first.id, useSuggestion: false });
    studio.act.mockClear();
    const field = screen.getByRole('textbox', { name: (n) => n.startsWith(`Telugu translation of: ${first.text} Really.`) });
    expect((field as HTMLTextAreaElement).value).toBe('నా అనువాదం');
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    expect(studio.act).toHaveBeenCalledWith({ type: 'accept_translation_issue', lang: 'te', lineId: first.id, useSuggestion: false });
    expect(studio.patch).not.toHaveBeenCalled(); // the wording did not change, so nothing is re-saved
  });
});

describe('TranslationCard', () => {
  it('shows live progress per language with Review and (when ready) Publish', () => {
    const studio = makeFakeStudio({ doc: withTelugu() });
    render(<TranslationCard card={{ type: 'translation', id: 'c1', languages: ['te', 'hi'] }} message={{ id: 'm', role: 'assistant', text: '', at: 1 }} studio={studio} />);
    const bars = screen.getAllByRole('progressbar');
    expect(bars.map((b) => b.getAttribute('aria-valuenow'))).toEqual(['100', '0']);
    expect(screen.getByText(/Translated and reviewed — ready to publish/)).toBeTruthy();
    expect(screen.getByText('not started')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(studio.setTab).toHaveBeenCalledWith('languages');
    expect(screen.queryByRole('button', { name: 'Publish…' })).toBeNull(); // Hindi isn't ready
    const ready = makeFakeStudio({ doc: withTelugu() });
    const { container } = render(<TranslationCard card={{ type: 'translation', id: 'c2', languages: ['te'] }} message={{ id: 'm', role: 'assistant', text: '', at: 1 }} studio={ready} />);
    fireEvent.click(within(container).getByRole('button', { name: 'Publish…' }));
    expect(ready.runClientAction).toHaveBeenCalledWith({ type: 'open_share' });
  });
});

describe('GlossaryDrawer', () => {
  it('renaming a form propagates through the translated lines (patch with translation ops)', async () => {
    let doc = withTelugu();
    const first = allLines(doc)[0];
    doc = applyOps(doc, [
      { op: 'translation', lang: 'te', lineId: first.id, patch: { text: 'మాయా, ఆగు!' } },
      { op: 'glossary_term', id: 'gl_c_c_maya', patch: { term: 'Maya', kind: 'character', forms: { te: 'మాయా' } } }
    ]);
    const studio = makeFakeStudio({ doc });
    render(<LanguagesTab studio={studio} />);
    fireEvent.click(screen.getByRole('button', { name: 'Glossary' }));
    const input = await screen.findByRole('textbox', { name: 'Maya in Telugu' });
    fireEvent.change(input, { target: { value: 'మాయ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const [ops] = studio.patch.mock.calls[0];
    expect(ops).toEqual(
      expect.arrayContaining([
        { op: 'glossary_term', id: 'gl_c_c_maya', patch: { forms: { te: 'మాయ' } } },
        { op: 'translation', lang: 'te', lineId: first.id, patch: { text: 'మాయ, ఆగు!' } }
      ])
    );
    expect(await screen.findByText(/Renamed మాయా → మాయ in 1 Telugu line \(free\)/)).toBeTruthy();
  });
});
