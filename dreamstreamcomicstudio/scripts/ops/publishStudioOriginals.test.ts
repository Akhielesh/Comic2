// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ORIGINAL_KEYS, ORIGINAL_SLUGS } from '../../shared/comic/originals';
import { publish } from './publishStudioOriginals.mjs';

const env = {
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://run-actions-1.actions.githubusercontent.com/idtoken',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-runner-token'
};

describe('Studio Originals release', () => {
  it('assigns each registered book a separate job that survives another job failing', () => {
    const workflow = readFileSync(new URL('../../../.github/workflows/publish-studio-originals.yml', import.meta.url), 'utf8');
    expect(workflow).toMatch(/fail-fast:\s*false/);
    expect(workflow).toMatch(/ORIGINAL_BOOK:\s*\$\{\{ matrix.book \}\}/);
    const titles = workflow.match(/book:\s*\[([^\]]+)\]/)?.[1].split(',').map((title) => title.trim());
    expect(titles?.sort()).toEqual([...ORIGINAL_KEYS].sort());
  });

  it('reports the held title and gives the reader URL for each independently approved title', async () => {
    const jobs = ORIGINAL_KEYS.map((key) => {
      const fetcher = vi.fn()
        .mockResolvedValueOnce(Response.json({ value: 'test-workflow-token' }))
        .mockResolvedValueOnce(key === 'tide'
          ? Response.json({ code: 'REVIEW_INCOMPLETE' }, { status: 503 })
          : Response.json({ state: 'published', slug: ORIGINAL_SLUGS[key] }));
      return publish(key, env, fetcher);
    });
    const results = await Promise.allSettled(jobs);
    for (const [index, key] of ORIGINAL_KEYS.entries()) {
      if (key === 'tide') expect(results[index]).toMatchObject({ status: 'rejected', reason: new Error('Publishing tide returned HTTP 503 (REVIEW_INCOMPLETE)') });
      else expect(results[index]).toEqual({ status: 'fulfilled', value: 'https://comics.dreamstreamstudio.ai/c/' + ORIGINAL_SLUGS[key] });
    }
  });

  it('rejects unregistered books before requesting a workflow credential', async () => {
    const fetcher = vi.fn();
    await expect(publish('unregistered', env, fetcher)).rejects.toThrow('Select one registered Studio Original');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
