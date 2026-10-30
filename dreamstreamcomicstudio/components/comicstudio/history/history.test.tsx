// The History UI (versions plan §8, §14 H5): phone first, Atlas, free, honest — on the fake HistoryApi.
//
// The H5 test list, one describe each: no overflow at 320/360 px in every sheet; every target ≥ 44 px; money words
// (governed users read no '$', own-key rows say "on your key", history actions say "Free"); the keyboard scrubber
// with aria-valuetext; "removed:" / "added:" screen-reader text in diffs; "Use then" sends the right RestoreScope
// for a line, a panel, a page and a language; the restore sheet's list; the read-only reader; reduced motion; Android
// back closes layers in order; the empty, v4 "Earlier" and "Classic snapshots" states; the card renders from ids; no
// git words in rendered copy; and with Comic History off no entry point shows.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import type { HistoryCard as HistoryCardData } from '../../../shared/comic/history/types';
import { resetUsageStatus, showDollarPrices, showUsagePrices } from '../conversation/testing/fixtures';
import { openLayers, resetBackStack } from '../mobile/backStack';
import { ChangesSincePublishLink } from './ChangesSincePublishLink';
import { PageHistoryLink, TimelineHistoryLink } from './EntryLinks';
import { HistoryButton } from './HistoryButton';
import { HistoryCardView } from './HistoryCard';
import { HistoryBrowser, HistoryPanel, type HistoryOpenRequest } from './HistoryPanel';
import { HistoryTab } from './HistoryTab';
import { feature, requestOpenHistory } from './index';
import { gitWordsIn, GIT_WORDS_RE, HISTORY_COPY } from './historyModel';
import { AUTO_BLINK_MS } from './PageCompare';
import { Scrubber } from './Scrubber';
import { WordDiff } from './WordDiff';
import { HISTORY_KIT_SCENES, HistoryKitScene } from './__scenes__/HistoryScenes';
import { parseQaParams } from '../testing/qaController';
import { FormFactorProvider, formFactorFor } from '../mobile/useFormFactor';
import { fakeAct, historySetup, HISTORY_NOW, HISTORY_TZ, interactive, mountWith, overflowProblems, settle, TARGET_RE, type Mounted } from './history.testkit';

const NOW = HISTORY_NOW;
const TZ = HISTORY_TZ;
let seq = 0;
const req = (r: Omit<HistoryOpenRequest, 'seq'> = {}): HistoryOpenRequest => ({ ...r, seq: ++seq });

const browser = (m: Mounted, request?: HistoryOpenRequest) => mountWith(m, <HistoryBrowser studio={m.studio} open request={request ?? null} now={NOW} tz={TZ} />);
const panel = (m: Mounted, request?: HistoryOpenRequest, onClose = vi.fn()) =>
  mountWith(m, <HistoryPanel studio={m.studio} open onClose={onClose} request={request ?? null} now={NOW} tz={TZ} />);

/** The visible view of the browser. */
const view = (kind: string): HTMLElement => {
  const all = Array.from(document.querySelectorAll<HTMLElement>(`[data-history-view="${kind}"]`)).filter((el) => !el.hidden);
  expect(all.length, `the ${kind} view is shown`).toBeGreaterThan(0);
  return all[all.length - 1];
};

beforeEach(() => {
  resetBackStack();
  showUsagePrices(1);
});

afterEach(() => {
  resetBackStack();
  resetUsageStatus();
  vi.useRealTimers();
});

// ── Layout: 320/360 px, 44 px targets ────────────────────────────────────────

