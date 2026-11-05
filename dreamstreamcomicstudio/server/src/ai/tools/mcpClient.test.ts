// @vitest-environment node
import { afterEach, describe, it, expect, vi } from 'vitest';
import { buildMcpTools, fetchPublicUrl, isSafeMcpUrl, mayUseInternalHosts } from './mcpClient.js';
import { __setNetForTests } from './safeNet.js';
import { envDesignMcpServers } from '../studio/designSystem.js';

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

// ---------------------------------------------------------------------------------------------
// web-surface-1: `trusted` (skip the SSRF guard) counts only for operator-configured URLs.
// web-surface-2 / N8: fetchPublicUrl re-checks every redirect hop and connects through the
// pinned transport. Every network edge is faked: global fetch (trusted servers), the pinned
// transport and the resolver (safeNet test hooks).
// ---------------------------------------------------------------------------------------------
const rpcServer = () =>
  vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { id?: number; method?: string };
    const result =
      body.method === 'initialize'
        ? { protocolVersion: '2025-06-18' }
        : body.method === 'tools/list'
          ? { tools: [{ name: 'hello', description: 'Says hello' }] }
          : {};
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  });

describe('buildMcpTools: the trusted flag needs an operator-configured URL', () => {
  let restoreNet: (() => void) | null = null;
  afterEach(() => {
    restoreNet?.();
    restoreNet = null;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('a request-supplied {trusted: true} internal server gets no tools and nothing is sent', async () => {
    const net = rpcServer();
    vi.stubGlobal('fetch', net);
    restoreNet = __setNetForTests({ transport: net, resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
    const tools = await buildMcpTools([{ id: 'evil', name: 'Evil', url: 'http://127.0.0.1', trusted: true }]);
    expect(tools).toEqual([]);
    expect(net).not.toHaveBeenCalled();
  });

  it('{trusted: true} on a metadata URL is refused the same way', async () => {
    const net = rpcServer();
    vi.stubGlobal('fetch', net);
    restoreNet = __setNetForTests({ transport: net });
    expect(await buildMcpTools([{ id: 'm', name: 'M', url: 'http://169.254.169.254/latest/meta-data/', trusted: true }])).toEqual([]);
    expect(net).not.toHaveBeenCalled();
  });

  it('an env-listed internal URL (operator) still works', async () => {
    const net = rpcServer();
    vi.stubGlobal('fetch', net);
    vi.stubEnv('STUDIO_SHADCN_MCP_URL', 'http://127.0.0.1:8001/mcp');
    const operator = envDesignMcpServers();
    expect(operator.map((s) => s.url)).toContain('http://127.0.0.1:8001/mcp');
    // chat.ts dedupes servers by URL before building; the catalog can list one env var twice.
    const tools = await buildMcpTools(operator.filter((s) => s.url === 'http://127.0.0.1:8001/mcp').slice(0, 1));
    expect(tools.map((t) => t.name)).toEqual(['mcp_shadcn_hello']);
    expect(net).toHaveBeenCalled();
    expect(String(net.mock.calls[0][0])).toBe('http://127.0.0.1:8001/mcp');
  });

  it('mayUseInternalHosts: flag AND operator URL, never either alone', () => {
    const ops = new Set(['http://sidecar:8001/mcp']);
    expect(mayUseInternalHosts({ url: 'http://sidecar:8001/mcp', trusted: true }, ops)).toBe(true);
    expect(mayUseInternalHosts({ url: 'http://sidecar:8001/mcp' }, ops)).toBe(false);
    expect(mayUseInternalHosts({ url: 'http://127.0.0.1', trusted: true }, ops)).toBe(false);
  });

  it('an untrusted public server connects through the pinned transport, not the global fetch', async () => {
    const pinned = rpcServer();
    const global = vi.fn(async () => new Response('should not be used', { status: 500 }));
    vi.stubGlobal('fetch', global);
    restoreNet = __setNetForTests({ transport: pinned, resolve: async () => [{ address: '93.184.216.34', family: 4 }] });
    const tools = await buildMcpTools([{ id: 'pub', name: 'Pub', url: 'https://mcp-pinned.test/mcp' }]);
    expect(tools.map((t) => t.name)).toEqual(['mcp_pub_hello']);
    expect(pinned).toHaveBeenCalled();
    expect(global).not.toHaveBeenCalled();
  });
});

describe('fetchPublicUrl: every hop re-checked, nothing internal reached', () => {
  let restoreNet: (() => void) | null = null;
  afterEach(() => {
    restoreNet?.();
    restoreNet = null;
  });

  const publicResolver = async (host: string) =>
    host === 'rebind.test' ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '93.184.216.34', family: 4 }];

  it.each([
    ['https://127.0.0.1/'],
    ['https://169.254.169.254/latest/meta-data/'],
    ['http://public.test/'],
    ['https://rebind.test/admin']
  ])('a 302 to %s is refused after exactly one request', async (location) => {
    const transport = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 302, headers: { location } }));
    restoreNet = __setNetForTests({ transport, resolve: publicResolver });
    await expect(fetchPublicUrl('https://public.test/start')).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('follows a public redirect and stops after maxRedirects', async () => {
    const transport = vi.fn(async (url: string) =>
      url.endsWith('/final') ? new Response('ok', { status: 200 }) : new Response(null, { status: 301, headers: { location: '/final' } })
    );
    restoreNet = __setNetForTests({ transport, resolve: publicResolver });
    const res = await fetchPublicUrl('https://public.test/start');
    expect(await res.text()).toBe('ok');
    expect(transport).toHaveBeenCalledTimes(2);

    const loop = vi.fn(async () => new Response(null, { status: 302, headers: { location: '/again' } }));
    restoreNet();
    restoreNet = __setNetForTests({ transport: loop, resolve: publicResolver });
    await expect(fetchPublicUrl('https://public.test/start', {}, 2)).rejects.toThrow(/too many redirects/);
    expect(loop).toHaveBeenCalledTimes(3);
  });
});
