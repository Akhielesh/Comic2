import { describe, it, expect } from 'vitest';
import { isSafeMcpUrl } from './mcpClient.js';

describe('isSafeMcpUrl', () => {
  it('strict mode (user-supplied URLs) requires https + a public host', () => {
    expect(isSafeMcpUrl('https://mcp.example.com/mcp').ok).toBe(true);
    expect(isSafeMcpUrl('http://mcp.example.com/mcp').ok).toBe(false); // http rejected
    expect(isSafeMcpUrl('https://localhost/mcp').ok).toBe(false); // loopback rejected
    expect(isSafeMcpUrl('https://10.0.0.1/mcp').ok).toBe(false); // private range rejected
    expect(isSafeMcpUrl('https://svc.local/mcp').ok).toBe(false); // .local rejected
  });

  it('trusted mode (operator-configured) allows http + internal hosts, still validates the URL', () => {
    expect(isSafeMcpUrl('http://shadcn-mcp:8001/mcp', { allowInternal: true }).ok).toBe(true);
    expect(isSafeMcpUrl('http://localhost:3003/mcp', { allowInternal: true }).ok).toBe(true);
    expect(isSafeMcpUrl('https://mcp.example.com/mcp', { allowInternal: true }).ok).toBe(true);
    expect(isSafeMcpUrl('ftp://host/x', { allowInternal: true }).ok).toBe(false); // non-http(s) rejected
    expect(isSafeMcpUrl('not a url', { allowInternal: true }).ok).toBe(false);
  });
});
