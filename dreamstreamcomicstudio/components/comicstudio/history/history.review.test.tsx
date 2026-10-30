// The History UI's review-round regressions (package H5): each test fails without its fix.
//
//   - a translation-only compare still offers the language "Use then" (chips + an "Other changes" row per edition)
//   - a character / place / style piece lists the pages it puts "Out of date" and waits for [Bring back] (panel + card)
//   - the toast's Undo restores the moment the restore itself names, never "the newest before-restore moment"
//   - the undo-AI sheet and "Undo this AI change" follow the comic's latest AI run, whatever the list's filter shows
//   - a panel's "Use then" that leaves the newer drawing asks what next (earlier drawing free · quoted redraw)
//   - "Earlier (images only)" waits until History's start is known; the panel re-reads after its own actions
//   - a gone moment says so (not "History isn't available") (the reader's re-signing: VersionReader.test.tsx)
//   - a phone header narrower than 480 px gets no History icon (it overflowed), yet History still opens
//   - the timeline link is 44 px on every pointer; a row never renders a stray "0"; the publish link stays quiet
//     when nothing changed; the undo-AI conflict asks in the plan's words

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { normalizeDoc, type ComicDoc } from '../../../shared/comic/doc';
import type { HistoryCard as HistoryCardData, VersionRow } from '../../../shared/comic/history/types';
import { resetUsageStatus, showDollarPrices, showUsagePrices } from '../conversation/testing/fixtures';
import { resetBackStack } from '../mobile/backStack';
import { ChangesSincePublishLink } from './ChangesSincePublishLink';
import { TimelineHistoryLink } from './EntryLinks';
import { HistoryButton, HISTORY_HEADER_ICON_MIN_WIDTH } from './HistoryButton';
import { HistoryCardView } from './HistoryCard';
import { requestOpenHistory } from './openHistory';
import { HistoryBrowser, HistoryPanel, type HistoryOpenRequest } from './HistoryPanel';
import { HISTORY_MOMENT_GONE, HISTORY_UNAVAILABLE } from './historyApi';
import { MomentRow } from './MomentRow';
import { gitWordsIn } from './historyModel';
import { beforeRestoreId } from './historyActions';
import { historyFixture } from './__scenes__/historyFixtures';
import { fakeAct, historySetup, HISTORY_NOW, HISTORY_TZ, interactive, mountWith, overflowProblems, settle, TARGET_RE, type Mounted } from './history.testkit';

const NOW = HISTORY_NOW;
const TZ = HISTORY_TZ;
let seq = 0;
const req = (r: Omit<HistoryOpenRequest, 'seq'> = {}): HistoryOpenRequest => ({ ...r, seq: ++seq });
const browser = (m: Mounted, request?: HistoryOpenRequest) => mountWith(m, <HistoryBrowser studio={m.studio} open request={request ?? null} now={NOW} tz={TZ} />);
const panel = (m: Mounted, request?: HistoryOpenRequest) => mountWith(m, <HistoryPanel studio={m.studio} open onClose={vi.fn()} request={request ?? null} now={NOW} tz={TZ} />);
const view = (kind: string): HTMLElement => {
  const all = Array.from(document.querySelectorAll<HTMLElement>(`[data-history-view="${kind}"]`)).filter((el) => !el.hidden);
  expect(all.length, `the ${kind} view is shown`).toBeGreaterThan(0);
  return all[all.length - 1];
};
const restoresOf = (m: Mounted) => m.studio.act.mock.calls.map((c) => c[0]).filter((a: { type: string }) => a.type === 'history_restore');
const clone = (d: ComicDoc): ComicDoc => JSON.parse(JSON.stringify(d)) as ComicDoc;
const msg = { id: 'm', role: 'assistant' as const, text: '', at: NOW };

/** A saved moment (synthetic) holding `doc`, newer than every fixture moment unless `at` says otherwise. */
const moment = (id: string, doc: ComicDoc, extra: Partial<VersionRow> = {}): { row: VersionRow; doc: ComicDoc } => ({
  row: {
    id,
    kind: 'edits',
    actor: 'you',
    label: `Moment ${id}`,
    pinned: false,
    rev: doc.rev,
    contentAt: NOW - 5 * 60_000,
    createdAt: NOW - 5 * 60_000,
    codec: 'v5',
    changes: [],
    thumbs: [],
    stats: { pages: doc.pages.length, drawn: 0, lines: 0, langs: [], models: [] },
    ...extra
  },
  doc
});

/** The v5 fixture with extra moments in front (newest first). */
const withMoments = (extra: { row: VersionRow; doc: ComicDoc }[], opts: Parameters<typeof historySetup>[0] = {}): Mounted => {
  const base = historyFixture('v5');
  return historySetup({ ...opts, api: { versions: [...extra, ...base.versions], ...(opts.api || {}) } });
};

