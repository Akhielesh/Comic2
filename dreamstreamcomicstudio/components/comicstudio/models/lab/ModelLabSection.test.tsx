// Admin → Model Lab (models.md §2.6; wm-plan M1-MODEL-LAB): every check with its quoted cost first; Run opens a
// confirm and ONLY the confirm sends (with this click's id; a lost answer is retried with the SAME id); a changed
// price is re-confirmed; blind pairs hide the names until the vote; no timers; 360 px without overflow, 44 px targets.
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlindPair, LabOverview, LabRun, LabRunAnswer } from './labApi';

const fetchOverview = vi.fn<() => Promise<LabOverview>>();
const runCheck = vi.fn<(input: { itemId: string; idempotencyKey: string; quotedUsd: number }) => Promise<LabRunAnswer>>();
const vote = vi.fn<(pairId: string, pick: string, seen?: string) => Promise<BlindPair>>();
const watermark = vi.fn<(runId: string, visible: boolean | null) => Promise<LabRun>>();
vi.mock('./labApi', async (orig) => ({
  ...(await orig<typeof import('./labApi')>()),
  fetchLabOverview: () => fetchOverview(),
  runLabCheck: (input: { itemId: string; idempotencyKey: string; quotedUsd: number }) => runCheck(input),
  voteBlindPair: (pairId: string, pick: string, seen?: string) => vote(pairId, pick, seen),
  setLabWatermark: (runId: string, visible: boolean | null) => watermark(runId, visible)
}));

const { ModelLabSection } = await import('./ModelLabSection');
const { LabApiError } = await import('./labApi');
const { labAdminSection } = await import('./index');

const NOW = Date.parse('2026-10-29T12:00:00Z');
const item = (over: Partial<LabOverview['checks'][number]['items'][number]>) => ({
  id: 'd1-nano-banana-2.1-4k',
  check: 'D1' as const,
  title: 'Nano Banana 2.1 · 4K page',
  modelId: 'nano-banana-2.1',
  nickname: 'Nano Banana 2.1',
  kind: 'page',
  res: '4K',
  aspect: '2:3',
  refs: 4,
  refsNote: '4 synthetic reference cards (Maya, Tomas, Pip, the boathouse)',
  quote: { usd: 0.113, source: 'pricebook' as const, basis: 'price list from 2026-10-22 · reference cost unpublished', refsUnpriced: true },
  health: { state: 'ok' as const, source: 'openrouter' as const, checkedAt: NOW },
  canRun: true,
  runs: { ok: 0, failed: 0, running: 0 },
  ...over
});

const seedreamRun: LabRun = {
  id: 'run-d3',
  checkId: 'D3',
  itemId: 'd3-seedream-5-pro-2k',
  title: 'Seedream 5.0 Pro · 2K page',
  model: { id: 'seedream-5-pro', nickname: 'Seedream 5 Pro' },
  status: 'ok',
  res: '2K',
  aspect: '2:3',
  quotedUsd: 0.102,
  costUsd: 0.09,
  quoteBasis: 'upper estimate from models.md §2.6',
  facts: {
    callMade: true,
    endpoint: '/images',
    httpStatus: 200,
    costReported: true,
    width: 1664,
    height: 2496,
    bytes: 4_200_000,
    mediaType: 'image/png',
    latencyMs: 61_200,
    providerMs: 60_100,
    providerModelVersion: 'bytedance-seed/seedream-5-0-pro-20261001-a-very-long-version-string-that-must-wrap-at-360px',
    providerName: 'Seed',
    sent: { aspect: '2:3', resolution: '2K', quality: null, references: 4 },
    refsSent: 4,
    stored: true,
    recordedCall: true
  },
  imageUrl: 'https://signed.example/u/a/p/model-lab/ref/x.webp',
  createdAt: '2026-10-29T11:58:00Z',
  finishedAt: '2026-10-29T11:59:01Z'
};

