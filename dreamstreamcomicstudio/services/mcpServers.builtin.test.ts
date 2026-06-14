import { describe, it, expect } from 'vitest';
import { BUILTIN_MCP_SERVERS, listAllMcpServers, getMcpServersByIds } from './mcpServers';

describe('built-in MCP servers', () => {
  it('ships DeepWiki as a public, no-auth built-in', () => {
    const deepwiki = BUILTIN_MCP_SERVERS.find((s) => s.id === 'builtin:deepwiki');
    expect(deepwiki).toBeTruthy();
    expect(deepwiki?.url).toMatch(/deepwiki/);
    expect(deepwiki?.headers).toBeUndefined(); // no token
  });

  it('listAllMcpServers includes the built-ins', () => {
    expect(listAllMcpServers().some((s) => s.id === 'builtin:deepwiki')).toBe(true);
  });

  it('getMcpServersByIds resolves a built-in id (so it is sent in the request)', () => {
    const resolved = getMcpServersByIds(['builtin:deepwiki']);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].name).toBe('DeepWiki');
  });
});