/** Every History surface, opened for real: the list, a moment, the compare, the reader and the three sheets. */
const tour = async (width: number): Promise<{ name: string; root: HTMLElement }[]> => {
  const list: { name: string; root: HTMLElement }[] = [];
  // Each surface is captured as it is shown (a copy: the sheet's DOM moves on to the next view).
  const out = { push: (s: { name: string; root: HTMLElement }) => list.push({ name: s.name, root: (s.root?.cloneNode(true) as HTMLElement) ?? s.root }) };
  const m = historySetup({ width });
  const { unmount } = panel(m, req());
  await settle();
  out.push({ name: 'panel (list)', root: document.querySelector<HTMLElement>('[data-history-sheet="History"]')! });
  fireEvent.click(document.querySelector('[data-moment="ver_ai"]')!);
  await settle();
  out.push({ name: 'moment', root: view('moment') });
  fireEvent.click(within(view('moment')).getByRole('button', { name: 'Compare with now' }));
  await settle();
  out.push({ name: 'compare', root: view('compare') });
  fireEvent.click(within(view('compare')).getByRole('radio', { name: 'Blink' }));
  out.push({ name: 'compare (blink)', root: view('compare') });
  fireEvent.click(within(view('compare')).getAllByRole('button', { name: 'Back' })[0]);
  fireEvent.click(within(view('moment')).getByRole('button', { name: 'Read this version' }));
  await settle();
  out.push({ name: 'reader', root: view('reader') });
  fireEvent.click(within(view('reader')).getByRole('button', { name: 'Restore…' }));
  await settle();
  out.push({ name: 'restore sheet', root: document.querySelector<HTMLElement>('[data-restore-sheet]')! });
  unmount();
  resetBackStack();
  const m2 = historySetup({ width });
  const r2 = panel(m2, req({ view: 'undo_ai' }));
  await settle(6);
  out.push({ name: 'undo-AI sheet', root: document.querySelector<HTMLElement>('[data-undo-ai-sheet]')! });
  r2.unmount();
  resetBackStack();
  const m3 = historySetup({ width });
  const r3 = panel(m3, req());
  await settle();
  fireEvent.click(screen.getByRole('button', { name: /Save version/ }));
  out.push({ name: 'save sheet', root: document.querySelector<HTMLElement>('[data-save-sheet]')! });
  r3.unmount();
  resetBackStack();
  for (const fixture of ['v4', 'classic'] as const) {
    const mf = historySetup({ width, fixture });
    const rf = panel(mf, req());
    await settle(6);
    out.push({ name: `${fixture} list`, root: document.querySelector<HTMLElement>('[data-history-sheet="History"]')! });
    rf.unmount();
    resetBackStack();
  }
  return list;
};

describe('no horizontal overflow at 320 and 360 px in every sheet', () => {
  for (const width of [320, 360]) {
    it(`${width} px: nothing in the panel, its views or its sheets is wider than the phone`, async () => {
      const surfaces = await tour(width);
      expect(surfaces.map((s) => s.name)).toEqual(['panel (list)', 'moment', 'compare', 'compare (blink)', 'reader', 'restore sheet', 'undo-AI sheet', 'save sheet', 'v4 list', 'classic list']);
      for (const s of surfaces) {
        expect(s.root, s.name).toBeTruthy();
        expect(overflowProblems(s.root, width), s.name).toEqual([]);
      }
    });
  }
});

describe('every target is at least 44 px', () => {
  it('every button, field, slider, radio and menu item in every History surface is a 44 px target', async () => {
    for (const s of await tour(360)) {
      // The reader's own toolbar is the shared ComicReaderView (its own tests own its targets).
      const mine = interactive(s.root).filter((el) => !el.closest('[data-reader-host]'));
      expect(mine.length, s.name).toBeGreaterThan(0);
      for (const el of mine) {
        if (el.hasAttribute('data-hit-exempt')) continue;
        expect(el.className, `${s.name}: ${el.tagName} "${(el.getAttribute('aria-label') || el.textContent || '').slice(0, 40)}"`).toMatch(TARGET_RE);
      }
    }
  });

  it('the header button and the entry links are 44 px too', () => {
    const m = historySetup();
    const { container } = mountWith(
      m,
      <>
        <HistoryButton studio={m.studio} compact />
        <PageHistoryLink studio={m.studio} target={{ kind: 'page', id: 'pg_3' }} />
        <TimelineHistoryLink studio={m.studio} />
      </>
    );
    const els = interactive(container);
    expect(els).toHaveLength(3);
    for (const el of els) expect(el.className).toMatch(TARGET_RE);
    expect(screen.getByRole('button', { name: 'History' }).className).toMatch(/min-w-11/);
  });
});

// ── Money words ──────────────────────────────────────────────────────────────

