// Admin → Model Lab → P1 · Pro pages A/B, part 1: costs first (every drawing's quote and all six, 6 pages + 6 checks);
// while the server switch is off (the default) a calm "not enabled yet" and no Draw button at all; once on, Draw opens
// the shared confirm and ONLY the confirm sends (this click's id, the quote shown); the A/B budget sits next to the daily
// one; a page's two drawings stay blind (no arm, cost or check) until the vote, which reveals them; 360 px, 44 px targets,
// tokens only. Fakes only: labApi's network calls are mocked.
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlindPair, LabOverview, LabRunAnswer, ProPagesArmItem, ProPagesOverview } from './labApi';

const fetchOverview = vi.fn<() => Promise<LabOverview>>();
const runCheck = vi.fn<(input: { itemId: string; idempotencyKey: string; quotedUsd: number }) => Promise<LabRunAnswer>>();
const vote = vi.fn<(pairId: string, pick: string, seen?: string) => Promise<BlindPair>>();
vi.mock('./labApi', async (orig) => ({
  ...(await orig<typeof import('./labApi')>()),
  fetchLabOverview: () => fetchOverview(),
  runLabCheck: (input: { itemId: string; idempotencyKey: string; quotedUsd: number }) => runCheck(input),
  voteBlindPair: (pairId: string, pick: string, seen?: string) => vote(pairId, pick, seen)
}));

const { ModelLabSection } = await import('./ModelLabSection');
const { asBlindPair, asProPages, asOverview } = await import('./labApi');

const NOW = Date.parse('2026-10-30T12:00:00Z');
const NOT_ENABLED =
  "Not enabled yet. These test drawings wait for the owner's approval of the test budget, so nothing here can run or spend. To turn them on, set COMIC_LAB_AB_BUDGET_USD on the server (at most $1.20, shared with part 2).";

const GOLDEN = [
  { key: 'b4b5774f-p2', label: 'b4b5774f · page 2', why: 'Six panels in 2-1-3 rows.' },
  { key: 'b4b5774f-p4', label: 'b4b5774f · page 4', why: 'A wide row over a tall panel beside a stack.' },
  { key: 'f8312c86-p1', label: 'f8312c86 · page 1', why: 'A 4:5 storybook page.' }
];

const arm = (g: (typeof GOLDEN)[number], which: 'off' | 'on', over: Partial<ProPagesArmItem> = {}): ProPagesArmItem => ({
  id: `p1-${g.key}-guide-${which}`,
  check: 'P1',
  arm: which,
  label: which === 'on' ? 'Guide on' : 'Guide off',
  title: `${g.label} · guide ${which}`,
  pair: { id: `p1-${g.key}`, label: g.label },
  modelId: 'nano-banana-2.1',
  nickname: 'Nano Banana 2.1',
  res: '2K',
  aspect: '2:3',
  refs: which === 'on' ? 5 : 4,
  refsNote: which === 'on' ? 'Image 1 is the page layout guide · 4 references as the studio attaches them' : 'no layout guide · 4 references as the studio attaches them',
  quote: { usd: 0.0534, source: 'pricebook', basis: 'price list from 2026-10-22 · reference cost unpublished + QC $0.003', refsUnpriced: true },
  health: { state: 'ok', source: 'openrouter', checkedAt: NOW },
  canRun: true,
  runs: { ok: 0, failed: 0, running: 0 },
  ...over
});