const readyPair: BlindPair = {
  id: 'd4-sheet-1',
  label: 'Sheet 1 · Maya',
  state: 'ready',
  seen: '0123456789abcdef01234567',
  a: { slot: 'A', imageUrl: 'https://signed.example/u/a/p/model-lab/ref/1.webp' },
  b: { slot: 'B', imageUrl: 'https://signed.example/u/a/p/model-lab/ref/2.webp' }
};

const overview = (over: Partial<LabOverview> = {}): LabOverview => ({
  capUsd: 2,
  day: '2026-10-29',
  spentUsd: 0.31,
  remainingUsd: 1.69,
  ready: { platformKey: true, storage: true },
  checks: [
    { id: 'D1', title: 'Pro tier → Nano Banana 2.1 at 4K', decision: 'Turn on PRO_TIER_4K only if a real 4K page checks out.', answers: 'cost, pixel size, latency, file size', items: [item({})] },
    {
      id: 'D2',
      title: 'GPT Image 2.5 Sunburst and Flare as Experimental',
      decision: 'Offer both as Experimental.',
      answers: 'transport',
      items: [item({ id: 'd2-gpt-image-2.5-sunburst', check: 'D2', title: 'GPT Image 2.5 Sunburst · 2:3 page', modelId: 'gpt-image-2.5', nickname: 'GPT Image 2.5', res: '1K', quote: { usd: 0.2107, source: 'pricebook', basis: 'price list from 2026-10-22', refsUnpriced: true } })]
    },
    {
      id: 'D3',
      title: 'Reveal Seedream 5.0 Pro',
      decision: 'Reveal only without a watermark.',
      answers: 'watermark, 2K bill',
      items: [
        item({
          id: 'd3-seedream-5-pro-2k',
          check: 'D3',
          title: 'Seedream 5.0 Pro · 2K page',
          modelId: 'seedream-5-pro',
          nickname: 'Seedream 5 Pro',
          res: '2K',
          canRun: false,
          reason: "Today's lab budget can't cover this: $1.95 of $2 used (UTC day), and this check is quoted at $0.102. It resets at 00:00 UTC. Nothing was charged.",
          quote: { usd: 0.102, source: 'research', basis: 'upper estimate from models.md §2.6', refsUnpriced: false }
        })
      ]
    },
    {
      id: 'D4',
      title: 'Blind bake-off (optional)',
      decision: 'Watch list only if it holds up, judged blind.',
      answers: '4 sheets + 2 pages each',
      items: [
        item({ id: 'd4-seedream-5-0-flash-sheet-1', check: 'D4', title: 'Seedream 5 Flash · Sheet 1 · Maya', modelId: 'bytedance-seed/seedream-5-0-flash', nickname: 'Seedream 5 Flash', kind: 'sheet', res: '2K', aspect: '3:4', refs: 0, refsNote: 'no references', quote: { usd: 0.018, source: 'research', basis: 'OpenRouter list price checked 2026-10-22 (models.md §1.1)', refsUnpriced: false }, pair: { id: 'd4-sheet-1', label: 'Sheet 1 · Maya' }, runs: { ok: 1, failed: 0, running: 0 } }),
        item({ id: 'd4-qwen-image-2.1-turbo-sheet-1', check: 'D4', title: 'Qwen 2.1 Turbo · Sheet 1 · Maya', modelId: 'qwen/qwen-image-2.1-turbo', nickname: 'Qwen 2.1 Turbo', kind: 'sheet', res: '2K', aspect: '3:4', refs: 0, refsNote: 'no references', quote: { usd: 0.0184, source: 'research', basis: 'OpenRouter list price checked 2026-10-22 (models.md §1.1)', refsUnpriced: false }, pair: { id: 'd4-sheet-1', label: 'Sheet 1 · Maya' }, runs: { ok: 1, failed: 0, running: 0 } }),
        item({ id: 'd4-gpt-image-2.5-flare-medium', check: 'D4', title: 'Add-on · GPT Image 2.5 Flare at medium', modelId: 'gpt-image-2.5-flare', nickname: 'GPT Image 2.5 Flare', quote: null, canRun: false, reason: "Needs a per-request quality setting (medium). The lab can't run this add-on honestly yet." })
      ]
    }
  ],
  results: [seedreamRun],
  blind: [readyPair, { id: 'd4-page-1', label: 'Page 1 · the dock', state: 'waiting', waitingFor: ['Seedream 5 Flash'] }],
  now: NOW,
  ...over
});