beforeEach(() => {
  resetBackStack();
  showUsagePrices(1);
});

afterEach(() => {
  resetBackStack();
  resetUsageStatus();
});

// ── Major 1: a translation-only compare ──────────────────────────────────────

describe('a compare where only translations differ', () => {
  const translated = () => {
    const d = clone(historyFixture('v5').live);
    d.i18n!.editions.te.lines.pg_1_l1 = { ...d.i18n!.editions.te.lines.pg_1_l1, text: 'నా పాత అనువాదం.' };
    return normalizeDoc(d);
  };

  it('shows the language chips and a Telugu row whose "Use then" sends the language scope', async () => {
    const m = withMoments([moment('ver_tr', translated())], { studio: { act: fakeAct() } });
    browser(m, req({ view: 'compare', versionId: 'ver_tr' }));
    await settle();
    const compare = view('compare');
    expect(compare.querySelector('[data-page-compare]')).toBeNull(); // no page differs
    expect(compare.textContent).toContain('1 translated line');
    expect(compare.querySelector('[data-history-languages]')).toBeTruthy();
    const row = compare.querySelector<HTMLElement>('[data-other-change="ed:te"]')!;
    expect(row.textContent).toContain('Telugu');
    expect(row.textContent).toContain('1 translated line differs');
    fireEvent.click(within(row).getByRole('button', { name: 'Use then: Telugu (free)' }));
    await settle();
    expect(restoresOf(m)).toEqual([{ type: 'history_restore', versionId: 'ver_tr', scope: { kind: 'language', lang: 'te' } }]);
  });

  it('the Telugu chip offers the whole edition too', async () => {
    const m = withMoments([moment('ver_tr', translated())], { studio: { act: fakeAct() } });
    browser(m, req({ view: 'compare', versionId: 'ver_tr' }));
    await settle();
    const chips = view('compare').querySelector<HTMLElement>('[data-history-languages]')!;
    fireEvent.click(within(chips).getByRole('button', { name: /Telugu/ }));
    fireEvent.click(within(chips).getByRole('button', { name: 'Use then: the Telugu edition (free)' }));
    await settle();
    expect(restoresOf(m)).toEqual([{ type: 'history_restore', versionId: 'ver_tr', scope: { kind: 'language', lang: 'te' } }]);
  });
});

// ── Major 2: pieces that put pages out of date ───────────────────────────────

