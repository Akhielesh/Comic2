// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ORIGINAL_KEYS, ORIGINAL_SLUGS, PUBLISHABLE_ORIGINAL_KEYS, isOriginalSlug } from '../../shared/comic/originals';
import { publish } from './publishStudioOriginals.mjs';

const env = {
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://run-actions-1.actions.githubusercontent.com/idtoken',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-runner-token'
};

describe('Studio Originals release', () => {
  it('schedules all current books independently and preserves the registered reader identities', () => {
    const workflow = readFileSync(new URL('../../../.github/workflows/publish-studio-originals.yml', import.meta.url), 'utf8');
    expect(workflow).toMatch(/fail-fast:\s*false/);
    expect(workflow).toMatch(/ORIGINAL_BOOK:\s*\$\{\{ matrix.book \}\}/);
    const titles = workflow
      .match(/book:\s*\[([^\]]+)\]/)?.[1]
      .split(',')
      .map((title) => title.trim());
    expect(titles?.sort()).toEqual([...PUBLISHABLE_ORIGINAL_KEYS].sort());
    expect(titles).toContain('harbor');
    expect(titles).toContain('hat-shop');
    expect(titles).toHaveLength(9);
    expect(titles).not.toContain('tide');
    expect(titles).not.toContain('bubble');
    expect(ORIGINAL_KEYS).toHaveLength(11);
    expect(new Set(Object.values(ORIGINAL_SLUGS)).size).toBe(11);
    expect(Object.values(ORIGINAL_SLUGS).every((slug) => /^[a-zA-Z0-9]{17}$/.test(slug))).toBe(true);
    expect(isOriginalSlug(ORIGINAL_SLUGS.tide)).toBe(true);
    expect(isOriginalSlug(ORIGINAL_SLUGS.bubble)).toBe(true);
  });

  it('returns the exact independent reader URL for each publishable title', async () => {
    for (const key of PUBLISHABLE_ORIGINAL_KEYS) {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ value: 'test-workflow-token' }))
        .mockResolvedValueOnce(Response.json({ state: 'published', slug: ORIGINAL_SLUGS[key] }));
      await expect(publish(key, env, fetcher)).resolves.toBe('https://comics.dreamstreamstudio.ai/c/' + ORIGINAL_SLUGS[key]);
    }
    const wrong = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ value: 'test-token' }))
      .mockResolvedValueOnce(Response.json({ state: 'published', slug: ORIGINAL_SLUGS.tide }));
    await expect(publish('harbor', env, wrong)).rejects.toThrow('incomplete result');
  });

  it('rejects unregistered books before requesting a workflow credential', async () => {
    const fetcher = vi.fn();
    for (const key of ['unregistered', 'tide', 'bubble']) await expect(publish(key, env, fetcher)).rejects.toThrow('currently open for publication');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
