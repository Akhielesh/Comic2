// @vitest-environment node
/**
 * Guards the app-shell config owned by P0-E (Comic Studio v5): PWA manifest + icons,
 * index.html head, edge headers and routes, Tailwind screens, the §13.5 CSS
 * tokens/utilities and the pinned new dependencies. These are plain files that no
 * component test loads, so a stray edit would otherwise only show up on a device.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const require = createRequire(import.meta.url);

type ManifestIcon = { src: string; sizes: string; type: string; purpose?: string };
type Manifest = {
  id: string; name: string; short_name: string; start_url: string; scope: string;
  display: string; background_color: string; theme_color: string; description: string;
  icons: ManifestIcon[]; shortcuts?: { name: string; url: string }[];
};

const manifest = JSON.parse(read('public/app.webmanifest')) as Manifest;
const indexHtml = read('index.html');
const head = indexHtml.slice(0, indexHtml.indexOf('</head>'));

describe('public/app.webmanifest', () => {
  it('is a valid installable manifest', () => {
    expect(manifest.id).toBe('/?app=studio');
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.display).toBe('standalone');
    expect(manifest.scope).toBe('/');
    expect(manifest.start_url.startsWith('/')).toBe(true);
    expect(manifest.description).toBeTruthy();
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    for (const s of manifest.shortcuts ?? []) expect(s.url.startsWith('/')).toBe(true);
  });

  it('is a different installed app from the baby-monitor manifest', () => {
    const live = JSON.parse(read('public/live.webmanifest')) as Partial<Manifest>;
    expect(manifest.id).not.toBe(live.id ?? live.start_url);
    expect(manifest.start_url).not.toBe(live.start_url);
  });

  it('theme colour matches the light theme-color meta and the --ds-canvas paper', () => {
    expect(head).toContain(`<meta name="theme-color" content="${manifest.theme_color}" media="(prefers-color-scheme: light)"`);
    expect(read('index.css')).toMatch(new RegExp(`--ds-canvas:\\s*${manifest.theme_color}`, 'i'));
  });

  it('lists 192, 512 and maskable icons that exist at their declared sizes', async () => {
    const need = [
      { sizes: '192x192', purpose: 'any' },
      { sizes: '512x512', purpose: 'any' },
      { sizes: '512x512', purpose: 'maskable' },
    ];
    for (const n of need) {
      expect(manifest.icons.some((i) => i.sizes === n.sizes && (i.purpose ?? 'any').split(' ').includes(n.purpose))).toBe(true);
    }
    for (const icon of manifest.icons) {
      const file = path.join(ROOT, 'public', icon.src);
      expect(existsSync(file), icon.src).toBe(true);
      const meta = await sharp(file).metadata();
      expect(`${meta.width}x${meta.height}`).toBe(icon.sizes);
      expect(meta.format).toBe('png');
      expect(icon.type).toBe('image/png');
    }
  });

  it('maskable and apple-touch icons are full-bleed (no transparent corners)', async () => {
    for (const rel of ['public/icons/app-maskable-512.png', 'public/icons/apple-touch-180.png']) {
      const { data, info } = await sharp(path.join(ROOT, rel)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const alphaAt = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
      expect(alphaAt(0, 0), rel).toBe(255);
      expect(alphaAt(info.width - 1, info.height - 1), rel).toBe(255);
    }
  });
});

describe('index.html head', () => {
  it('links the manifest and an existing 180px apple-touch-icon', async () => {
    expect(head).toContain('<link rel="manifest" href="/app.webmanifest"');
    const m = head.match(/<link rel="apple-touch-icon" href="([^"]+)"/);
    expect(m).toBeTruthy();
    const meta = await sharp(path.join(ROOT, 'public', m![1])).metadata();
    expect(meta.width).toBe(180);
    expect(meta.height).toBe(180);
  });

  it('has exactly two theme-color metas (light + dark) and no unconditioned one', () => {
    const metas: string[] = [...(head.match(/<meta name="theme-color"[^>]*>/g) ?? [])];
    expect(metas).toHaveLength(2);
    expect(metas.some((m) => m.includes('(prefers-color-scheme: light)'))).toBe(true);
    expect(metas.some((m) => m.includes('(prefers-color-scheme: dark)'))).toBe(true);
  });

  it('has a default description of a sensible length', () => {
    const m = head.match(/<meta name="description" content="([^"]+)"/);
    expect(m).toBeTruthy();
    expect(m![1].length).toBeGreaterThan(40);
    expect(m![1].length).toBeLessThanOrEqual(160);
  });

  it('has exactly one <!--ds:head--> injection marker, inside <head>', () => {
    expect(indexHtml.split('<!--ds:head-->').length - 1).toBe(1);
    expect(indexHtml.indexOf('<!--ds:head-->')).toBeLessThan(indexHtml.indexOf('</head>'));
  });

  it('keeps the viewport zoomable and safe-area aware', () => {
    const vp = indexHtml.match(/<meta name="viewport" content="([^"]+)"/)?.[1] ?? '';
    expect(vp).toContain('viewport-fit=cover');
    expect(vp).not.toMatch(/maximum-scale|user-scalable\s*=\s*no/);
  });
});

describe('public/_headers and public/_routes.json', () => {
  const headers = read('public/_headers');
  const block = (pattern: string) => {
    const lines = headers.split('\n');
    const start = lines.findIndex((l) => l === pattern);
    if (start < 0) return '';
    const out: string[] = [];
    for (const l of lines.slice(start + 1)) {
      if (!/^\s+\S/.test(l)) break;
      out.push(l.trim());
    }
    return out.join('\n');
  };

  it('ships the app-wide CSP as REPORT-ONLY with the contract directives', () => {
    const all = block('/*');
    expect(all).toMatch(/^Content-Security-Policy-Report-Only: /m);
    expect(all).not.toMatch(/^Content-Security-Policy: /m);
    const csp = all.match(/^Content-Security-Policy-Report-Only: (.+)$/m)![1];
    for (const d of [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://aistudiocdn.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob: https://*.supabase.co",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
      "worker-src 'self' blob:",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "object-src 'none'",
    ]) expect(csp).toContain(d);
    expect(all).toContain('X-Content-Type-Options: nosniff');
    expect(all).toContain('Referrer-Policy: strict-origin-when-cross-origin');
  });

  it('never lets another site frame the sign-in link pages (a framed "Continue" could be disguised)', () => {
    for (const pattern of ['/auth/callback*', '/live*']) {
      const b = block(pattern);
      expect(b, pattern).toContain('X-Frame-Options: DENY');
      expect(b, pattern).toMatch(/^Content-Security-Policy: frame-ancestors 'none'$/m);
    }
  });

  it('isolates no page cross-origin (Code Studio and its /studio.html were removed)', () => {
    expect(headers).not.toContain('Cross-Origin-Embedder-Policy');
  });

  it('stays inside Cloudflare Pages limits', () => {
    for (const l of headers.split('\n')) expect(l.length).toBeLessThan(2000);
    const routes = JSON.parse(read('public/_routes.json')) as { version: number; include: string[]; exclude: string[] };
    expect(routes.version).toBe(1);
    expect(routes.include.length + routes.exclude.length).toBeLessThanOrEqual(100);
    expect(routes.exclude).toEqual(expect.arrayContaining(['/app.webmanifest', '/icons/*']));
  });
});

describe('tailwind.config.cjs screens', () => {
  const config = require(path.join(ROOT, 'tailwind.config.cjs')) as {
    theme: { screens: Record<string, string | { raw: string }>; extend: { screens?: unknown } };
  };

  it('replaces (not extends) screens, in ascending min-width order', () => {
    expect(config.theme.extend.screens).toBeUndefined();
    const keys = Object.keys(config.theme.screens);
    expect(keys).toEqual([
      'medium', 'sm', 'md', 'expanded', 'lg', 'large', 'xl', '2xl', 'xlarge',
      'compact-h', 'coarse', 'fine', 'can-hover', 'dual', 'standalone',
    ]);
    const widths = keys.map((k) => config.theme.screens[k]).filter((v): v is string => typeof v === 'string').map((v) => parseInt(v, 10));
    expect(widths).toEqual([...widths].sort((a, b) => a - b));
  });

  it('keeps the Tailwind default breakpoints unchanged', () => {
    expect(config.theme.screens).toMatchObject({ sm: '640px', md: '768px', lg: '1024px', xl: '1280px', '2xl': '1536px' });
  });
});

describe('index.css device tokens and utilities (contract §13.5)', () => {
  const css = read('index.css');

  it('defines every token', () => {
    for (const t of [
      '--sa-top', '--sa-right', '--sa-bottom', '--sa-left', '--app-h', '--kb', '--sa-bottom-eff',
      '--tap-min', '--tabbar-h', '--rail-w', '--header-h', '--sheet-radius', '--sheet-grabber',
      '--ds-text-xs', '--ds-text-sm', '--ds-text-base', '--ds-text-lg',
      '--ds-reader-room', '--ds-reader-paper-back', '--ds-reader-endpaper',
    ]) expect(css).toMatch(new RegExp(`${t}:\\s*[^;]+;`));
    expect(css).toMatch(/--ds-reader-room:\s*#0e0d0c;/);
    expect(css).toMatch(/--ds-reader-paper-back:\s*#f3eee4;/);
    expect(css).toMatch(/--ds-reader-endpaper:\s*#efe6d2;/);
    expect(css).toMatch(/--tap-min:\s*44px;/);
    expect(css).toMatch(/html\.kb-open\s*\{\s*--sa-bottom-eff:\s*0px;/);
  });

  it('defines every utility class, with a reduced-motion variant for .press', () => {
    for (const c of ['.tap-target', '.tap-min', '.press', '.no-callout', '.cv-auto', '.gesture-root', '.ds-reader-paper', '.comicstudio-md a']) {
      expect(css.includes(`${c} {`) || css.includes(`${c}::after {`), c).toBe(true);
    }
    expect(css).toMatch(/\.tap-target::after\s*\{[^}]*var\(--tap-min/);
    const reduced = css.split('@media (prefers-reduced-motion: reduce)').slice(1).map((s) => s.slice(0, 200));
    expect(reduced.some((s) => s.includes('.press:active { transform: none; }'))).toBe(true);
  });
});

describe('package.json (P0-E dependencies and scripts)', () => {
  const pkg = JSON.parse(read('package.json')) as {
    scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string>;
  };
  const NEW_DEPS = [
    '@fontsource/comic-neue', '@fontsource/bangers', '@fontsource/patrick-hand', '@fontsource/kalam',
    '@fontsource/shantell-sans', '@fontsource/andika', '@fontsource/atkinson-hyperlegible', '@fontsource/dela-gothic-one',
    '@fontsource/luckiest-guy', '@fontsource/permanent-marker', '@fontsource/special-elite', '@fontsource/ultra',
    'uqr', 'obscenity',
  ];
  const NEW_DEV = ['@playwright/test', '@axe-core/playwright', 'axe-core'];
  const ALLOWED = new Set(['MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'ISC', 'MPL-2.0', 'OFL-1.1']);

  it('pins every new dependency to an exact version', () => {
    for (const d of NEW_DEPS) expect(pkg.dependencies[d], d).toMatch(/^\d+\.\d+\.\d+$/);
    for (const d of NEW_DEV) expect(pkg.devDependencies[d], d).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('installed versions match the pins and carry an allowed licence', () => {
    for (const d of [...NEW_DEPS, ...NEW_DEV]) {
      const installed = JSON.parse(readFileSync(path.join(ROOT, 'node_modules', d, 'package.json'), 'utf8')) as { version: string; license: string };
      expect(installed.version, d).toBe(pkg.dependencies[d] ?? pkg.devDependencies[d]);
      expect(ALLOWED.has(installed.license), `${d}: ${installed.license}`).toBe(true);
    }
  });

  it('has the QA and icon scripts', () => {
    expect(pkg.scripts['qa:build']).toContain('QA_BUILD=1');
    expect(pkg.scripts['qa:build']).toContain('dist-qa');
    for (const s of ['qa:mobile', 'qa:mobile:update', 'test:layout', 'gen:icons']) expect(pkg.scripts[s], s).toBeTruthy();
  });
});
