// @vitest-environment node
/**
 * Bridge D5, "Atlas everywhere" (docs/design/atlas-skin.md "Wave 9 (bridge)"): index.html ships
 * `data-ds-skin="atlas"` on <html>, and the build kill switch VITE_DS_SKIN_EVERYWHERE=off strips it from
 * EVERY HTML entry (vite.config.ts dsSkinEverywherePlugin; no file-name filter, so live.html rolls back with
 * the same switch once it carries the attribute). Any other value keeps it. The no-flash theme script is
 * external (the CSP hashes the page's one inline script, which must not change; tests/edge/securityHeaders).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import viteConfig, { DS_SKIN_EVERYWHERE_VAR, dsSkinEverywhere, dsSkinEverywherePlugin, dsSkinEverywhereWarning, stripDsSkinAttribute } from '../../vite.config';
import { applySecurityHeaders } from '../../comics-edge/src/policy';
import { SUPABASE_ORIGIN, mainCsp } from '../../functions/_middleware';
import { buildCsp, inlineHashes } from '../../functions/_shared/csp';
import { allowsUrl, parsePolicy } from '../edge/cspEval';
import { APP_ROOT } from './cssTokens';

const INDEX_HTML = readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8');
const LIVE_HTML = readFileSync(path.join(APP_ROOT, 'live.html'), 'utf8');
/** live.html as the other session ships it: the same attribute on its <html>. */
const LIVE_SKINNED = LIVE_HTML.replace(/<html\b([^>]*)>/i, '<html$1 data-ds-skin="atlas">');
const htmlTag = (html: string) => html.match(/<html\b[^>]*>/i)?.[0] ?? '';

type Handler = (html: string, ctx: { path: string; filename: string }) => string;
const handlerOf = (value: string | undefined): Handler => {
  const hook = dsSkinEverywherePlugin(value).transformIndexHtml as { order: string; handler: Handler };
  expect(hook.order).toBe('pre');
  return hook.handler;
};

describe('index.html ships the skin on <html>', () => {
  it('has data-ds-skin="atlas" on its <html> start tag, and the external theme script in <head>', () => {
    expect(htmlTag(INDEX_HTML)).toBe('<html lang="en" data-ds-skin="atlas">');
    const doc = new JSDOM(INDEX_HTML).window.document;
    expect(doc.documentElement.getAttribute('data-ds-skin')).toBe('atlas');
    const boot = doc.head.querySelector('script[src="/theme-boot.js"]');
    expect(boot).not.toBeNull();
    // Classic, blocking, same-origin: no type=module (that would defer it past first paint), no async/defer.
    expect(boot!.hasAttribute('type') || boot!.hasAttribute('async') || boot!.hasAttribute('defer')).toBe(false);
    // Before the stylesheet, so .dark is on <html> before the first styled paint.
    const order = [...doc.head.children].map((el) => el.getAttribute('src') ?? el.getAttribute('href') ?? el.tagName);
    expect(order.indexOf('/theme-boot.js')).toBeLessThan(order.indexOf('/index.css'));
  });
});

