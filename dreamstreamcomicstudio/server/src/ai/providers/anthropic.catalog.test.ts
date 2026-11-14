import { afterEach, describe, expect, it, vi } from 'vitest';
import { anthropicProvider } from './anthropic.js';
const ctx = { apiKey: 'test-key', byok: true };
afterEach(() => vi.unstubAllGlobals());
describe('Anthropic live catalog', () => {
  it('follows all pages and does not retain seed-only IDs or invent context/pricing', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'claude-new-one', display_name: 'One' }], has_more: true, last_id: 'claude-new-one' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'claude-new-two', display_name: 'Two' }], has_more: false })));
    vi.stubGlobal('fetch', fetcher);
    const models = await anthropicProvider.listModels(ctx);
    expect(models.map((m) => m.id)).toEqual(['claude-new-one', 'claude-new-two']);
    expect(fetcher.mock.calls[1][0]).toContain('after_id=claude-new-one');
    expect(models.every((m) => m.catalogOrigin === 'live' && m.pricingKnown === false && m.contextLength === undefined)).toBe(true);
  });
  it('does not report a partial listing as live if later pages fail', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'claude-new-one' }], has_more: true, last_id: 'claude-new-one' })))
      .mockResolvedValueOnce(new Response('temporary failure', { status: 503 })));
    const models = await anthropicProvider.listModels(ctx);
    expect(models.every((m) => m.catalogOrigin === 'curated')).toBe(true);
  });
});