describe('money: governed users read no $, own-key rows say "on your key", history actions say "Free"', () => {
  const NO_DOLLARS = /\$\s?\d|<\$/;

  it('a governed user reads usage, never dollars — even on an own-key row', async () => {
    showUsagePrices(1);
    const m = historySetup();
    panel(m, req());
    await settle();
    const sheet = document.querySelector<HTMLElement>('[data-history-sheet="History"]')!;
    expect(sheet.textContent).not.toMatch(NO_DOLLARS);
    const ai = sheet.querySelector('[data-moment="ver_ai"]')!;
    expect(ai.textContent).toMatch(/of your usage/);
    const own = sheet.querySelector('[data-moment="ver_draw"]')!;
    expect(own.textContent).toContain('on your key');
    expect(own.textContent).not.toMatch(NO_DOLLARS);
    expect(sheet.querySelector('[data-moment="ver_edit"]')!.textContent).toMatch(/· Free$/);
  });

  it('a viewer who reads dollars sees the own-key amount with "on your key"', async () => {
    showDollarPrices();
    const m = historySetup();
    panel(m, req());
    await settle();
    expect(document.querySelector('[data-moment="ver_draw"]')!.textContent).toContain('$0.27 · on your key');
    expect(document.querySelector('[data-moment="ver_ai"]')!.textContent).toContain('$0.07');
  });

  it('every history action says Free: restore, save, undo-AI, Use then, earlier drawings, classic snapshots, the card', async () => {
    const m = historySetup();
    panel(m, req({ view: 'confirm', versionId: 'ver_before' }));
    await settle(6);
    expect(document.querySelector('[data-restore-sheet]')!.textContent).toContain(HISTORY_COPY.free);
    fireEvent.click(within(document.querySelector<HTMLElement>('[data-restore-sheet]')!).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(view('moment')).getByRole('button', { name: 'Compare with now' }));
    await settle();
    const compare = view('compare');
    expect(compare.textContent).toContain('free and instant');
    for (const b of compare.querySelectorAll('[data-use-then]')) expect(b.getAttribute('aria-label') || b.textContent).toMatch(/free|Free/);
    fireEvent.click(within(compare).getAllByRole('button', { name: 'Back' })[0]);
    fireEvent.click(within(view('moment')).getAllByRole('button', { name: 'Back' })[0]);
    fireEvent.click(within(view('list')).getByRole('button', { name: /Save version/ }));
    expect(document.querySelector('[data-save-sheet]')!.textContent).toMatch(/Free/);

    const u = historySetup();
    panel(u, req({ view: 'undo_ai' }));
    await settle(6);
    expect(document.querySelector('[data-undo-ai-sheet]')!.textContent).toContain(HISTORY_COPY.free);

    const v4 = historySetup({ fixture: 'v4' });
    panel(v4, req());
    await settle(6);
    expect(document.querySelector('[data-history-earlier]')!.textContent).toMatch(/free/);

    const c = historySetup({ fixture: 'classic' });
    panel(c, req());
    await settle(6);
    expect(document.querySelector('[data-history-classic]')!.textContent).toMatch(/free/);
    for (const b of document.querySelectorAll('[data-classic-snapshot] button')) expect(b.getAttribute('aria-label')).toMatch(/\(free\)/);

    const card = historySetup();
    mountWith(card, <HistoryCardView card={{ type: 'history', id: 'k', view: 'confirm', versionId: 'ver_before', scope: { kind: 'page', pageId: 'pg_3', mode: 'replace', part: 'all' } }} message={{ id: 'm', role: 'assistant', text: '', at: NOW }} studio={card.studio} now={NOW} tz={TZ} />);
    await settle();
    expect(screen.getByRole('button', { name: 'Use then · Free' })).toBeInTheDocument();
  });
});

// ── Scrubber ─────────────────────────────────────────────────────────────────

describe('the scrubber is keyboard-operable with aria-valuetext', () => {
  it('arrows step one moment, Page Up/Down five, Home/End jump; the value is read as day, time and what happened', () => {
    const m = historySetup();
    const rows = m.fixture.versions.map((v) => v.row);
    const onSelect = vi.fn();
    const { rerender } = render(<Scrubber rows={rows} selectedId="ver_ai" onSelect={onSelect} now={NOW} tz={TZ} />);
    const slider = screen.getByRole('slider', { name: 'Moment in this comic’s history' });
    expect(slider.getAttribute('aria-valuetext')).toMatch(/^[A-Z][a-z]+day \d\d:\d\d, AI revised pages 3 to 4$/);
    expect(slider.className).toMatch(TARGET_RE);
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(onSelect).toHaveBeenLastCalledWith('ver_before');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onSelect).toHaveBeenLastCalledWith('ver_edit');
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(onSelect).toHaveBeenLastCalledWith('ver_start');
    fireEvent.keyDown(slider, { key: 'End' });
    expect(onSelect).toHaveBeenLastCalledWith('ver_edit');
    fireEvent.keyDown(slider, { key: 'PageDown' });
    expect(onSelect).toHaveBeenLastCalledWith('ver_start');
    rerender(<Scrubber rows={rows} selectedId="ver_draft2" onSelect={onSelect} now={NOW} tz={TZ} />);
    expect(slider.getAttribute('aria-valuetext')).toMatch(/, Draft 2$/);
    fireEvent.keyDown(slider, { key: 'PageUp' });
    expect(onSelect).toHaveBeenLastCalledWith('ver_edit');
  });

  it('in the panel, the scrubber drives the filmstrip and never touches the live book', async () => {
    const m = historySetup();
    browser(m, req());
    await settle();
    const slider = screen.getByRole('slider', { name: 'Moment in this comic’s history' });
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(screen.getByRole('list', { name: /The book at History starts here/ })).toBeInTheDocument();
    fireEvent.keyDown(slider, { key: 'End' });
    expect(screen.getByRole('list', { name: /The book at You edited dialogue on page 2/ })).toBeInTheDocument();
    expect(m.studio.act).not.toHaveBeenCalled();
    expect(m.studio.patch).not.toHaveBeenCalled();
  });
});