const runAnswer: LabRunAnswer = {
  replayed: false,
  spentUsd: 0.3856,
  remainingUsd: 1.6144,
  run: {
    ...seedreamRun,
    id: 'run-d1',
    checkId: 'D1',
    itemId: 'd1-nano-banana-2.1-4k',
    title: 'Nano Banana 2.1 · 4K page',
    model: { id: 'nano-banana-2.1', nickname: 'Nano Banana 2.1' },
    quotedUsd: 0.113,
    costUsd: 0.0756,
    facts: { ...seedreamRun.facts, providerModelVersion: 'google/gemini-nano-banana-2.1-20261006', width: 2731, height: 4096 }
  }
};

const open = async () => {
  render(<ModelLabSection />);
  await act(async () => undefined);
};
const runButton = (name: RegExp) => screen.getByRole('button', { name });

beforeEach(() => {
  fetchOverview.mockReset().mockResolvedValue(overview());
  runCheck.mockReset().mockResolvedValue(runAnswer);
  vote.mockReset();
  watermark.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('ModelLabSection', () => {
  it('exports the admin section for the lead to register', () => {
    expect(labAdminSection).toMatchObject({ id: 'model-lab', label: 'Model Lab' });
    expect(typeof labAdminSection.Component).toBe('function');
  });

  it('lists D1–D4 with the quote and its source first, the budget, and honest reasons where a check cannot run', async () => {
    await open();
    expect(fetchOverview).toHaveBeenCalledTimes(1);
    for (const id of ['D1', 'D2', 'D3', 'D4']) expect(document.querySelector(`[data-lab-check="${id}"]`)).not.toBeNull();
    const d1 = document.querySelector('[data-lab-item="d1-nano-banana-2.1-4k"]') as HTMLElement;
    expect(d1).toHaveTextContent('≈ $0.113 + reference input (unpublished)');
    expect(d1).toHaveTextContent('price list from 2026-10-22');
    expect(d1).toHaveTextContent('4K · 2:3 · 4 synthetic reference cards');
    expect(screen.getByText(/Today \(UTC 2026-10-29\):/).textContent).toBe('Today (UTC 2026-10-29): $0.31 of $2.00 used · $1.69 left');
    expect(screen.getByRole('progressbar', { name: "Today's lab spend" })).toHaveAttribute('aria-valuenow', '0.31');
    const d3 = document.querySelector('[data-lab-item="d3-seedream-5-pro-2k"]') as HTMLElement;
    expect(within(d3).queryByRole('button')).toBeNull();
    expect(d3).toHaveTextContent("Today's lab budget can't cover this");
    const addOn = document.querySelector('[data-lab-item="d4-gpt-image-2.5-flare-medium"]') as HTMLElement;
    expect(within(addOn).queryByRole('button')).toBeNull();
    expect(addOn).toHaveTextContent('quality setting');
  });

  it('no call without the confirm: Run opens a dialog with the cost; Cancel sends nothing', async () => {
    await open();
    fireEvent.click(runButton(/Run Nano Banana 2.1 · 4K page — \$0.113/));
    const dialog = screen.getByRole('dialog');
    expect(runCheck).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/≈ \$0.113/)).toBeInTheDocument();
    expect(dialog).toHaveTextContent('One paid call to Nano Banana 2.1 on the platform key');
    expect(dialog).toHaveTextContent('No retries');
    expect(dialog).toHaveTextContent('Today (UTC): $0.31 of $2.00 used → about $0.423 after this run.');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Escape closes too, still without a call.
    fireEvent.click(runButton(/Run Nano Banana 2.1 · 4K page/));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(runCheck).not.toHaveBeenCalled();
  });

  it('confirm → exactly one request with this click’s id and the quote shown; the result shows the facts; the lab re-reads', async () => {
    await open();
    fireEvent.click(runButton(/Run Nano Banana 2.1 · 4K page/));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Run — $0.113' }));
    await act(async () => undefined);
    expect(runCheck).toHaveBeenCalledTimes(1);
    const sent = runCheck.mock.calls[0][0];
    expect(sent).toMatchObject({ itemId: 'd1-nano-banana-2.1-4k', quotedUsd: 0.113 });
    expect(sent.idempotencyKey).toMatch(/^lab-[0-9a-f]{32}$/);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Cost $0.0756 (provider-reported) · quoted $0.113');
    expect(dialog).toHaveTextContent('2731 × 4096');
    expect(dialog).toHaveTextContent('google/gemini-nano-banana-2.1-20261006');
    expect(dialog).toHaveTextContent('Today: $0.3856 used · $1.61 left.');
    expect(fetchOverview).toHaveBeenCalledTimes(2);
  });

  it('a lost answer is retried with the SAME click id; a changed price asks again at the new number with a new id', async () => {
    await open();
    runCheck.mockRejectedValueOnce(new LabApiError("Couldn't reach the server. Trying again sends the same click, so it can't be charged twice.", 0));
    fireEvent.click(runButton(/Run Nano Banana 2.1 · 4K page/));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Run — $0.113' }));
    await act(async () => undefined);
    const retry = within(screen.getByRole('dialog')).getByRole('button', { name: 'Try again (same click)' });
    fireEvent.click(retry);
    await act(async () => undefined);
    expect(runCheck).toHaveBeenCalledTimes(2);
    expect(runCheck.mock.calls[1][0].idempotencyKey).toBe(runCheck.mock.calls[0][0].idempotencyKey);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));

    runCheck.mockReset().mockRejectedValueOnce(
      new LabApiError('The price changed since you opened this: it’s now $0.12 (you confirmed $0.113). Nothing was charged.', 409, 'QUOTE_CHANGED', {
        code: 'QUOTE_CHANGED',
        quote: { usd: 0.12, source: 'pricebook', basis: 'OpenRouter price, 2026-10-29T11:00:00Z', refsUnpriced: true }
      })
    );
    fireEvent.click(runButton(/Run Nano Banana 2.1 · 4K page/));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Run — $0.113' }));
    await act(async () => undefined);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('The price changed');
    expect(dialog).toHaveTextContent('≈ $0.12');
    runCheck.mockResolvedValueOnce(runAnswer);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run at the new price — $0.12' }));
    await act(async () => undefined);
    expect(runCheck.mock.calls[1][0].quotedUsd).toBe(0.12);
    expect(runCheck.mock.calls[1][0].idempotencyKey).not.toBe(runCheck.mock.calls[0][0].idempotencyKey);
  });

  it('a refusal (cap, provider down) only offers Close — no retry button that could spend', async () => {
    await open();
    runCheck.mockRejectedValueOnce(new LabApiError("Today's lab budget can't cover this. Nothing was charged.", 409, 'LAB_CAP_REACHED', { code: 'LAB_CAP_REACHED' }));
    fireEvent.click(runButton(/Run Nano Banana 2.1 · 4K page/));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Run — $0.113' }));
    await act(async () => undefined);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent("Today's lab budget can't cover this. Nothing was charged.");
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['Close']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    // Provider down is the lab's own 503 refusal (nothing was sent): an answer, not a lost request — no "same click" retry.
    runCheck.mockRejectedValueOnce(
      new LabApiError(
        "Nano Banana 2.1 is paused right now — our last 3 calls failed (RATE_LIMIT). The lab didn't call it. Nothing was charged. Provider status shows when it's serving again.",
        503,
        'PROVIDER_DOWN',
        { code: 'PROVIDER_DOWN' }
      )
    );
    fireEvent.click(runButton(/Run Nano Banana 2.1 · 4K page/));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Run — $0.113' }));
    await act(async () => undefined);
    const down = screen.getByRole('dialog');
    expect(down).toHaveTextContent('Nano Banana 2.1 is paused right now');
    expect(down).not.toHaveTextContent('Trying again sends the same click');
    expect(within(down).getAllByRole('button').map((b) => b.textContent)).toEqual(['Close']);
    expect(runCheck).toHaveBeenCalledTimes(2);
  });

  it('a gateway error with no lab code (the answer was lost) offers the same-click retry', async () => {
    await open();
    runCheck.mockRejectedValueOnce(new LabApiError('Bad Gateway', 502));
    fireEvent.click(runButton(/Run Nano Banana 2.1 · 4K page/));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Run — $0.113' }));
    await act(async () => undefined);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Trying again sends the same click');
    expect(within(dialog).getByRole('button', { name: 'Try again (same click)' })).toBeInTheDocument();
  });

  it('blind pairs: A and B with no names before the vote; the vote reveals them', async () => {
    await open();
    const pair = document.querySelector('[data-blind-pair="d4-sheet-1"]') as HTMLElement;
    expect(pair).toHaveTextContent('Names hidden until you vote');
    expect(pair.textContent).not.toMatch(/Seedream|Qwen/);
    expect(within(pair).getAllByRole('img').map((i) => i.getAttribute('alt'))).toEqual(['Sheet 1 · Maya, drawing A', 'Sheet 1 · Maya, drawing B']);
    const waiting = document.querySelector('[data-blind-pair="d4-page-1"]') as HTMLElement;
    expect(waiting).toHaveTextContent('Waiting for Seedream 5 Flash to draw this.');
    expect(within(waiting).queryByRole('img')).toBeNull();

    const revealedRun = (slot: 'A' | 'B', nickname: string, id: string): LabRun => ({ ...seedreamRun, id, checkId: 'D4', model: { id: nickname.startsWith('Qwen') ? 'qwen/qwen-image-2.1-turbo' : 'bytedance-seed/seedream-5-0-flash', nickname }, title: slot });
    vote.mockResolvedValueOnce({
      ...readyPair,
      state: 'voted',
      pick: 'B',
      a: { ...readyPair.a!, run: revealedRun('A', 'Seedream 5 Flash', 'r-a') },
      b: { ...readyPair.b!, run: revealedRun('B', 'Qwen 2.1 Turbo', 'r-b') }
    });
    fireEvent.click(within(pair).getByRole('button', { name: 'B is better' }));
    await act(async () => undefined);
    expect(vote).toHaveBeenCalledWith('d4-sheet-1', 'B', '0123456789abcdef01234567'); // tied to the drawings shown
    const after = document.querySelector('[data-blind-pair="d4-sheet-1"]') as HTMLElement;
    expect(after).toHaveTextContent('You picked B — Qwen 2.1 Turbo.');
    expect(after).toHaveTextContent('A · Seedream 5 Flash');
    expect(within(after).queryByRole('button', { name: 'A is better' })).toBeNull();
  });

  it('the Seedream result carries the watermark checkbox', async () => {
    await open();
    watermark.mockResolvedValueOnce({ ...seedreamRun, facts: { ...seedreamRun.facts, watermark: { visible: true, at: '2026-10-29T12:01:00Z', by: 'admin' } } });
    const card = document.querySelector('[data-lab-run="run-d3"]') as HTMLElement;
    const group = within(card).getByRole('group', { name: '“AI-generated” watermark visible?' });
    fireEvent.click(within(group).getByRole('radio', { name: 'Yes, visible' }));
    await act(async () => undefined);
    expect(watermark).toHaveBeenCalledWith('run-d3', true);
    expect(within(document.querySelector('[data-lab-run="run-d3"]') as HTMLElement).getByRole('radio', { name: 'Yes, visible' })).toBeChecked();
  });

  it('a D2 result not drawn at quality max says its cost is not the max-quality price', async () => {
    const d2Run: LabRun = {
      ...seedreamRun,
      id: 'run-d2',
      checkId: 'D2',
      itemId: 'd2-gpt-image-2.5-sunburst',
      title: 'GPT Image 2.5 Sunburst · 2:3 page',
      model: { id: 'gpt-image-2.5', nickname: 'GPT Image 2.5' },
      quotedUsd: 0.2107,
      costUsd: 0.041,
      facts: { ...seedreamRun.facts, sent: { aspect: '2:3', resolution: null, quality: null, references: 4 } }
    };
    const atMax: LabRun = { ...d2Run, id: 'run-d2-max', facts: { ...d2Run.facts, sent: { ...d2Run.facts.sent!, quality: 'max' } } };
    fetchOverview.mockReset().mockResolvedValue(overview({ results: [d2Run, atMax, seedreamRun] }));
    await open();
    const card = document.querySelector('[data-lab-run="run-d2"]') as HTMLElement;
    expect(card).toHaveTextContent('Not drawn at quality max: this cost is not the max-quality price.');
    expect(card).toHaveTextContent('no quality setting (provider default)');
    expect(document.querySelector('[data-lab-run="run-d2-max"]')).not.toHaveTextContent('Not drawn at quality max');
    expect(document.querySelector('[data-lab-run="run-d3"]')).not.toHaveTextContent('Not drawn at quality max');
  });

  it('no timers: one read on open, one per Refresh', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    render(<ModelLabSection />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
    });
    expect(fetchOverview).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await act(async () => undefined);
    expect(fetchOverview).toHaveBeenCalledTimes(2);
  });

  it('fits 360 px: shrinkable containers, wrapping text, nothing wider than the screen, 44 px targets', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    await open();
    fireEvent.click(runButton(/Run Nano Banana 2.1 · 4K page/));
    const root = document.querySelector('[data-model-lab]') as HTMLElement;
    expect(root.className).toContain('min-w-0');
    const all = [...document.body.querySelectorAll<HTMLElement>('*')];
    for (const el of all) {
      const cls = typeof el.className === 'string' ? el.className : '';
      for (const m of cls.matchAll(/(?:^|\s)(?:min-)?w-\[(\d+)px\]/g)) expect(Number(m[1]), cls).toBeLessThanOrEqual(328);
      expect(cls).not.toMatch(/(?:^|\s)w-(?:96|\[[3-9]\d\drem\])/);
      expect(cls).not.toMatch(/rounded-2xl|duration-\d|#[0-9a-f]{3,6}/i);
    }
    // Every control is a 44 px target.
    const controls = [...document.body.querySelectorAll<HTMLElement>('button'), ...[...document.body.querySelectorAll<HTMLElement>('label')].filter((l) => l.querySelector('input[type="radio"]'))];
    expect(controls.length).toBeGreaterThan(5);
    for (const c of controls) expect(c.className, c.textContent || '').toMatch(/(?:^|\s)min-h-11(?:\s|$)/);
    // Long provider words wrap instead of overflowing.
    const version = screen.getAllByText(/a-very-long-version-string-that-must-wrap-at-360px/)[0];
    expect(version.className).toContain('[overflow-wrap:anywhere]');
    // The dialog is full-width on a phone (bottom sheet), capped on larger screens.
    expect(screen.getByRole('dialog').className).toMatch(/w-full/);
    expect(screen.getByRole('dialog').className).toMatch(/min-w-0/);
  });

  it('says so calmly when the lab cannot be read', async () => {
    fetchOverview.mockReset().mockRejectedValueOnce(new LabApiError('Admin access required', 403));
    await open();
    expect(screen.getByRole('status')).toHaveTextContent("Couldn't open the Model Lab: Admin access required");
  });
});
