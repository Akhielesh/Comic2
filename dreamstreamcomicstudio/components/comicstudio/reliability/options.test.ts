// Outage options on the client (reliability.md §3/§5): real registry prices and redraw counts, the server card's
// options win when one exists, nothing to retry → no wait button; and the status API's validation.
import { describe, expect, it } from 'vitest';
import { DEFAULT_CAPS, resolveStudioCaps } from '../../../shared/comic/capabilities';
import type { Card, ComicDoc } from '../../../shared/comic/doc';
import { PLATFORM_MARKUP, getImageModel, imagePriceUsd } from '../../../shared/comic/models';
import { drawnTargets, redrawQuote } from '../../../shared/comic/modelLock';
import { makeSampleDoc } from '../conversation/testing/fixtures';
import type { PriceBook } from '../../../shared/comic/modelLock';
import type { ModelHealth } from '../../../shared/comic/modelHealth';
import { bannerOptions, cleanOptions, latestOutageCard, outageFacts, registryPriceBook, registrySwitchOptions } from './options';
import { optionText } from './OptionButtons';
import { asModelHealth, asProviderStatusReport } from './statusApi';
import { blockedWhat, friendlyReason, isRateLimited, notDrawnSentence, outageSentence, timeAgo } from './copy';

const paid = resolveStudioCaps({ planId: 'pro', byok: false, isAdmin: false });
const byokCaps = resolveStudioCaps({ byok: true, isAdmin: false });
const PRO = getImageModel('nano-banana-pro')!;

const drawnDoc = (): ComicDoc => {
  const doc = makeSampleDoc();
  doc.pages = doc.pages.map((p) => ({ ...p, render: { status: 'ready', history: [], asset: { path: `u/x/${p.id}.webp`, source: 'generated', at: 1 } } }));
  doc.cover = { ...doc.cover, render: { status: 'ready', history: [], asset: { path: 'u/x/cover.webp', source: 'generated', at: 1 } } };
  return doc;
};

describe('registrySwitchOptions', () => {
  it('offers the same-family model with its real list price × markup and the real redraw count and total', () => {
    const doc = drawnDoc();
    const [sw, ...rest] = registrySwitchOptions({ doc, blockedModelId: 'nano-banana-2.1', caps: paid });
    expect(rest).toEqual([]);
    expect(sw.modelId).toBe(PRO.id);
    expect(sw.consistency).toBe('same_family');
    expect(sw.usdPerImage).toBeCloseTo(imagePriceUsd(PRO, '2K') * PLATFORM_MARKUP, 4);
    const t = drawnTargets(doc);
    expect(sw.redrawCount).toBe(t.pages.length + 1);
    expect(sw.redrawCount).toBe(4); // 3 drawn pages + cover
    expect(sw.redrawUsd).toBeCloseTo(redrawQuote(doc, PRO.id, 'pages_cover', registryPriceBook(), false).usd!, 4);
  });

  it('a candidate whose redraw has no price is left out (never shown as a $0 "Free" redraw)', () => {
    const doc = drawnDoc(); // a drawn cover: the redraw needs a cover price
    const list = registryPriceBook();
    const noCoverPrice: PriceBook = { ...list, unit: (id, res, kind, refs) => (kind === 'cover' ? { usd: null, basis: 'not published' } : list.unit(id, res, kind, refs)) };
    expect(registrySwitchOptions({ doc, blockedModelId: 'nano-banana-2.1', caps: paid, prices: noCoverPrice })).toEqual([]);
    expect(registrySwitchOptions({ doc, blockedModelId: 'nano-banana-2.1', caps: paid, prices: list })).toHaveLength(1);
  });

  it('BYOK prices carry no markup; the free plan gets no switch; a down candidate is never offered', () => {
    const doc = drawnDoc();
    expect(registrySwitchOptions({ doc, blockedModelId: 'nano-banana-2.1', caps: byokCaps })[0].usdPerImage).toBeCloseTo(imagePriceUsd(PRO, '2K'), 4);
    expect(registrySwitchOptions({ doc, blockedModelId: 'nano-banana-2.1', caps: DEFAULT_CAPS })).toEqual([]);
    const down = { [PRO.id]: { modelId: PRO.id, state: 'down' as const, routes: [], checkedAt: 1 } };
    expect(registrySwitchOptions({ doc, blockedModelId: 'nano-banana-2.1', caps: paid, health: down })).toEqual([]);
  });
});