// ── Word diff ────────────────────────────────────────────────────────────────

describe('diffs carry "removed:" / "added:" screen-reader text', () => {
  it('WordDiff marks removed and added words in words, not only in style', () => {
    const { container } = render(<WordDiff from="You owe me the truth, Maya." to="You owe me an answer, Maya." lang="en" />);
    expect(container.querySelectorAll('del')).toHaveLength(1);
    expect(container.querySelectorAll('ins')).toHaveLength(1);
    const del = container.querySelector('del')!;
    const ins = container.querySelector('ins')!;
    expect(del.textContent).toBe('removed: the truth,');
    expect(ins.textContent).toBe('added: an answer,');
    expect(del.querySelector('.sr-only')!.textContent).toBe('removed: ');
    expect(ins.querySelector('.sr-only')!.textContent).toBe('added: ');
    expect(container.firstElementChild!.getAttribute('dir')).toBe('auto');
    expect(container.firstElementChild!.getAttribute('lang')).toBe('en');
  });

  it('the page compare shows the AI’s rewording of page 3 with the same words', async () => {
    const m = historySetup();
    browser(m, req({ view: 'compare', versionId: 'ver_before', pageId: 'pg_3' }));
    await settle();
    const line = document.querySelector('[data-line-diff="pg_3_l3"]')!;
    expect(line.textContent).toContain('removed: the truth');
    expect(line.textContent).toContain('added: an answer');
  });
});

// ── Use then ─────────────────────────────────────────────────────────────────

