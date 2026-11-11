// @vitest-environment node
// web-surface-1 follow-up: sanitizeRequestMcpServers bounds the entries it LOOKS AT, not just the ones
// it keeps, so a 10 MB body of invalid entries costs at most 32 URL parses on the main thread.
// (The route-level behaviour — no `trusted`, no fetch to internal hosts — is chat.mcpTrusted.test.ts.)
import { describe, expect, it } from 'vitest';
import { MAX_REQUEST_MCP_ENTRIES_SCANNED, sanitizeRequestMcpServers } from './mcpRequestServers.js';

describe('sanitizeRequestMcpServers scan bound', () => {
  it('reads at most 32 entries of a huge array of invalid ones', () => {
    const looked = new Set<number>();
    const raw = Array.from({ length: 300_000 }, (_, i) => ({
      get id() {
        looked.add(i);
        return 'a';
      },
      url: 'https://10.0.0.1/'
    }));
    expect(sanitizeRequestMcpServers(raw)).toEqual([]);
    expect(MAX_REQUEST_MCP_ENTRIES_SCANNED).toBe(32);
    expect([...looked]).toEqual(Array.from({ length: 32 }, (_, i) => i));
  });

  it('a valid entry inside the first 32 is kept; one after them is not', () => {
    const bad = { id: 'bad', url: 'http://127.0.0.1/' };
    const good = (id: string) => ({ id, url: `https://${id}.example.com/mcp` });
    const raw = [...Array.from({ length: 31 }, () => bad), good('inside'), good('outside')];
    expect(sanitizeRequestMcpServers(raw).map((s) => s.id)).toEqual(['inside']);
  });
});