describe('bannerOptions', () => {
  const card = (extra: Partial<Extract<Card, { type: 'model_outage' }>> = {}): Extract<Card, { type: 'model_outage' }> => ({
    type: 'model_outage',
    id: 'c1',
    modelId: 'nano-banana-2.1',
    options: [{ kind: 'wait_and_retry' }, { kind: 'other_route', route: 'gemini', label: 'Use the same model through your Gemini key' }, { kind: 'add_key', route: 'gemini', label: 'Add a Gemini key' }, { kind: 'teleport' } as never],
    blockedAction: { type: 'render_cover', quotedUsd: 0.07 },
    ...extra
  });

  it('prefers the newest server card for the model (≤ 3, malformed options dropped)', () => {
    const doc = drawnDoc();
    doc.conversation = [
      { id: 'm1', role: 'assistant', text: '', at: 1, cards: [card({ id: 'old' })] },
      { id: 'm2', role: 'assistant', text: '', at: 2, cards: [card()] }
    ];
    expect(latestOutageCard(doc)?.id).toBe('c1');
    expect(latestOutageCard(doc, 'nano-banana-pro')).toBeUndefined();
    const out = bannerOptions({ doc, modelId: 'nano-banana-2.1', caps: paid });
    expect(out.card?.id).toBe('c1');
    expect(out.options.map((o) => o.kind)).toEqual(['wait_and_retry', 'other_route', 'add_key']);
    expect(cleanOptions([{ kind: 'teleport' }, null, { kind: 'wait_and_retry' }])).toEqual([{ kind: 'wait_and_retry' }]);
  });

  it('without a blocked action, wait / other route are left out (nothing to re-send)', () => {
    const doc = drawnDoc();
    doc.conversation = [{ id: 'm', role: 'assistant', text: '', at: 1, cards: [card({ blockedAction: undefined })] }];
    expect(bannerOptions({ doc, modelId: 'nano-banana-2.1', caps: paid }).options.map((o) => o.kind)).toEqual(['add_key']);
  });

  it('with no card it falls back to registry switches', () => {
    expect(bannerOptions({ doc: drawnDoc(), modelId: 'nano-banana-2.1', caps: paid }).options.map((o) => o.kind)).toEqual(['switch_model']);
  });
});

describe('copy', () => {
  const dollars = { governed: false, exact: (u: number) => `$${u.toFixed(2)}`, approx: (u: number) => `≈ $${u.toFixed(2)}`, badge: String, spoken: String, saved: String };
  it('option labels carry the price and the consistency cost', () => {
    expect(optionText({ kind: 'wait_and_retry', etaHint: 'about 2 min' }, dollars)).toEqual({ label: 'Wait and retry automatically', price: 'Free', detail: 'checks again in about 2 min' });
    expect(
      optionText({ kind: 'switch_model', modelId: 'x', nickname: 'X', usdPerImage: 0.17, consistency: 'different', redrawCount: 1, redrawUsd: 0.2 }, dollars)
    ).toEqual({ label: 'Try X instead', price: '≈ $0.17 per image', detail: 'a different look · redraw 1 drawn image ≈ $0.20 to keep the book consistent' });
  });

  it('reasons read as words, what was held back as a phrase, times as ages', () => {
    expect(friendlyReason('Our last 3 calls failed (RATE_LIMIT)')).toBe('our last 3 calls failed: rate limited');
    expect(friendlyReason('Our last call failed (503)')).toBe('our last call failed: provider error');
    expect(friendlyReason('Provider uptime 41% in the last 30 min')).toBe('provider uptime 41% in the last 30 min');
    expect(blockedWhat({ type: 'render_pages', pageIds: ['pg_2'], quotedUsd: 0.1 }, () => 2)).toEqual({ label: 'Page 2', plural: false });
    expect(blockedWhat({ type: 'render_sheets', quotedUsd: 0.1 })).toEqual({ label: 'The character sheets', plural: true });
    expect(outageSentence({ modelId: 'nano-banana-2.1', origin: 'preflight' })).toBe(
      "Nano Banana 2.1 isn't available for this comic right now. Nothing was drawn, and nothing was charged. You can wait, or switch models. Switching can affect consistency."
    );
    expect(outageSentence({ modelId: 'nano-banana-2.1' })).toBe(
      "Nano Banana 2.1 isn't available for this comic right now. Some images weren't drawn. You can wait, or switch models. Switching can affect consistency."
    );
    expect(timeAgo(1000, 1000 + 30_000)).toBe('just now');
    expect(timeAgo(1000, 1000 + 2 * 60_000)).toBe('2 min ago');
    expect(timeAgo(undefined)).toBe('time unknown');
  });
});

