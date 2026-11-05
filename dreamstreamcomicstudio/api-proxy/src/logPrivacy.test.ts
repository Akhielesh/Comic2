// @vitest-environment node
// S19: an unlisted share slug is a read capability — it must not land in the agent log (D1, kept
// 90 days, shown on another site's panel) nor in Cloudflare's stored invocation logs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { logVisit, type D1Like } from './agent-log';
import type { AgentMatch } from './agent-gate';

const SLUG = 'Ab3dEf6hIj9kLm2nP';

/** A D1 fake that records every bound INSERT (schema DDL and the rate-limit count answer too). */
function fakeD1() {
  const inserts: unknown[][] = [];
  const db: D1Like = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        run: async () => {
          if (/^\s*INSERT/i.test(sql)) inserts.push(values);
          return {};
        },
        first: async <T,>() => ({ n: 0 }) as T
      }),
      run: async () => ({})
    })
  };
  return { db, inserts };
}

const agent: AgentMatch = { name: 'ChatGPT-User', kind: 'ai', reason: 'user-agent' };

const readJsonc = (rel: string): Record<string, unknown> => {
  const text = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const parsed = ts.parseConfigFileTextToJson(rel, text);
  expect(parsed.error).toBeUndefined();
  return parsed.config as Record<string, unknown>;
};

describe('agent log (agent_visits) never stores a share capability', () => {
  it('masks the visited path and the Referer', async () => {
    const { db, inserts } = fakeD1();
    const req = new Request('https://dreamstreamstudio.ai/api/agent-gate', {
      headers: { 'user-agent': 'ChatGPT-User/1.0', referer: `https://comics.dreamstreamstudio.ai/c/${SLUG}?lang=hi`, 'cf-connecting-ip': '203.0.113.9' }
    });
    await logVisit(db, req, agent, 'visit-1', 'canary', `/c/${SLUG}`);
    await logVisit(db, req, agent, 'visit-2', 'canary', `/api/comic/public/s/${SLUG}/event`);
    await logVisit(db, req, agent, 'visit-3', 'canary', '/');
    expect(inserts).toHaveLength(3);
    expect(inserts.map((row) => row[2])).toEqual(['/c/:slug', '/api/comic/public/s/:slug/event', '/']);
    expect(JSON.parse(String(inserts[0][12])).referer).toBe('https://comics.dreamstreamstudio.ai/c/:slug');
    expect(JSON.stringify(inserts)).not.toContain(SLUG);
  });
});

describe('Workers invocation logs (which store every request URL) are off on the share hosts', () => {
  for (const rel of ['../wrangler.jsonc', '../../comics-edge/wrangler.jsonc']) {
    it(rel, () => {
      const observability = readJsonc(rel).observability as { enabled?: boolean; logs?: { enabled?: boolean; invocation_logs?: boolean } };
      expect(observability.enabled).toBe(true);
      // Custom (masked) logs and the container's logs stay on …
      expect(observability.logs?.enabled).not.toBe(false);
      // … but Cloudflare's per-invocation "<METHOD> <URL>" records do not.
      expect(observability.logs?.invocation_logs).toBe(false);
    });
  }
});