describe('the kill switch (vite.config.ts)', () => {
  it('keeps the attribute for every value but exactly `off` (default on)', () => {
    for (const v of [undefined, '', 'on', 'true', '1', 'ON', 'Off', 'OFF', ' off']) expect(dsSkinEverywhere(v), String(v)).toBe(true);
    expect(dsSkinEverywhere('off')).toBe(false);
    expect(DS_SKIN_EVERYWHERE_VAR).toBe('VITE_DS_SKIN_EVERYWHERE');
  });

  it('warns in the build log when a value looks like "off" but is not exactly `off` (the skin stays; nothing is silent)', () => {
    // During an incident `OFF` or `false` in the Pages build vars would otherwise give a green build that
    // still ships data-ds-skin="atlas". The exact-match rule stays; the plugin says so at configResolved.
    const warnings = (value: string | undefined) => {
      const warn = vi.fn();
      const hook = dsSkinEverywherePlugin(value).configResolved as (config: { logger: { warn: (msg: string) => void } }) => void;
      hook({ logger: { warn } });
      return warn.mock.calls.map((c) => String(c[0]));
    };
    for (const v of ['OFF', 'Off', ' off', 'off ', 'false', 'FALSE', '0', 'no', 'disable', 'Disabled']) {
      const got = warnings(v);
      expect(got, JSON.stringify(v)).toHaveLength(1);
      expect(got[0]).toBe(`VITE_DS_SKIN_EVERYWHERE="${v}" keeps the Atlas skin: only the exact value "off" strips it`);
      expect(dsSkinEverywhere(v), JSON.stringify(v)).toBe(true);
    }
    // Unset, the exact `off`, and values that mean "on" stay quiet.
    for (const v of [undefined, 'off', '', 'on', 'true', '1', 'atlas']) {
      expect(warnings(v), JSON.stringify(v)).toEqual([]);
      expect(dsSkinEverywhereWarning(v)).toBeNull();
    }
  });

  it('strips only the attribute from <html> (any quoting), leaving the rest of the page byte for byte', () => {
    const stripped = stripDsSkinAttribute(INDEX_HTML);
    expect(htmlTag(stripped)).toBe('<html lang="en">');
    expect(stripped).toBe(INDEX_HTML.replace('<html lang="en" data-ds-skin="atlas">', '<html lang="en">'));
    // The comment in <head> that names the attribute is text, not the tag: untouched.
    expect(stripped).toContain('<!-- data-ds-skin on <html>');
    for (const [input, out] of [
      ["<html data-ds-skin='atlas' lang=en>", '<html lang=en>'],
      ['<html data-ds-skin=atlas>', '<html>'],
      ['<HTML lang="en" DATA-DS-SKIN="atlas" class="x">', '<HTML lang="en" class="x">'],
      ['<html lang="en" data-ds-skin>', '<html lang="en">'],
      ['<html lang="en" data-ds-skinny="1">', '<html lang="en" data-ds-skinny="1">']
    ]) expect(stripDsSkinAttribute(input), input).toBe(out);
  });

  it('applies to EVERY HTML entry (no file-name filter): index.html and a live.html-shaped page alike', () => {
    expect(htmlTag(LIVE_SKINNED)).toContain('data-ds-skin="atlas"');
    const off = handlerOf('off');
    for (const [html, file] of [[INDEX_HTML, 'index.html'], [LIVE_SKINNED, 'live.html'], [INDEX_HTML, 'qa/comic-qa.html']] as const) {
      const out = off(html, { path: `/${file}`, filename: path.join(APP_ROOT, file) });
      expect(htmlTag(out), file).not.toContain('data-ds-skin');
    }
    // live.html keeps its own attributes.
    expect(htmlTag(off(LIVE_SKINNED, { path: '/live.html', filename: 'live.html' }))).toBe(htmlTag(LIVE_HTML));
    // Switch on (or unset): every page is returned unchanged.
    for (const v of [undefined, 'on']) {
      const on = handlerOf(v);
      expect(on(INDEX_HTML, { path: '/index.html', filename: 'index.html' })).toBe(INDEX_HTML);
      expect(on(LIVE_SKINNED, { path: '/live.html', filename: 'live.html' })).toBe(LIVE_SKINNED);
    }
  });

  it('is wired into the build (the config reads VITE_DS_SKIN_EVERYWHERE)', () => {
    const build = (value: string | undefined) => {
      const before = process.env[DS_SKIN_EVERYWHERE_VAR];
      if (value === undefined) delete process.env[DS_SKIN_EVERYWHERE_VAR];
      else process.env[DS_SKIN_EVERYWHERE_VAR] = value;
      try {
        const config = (viteConfig as unknown as (env: { mode: string; command: string }) => { plugins: Array<{ name?: string; transformIndexHtml?: { handler: Handler } }> })({ mode: 'production', command: 'build' });
        return config.plugins.flat().find((p) => p?.name === 'ds-skin-everywhere');
      } finally {
        if (before === undefined) delete process.env[DS_SKIN_EVERYWHERE_VAR];
        else process.env[DS_SKIN_EVERYWHERE_VAR] = before;
      }
    };
    const on = build(undefined);
    expect(on).toBeDefined();
    expect(htmlTag(on!.transformIndexHtml!.handler(INDEX_HTML, { path: '/index.html', filename: 'index.html' }))).toContain('data-ds-skin="atlas"');
    const off = build('off');
    expect(htmlTag(off!.transformIndexHtml!.handler(INDEX_HTML, { path: '/index.html', filename: 'index.html' }))).toBe('<html lang="en">');
  });
});