describe('outage copy (models.md §3.6 G/H) and money honesty', () => {
  const throttled: ModelHealth = {
    modelId: 'nano-banana-2.1',
    state: 'down',
    checkedAt: 1,
    routes: [
      {
        route: 'gemini',
        model: 'gemini-nano-banana-2.1',
        state: 'down',
        reason: 'Our last 3 calls failed (RATE_LIMIT)',
        observed: { ok: 0, upstreamFailures: 3, lastCode: 'RATE_LIMIT', lastFailureAt: 1 },
        checkedAt: 1,
        source: 'observed'
      }
    ]
  };
  const page2: Parameters<typeof notDrawnSentence>[0]['action'] = { type: 'render_pages', pageIds: ['pg_2'], quotedUsd: 0.05 };

  it('G when our calls were rate-limited, H otherwise', () => {
    expect(isRateLimited(throttled)).toBe(true);
    expect(isRateLimited(undefined, '429')).toBe(true);
    expect(isRateLimited(undefined, 'PROVIDER_ERROR')).toBe(false);
    expect(outageSentence({ modelId: 'nano-banana-2.1', health: throttled, action: page2, pageNumber: () => 2, origin: 'mid_run', chargedUsd: 0 })).toBe(
      "Google is rate-limiting Nano Banana 2.1 right now (Gemini · 429). Page 2 wasn't drawn, and you weren't charged for it. Your comic stays on Nano Banana 2.1 so every page matches."
    );
  });

  it('the charge clause appears only when it is known: preflight, or a mid-run part the provider billed $0', () => {
    expect(notDrawnSentence({ action: page2, pageNumber: () => 2, origin: 'preflight' })).toBe("Page 2 wasn't drawn, and you weren't charged for it.");
    expect(notDrawnSentence({ action: page2, pageNumber: () => 2, origin: 'mid_run', chargedUsd: 0 })).toBe("Page 2 wasn't drawn, and you weren't charged for it.");
    expect(notDrawnSentence({ action: page2, pageNumber: () => 2, origin: 'mid_run', chargedUsd: 0.04 })).toBe("Page 2 wasn't drawn.");
    expect(notDrawnSentence({ action: page2, pageNumber: () => 2, origin: 'mid_run' })).toBe("Page 2 wasn't drawn.");
    expect(notDrawnSentence({ action: page2, pageNumber: () => 2 })).toBe("Page 2 wasn't drawn.");
    expect(notDrawnSentence({ action: { type: 'render_style_options', quotedUsd: 0.1 }, origin: 'preflight' })).toBe(
      "The style tests weren't drawn, and you weren't charged for them."
    );
  });

  it('reads origin / chargedUsd off a card and ignores anything malformed', () => {
    expect(outageFacts({ origin: 'preflight' })).toEqual({ origin: 'preflight' });
    expect(outageFacts({ origin: 'mid_run', chargedUsd: 0 })).toEqual({ origin: 'mid_run', chargedUsd: 0 });
    expect(outageFacts({ origin: 'later', chargedUsd: -1 })).toEqual({});
    expect(outageFacts({ chargedUsd: Number.NaN })).toEqual({});
    expect(outageFacts(null)).toEqual({});
  });
});

describe('statusApi validation', () => {
  it('keeps well-formed health and drops malformed routes and fields', () => {
    const h = asModelHealth({
      modelId: 'nano-banana-2.1',
      state: 'down',
      checkedAt: 5,
      routes: [
        { route: 'openrouter', model: 'g/x', state: 'down', checkedAt: 5, source: 'openrouter', providers: [{ name: 'Google', status: -1, uptime30m: 'x', uptime1d: 90 }, { status: 0 }], key: 'sk-or-secret' },
        { route: 'mars', model: 'x', state: 'ok', checkedAt: 1, source: 'none' },
        { route: 'gemini', model: 'g', state: 'maybe', checkedAt: 1 }
      ]
    });
    expect(h).toEqual({
      modelId: 'nano-banana-2.1',
      state: 'down',
      checkedAt: 5,
      routes: [{ route: 'openrouter', model: 'g/x', state: 'down', checkedAt: 5, source: 'openrouter', providers: [{ name: 'Google', status: -1, uptime30m: null, uptime1d: 90 }] }]
    });
    expect(asModelHealth({ modelId: 'x', state: 'fine', checkedAt: 1 })).toBeUndefined();
    expect(asModelHealth(null)).toBeUndefined();
    const report = asProviderStatusReport({ models: [h, 'junk'], breakerEvents: [{ at: 1, route: 'gemini', model: 'g', event: 'opened', failures: 3 }, { at: 1, route: 'gemini', model: 'g', event: 'boom' }], bootedAt: 1, now: 2 });
    expect(report.models).toHaveLength(1);
    expect(report.breakerEvents).toEqual([{ at: 1, route: 'gemini', model: 'g', event: 'opened', failures: 3 }]);
  });
});