const proPages = (over: Partial<ProPagesOverview> = {}, armOver: Partial<ProPagesArmItem> = {}): ProPagesOverview => ({
  id: 'P1',
  title: 'Pro pages A/B, part 1 · the layout guide',
  decision: 'Turn on COMIC_LAYOUT_GUIDE only if the guide-on pages bind their beats better and never copy its lines.',
  answers: 'Three of your golden pages, each drawn twice — guide off and guide on — and each drawing checked once.',
  note: 'Each drawing is one image call that is never retried, plus its one page check.',
  switchName: 'COMIC_LAB_AB_BUDGET_USD',
  enabled: true,
  budget: { capUsd: 1.2, limitUsd: 1.2, spentUsd: 0.12, remainingUsd: 1.08 },
  quote: { usd: 0.3204, arms: 6, pages: 6, checks: 6, basis: ['price list from 2026-10-22 · reference cost unpublished + QC $0.003'], refsUnpriced: true },
  pages: GOLDEN.map((g) => ({ ...g, pairId: `p1-${g.key}`, available: true, arms: [arm(g, 'off', armOver), arm(g, 'on', armOver)] })),
  pairs: [
    { id: 'p1-b4b5774f-p2', label: 'b4b5774f · page 2', state: 'ready', seen: 'feedfacecafebeef01234567', a: { slot: 'A', imageUrl: 'https://signed.example/u/a/p/model-lab/ref/1.webp' }, b: { slot: 'B', imageUrl: 'https://signed.example/u/a/p/model-lab/ref/2.webp' } },
    { id: 'p1-b4b5774f-p4', label: 'b4b5774f · page 4', state: 'waiting', waitingFor: ['Guide on'] },
    { id: 'p1-f8312c86-p1', label: 'f8312c86 · page 1', state: 'waiting', waitingFor: ['Guide off', 'Guide on'] }
  ],
  ...over
});

const overview = (pp: ProPagesOverview | undefined): LabOverview => ({
  capUsd: 2,
  day: '2026-10-30',
  spentUsd: 0.31,
  remainingUsd: 1.69,
  ready: { platformKey: true, storage: true },
  checks: [],
  results: [],
  blind: [],
  now: NOW,
  ...(pp ? { proPages: pp } : {})
});

const open = async () => {
  render(<ModelLabSection />);
  await act(async () => undefined);
};
const section = () => document.querySelector('[data-lab-check="P1"]') as HTMLElement;

beforeEach(() => {
  fetchOverview.mockReset().mockResolvedValue(overview(proPages()));
  runCheck.mockReset();
  vote.mockReset();
});

describe('P1 · Pro pages A/B — switch off (the default)', () => {
  it('a calm "not enabled yet" that names the switch, every quote shown first, and no Draw button anywhere', async () => {
    fetchOverview.mockResolvedValue(overview(proPages({ enabled: false, notice: NOT_ENABLED, budget: { capUsd: 1.2, limitUsd: null, spentUsd: 0, remainingUsd: null } }, { canRun: false, reason: NOT_ENABLED })));
    await open();
    const p1 = section();
    expect(p1).toHaveAttribute('data-ab-enabled', 'false');
    const notice = p1.querySelector('[data-ab-not-enabled]') as HTMLElement;
    expect(notice).toHaveTextContent(NOT_ENABLED);
    expect(notice).toHaveTextContent('Server switch: COMIC_LAB_AB_BUDGET_USD');
    expect(notice.className).not.toMatch(/warning|danger/); // calm, not an error
    expect(p1.querySelector('[data-ab-quote]')).toHaveTextContent('All six drawings: ≈ $0.3204 (6 pages + 6 page checks, provider price) + reference input (unpublished)');
    const arms = p1.querySelectorAll('[data-ab-arm]');
    expect(arms).toHaveLength(6);
    for (const a of arms) {
      expect(a).toHaveTextContent('≈ $0.0534 page + check');
      expect(a).toHaveTextContent('Not enabled yet');
      expect(a).not.toHaveTextContent(NOT_ENABLED); // said once, not six times
    }
    expect(within(p1).queryAllByRole('button', { name: /^Draw/ })).toEqual([]);
    expect(runCheck).not.toHaveBeenCalled();
  });

  it('even an arm a server marks runnable gets no button while the switch is off (the parse forces it)', () => {
    const parsed = asProPages(JSON.parse(JSON.stringify(proPages({ enabled: false }))))!;
    for (const p of parsed.pages) for (const a of p.arms) expect(a.canRun).toBe(false);
    const quoteless = asProPages(JSON.parse(JSON.stringify(proPages({}, { quote: null }))))!;
    for (const p of quoteless.pages) for (const a of p.arms) expect(a.canRun).toBe(false); // costs first
    expect(asProPages({ id: 'P9', pages: [] })).toBeNull();
    expect(asOverview({ ...overview(undefined), proPages: { nonsense: true } })).not.toHaveProperty('proPages');
  });
});