describe('a character, place or style piece lists the pages it puts out of date first', () => {
  const lookChanged = () => {
    const d = clone(historyFixture('v5').live);
    d.cast[0].look = { ...d.cast[0].look, summary: 'A wiry girl in a green scarf' };
    return normalizeDoc(d);
  };

  it('compare: nothing is sent until [Bring back]; Cancel sends nothing', async () => {
    const m = withMoments([moment('ver_look', lookChanged())], { studio: { act: fakeAct() } });
    browser(m, req({ view: 'compare', versionId: 'ver_look' }));
    await settle();
    const row = () => view('compare').querySelector<HTMLElement>('[data-other-change="char:ch_maya"]')!;
    fireEvent.click(within(row()).getByRole('button', { name: 'Use then: Maya (free)' }));
    await settle();
    expect(restoresOf(m)).toEqual([]);
    const ask = row().querySelector<HTMLElement>('[data-stale-confirm]')!;
    expect(ask.textContent).toContain('Pages 1–6 will show Out of date until redrawn. Bring Maya back anyway?');
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(row().querySelector('[data-stale-confirm]')).toBeNull();
    expect(restoresOf(m)).toEqual([]);
    fireEvent.click(within(row()).getByRole('button', { name: 'Use then: Maya (free)' }));
    fireEvent.click(within(row()).getByRole('button', { name: 'Bring back · Free' }));
    await settle();
    expect(restoresOf(m)).toEqual([{ type: 'history_restore', versionId: 'ver_look', scope: { kind: 'character', id: 'ch_maya' } }]);
  });

  it('a piece that puts no page out of date is taken back at once', async () => {
    const d = clone(historyFixture('v5').live);
    d.places = d.places.map((p) => (p.id === 'pl_roof' ? { ...p, look: 'Tin roofs, kites' } : p));
    const m = withMoments([moment('ver_roof', normalizeDoc(d))], { studio: { act: fakeAct() } });
    browser(m, req({ view: 'compare', versionId: 'ver_roof' }));
    await settle();
    const row = view('compare').querySelector<HTMLElement>('[data-other-change="place:pl_roof"]')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Use then: Rooftops (free)' }));
    await settle();
    expect(row.querySelector('[data-stale-confirm]')).toBeNull();
    expect(restoresOf(m)).toEqual([{ type: 'history_restore', versionId: 'ver_roof', scope: { kind: 'place', id: 'pl_roof' } }]);
  });

  it('the history card asks the same before a character comes back', async () => {
    const m = withMoments([moment('ver_look', lookChanged())], { studio: { act: fakeAct() } });
    const card: HistoryCardData = { type: 'history', id: 'k', view: 'confirm', versionId: 'ver_look', scope: { kind: 'character', id: 'ch_maya' } };
    mountWith(m, <HistoryCardView card={card} message={msg} studio={m.studio} now={NOW} tz={TZ} />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Use then · Free' }));
    await settle();
    expect(m.studio.act).not.toHaveBeenCalled();
    expect(document.querySelector('[data-stale-confirm="card"]')!.textContent).toContain('Pages 1–6 will show Out of date until redrawn. Bring Maya back anyway?');
    fireEvent.click(screen.getByRole('button', { name: 'Bring back · Free' }));
    await settle();
    expect(restoresOf(m)).toEqual([{ type: 'history_restore', versionId: 'ver_look', scope: { kind: 'character', id: 'ch_maya' } }]);
  });
});

// ── Major 3: the restore toast's Undo ────────────────────────────────────────

describe('the toast’s Undo restores the moment the restore itself names', () => {
  it('the restore row’s undoId — not the newest before-restore moment (a restore that reused the latest moment)', async () => {
    const live = historyFixture('v5').live;
    // The newest restore reused 'ver_edit' (the book already matched it, §6.1 step 4): no before_restore row of its
    // own. An older, unrelated before-restore moment is still inside the newest five.
    const m = withMoments(
      [
        moment('ver_r2', live, { kind: 'restore', actor: 'you', undoId: 'ver_edit', contentAt: NOW - 60_000, createdAt: NOW - 60_000 }),
        moment('ver_br_old', live, { kind: 'before_restore', actor: 'system', contentAt: NOW - 2 * 60_000, createdAt: NOW - 2 * 60_000 })
      ],
      { studio: { act: fakeAct() } }
    );
    browser(m, req({ view: 'compare', versionId: 'ver_before', pageId: 'pg_3' }));
    await settle();
    fireEvent.click(within(view('compare').querySelector<HTMLElement>('[data-line-diff="pg_3_l3"]')!).getByRole('button', { name: /Use then/ }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await settle();
    expect(m.studio.act).toHaveBeenLastCalledWith({ type: 'history_restore', versionId: 'ver_edit', scope: { kind: 'line', pageId: 'pg_3', lineId: 'pg_3_l3' } });
  });

  it('the restore’s own outcome (beforeVersionId) first, with no lookup', async () => {
    const act = vi.fn(async () => ({ ok: true, aborted: false, retryable: false, gated: false, beforeVersionId: 'ver_saved_first' }));
    const m = historySetup({ studio: { act } });
    browser(m, req({ view: 'compare', versionId: 'ver_before', pageId: 'pg_3' }));
    await settle();
    fireEvent.click(within(view('compare').querySelector<HTMLElement>('[data-line-diff="pg_3_l3"]')!).getByRole('button', { name: /Use then/ }));
    await settle();
    // The Undo lookup is an unfiltered read of the newest five moments.
    const lookups = () => m.api.calls.filter((c) => c.method === 'list' && (c.args[1] as { limit?: number; filter?: string }).limit === 5 && !(c.args[1] as { filter?: string }).filter).length;
    const before = lookups();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await settle();
    expect(act).toHaveBeenLastCalledWith({ type: 'history_restore', versionId: 'ver_saved_first', scope: { kind: 'line', pageId: 'pg_3', lineId: 'pg_3_l3' } });
    expect(lookups()).toBe(before);
  });

  it('with no restore row naming one, Undo says so instead of guessing', async () => {
    const live = historyFixture('v5').live;
    const m = withMoments([moment('ver_br_old', live, { kind: 'before_restore', actor: 'system' })], { studio: { act: fakeAct() } });
    browser(m, req({ view: 'compare', versionId: 'ver_before', pageId: 'pg_3' }));
    await settle();
    fireEvent.click(within(view('compare').querySelector<HTMLElement>('[data-line-diff="pg_3_l3"]')!).getByRole('button', { name: /Use then/ }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await settle();
    expect(restoresOf(m)).toHaveLength(1); // only the Use then
    expect(screen.getByText(/Couldn’t find the copy saved just before/)).toBeInTheDocument();
  });
});

// ── Major 4: undo-AI follows the comic's latest AI run ───────────────────────

describe('the undo-AI sheet and "Undo this AI change" follow the comic’s latest AI run', () => {
  it('with "This page" on an older AI run’s page, the menu offers no undo for it and the sheet previews the latest run', async () => {
    const m = historySetup({ studio: { act: fakeAct() } });
    // Page 1 was touched only by the older run ("AI drew pages 1–5"); the latest run revised pages 3–4.
    browser(m, req({ view: 'moment', versionId: 'ver_draw', pageId: 'pg_1' }));
    await settle(6);
    expect(m.api.calls.some((c) => c.method === 'list' && (c.args[1] as { filter?: string }).filter === 'page')).toBe(true);
    const detail = view('moment');
    expect(detail.querySelector('[data-moment-detail="ver_draw"]')).toBeTruthy();
    // No More menu at all: not the latest AI run, and a filtered list's first row is not the newest moment.
    expect(within(detail).queryByRole('button', { name: 'More' })).toBeNull();
  });

  it('the latest AI run offers "Undo this AI change" even when the filtered list does not show it', async () => {
    const m = historySetup({ studio: { act: fakeAct() } });
    browser(m, req({ view: 'moment', versionId: 'ver_ai', pageId: 'pg_1' }));
    await settle(6);
    fireEvent.click(within(view('moment')).getByRole('button', { name: 'More' }));
    expect(within(view('moment')).getByRole('button', { name: 'Undo this AI change · Free' })).toBeInTheDocument();
  });

  it('the sheet opened under a page filter shows the run the server reverts', async () => {
    const m = historySetup({ studio: { act: fakeAct() } });
    panel(m, req({ view: 'undo_ai', pageId: 'pg_1' }));
    await settle(8);
    const sheet = document.querySelector<HTMLElement>('[data-undo-ai-sheet]')!;
    expect(sheet.textContent).toContain('AI revised pages 3–4');
    expect(sheet.textContent).not.toContain('AI drew pages 1–5');
    expect(m.api.calls.some((c) => c.method === 'list' && (c.args[1] as { filter?: string }).filter === 'ai')).toBe(true);
  });

  it('the latest AI run beyond the first page of moments is still found', async () => {
    const m = historySetup({ studio: { act: fakeAct() }, api: { pageSize: 1 } });
    panel(m, req({ view: 'undo_ai' }));
    await settle(8);
    const sheet = document.querySelector<HTMLElement>('[data-undo-ai-sheet]')!;
    expect(sheet.textContent).not.toContain('There’s no AI change to undo yet.');
    expect(sheet.textContent).toContain('AI revised pages 3–4');
  });
});

// ── Minor: the panel's drawing after a panel "Use then" ──────────────────────

describe('a panel "Use then" that leaves the newer drawing asks what next', () => {
  const actionChanged = () => {
    const f = historyFixture('v5');
    const d = clone(f.versions.find((v) => v.row.id === 'ver_before')!.doc);
    d.pages.find((p) => p.id === 'pg_3')!.panels[0].action = 'The market before dawn, empty';
    return normalizeDoc(d);
  };

  it('offers the earlier drawing (free) and a quoted redraw — and sends neither by itself', async () => {
    showDollarPrices();
    const m = withMoments([moment('ver_act', actionChanged())], { studio: { act: fakeAct() } });
    browser(m, req({ view: 'compare', versionId: 'ver_act', pageId: 'pg_3' }));
    await settle();
    const panelRow = view('compare').querySelector<HTMLElement>('[data-panel-diff="pg_3_p1"]')!;
    expect(panelRow.textContent).toContain('action changed');
    fireEvent.click(within(panelRow).getByRole('button', { name: /Use then: panel/ }));
    await settle();
    expect(restoresOf(m)).toEqual([{ type: 'history_restore', versionId: 'ver_act', scope: { kind: 'panel', pageId: 'pg_3', panelId: 'pg_3_p1' } }]);
    const toast = document.querySelector<HTMLElement>('[data-history-toast]')!;
    expect(toast.textContent).toContain('The drawing still shows the newer panel.');
    const redraw = within(toast).getByRole('button', { name: /^Redraw page 3 · ≈ \$\d/ });
    expect(m.studio.act).toHaveBeenCalledTimes(1);
    fireEvent.click(within(toast).getByRole('button', { name: 'Use the earlier drawing too · Free' }));
    await settle();
    expect(restoresOf(m)[1]).toEqual({ type: 'history_restore', versionId: 'ver_act', scope: { kind: 'page', pageId: 'pg_3', mode: 'replace', part: 'art' } });
    expect(redraw).toBeTruthy();
  });

  it('the redraw is the normal quoted page render', async () => {
    const m = withMoments([moment('ver_act', actionChanged())], { studio: { act: fakeAct() } });
    browser(m, req({ view: 'compare', versionId: 'ver_act', pageId: 'pg_3' }));
    await settle();
    fireEvent.click(within(view('compare').querySelector<HTMLElement>('[data-panel-diff="pg_3_p1"]')!).getByRole('button', { name: /Use then: panel/ }));
    await settle();
    const toast = document.querySelector<HTMLElement>('[data-history-toast]')!;
    expect(toast.textContent).not.toMatch(/\$\d/); // a governed viewer reads usage
    fireEvent.click(within(toast).getByRole('button', { name: /^Redraw page 3 · / }));
    await settle();
    const last = m.studio.act.mock.calls[m.studio.act.mock.calls.length - 1][0] as { type: string; pageIds: string[]; force: boolean; quotedUsd: number };
    expect(last).toMatchObject({ type: 'render_pages', pageIds: ['pg_3'], force: true });
    expect(last.quotedUsd).toBeGreaterThan(0);
  });

  it('a panel whose words only came back gets the plain toast', async () => {
    const m = historySetup({ studio: { act: fakeAct() } });
    browser(m, req({ view: 'compare', versionId: 'ver_before', pageId: 'pg_3' }));
    await settle();
    fireEvent.click(within(view('compare').querySelector<HTMLElement>('[data-panel-diff="pg_3_p3"]')!).getAllByRole('button', { name: /Use then: panel/ })[0]);
    await settle();
    expect(document.querySelector('[data-history-toast]')!.textContent).not.toContain('The drawing still shows');
    expect(document.querySelector('[data-toast-actions]')).toBeNull();
  });
});

// ── Minor: "Earlier (images only)" with older moments unloaded ───────────────

describe('"Earlier (images only)" waits until History’s start is known', () => {
  const v4WithMoments = () => {
    const f = historyFixture('v4');
    const recent = (id: string, min: number) => moment(id, f.live, { contentAt: NOW - min * 60_000, createdAt: NOW - min * 60_000 });
    return historySetup({ fixture: 'v4', api: { versions: [recent('ver_a', 2), recent('ver_b', 5), ...f.versions], pageSize: 1 } });
  };

  it('is not shown while older moments are unloaded, and is once the start arrives', async () => {
    const m = v4WithMoments();
    browser(m, req());
    await settle();
    expect(document.querySelector('[data-history-earlier]')).toBeNull();
    for (let i = 0; i < 2; i += 1) {
      fireEvent.click(screen.getByRole('button', { name: /older moments/i }));
      await settle();
    }
    expect(document.querySelector('[data-moment="ver_start"]')).toBeTruthy();
    expect(document.querySelector('[data-history-earlier]')).toBeTruthy();
  });
});

// ── Minor: the panel re-reads after its own actions ──────────────────────────

describe('the panel re-reads after its own actions', () => {
  it('a save reloads the moments; a piece taken back re-reads the open compare', async () => {
    const m = historySetup({ studio: { act: fakeAct() } });
    panel(m, req());
    await settle();
    // The moment list's own reads (filter 'all'), not the latest-AI lookups.
    const lists = () => m.api.calls.filter((c) => c.method === 'list' && (c.args[1] as { filter?: string }).filter === 'all').length;
    const before = lists();
    fireEvent.click(screen.getByRole('button', { name: /Save version/ }));
    fireEvent.click(within(document.querySelector<HTMLElement>('[data-save-sheet]')!).getByRole('button', { name: /^Save/ }));
    await settle();
    expect(m.studio.act).toHaveBeenCalledWith(expect.objectContaining({ type: 'history_save' }));
    expect(lists()).toBeGreaterThan(before);

    fireEvent.click(document.querySelector('[data-moment="ver_before"]')!);
    await settle();
    fireEvent.click(within(view('moment')).getByRole('button', { name: 'Compare with now' }));
    await settle();
    const compares = () => m.api.calls.filter((c) => c.method === 'compare').length;
    const c0 = compares();
    // The first changed page is page 2 (your edit since then).
    fireEvent.click(within(view('compare').querySelector<HTMLElement>('[data-line-diff="pg_2_l2"]')!).getByRole('button', { name: /Use then/ }));
    await settle();
    expect(compares()).toBeGreaterThan(c0);
  });
});

// ── Minor: 404 sentences ─────────────────────────────────────────────────────

describe('a missing moment says so; only the list speaks for the whole History', () => {
  const notFound = () => Object.assign(new Error('nope'), { kind: 'not_found', status: 404 });

  it('a moment card, a moment and a compare: "This moment isn’t kept any more…"', async () => {
    const m = historySetup();
    mountWith(m, <HistoryCardView card={{ type: 'history', id: 'c', view: 'moment', versionId: 'ver_gone' }} message={msg} studio={m.studio} now={NOW} tz={TZ} />);
    await settle();
    expect(screen.getByText(HISTORY_MOMENT_GONE)).toBeInTheDocument();
    expect(screen.queryByText(HISTORY_UNAVAILABLE)).toBeNull();
  });

  it('the compare of a thinned moment', async () => {
    const m = historySetup();
    browser(m, req({ view: 'compare', versionId: 'ver_gone' }));
    await settle();
    expect(view('compare').textContent).toContain(HISTORY_MOMENT_GONE);
  });

  it('the list itself: "History isn’t available for this comic yet."', async () => {
    const m = historySetup({ api: { fail: { list: notFound() } } });
    browser(m, req());
    await settle();
    expect(view('list').textContent).toContain(HISTORY_UNAVAILABLE);
  });
});

// ── The new pieces at 320 px: no overflow, 44 px targets ─────────────────────

describe('the new confirm and toast choices fit a 320 px phone', () => {
  it('the "Out of date" confirm and the drawing follow-up toast: nothing wider than the phone, every control 44 px', async () => {
    const f = historyFixture('v5');
    const look = clone(f.live);
    look.cast[0].look = { ...look.cast[0].look, summary: 'A wiry girl in a green scarf' };
    const act2 = clone(f.versions.find((v) => v.row.id === 'ver_before')!.doc);
    act2.pages.find((p) => p.id === 'pg_3')!.panels[0].action = 'The market before dawn, empty';
    const m = withMoments([moment('ver_look', normalizeDoc(look)), moment('ver_act', normalizeDoc(act2))], { width: 320, height: 568, studio: { act: fakeAct() } });
    const { unmount } = browser(m, req({ view: 'compare', versionId: 'ver_look' }));
    await settle();
    const row = view('compare').querySelector<HTMLElement>('[data-other-change="char:ch_maya"]')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Use then: Maya (free)' }));
    const ask = row.querySelector<HTMLElement>('[data-stale-confirm]')!;
    expect(overflowProblems(ask, 320)).toEqual([]);
    for (const el of interactive(ask)) expect(el.className).toMatch(TARGET_RE);
    unmount();
    resetBackStack();
    browser(m, req({ view: 'compare', versionId: 'ver_act', pageId: 'pg_3' }));
    await settle();
    fireEvent.click(within(view('compare').querySelector<HTMLElement>('[data-panel-diff="pg_3_p1"]')!).getByRole('button', { name: /Use then: panel/ }));
    await settle();
    const toast = document.querySelector<HTMLElement>('[data-history-toast]')!;
    expect(toast.querySelector('[data-toast-actions]')).toBeTruthy();
    expect(overflowProblems(toast, 320)).toEqual([]);
    for (const el of interactive(toast)) expect(el.className).toMatch(TARGET_RE);
  });
});

// ── Minor: the phone header at 320–430 px ────────────────────────────────────

describe('a narrow phone header gets no History icon (measured overflow), yet History still opens', () => {
  it('320 and 360 px compact headers: no icon; the open event still opens the panel; 480 px and wider headers show it', async () => {
    for (const width of [320, 360]) {
      const m = historySetup({ width, height: 740 });
      const { container, unmount } = mountWith(m, <HistoryButton studio={m.studio} compact />);
      expect(container.querySelector('[data-history-entry="header"]'), `${width}`).toBeNull();
      let handled = false;
      act(() => {
        handled = requestOpenHistory({ view: 'list' });
      });
      expect(handled).toBe(true);
      await settle();
      expect(document.querySelector('[data-history-sheet="History"]')).toBeTruthy();
      unmount();
      resetBackStack();
    }
    const wide = historySetup({ width: HISTORY_HEADER_ICON_MIN_WIDTH, height: 900 });
    const w = mountWith(wide, <HistoryButton studio={wide.studio} compact />);
    expect(w.container.querySelector('[data-history-entry="header"]')).toBeTruthy();
    w.unmount();
    const desk = historySetup({ width: 1440, height: 900, coarse: false });
    const d = mountWith(desk, <HistoryButton studio={desk.studio} compact={false} />);
    expect(d.container.querySelector('[data-history-entry="header"]')).toBeTruthy();
  });
});

// ── Minors: targets, a stray 0, the publish link, the conflict question ──────

describe('small things', () => {
  it('the timeline History link is a 44 px target on every pointer, not only on touch', () => {
    const m = historySetup({ coarse: false, width: 1440, height: 900 });
    const { container } = mountWith(m, <TimelineHistoryLink studio={m.studio} />);
    const btn = container.querySelector('button')!;
    expect(btn.className).toMatch(/(^|\s)min-h-11(\s|$)/);
    expect(btn.className).not.toMatch(/(^|\s)h-7(\s|$)/);
  });

  it('a moment published at revision 0 with no name shows "Published", never a stray 0', () => {
    const m = historySetup();
    const row = { ...m.fixture.versions[0].row, kind: 'edits' as const, name: undefined, publishedRev: 0 };
    const { container } = mountWith(m, <MomentRow row={row} money={{ governed: true, exact: () => 'x' }} tz={TZ} urlFor={() => undefined} onOpen={vi.fn()} />);
    expect(container.textContent).toContain('Published');
    expect(container.textContent).not.toMatch(/0$/);
    const unpublished = { ...row, publishedRev: undefined };
    const r2 = mountWith(m, <MomentRow row={unpublished} money={{ governed: true, exact: () => 'x' }} tz={TZ} urlFor={() => undefined} onOpen={vi.fn()} />);
    expect(r2.container.textContent).not.toContain('Published');
  });

  it('the Share sheet link says nothing when the published book and now are the same story', async () => {
    const f = historyFixture('v5');
    const live = { ...f.live, publication: { slug: 's', publishedAt: NOW - 1000, rev: 240 } } as unknown as ComicDoc;
    const pub = moment('ver_pub_same', clone(f.live), { kind: 'publish', publishedRev: 240 });
    const m = historySetup({ api: { versions: [pub], live: () => f.live }, studio: { doc: live } });
    const { container } = mountWith(m, <ChangesSincePublishLink studio={m.studio} />);
    await settle();
    expect(m.api.calls.some((c) => c.method === 'compare')).toBe(true);
    expect(container.textContent).toBe('');
  });

  it('the Share sheet link still names story-only changes', async () => {
    const f = historyFixture('v5');
    const live = { ...f.live, publication: { slug: 's', publishedAt: NOW - 1000, rev: 240 } } as unknown as ComicDoc;
    const older = clone(f.live);
    older.brief = { ...older.brief, logline: 'An older logline' };
    const m = historySetup({ api: { versions: [moment('ver_pub_meta', normalizeDoc(older), { kind: 'publish', publishedRev: 200 })], live: () => f.live }, studio: { doc: live } });
    const { container } = mountWith(m, <ChangesSincePublishLink studio={m.studio} />);
    await settle();
    expect(container.textContent).toContain('Only story details changed since you published');
  });

  it('the undo-AI conflict asks in the plan’s words: only on the other pages, or on this one too', async () => {
    const m = historySetup({ fixture: 'v5-conflict', studio: { act: fakeAct() } });
    panel(m, req({ view: 'undo_ai' }));
    await settle(10);
    const legend = document.querySelector('[data-undo-conflict] legend')!;
    expect(legend.textContent).toBe("You've changed page 3 since. Undo the AI’s change only on pages 1, 4 and 6 (and page 3’s drawing), or on page 3’s words too?");
  });
});

describe('rows of a version you removed (H1 FIX note 4)', () => {
  /** v5 + two rows of a removed version, both newer than Original's own newest moment (ver_edit), and one live-line row. */
  const withRemoved = (): Mounted => {
    const f = historyFixture('v5');
    const gone = (id: string, kind: VersionRow['kind'], min: number) =>
      moment(id, clone(f.live), { kind, actor: kind === 'ai' ? 'ai' : 'you', label: kind === 'ai' ? 'AI revised page 2' : 'You edited page 2', alternativeId: 'alt_gone', contentAt: NOW - min * 60_000, createdAt: NOW - min * 60_000 });
    const elsewhere = moment('ver_elsewhere', clone(f.live), { alternativeId: 'alt_live', contentAt: NOW - 30_000, createdAt: NOW - 30_000 });
    return historySetup({
      api: { versions: [elsewhere, gone('ver_gone_ai', 'ai', 1), gone('ver_gone_edit', 'edits', 2), ...f.versions], lines: [{ id: 'alt_gone', removed: true }, { id: 'alt_live' }] }
    });
  };

  it('reads "From a version you removed" in plain words, in the list and in its moment', async () => {
    const m = withRemoved();
    panel(m, req());
    await settle();
    const gone = document.querySelector<HTMLElement>('[data-moment="ver_gone_ai"]')!;
    expect(gone).toBeTruthy();
    expect(gone.textContent).toContain('From a version you removed');
    expect(gone.getAttribute('aria-label')).toContain('From a version you removed');
    expect(document.querySelector('[data-moment="ver_gone_edit"]')!.textContent).toContain('From a version you removed');
    // Original's own rows say nothing of the kind; a live line's rows are not in Original's list at all.
    for (const id of ['ver_edit', 'ver_ai', 'ver_start']) expect(document.querySelector(`[data-moment="${id}"]`)!.textContent).not.toContain('removed');
    expect(document.querySelector('[data-moment="ver_elsewhere"]')).toBeNull();
    fireEvent.click(gone);
    await settle();
    expect(view('moment').querySelector('[data-moment-removed]')!.textContent).toBe('From a version you removed');
    expect(gitWordsIn(document.body.textContent || '')).toEqual([]);
  });

  it('is never "you\'re here" nor the top of Original: the selection, Name this version and Undo this AI change go by head()', async () => {
    const m = withRemoved();
    panel(m, req());
    await settle();
    // The list's first row is the removed version's; "you're here" is Original's head (its own newest row).
    expect(document.querySelectorAll('[data-moment]')[0].getAttribute('data-moment')).toBe('ver_gone_ai');
    expect(document.querySelector('[data-moment="ver_edit"]')!.getAttribute('aria-current')).toBe('true');
    expect(document.querySelector('[data-moment="ver_gone_ai"]')!.getAttribute('aria-current')).toBeNull();
    // The removed version's AI run: neither "Name this version" nor "Undo this AI change".
    fireEvent.click(document.querySelector('[data-moment="ver_gone_ai"]')!);
    await settle();
    expect(within(view('moment')).queryByRole('button', { name: 'More' })).toBeNull();
    fireEvent.click(within(view('moment')).getAllByRole('button', { name: 'Back' })[0]);
    // Where you are: "Name this version".
    fireEvent.click(document.querySelector('[data-moment="ver_edit"]')!);
    await settle();
    fireEvent.click(within(view('moment')).getByRole('button', { name: 'More' }));
    expect(within(view('moment')).getByRole('button', { name: 'Name this version · Free' })).toBeInTheDocument();
    fireEvent.click(within(view('moment')).getAllByRole('button', { name: 'Back' })[0]);
    // Original's own latest AI run is the one "Undo this AI change" reverts.
    fireEvent.click(document.querySelector('[data-moment="ver_ai"]')!);
    await settle();
    fireEvent.click(within(view('moment')).getByRole('button', { name: 'More' }));
    expect(within(view('moment')).getByRole('button', { name: 'Undo this AI change · Free' })).toBeInTheDocument();
  });

  it('a moment saved while History is open is where you are now (the head moves with it)', async () => {
    const m = withRemoved();
    const r = panel(m, req());
    await settle();
    expect(document.querySelector('[data-moment="ver_edit"]')!.getAttribute('aria-current')).toBe('true');
    const live = moment('ver_new', clone(historyFixture('v5').live), { label: 'You edited page 1', contentAt: NOW, createdAt: NOW }).row;
    (m.studio as typeof m.studio & { lastHistoryVersion?: VersionRow }).lastHistoryVersion = live;
    r.rerender(m.wrap(<HistoryPanel studio={m.studio} open onClose={vi.fn()} request={null} now={NOW} tz={TZ} />));
    await settle();
    expect(document.querySelector('[data-moment="ver_new"]')!.getAttribute('aria-current')).toBe('true');
    expect(document.querySelector('[data-moment="ver_edit"]')!.getAttribute('aria-current')).toBeNull();
  });

  it('a toast\'s Undo never brings back a removed version\'s before-restore copy', async () => {
    const f = historyFixture('v5');
    const restoreRow = (id: string, undoId: string, min: number, alternativeId?: string) =>
      moment(id, clone(f.live), { kind: 'restore', label: 'Restored page 2', undoId, contentAt: NOW - min * 60_000, createdAt: NOW - min * 60_000, ...(alternativeId ? { alternativeId } : {}) });
    const m = historySetup({ api: { versions: [restoreRow('ver_gone_restore', 'ver_gone_before', 1, 'alt_gone'), restoreRow('ver_restore', 'ver_before', 3), ...f.versions], lines: [{ id: 'alt_gone', removed: true }] } });
    expect(await beforeRestoreId(m.studio, m.api)).toBe('ver_before');
  });

  it('the history card\'s "Undo the last AI change" never names a removed version\'s AI run', async () => {
    const m = withRemoved();
    mountWith(m, <HistoryCardView card={{ type: 'history', id: 'u', view: 'undo_ai' }} message={msg} studio={m.studio} now={NOW} tz={TZ} />);
    await settle();
    const aiRow = historyFixture('v5').versions.find((v) => v.row.id === 'ver_ai')!.row;
    const card = document.querySelector<HTMLElement>('[data-history-card="undo_ai"]')!;
    expect(card.textContent).toContain(aiRow.label);
    expect(card.textContent).not.toContain('AI revised page 2');
  });
});