describe('every host\'s CSP lets the page load its same-origin scripts (the no-flash theme script first)', () => {
  // theme-boot.js is a blocking classic script: if a policy stopped allowing it (hashes only, 'strict-dynamic',
  // or an enforced main policy without 'self'), the page would flash light again and nothing else would fail.
  const ORIGINS = ['https://dreamstreamstudio.ai', 'https://comics.dreamstreamstudio.ai'];
  const SCRIPTS = [...new JSDOM(INDEX_HTML).window.document.querySelectorAll('script[src^="/"]')].map((el) => el.getAttribute('src')!);

  it('index.html loads /theme-boot.js as a same-origin script (what the policies below must allow)', () => {
    expect(SCRIPTS).toContain('/theme-boot.js');
  });

  it('the app policy (functions/_middleware.ts mainCsp), as served on the apex and through comics-edge on the comics host', () => {
    for (const origin of ORIGINS) {
      const policy = mainCsp({ origin });
      for (const src of SCRIPTS) expect(allowsUrl(parsePolicy(policy), 'script-src-elem', new URL(src, origin), origin), `${origin} ${src}`).toBe(true);
      // comics-edge adds frame-ancestors to the enforced header (Pages sends the app policy Report-Only):
      // whichever header the browser applies, the script stays allowed.
      for (const header of ['content-security-policy', 'content-security-policy-report-only']) {
        const headers = new Headers({ [header]: policy, 'content-type': 'text/html' });
        applySecurityHeaders(headers, '/');
        for (const name of ['content-security-policy', 'content-security-policy-report-only']) {
          const value = headers.get(name);
          if (!value) continue;
          for (const src of SCRIPTS) expect(allowsUrl(parsePolicy(value), 'script-src-elem', new URL(src, origin), origin), `${origin} ${header} → ${name} ${src}`).toBe(true);
        }
      }
    }
  });

  it('the enforced share-page policy (functions/_shared/csp.ts buildCsp, /c/*) with index.html\'s own inline hashes', async () => {
    const policy = buildCsp({ hashes: await inlineHashes(INDEX_HTML), supabaseOrigin: SUPABASE_ORIGIN, embed: false });
    for (const origin of ORIGINS) {
      for (const src of SCRIPTS) expect(allowsUrl(parsePolicy(policy), 'script-src-elem', new URL(src, origin), origin), `${origin} ${src}`).toBe(true);
    }
  });

  it('Pages serves /theme-boot.js as a static file (public/_routes.json excludes it from the Functions)', () => {
    const routes = JSON.parse(readFileSync(path.join(APP_ROOT, 'public/_routes.json'), 'utf8')) as { exclude: string[] };
    expect(routes.exclude).toContain('/theme-boot.js');
  });
});

describe('public/theme-boot.js (no flash of the light theme)', () => {
  const SOURCE = readFileSync(path.join(APP_ROOT, 'public/theme-boot.js'), 'utf8');
  const THEME_TS = readFileSync(path.join(APP_ROOT, 'services/theme.ts'), 'utf8');

  /** Run the script in a fresh page with a given stored value and OS scheme. */
  const run = (stored: string | null | 'throws', osDark = false, matchMediaThrows = false): boolean => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only', url: 'https://dreamstreamstudio.ai/' });
    const win = dom.window as unknown as Window & { eval: (s: string) => unknown };
    Object.defineProperty(win, 'localStorage', {
      configurable: true,
      get: () => {
        if (stored === 'throws') throw new Error('SecurityError');
        return { getItem: (k: string) => (k === 'ds.theme.v1' ? stored : null) };
      }
    });
    (win as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia = (q: string) => {
      if (matchMediaThrows) throw new Error('no matchMedia');
      return { matches: osDark && q === '(prefers-color-scheme: dark)' };
    };
    win.eval(SOURCE);
    return dom.window.document.documentElement.classList.contains('dark');
  };

  it('reads the key and values services/theme.ts writes', () => {
    expect(THEME_TS).toContain("const KEY = 'ds.theme.v1';");
    expect(SOURCE).toContain("getItem('ds.theme.v1')");
    expect(THEME_TS).toMatch(/v === 'dark' \|\| v === 'system' \? v : 'light'/);
  });

  it('sets .dark for a saved dark theme, and for "system" on a dark OS; light otherwise', () => {
    expect(run('dark')).toBe(true);
    expect(run('system', true)).toBe(true);
    expect(run('system', false)).toBe(false);
    expect(run('light', true)).toBe(false);
    expect(run(null, true)).toBe(false);
    expect(run('nonsense')).toBe(false);
  });

  it('never throws: blocked storage or a missing matchMedia leaves the page light', () => {
    expect(run('throws', true)).toBe(false);
    expect(run('system', true, true)).toBe(false);
  });

  it('is plain ES5 for every browser that loads the page (no module syntax, no arrow functions)', () => {
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/=>|\bconst\b|\blet\b|\bimport\b|\bexport\b/);
  });
});

describe('index.tsx boots the skin and the theme at the app root', () => {
  it('runs bootDsSkin, then initTheme, before React renders (dark applies on every page, not only in Chat and Comic Studio)', () => {
    const src = readFileSync(path.join(APP_ROOT, 'index.tsx'), 'utf8');
    const boot = src.indexOf('bootDsSkin({ document });');
    const theme = src.indexOf('initTheme();');
    const render = src.indexOf('root.render(');
    expect(boot).toBeGreaterThan(0);
    expect(theme).toBeGreaterThan(boot);
    expect(render).toBeGreaterThan(theme);
  });
});