describe('P1 · Pro pages A/B — switch on', () => {
  it('Draw opens the confirm with the cost, what is sent and both budgets; Cancel sends nothing; only the confirm sends, once', async () => {
    runCheck.mockResolvedValue({
      replayed: false,
      spentUsd: 0.3935,
      remainingUsd: 1.6065,
      run: { id: 'r1', checkId: 'P1', itemId: 'p1-b4b5774f-p4-guide-on', status: 'ok', pair: { id: 'p1-b4b5774f-p4', label: 'b4b5774f · page 4' }, quotedUsd: 0.0534, costUsd: 0.0635, callMade: true, costReported: true, checked: true, message: null }
    });
    await open();
    const p1 = section();
    expect(p1.querySelector('[data-ab-budget]')).toHaveTextContent('A/B budget: $0.12 of $1.20 used · $1.08 left · every day, shared with part 2 (hard cap $1.20)');
    fireEvent.click(within(p1).getByRole('button', { name: 'Draw b4b5774f · page 4 · guide on — $0.0534' }));
    let dialog = screen.getByRole('dialog');
    expect(runCheck).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/≈ \$0.0534/)).toBeInTheDocument();
    expect(dialog.querySelector('[data-lab-ab-call]')).toHaveTextContent(
      'One drawing of this page on Nano Banana 2.1 (2K · 2:3 · Image 1 is the page layout guide · 4 references as the studio attaches them), then one page check of it — on the platform key. No retries'
    );
    expect(dialog).toHaveTextContent('Today (UTC): $0.31 of $2.00 used → about $0.3634 after this run.');
    expect(dialog.querySelector('[data-lab-ab-budget]')).toHaveTextContent('A/B budget (every day, shared with part 2): $0.12 of $1.20 used → about $0.1734 after this drawing.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(runCheck).not.toHaveBeenCalled();

    fireEvent.click(within(section()).getByRole('button', { name: 'Draw b4b5774f · page 4 · guide on — $0.0534' }));
    dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run — $0.0534' }));
    await act(async () => undefined);
    expect(runCheck).toHaveBeenCalledTimes(1);
    expect(runCheck.mock.calls[0][0]).toMatchObject({ itemId: 'p1-b4b5774f-p4-guide-on', quotedUsd: 0.0534 });
    expect(runCheck.mock.calls[0][0].idempotencyKey).toMatch(/^lab-[0-9a-f]{32}$/);
    const done = screen.getByRole('dialog').querySelector('[data-lab-ab-done]') as HTMLElement;
    expect(done).toHaveTextContent('Drawn and checked. It joins the side-by-side for b4b5774f · page 4 once both drawings are made — which one had the guide, and what its check found, stays hidden until you vote.');
    expect(done).toHaveTextContent('Cost $0.0635 (provider-reported) · quoted $0.0534');
    expect(done).not.toHaveTextContent(/guide on|Guide on/); // the answer itself stays blind
    expect(fetchOverview).toHaveBeenCalledTimes(2); // the lab re-reads after a run
  });

  it('a pair waiting for its vote: A and B with nothing else; the vote sends the tag of what was shown and reveals arms and checks', async () => {
    await open();
    const pair = section().querySelector('[data-ab-pair="p1-b4b5774f-p2"]') as HTMLElement;
    expect(pair).toHaveTextContent('Which one had the guide stays hidden until you vote');
    expect(pair.textContent).not.toMatch(/Guide on|Guide off|\$|Beats/);
    expect(within(pair).getAllByRole('img').map((i) => i.getAttribute('alt'))).toEqual(['b4b5774f · page 2, drawing A', 'b4b5774f · page 2, drawing B']);
    expect(section().querySelector('[data-ab-pair="p1-f8312c86-p1"]')).toHaveTextContent('Waiting for guide off and guide on to be drawn.');

    const run = (id: string, title: string) => ({
      id,
      checkId: 'P1' as const,
      itemId: id,
      title,
      model: { id: 'nano-banana-2.1', nickname: 'Nano Banana 2.1' },
      status: 'ok' as const,
      res: '2K',
      aspect: '2:3',
      quotedUsd: 0.0534,
      costUsd: 0.0635,
      facts: { callMade: true, costReported: true, refsSent: 5 },
      createdAt: '2026-10-30T11:58:00Z',
      finishedAt: '2026-10-30T11:59:00Z'
    });
    vote.mockResolvedValueOnce({
      id: 'p1-b4b5774f-p2',
      label: 'b4b5774f · page 2',
      state: 'voted',
      pick: 'B',
      a: { slot: 'A', imageUrl: 'https://signed.example/1.webp', run: run('r-off', 'b4b5774f · page 2 · guide off'), arm: { id: 'off', label: 'Guide off' }, check: { ok: true, callMade: true, costReported: true, panelsPlanned: 6, panelsDrawn: 6, beatsMatched: 4, crosses: [], score: 0.81 } },
      b: { slot: 'B', imageUrl: 'https://signed.example/2.webp', run: run('r-on', 'b4b5774f · page 2 · guide on'), arm: { id: 'on', label: 'Guide on' }, check: { ok: true, callMade: true, costReported: true, panelsPlanned: 6, panelsDrawn: 6, beatsMatched: 6, crosses: [1], score: 0.9 } }
    });
    fireEvent.click(within(pair).getByRole('button', { name: 'B is better' }));
    await act(async () => undefined);
    expect(vote).toHaveBeenCalledWith('p1-b4b5774f-p2', 'B', 'feedfacecafebeef01234567');
    const after = section().querySelector('[data-ab-pair="p1-b4b5774f-p2"]') as HTMLElement;
    expect(after).toHaveTextContent('You picked B — guide on.');
    expect(after.querySelector('[data-ab-revealed="on"]')).toHaveTextContent('Beats matched6 of 6 drawn panels show their planned moment');
    expect(after.querySelector('[data-ab-revealed="on"]')).toHaveTextContent('Art over a borderpanel 1');
    expect(after.querySelector('[data-ab-revealed="off"]')).toHaveTextContent('Beats matched4 of 6 drawn panels');
    expect(after.querySelector('[data-ab-revealed="off"]')).toHaveTextContent('Art over a bordernone');
    expect(after.querySelector('[data-ab-revealed="on"]')).toHaveTextContent('Cost $0.0635 (provider-reported) · quoted $0.0534');
    expect(within(after).queryByRole('button', { name: 'A is better' })).toBeNull();
  });

  it('the tally (voted pairs only), a page that is not this admin’s, and a refused arm say why', async () => {
    fetchOverview.mockResolvedValue(
      overview(
        proPages({
          tally: { voted: 1, pairs: 3, picks: { on: 1, off: 0, tie: 0 }, beats: { on: { matched: 6, planned: 6 }, off: { matched: 4, planned: 6 } } },
          pages: [
            { ...GOLDEN[0], pairId: 'p1-b4b5774f-p2', available: true, arms: [arm(GOLDEN[0], 'off', { canRun: false, reason: 'Vote on b4b5774f · page 2 first — a new drawing now would show which side is which.' }), arm(GOLDEN[0], 'on')] },
            { ...GOLDEN[2], pairId: 'p1-f8312c86-p1', available: false, reason: "Comic f8312c86 isn't one of your comics on this server, so its page can't be drawn here.", arms: [] }
          ],
          quote: { usd: 0.1068, arms: 2, pages: 2, checks: 2, basis: [], refsUnpriced: false }
        })
      )
    );
    await open();
    const p1 = section();
    expect(p1.querySelector('[data-ab-tally]')).toHaveTextContent('Your votes so far (1 of 3 pages): guide on 1 · guide off 0 · about the same 0.');
    expect(p1.querySelector('[data-ab-tally]')).toHaveTextContent('Beats matched: guide on 6 of 6 panels · guide off 4 of 6 panels.');
    expect(p1.querySelector('[data-ab-page="f8312c86-p1"]')).toHaveTextContent("isn't one of your comics on this server");
    expect(p1.querySelector('[data-ab-quote]')).toHaveTextContent('The 2 drawings that can be quoted: ≈ $0.1068 (2 pages + 2 page checks, provider price)');
    const refused = p1.querySelector('[data-ab-arm="p1-b4b5774f-p2-guide-off"]') as HTMLElement;
    expect(within(refused).queryByRole('button')).toBeNull();
    expect(refused).toHaveTextContent('Vote on b4b5774f · page 2 first');
  });

  it('labApi: a pair never carries the arm or the check before its vote, even if a server sent them', () => {
    const ready = asBlindPair({ id: 'p1-b4b5774f-p2', label: 'b4b5774f · page 2', state: 'ready', seen: 'feedfacecafebeef01234567', a: { slot: 'A', imageUrl: 'https://x.example/a.webp', arm: { id: 'on', label: 'Guide on' }, check: { panelsPlanned: 6, beatsMatched: 6 } }, b: { slot: 'B', imageUrl: 'https://x.example/b.webp' } });
    expect(ready).toEqual({ id: 'p1-b4b5774f-p2', label: 'b4b5774f · page 2', state: 'ready', seen: 'feedfacecafebeef01234567', a: { slot: 'A', imageUrl: 'https://x.example/a.webp' }, b: { slot: 'B', imageUrl: 'https://x.example/b.webp' } });
    const voted = asBlindPair({ id: 'p1-b4b5774f-p2', label: 'b4b5774f · page 2', state: 'voted', pick: 'A', a: { slot: 'A', arm: { id: 'on', label: 'Guide on' }, check: { panelsPlanned: 6, beatsMatched: 6, ok: true, beats: [1, 2, 'x', 3] } } });
    expect(voted?.a).toMatchObject({ arm: { id: 'on', label: 'Guide on' }, check: { panelsPlanned: 6, beatsMatched: 6, ok: true, beats: [1, 2, 3] } });
  });

  it('fits 360 px: shrinkable containers, wrapping copy, tokens only, 44 px targets', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    await open();
    fireEvent.click(within(section()).getByRole('button', { name: 'Draw b4b5774f · page 2 · guide on — $0.0534' }));
    const all = [section(), ...section().querySelectorAll<HTMLElement>('*'), screen.getByRole('dialog'), ...screen.getByRole('dialog').querySelectorAll<HTMLElement>('*')];
    for (const el of all) {
      const cls = typeof el.className === 'string' ? el.className : '';
      for (const m of cls.matchAll(/(?:^|\s)(?:min-)?w-\[(\d+)px\]/g)) expect(Number(m[1]), cls).toBeLessThanOrEqual(328);
      expect(cls).not.toMatch(/rounded-2xl|duration-\d|#[0-9a-f]{3,6}|amber-|font-comic|shadow-comic|border-black/i);
    }
    expect(section().className).toContain('min-w-0');
    const buttons = [...section().querySelectorAll<HTMLElement>('button'), ...screen.getByRole('dialog').querySelectorAll<HTMLElement>('button')];
    expect(buttons.length).toBeGreaterThan(6);
    for (const b of buttons) expect(b.className, b.textContent || '').toMatch(/(?:^|\s)min-h-11(?:\s|$)/);
    // The long refs note and quote basis wrap instead of overflowing.
    const note = within(section()).getAllByText(/Image 1 is the page layout guide/)[0];
    expect(note.className).toContain('[overflow-wrap:anywhere]');
  });
});
