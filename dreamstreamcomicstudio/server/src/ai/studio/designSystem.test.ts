import { describe, it, expect } from 'vitest';
import {
  DESIGN_CHARTER,
  buildDesignDirective,
  ALWAYS_ON_STUDIO_MCP_SERVERS,
  envDesignMcpServers,
  CURATED_MCP_CATALOG,
} from './designSystem.js';

describe('designSystem', () => {
  it('buildDesignDirective embeds the charter and self-customizes per request', () => {
    const fresh = buildDesignDirective({ prompt: 'a budgeting app' });
    expect(fresh).toContain(DESIGN_CHARTER);
    expect(fresh).toContain('COMMIT'); // new app: infer an aesthetic and commit to it
    expect(fresh).toContain('WEB + MOBILE BY DEFAULT');

    const refine = buildDesignDirective({ prompt: 'add dark mode', refining: true });
    expect(refine).toContain('EDIT to an existing app'); // refine: extend the established language
    expect(refine).toContain(DESIGN_CHARTER);
  });

  it('always-on MCP servers are curated, https, and include Context7 + DeepWiki', () => {
    const ids = ALWAYS_ON_STUDIO_MCP_SERVERS.map((s) => s.id);
    expect(ids).toContain('context7');
    expect(ids).toContain('deepwiki');
    expect(ALWAYS_ON_STUDIO_MCP_SERVERS.every((s) => s.url.startsWith('https://'))).toBe(true);
  });

  it('envDesignMcpServers maps env vars to trusted servers (http allowed for self-hosted), with optional headers', () => {
    const servers = envDesignMcpServers({
      STUDIO_SHADCN_MCP_URL: 'https://shadcn.example.com/mcp',
      STUDIO_NANGO_MCP_URL: 'http://nango.internal:3003/mcp', // http allowed: operator-configured/trusted
      STUDIO_NANGO_MCP_URL_HEADERS: '{"Authorization":"Bearer secret"}',
      STUDIO_MAGIC_MCP_URL: 'not-a-url', // dropped: not http(s)
    });
    const byId = Object.fromEntries(servers.map((s) => [s.id, s]));
    expect(byId.shadcn.trusted).toBe(true);
    expect(byId.nango.url).toBe('http://nango.internal:3003/mcp');
    expect(byId.nango.headers).toEqual({ Authorization: 'Bearer secret' });
    expect(byId.magic).toBeUndefined();
  });

  it('catalog documents transport + license for every curated tool', () => {
    expect(CURATED_MCP_CATALOG.length).toBeGreaterThan(0);
    for (const m of CURATED_MCP_CATALOG) {
      expect(['http', 'stdio']).toContain(m.transport);
      expect(typeof m.license).toBe('string');
      // stdio servers must declare the env var an operator points at an HTTPS bridge with.
      if (m.transport === 'stdio') expect(m.envVar).toBeTruthy();
    }
  });
});
