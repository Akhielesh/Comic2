import { describe, it, expect } from 'vitest';
import { connectorsPublicRouter } from './connectors.js';

// The OAuth popup lands on /oauth/callback, whose self-closing HTML must (a) keep its
// window.opener so it can postMessage the result back, and (b) be allowed to run its own
// inline script. The global API security headers (COOP: same-origin + CSP default-src
// 'none') break BOTH — the callback response has to override them. These tests guard that
// override, because regressing it silently re-breaks the popup (stuck open + a console
// flood of "Cross-Origin-Opener-Policy would block the window.closed call").

const callbackHandler = () => {
  const layer = (connectorsPublicRouter as unknown as { stack: any[] }).stack.find(
    (l) => l.route?.path === '/oauth/callback'
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any) => Promise<void>;
};

const mockRes = () => {
  const res: any = { _headers: {} as Record<string, string>, _body: '' };
  res.set = (k: string, v: string) => {
    res._headers[k] = v;
    return res;
  };
  res.send = (b: string) => {
    res._body = b;
    return res;
  };
  return res;
};

// Empty query → the handler short-circuits to the self-closing page BEFORE any state/DB
// work, so we can assert the response shape with no mocks.
const render = async () => {
  const res = mockRes();
  await callbackHandler()({ query: {} }, res);
  return res;
};

describe('OAuth callback popup page', () => {
  it('sets COOP same-origin-allow-popups so postMessage reaches the opener', async () => {
    const res = await render();
    expect(res._headers['Cross-Origin-Opener-Policy']).toBe('same-origin-allow-popups');
  });

  it('ships a nonce CSP that matches the inline script (so CSP does not block it)', async () => {
    const res = await render();
    const csp = res._headers['Content-Security-Policy'] || '';
    const match = csp.match(/script-src 'nonce-([0-9a-f]{32})'/);
    expect(match, `CSP should carry a script nonce, got: ${csp}`).toBeTruthy();
    const nonce = match![1];
    expect(res._body).toContain(`<script nonce="${nonce}">`);
    expect(res._body).toContain('window.opener.postMessage');
    // Everything else stays locked down — only the nonce'd script is allowed.
    expect(csp).toContain("default-src 'none'");
  });

  it('escapes a crafted ?error= so it cannot break out of the <script> block', async () => {
    const res = mockRes();
    await callbackHandler()({ query: { error: '</script><img src=x onerror=alert(1)>' } }, res);
    // The raw closing tag must not survive into the document; `<` is escaped to <.
    expect(res._body).not.toContain('</script><img');
    expect(res._body).toContain('\\u003c/script');
  });

  it('uses a fresh nonce per request (no fixed/guessable value)', async () => {
    const nonceOf = (res: any) =>
      (res._headers['Content-Security-Policy'].match(/nonce-([0-9a-f]{32})/) || [])[1];
    const a = await render();
    const b = await render();
    expect(nonceOf(a)).toBeTruthy();
    expect(nonceOf(a)).not.toBe(nonceOf(b));
  });
});