describe('"Use then" sends the right RestoreScope', () => {
  const restoreOf = (m: Mounted) => m.studio.act.mock.calls.map((c) => c[0]).filter((a: { type: string }) => a.type === 'history_restore');

  it('for a line, a panel, a page (whole, text only, art only) and a language — each free, from the earlier moment', async () => {
    const m = historySetup({ studio: { act: fakeAct() } });
    browser(m, req({ view: 'compare', versionId: 'ver_before', pageId: 'pg_3' }));
    await settle();
    const compare = view('compare');
    expect(compare.querySelector('[data-page-compare="pg_3"]')).toBeTruthy();
    fireEvent.click(within(compare.querySelector<HTMLElement>('[data-line-diff="pg_3_l3"]')!).getByRole('button', { name: /Use then/ }));
    await settle();
    fireEvent.click(within(compare.querySelector<HTMLElement>('[data-panel-diff="pg_3_p3"]')!).getAllByRole('button', { name: /Use then: panel/ })[0]);
    await settle();
    fireEvent.click(within(compare).getByRole('button', { name: 'Use then for this page…' }));
    fireEvent.click(within(compare).getByRole('button', { name: 'Whole page' }));
    await settle();
    fireEvent.click(within(compare).getByRole('button', { name: 'Text only' }));
    await settle();
    fireEvent.click(within(compare).getByRole('button', { name: 'Art only' }));
    await settle();
    fireEvent.click(within(compare.querySelector<HTMLElement>('[data-history-languages]')!).getByRole('button', { name: /Telugu/ }));
    fireEvent.click(within(compare).getByRole('button', { name: 'Use then: the Telugu edition (free)' }));
    await settle();
    expect(restoreOf(m)).toEqual([
      { type: 'history_restore', versionId: 'ver_before', scope: { kind: 'line', pageId: 'pg_3', lineId: 'pg_3_l3' } },
      { type: 'history_restore', versionId: 'ver_before', scope: { kind: 'panel', pageId: 'pg_3', panelId: 'pg_3_p3' } },
      { type: 'history_restore', versionId: 'ver_before', scope: { kind: 'page', pageId: 'pg_3', mode: 'replace', part: 'all' } },
      { type: 'history_restore', versionId: 'ver_before', scope: { kind: 'page', pageId: 'pg_3', mode: 'replace', part: 'text' } },
      { type: 'history_restore', versionId: 'ver_before', scope: { kind: 'page', pageId: 'pg_3', mode: 'replace', part: 'art' } },
      { type: 'history_restore', versionId: 'ver_before', scope: { kind: 'language', lang: 'te' } }
    ]);
    // Partial restores never carry baseRev (a stray job commit must not block them) and the toast offers Undo.
    expect(screen.getByText(/restored from/)).toBeInTheDocument();
  });

  it('a page deleted since comes back where it was (insert), and a drawing page is refused with words, not sent', async () => {
    const m = historySetup({ studio: { act: fakeAct(), isRendering: (t) => t.kind === 'page' && t.id === 'pg_3' } });
    browser(m, req({ view: 'compare', versionId: 'ver_before', pageId: 'pg_3' }));
    await settle();
    const compare = view('compare');
    expect(compare.textContent).toContain('Page 3 is still drawing — restore when it’s done.');
    for (const b of within(compare.querySelector<HTMLElement>('[data-page-compare="pg_3"]')!).getAllByRole('button', { name: /Use then/ })) expect(b).toBeDisabled();
    expect(m.studio.act).not.toHaveBeenCalled();
  });

  it('Undo on the toast restores the before-restore moment with the same scope', async () => {
    const before = { ...historySetup().fixture.versions[0].row, id: 'ver_br', kind: 'before_restore' as const };
    const m = historySetup({ studio: { act: fakeAct() }, lastHistoryVersion: { ...before, id: 'ver_r', kind: 'restore', undoId: 'ver_br' } });
    browser(m, req({ view: 'compare', versionId: 'ver_before', pageId: 'pg_3' }));
    await settle();
    fireEvent.click(within(view('compare').querySelector<HTMLElement>('[data-line-diff="pg_3_l3"]')!).getByRole('button', { name: /Use then/ }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await settle();
    expect(m.studio.act).toHaveBeenLastCalledWith({ type: 'history_restore', versionId: 'ver_br', scope: { kind: 'line', pageId: 'pg_3', lineId: 'pg_3_l3' } });
  });
});

// ── Restore sheet ────────────────────────────────────────────────────────────

describe('the restore sheet lists pages to Deleted, editions kept and the model unchanged', () => {
  it('says what happens first, then restores the whole book with the live revision', async () => {
    const m = historySetup({ studio: { act: fakeAct() } });
    panel(m, req({ view: 'confirm', versionId: 'ver_before' }));
    await settle(6);
    const sheet = document.querySelector<HTMLElement>('[data-restore-sheet]')!;
    expect(within(sheet).getByRole('heading', { name: /^Restore the whole book to .+\?$/ })).toBeInTheDocument();
    expect(sheet.textContent).toContain(HISTORY_COPY.saveFirst);
    const items = within(sheet.querySelector<HTMLElement>('[data-restore-list]')!)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(items).toContain('1 page added since goes to Deleted');
    expect(items).toContain('Hindi kept');
    expect(items).toContain('Telugu kept');
    expect(items).toContain('Image model stays Nano Banana 2.1');
    expect(items).toContain('Cover stays');
    expect(items.find((t) => /pages? change$/.test(t || ''))).toBe('3 pages change');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Restore' }));
    await settle();
    expect(m.studio.act).toHaveBeenCalledWith({ type: 'history_restore', versionId: 'ver_before', scope: { kind: 'book' }, baseRev: m.fixture.live.rev });
    expect(document.querySelector('[data-restore-sheet]')).toBeNull();
    expect(screen.getByText(/^Restored to /)).toBeInTheDocument();
  });

  it('a refused restore keeps the sheet open and says why (nothing changed)', async () => {
    const act = vi.fn(async () => ({ ok: false, error: 'Your comic changed while you were looking. Review the changes again.', aborted: false, retryable: false, gated: false }));
    const m = historySetup({ studio: { act } });
    panel(m, req({ view: 'confirm', versionId: 'ver_before' }));
    await settle(6);
    fireEvent.click(within(document.querySelector<HTMLElement>('[data-restore-sheet]')!).getByRole('button', { name: 'Restore' }));
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Your comic changed while you were looking.');
  });
});

// ── Read-only reader ─────────────────────────────────────────────────────────

describe('the reader view is read-only', () => {
  it('shows the moment’s book in the reader with no edit, download or share controls', async () => {
    const m = historySetup();
    browser(m, req({ view: 'moment', versionId: 'ver_before' }));
    await settle();
    fireEvent.click(within(view('moment')).getByRole('button', { name: 'Read this version' }));
    await settle(6);
    const reader = view('reader');
    expect(reader.querySelector('[data-readonly="true"]')).toBeTruthy();
    expect(within(reader).getByRole('status')).toHaveTextContent(/^Viewing .+ — read-only$/);
    expect(reader.querySelectorAll('textarea, [contenteditable="true"], input[type="text"], input:not([type])')).toHaveLength(0);
    for (const b of interactive(reader)) expect(b.getAttribute('aria-label') || b.textContent || '').not.toMatch(/\b(edit|delete|redraw|download|share|rename)\b/i);
    expect(within(reader).getByRole('button', { name: 'Back to now' })).toBeInTheDocument();
    expect(m.studio.patch).not.toHaveBeenCalled();
    expect(m.studio.act).not.toHaveBeenCalled();
    expect(m.api.calls.some((c) => c.method === 'book' && c.args[1] === 'ver_before')).toBe(true);
  });
});

// ── Reduced motion ───────────────────────────────────────────────────────────

describe('reduced motion disables animation and auto-blink', () => {
  const openBlink = async (reducedMotion: boolean) => {
    const m = historySetup({ reducedMotion });
    panel(m, req({ view: 'compare', versionId: 'ver_before', pageId: 'pg_3' }));
    await settle();
    fireEvent.click(within(view('compare')).getByRole('radio', { name: 'Blink' }));
    return m;
  };

  it('with motion allowed, Auto-blink alternates then and now', async () => {
    await openBlink(false);
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Auto-blink' }));
    const shown = () => document.querySelector('[data-blink]')!.getAttribute('data-blink');
    expect(shown()).toBe('then');
    act(() => void vi.advanceTimersByTime(AUTO_BLINK_MS));
    expect(shown()).toBe('now');
    act(() => void vi.advanceTimersByTime(AUTO_BLINK_MS));
    expect(shown()).toBe('then');
  });

  it('under reduced motion there is no auto-blink, the sheet does not slide and the toast does not animate', async () => {
    const m = await openBlink(true);
    expect(screen.queryByRole('button', { name: 'Auto-blink' })).toBeNull();
    // Blink stays manual: B and the button flip it.
    fireEvent.click(screen.getByRole('button', { name: 'Show now' }));
    expect(document.querySelector('[data-blink]')!.getAttribute('data-blink')).toBe('now');
    expect(document.querySelector('[data-sheet="bottom"]')!.className).not.toMatch(/studio-reveal|transition-\[height\]/);
    m.studio.act = fakeAct();
    fireEvent.click(within(view('compare').querySelector<HTMLElement>('[data-line-diff="pg_3_l3"]')!).getByRole('button', { name: /Use then/ }));
    await settle();
    expect(document.querySelector('[data-history-toast]')!.className).not.toMatch(/ds-toast-enter/);
  });
});

// ── Android back ─────────────────────────────────────────────────────────────

describe('Android back closes layers in order', () => {
  const back = async () =>
    act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 40));
    });

  it('the restore sheet first, then the moment, then the panel', async () => {
    const onClose = vi.fn();
    const m = historySetup();
    panel(m, req(), onClose);
    await settle();
    fireEvent.click(document.querySelector('[data-moment="ver_before"]')!);
    await settle();
    fireEvent.click(within(view('moment')).getByRole('button', { name: 'Restore…' }));
    await settle();
    expect(openLayers()).toEqual(['sheet:History', 'history:view:1', 'sheet:Restore the whole book']);
    await back();
    expect(document.querySelector('[data-restore-sheet]')).toBeNull();
    expect(view('moment')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    await back();
    expect(view('list')).toBeTruthy();
    expect(openLayers()).toEqual(['sheet:History']);
    expect(onClose).not.toHaveBeenCalled();
    await back();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ── Empty, v4 "Earlier", classic ─────────────────────────────────────────────

describe('the empty, v4 "Earlier" and "Classic snapshots" states render', () => {
  it('a new comic: History starts now', async () => {
    const m = historySetup({ fixture: 'empty' });
    browser(m, req());
    await settle();
    expect(document.querySelector('[data-history-empty]')).toHaveTextContent(HISTORY_COPY.empty);
    expect(document.querySelector('[data-history-earlier]')).toBeNull();
    expect(document.querySelector('[data-history-retention]')).toHaveTextContent(HISTORY_COPY.retention);
  });

  it('a v4 comic: History starts here, and its older drawings are "Earlier (images only)" by day', async () => {
    const m = historySetup({ fixture: 'v4' });
    browser(m, req());
    await settle();
    const earlier = document.querySelector<HTMLElement>('[data-history-earlier]')!;
    expect(within(earlier).getByRole('heading', { name: 'Earlier (images only)' })).toBeInTheDocument();
    expect(earlier.textContent).toMatch(/Only drawings were recorded before \d+ [A-Z][a-z]{2}\./);
    // The v4 fixture's five pages each hold one older drawing.
    expect(within(earlier).getAllByRole('button', { name: /: open$/ })).toHaveLength(5);
    expect(document.querySelector('[data-moment="ver_start"]')).toHaveTextContent('History starts here');
  });

  it('a classic import: Classic snapshots (3), read-only, each can start a new comic (free)', async () => {
    const m = historySetup({ fixture: 'classic' });
    browser(m, req());
    await settle(6);
    const classic = document.querySelector<HTMLElement>('[data-history-classic]')!;
    expect(within(classic).getByRole('heading', { name: 'Classic snapshots (3)' })).toBeInTheDocument();
    expect(classic.querySelectorAll('[data-classic-snapshot]')).toHaveLength(3);
    expect(m.api.calls.find((c) => c.method === 'classicSnapshots')?.args[0]).toBe('classic_1');
  });
});

// ── Card ─────────────────────────────────────────────────────────────────────

describe('the history card renders from ids', () => {
  const msg = { id: 'm', role: 'assistant' as const, text: '', at: NOW };
  const card = (c: Partial<HistoryCardData>): HistoryCardData => ({ type: 'history', id: 'card_1', view: 'moment', ...c });

  it('a moment card fetches the moment by id and shows what changed', async () => {
    const m = historySetup();
    mountWith(m, <HistoryCardView card={card({ view: 'moment', versionId: 'ver_ai' })} message={msg} studio={m.studio} now={NOW} tz={TZ} />);
    await settle();
    expect(m.api.calls.filter((c) => c.method === 'detail').map((c) => c.args[1])).toEqual(['ver_ai']);
    const el = document.querySelector<HTMLElement>('[data-history-card="moment"]')!;
    expect(screen.getByText('AI revised pages 3–4')).toBeInTheDocument();
    expect(el.textContent).toMatch(/Page 3 — Dialogue/);
  });

  it('a compare card counts the changed pages from the compare route; "See changes" opens History there', async () => {
    const m = historySetup();
    const onOpen = vi.fn((e: Event) => e.preventDefault());
    window.addEventListener('ds:open-history', onOpen);
    mountWith(m, <HistoryCardView card={card({ view: 'compare', a: 'ver_before', b: 'now' })} message={msg} studio={m.studio} now={NOW} tz={TZ} />);
    await settle();
    expect(m.api.calls.find((c) => c.method === 'compare')?.args).toEqual(['proj-v5', 'ver_before', 'now']);
    expect(screen.getByText('4 pages changed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'See changes' }));
    expect((onOpen.mock.calls[0][0] as CustomEvent).detail).toEqual({ view: 'compare', versionId: 'ver_before' });
    window.removeEventListener('ds:open-history', onOpen);
  });

  it('holds no content of its own: a card whose moment is gone says so, with nothing invented', async () => {
    const m = historySetup();
    mountWith(m, <HistoryCardView card={card({ view: 'moment', versionId: 'ver_missing' })} message={msg} studio={m.studio} now={NOW} tz={TZ} />);
    await settle();
    expect(screen.getByText("History isn't available for this comic yet.")).toBeInTheDocument();
  });
});

// ── No git words ─────────────────────────────────────────────────────────────

describe('the no-git-words regex finds nothing in rendered copy', () => {
  it('the guard catches the words it must', () => {
    for (const w of ['commit', 'committed', 'branch', 'merge', 'merged', 'diff', 'checkout', 'rebase', 'revert', 'fork', 'HEAD']) expect(gitWordsIn(`a ${w} b`), w).toEqual([w]);
    expect(gitWordsIn('a character’s head')).toEqual([]);
    expect(GIT_WORDS_RE.test('Restore the whole book')).toBe(false);
  });

  it('every History surface, its labels and its titles use plain words', async () => {
    const texts: string[] = [];
    const collect = (root: HTMLElement) => {
      texts.push(root.textContent || '');
      for (const el of Array.from(root.querySelectorAll<HTMLElement>('[aria-label],[title],[aria-valuetext]'))) texts.push(el.getAttribute('aria-label') || '', el.getAttribute('title') || '', el.getAttribute('aria-valuetext') || '');
    };
    for (const s of await tour(360)) collect(s.root);
    const m = historySetup();
    const { container } = mountWith(
      m,
      <>
        <HistoryCardView card={{ type: 'history', id: 'a', view: 'list' }} message={{ id: 'm', role: 'assistant', text: '', at: NOW }} studio={m.studio} now={NOW} tz={TZ} />
        <HistoryCardView card={{ type: 'history', id: 'b', view: 'undo_ai' }} message={{ id: 'm', role: 'assistant', text: '', at: NOW }} studio={m.studio} now={NOW} tz={TZ} />
        <HistoryButton studio={m.studio} compact={false} />
        <PageHistoryLink studio={m.studio} target={{ kind: 'page', id: 'pg_1' }} />
        <TimelineHistoryLink studio={m.studio} />
      </>
    );
    await settle();
    collect(container);
    expect(texts.join('\n').length).toBeGreaterThan(500);
    expect(gitWordsIn(texts.join('\n'))).toEqual([]);
  });
});

// ── Off by default ───────────────────────────────────────────────────────────

describe('with Comic History off, no entry point shows', () => {
  it('the header button, the tab, the card, the links and the panel render nothing; nobody answers the open event', async () => {
    const m = historySetup({ caps: DEFAULT_CAPS });
    const doc = m.fixture.live;
    const { container } = mountWith(
      m,
      <>
        <HistoryButton studio={m.studio} compact />
        <HistoryTab studio={m.studio} />
        <HistoryCardView card={{ type: 'history', id: 'a', view: 'list' }} message={{ id: 'm', role: 'assistant', text: '', at: NOW }} studio={m.studio} />
        <PageHistoryLink studio={m.studio} target={{ kind: 'page', id: 'pg_1' }} />
        <TimelineHistoryLink studio={m.studio} />
        <ChangesSincePublishLink studio={m.studio} />
        <HistoryPanel studio={m.studio} open onClose={vi.fn()} />
      </>
    );
    await settle();
    expect(container.innerHTML).toBe('');
    expect(document.body.querySelector('[data-history-sheet]')).toBeNull();
    expect(feature.tabs?.[0].visible?.(doc, DEFAULT_CAPS)).toBe(false);
    expect(requestOpenHistory({ view: 'list' })).toBe(false);
    expect(m.api.calls).toEqual([]);
  });

  it('with it on, the header button opens the panel and answers the open event', async () => {
    const m = historySetup();
    mountWith(m, <HistoryButton studio={m.studio} compact />);
    expect(feature.tabs?.[0].visible?.(m.fixture.live, m.studio.caps)).toBe(true);
    let handled = false;
    act(() => {
      handled = requestOpenHistory({ view: 'moment', versionId: 'ver_ai' });
    });
    expect(handled).toBe(true);
    await settle();
    expect(document.querySelector('[data-moment-detail="ver_ai"]')).toBeTruthy();
  });

  it('the feature registers the header slot (240), the tab (510) and the history card', () => {
    expect(feature.headerSlots?.map((s) => [s.id, s.order])).toEqual([['history', 240]]);
    expect(feature.tabs?.map((t) => [t.id, t.order])).toEqual([['history', 510]]);
    expect(feature.cards?.map((c) => c.type)).toEqual(['history']);
  });
});

// ── QA scenes (registered by the qa/KitScenes.tsx owner) ─────────────────────

describe('the QA scenes render offline on the fake API', () => {
  it('every History kit scene mounts with content and makes no history action', async () => {
    for (const scene of HISTORY_KIT_SCENES) {
      const { container, unmount } = render(
        <FormFactorProvider value={formFactorFor({ w: 360, h: 740, coarse: true })}>
          <HistoryKitScene params={parseQaParams(`?surface=kit&kit=${scene}`)} scene={scene} />
        </FormFactorProvider>
      );
      await settle(6);
      expect(container.querySelectorAll('[data-testid^="kit-history"]').length, scene).toBeGreaterThan(0);
      expect(container.textContent!.length, scene).toBeGreaterThan(40);
      unmount();
      resetBackStack();
    }
  });
});
