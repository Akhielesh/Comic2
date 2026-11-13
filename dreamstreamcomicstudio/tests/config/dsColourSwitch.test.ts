// @vitest-environment node
/**
 * The colour layer's one switch (CL-6; docs/design/design-system.md § Colour layer, docs/infrastructure/ENV_MATRIX.md).
 *
 * VITE_DS_COLOUR is read at build time. Exactly `off` marks the <html> start tag of every HTML entry with
 * data-ds-colour="off" (vite.config.ts dsColourPlugin; no file-name filter, so the site, live.html and the QA harness
 * all roll back together), and ONE block in index.css then points every name the layer added back to neutral: tints
 * transparent, hue text the muted ink, solids the strong well under ink, the ramps the ink steps, no washes, no studio
 * accent, the comic's tint the plain card. That block outranks every token block by specificity on <html> and on
 * every element that restates the tokens (a nested skin root, a .dark subtree, a studio, an art scope), so it holds
 * wherever the tokens are declared. Every other value, or none, leaves the pages untouched. Turning it off (or on
 * again) is a rebuild and a redeploy; no component changes.
 *
 * The build MARKS the pages off rather than stripping an "on" attribute, so a page that carries no attribute
 * (live.html, the QA harness) still shows the colour the release ships, and the rollback reaches every entry the
 * build writes.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import viteConfig, { DS_COLOUR_OFF_ATTR, DS_COLOUR_VAR, dsColourOn, dsColourPlugin, dsColourWarning, markDsColourOff } from '../../vite.config';
import * as design from '../../components/chat/studioDesign';
import { APP_ROOT, compareSpecificity, indexCss, luminance, over, parseRules, ratio, resolveColor, type Rgba, specificity, tokenBlocks, tokensOf, topLevelSplit } from './cssTokens';

const INDEX_HTML = readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8');
const LIVE_HTML = readFileSync(path.join(APP_ROOT, 'live.html'), 'utf8');
const QA_HTML = readFileSync(path.join(APP_ROOT, 'qa/comic-qa.html'), 'utf8');
const htmlTag = (html: string) => html.match(/<html\b[^>]*>/i)?.[0] ?? '';
type Handler = (html: string, ctx: { path: string; filename: string }) => string;
const handlerOf = (value: string | undefined): Handler => {
  const hook = dsColourPlugin(value).transformIndexHtml as { order: string; handler: Handler };
  expect(hook.order).toBe('pre');
  return hook.handler;
};

/** Every name the colour layer added (the same list tokenContrast.test.ts measures). */
const NEW_TOKENS = [
  '--ds-hue-6', '--ds-hue-7',
  ...[1, 2, 3, 4, 5, 6, 7].map((n) => `--ds-hue-${n}-text`),
  ...[1, 2, 3, 4, 5, 6, 7].map((n) => `--ds-hue-${n}-soft`),
  ...[1, 2, 3, 4, 5, 6, 7].map((n) => `--ds-hue-${n}-solid`),
  '--ds-on-hue',
  ...[1, 2, 3, 4, 5, 6].map((n) => `--ds-chart-seq-${n}`),
  ...[1, 2, 3, 4, 5, 6, 7].map((n) => `--ds-chart-div-${n}`),
  '--ds-wash-hero', '--ds-wash-empty', '--ds-studio', '--ds-studio-soft', '--ds-art-soft', '--ds-art-edge'
];

const rules = parseRules(indexCss);
const { ROOT_TOKENS, DARK_TOKENS, ATLAS_LIGHT, ATLAS_DARK } = tokenBlocks(rules);
const OFF = 'html:root[data-ds-colour="off"]';
const OFF_SELECTOR = [OFF, `${OFF} .dark`, `${OFF} [data-ds-skin]`, `${OFF} [data-ds-studio]`].join(', ');
const offRules = () => rules.filter((r) => /data-ds-colour/.test(r.selector));
const OFF_TOKENS = tokensOf(rules, (s) => s === OFF_SELECTOR);
const OFF_ART = tokensOf(rules, (s) => s === `${OFF} .ds-art-scope`);

/** The four token contexts, with the off block layered on top (it wins: see the specificity test). */
const CONTEXTS: Record<string, Array<Map<string, string>>> = {
  'default light': [ROOT_TOKENS],
  'default dark': [DARK_TOKENS, ROOT_TOKENS],
  'atlas light': [ATLAS_LIGHT, ROOT_TOKENS],
  'atlas dark': [ATLAS_DARK, ATLAS_LIGHT, DARK_TOKENS, ROOT_TOKENS]
};
function resolverOf(blocks: Array<Map<string, string>>) {
  const lookup = (n: string) => {
    for (const b of blocks) if (b.has(n)) return b.get(n)!;
    throw new Error(`dsColourSwitch: ${n} is not defined`);
  };
  return { lookup, color: (n: string) => resolveColor(lookup(n), lookup, [n]) };
}
const same = (a: Rgba, b: Rgba) => [a.r - b.r, a.g - b.g, a.b - b.b, a.a - b.a].every((d) => Math.abs(d) < 0.5);
const grey = (c: Rgba) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) <= 1;

describe('the build switch (vite.config.ts dsColourPlugin)', () => {
  it('colour is on for every value but exactly `off` (the default is on)', () => {
    for (const v of [undefined, '', 'on', 'true', '1', 'OFF', 'Off', ' off', 'off ']) expect(dsColourOn(v), String(v)).toBe(true);
    expect(dsColourOn('off')).toBe(false);
    expect(DS_COLOUR_VAR).toBe('VITE_DS_COLOUR');
    expect(DS_COLOUR_OFF_ATTR).toBe('data-ds-colour="off"');
  });

  it('off marks only the <html> start tag (any earlier data-ds-colour replaced); the rest of the page is byte for byte the same', () => {
    const off = markDsColourOff(INDEX_HTML);
    expect(htmlTag(off)).toBe('<html data-ds-colour="off" lang="en" data-ds-skin="atlas">');
    expect(off).toBe(INDEX_HTML.replace('<html lang="en" data-ds-skin="atlas">', '<html data-ds-colour="off" lang="en" data-ds-skin="atlas">'));
    expect(new JSDOM(off).window.document.documentElement.getAttribute('data-ds-colour')).toBe('off');
    for (const [input, out] of [
      ['<html>', '<html data-ds-colour="off">'],
      ['<HTML lang="en">', '<HTML data-ds-colour="off" lang="en">'],
      ['<html data-ds-colour="on" lang=en>', '<html data-ds-colour="off" lang=en>'],
      ["<html lang='en' data-ds-colour='x' class=a>", '<html data-ds-colour="off" lang=\'en\' class=a>'],
      ['<html lang="en" data-ds-colourful="1">', '<html data-ds-colour="off" lang="en" data-ds-colourful="1">']
    ]) expect(markDsColourOff(input), input).toBe(out);
    // Idempotent: a second pass changes nothing.
    expect(markDsColourOff(off)).toBe(off);
  });

  it('applies to EVERY HTML entry (no file-name filter); with the switch on, every page is returned unchanged', () => {
    const offHandler = handlerOf('off');
    for (const [html, file] of [[INDEX_HTML, 'index.html'], [LIVE_HTML, 'live.html'], [QA_HTML, 'qa/comic-qa.html']] as const) {
      expect(htmlTag(offHandler(html, { path: `/${file}`, filename: path.join(APP_ROOT, file) })), file).toContain('data-ds-colour="off"');
      for (const v of [undefined, 'on', 'OFF']) expect(handlerOf(v)(html, { path: `/${file}`, filename: file }), `${file} ${v}`).toBe(html);
    }
    // No source page carries the attribute: colour is on wherever the build did not switch it off.
    for (const html of [INDEX_HTML, LIVE_HTML, QA_HTML]) expect(htmlTag(html)).not.toContain('data-ds-colour');
  });

  it('warns in the build log for a value that looks like "off" but is not exactly `off` (colour stays on)', () => {
    const warnings = (value: string | undefined) => {
      const warn = vi.fn();
      (dsColourPlugin(value).configResolved as (c: { logger: { warn: (m: string) => void } }) => void)({ logger: { warn } });
      return warn.mock.calls.map((c) => String(c[0]));
    };
    for (const v of ['OFF', ' off', 'false', '0', 'no', 'Disabled']) {
      expect(warnings(v), v).toEqual([`VITE_DS_COLOUR="${v}" keeps the colour layer: only the exact value "off" turns it off`]);
    }
    for (const v of [undefined, 'off', '', 'on']) {
      expect(warnings(v), String(v)).toEqual([]);
      expect(dsColourWarning(v)).toBeNull();
    }
  });

  it('is wired into the build: the config reads VITE_DS_COLOUR', () => {
    const build = (value: string | undefined) => {
      const before = process.env[DS_COLOUR_VAR];
      if (value === undefined) delete process.env[DS_COLOUR_VAR];
      else process.env[DS_COLOUR_VAR] = value;
      try {
        const config = (viteConfig as unknown as (env: { mode: string; command: string }) => { plugins: Array<{ name?: string; transformIndexHtml?: { handler: Handler } }> })({ mode: 'production', command: 'build' });
        return config.plugins.flat().find((p) => p?.name === 'ds-colour');
      } finally {
        if (before === undefined) delete process.env[DS_COLOUR_VAR];
        else process.env[DS_COLOUR_VAR] = before;
      }
    };
    expect(htmlTag(build('off')!.transformIndexHtml!.handler(INDEX_HTML, { path: '/index.html', filename: 'index.html' }))).toContain('data-ds-colour="off"');
    expect(build(undefined)!.transformIndexHtml!.handler(INDEX_HTML, { path: '/index.html', filename: 'index.html' })).toBe(INDEX_HTML);
  });

  it('is wired into the build through the mode .env file too (a .env.production line, not only the process environment)', () => {
    // vite.config.ts reads loadEnv(mode, '.') first; a probe mode keeps the real .env files out of it. Git ignores .env.*.
    const mode = `dscolourprobe${process.pid}`;
    const file = path.join(process.cwd(), `.env.${mode}`);
    const before = process.env[DS_COLOUR_VAR];
    delete process.env[DS_COLOUR_VAR];
    writeFileSync(file, `${DS_COLOUR_VAR}=off\n`);
    try {
      const config = (viteConfig as unknown as (env: { mode: string; command: string }) => { plugins: Array<{ name?: string; transformIndexHtml?: { handler: Handler } }> })({ mode, command: 'build' });
      const plugin = config.plugins.flat().find((p) => p?.name === 'ds-colour')!;
      expect(htmlTag(plugin.transformIndexHtml!.handler(INDEX_HTML, { path: '/index.html', filename: 'index.html' }))).toContain('data-ds-colour="off"');
    } finally {
      rmSync(file, { force: true });
      if (before !== undefined) process.env[DS_COLOUR_VAR] = before;
    }
  });
});

describe('the one neutral block in index.css', () => {
  it('is one block (plus the art scope rule) and names exactly the layer’s new tokens, nothing older', () => {
    expect(offRules().map((r) => r.selector)).toEqual([OFF_SELECTOR, `${OFF} .ds-art-scope`]);
    expect(offRules().every((r) => r.parents.length === 0)).toBe(true);
    expect([...OFF_TOKENS.keys()]).toEqual(NEW_TOKENS);
    expect([...OFF_ART.keys()].sort()).toEqual(['--ds-art-edge', '--ds-art-glow', '--ds-art-soft']);
    // Every new token is in every token block (so the list here is the layer's whole contract) …
    for (const block of [ROOT_TOKENS, DARK_TOKENS, ATLAS_LIGHT, ATLAS_DARK]) expect(NEW_TOKENS.filter((t) => !block.has(t))).toEqual([]);
    // … and the older names keep their values when colour is off: hues 1-5, the spark, the ink chart steps, the art input.
    for (const old of ['--ds-hue-1', '--ds-hue-5', '--ds-spark', '--ds-chart-1', '--ds-art']) expect(OFF_TOKENS.has(old), old).toBe(false);
  });

  it('outranks every rule that declares a colour-layer token, on <html> and on every nested element that restates them', () => {
    const offSpecs = offRules().flatMap((r) => topLevelSplit(r.selector)).map(specificity);
    const htmlOff = specificity(OFF);
    const nestedOff = offSpecs.filter((s) => compareSpecificity(s, htmlOff) > 0);
    const weakestNested = nestedOff.sort(compareSpecificity)[0];
    const declaring = rules.filter((r) => !/data-ds-colour/.test(r.selector) && NEW_TOKENS.concat(['--ds-art-glow']).some((t) => r.body.includes(`${t}:`)));
    expect(declaring.length).toBeGreaterThanOrEqual(10);
    for (const r of declaring) {
      for (const item of topLevelSplit(r.selector)) {
        // A rule that can match <html> itself loses to the html rule; a rule on an inner element loses to the nested ones.
        const beats = compareSpecificity(htmlOff, specificity(item)) > 0 && compareSpecificity(weakestNested, specificity(item)) > 0;
        expect(beats, `${item} ${JSON.stringify(specificity(item))} vs ${JSON.stringify(htmlOff)} / ${JSON.stringify(weakestNested)}`).toBe(true);
      }
    }
  });

  for (const [name, blocks] of Object.entries(CONTEXTS)) {
    it(`${name}: with colour off every new token resolves to neutral`, () => {
      const on = resolverOf(blocks);
      const off = resolverOf([OFF_TOKENS, ...blocks]);
      const canvas = on.color('--ds-canvas');
      for (const n of design.HUE_SLOTS) {
        expect(same(off.color(`--ds-hue-${n}-text`), on.color('--ds-muted')), `hue-${n}-text is the muted ink`).toBe(true);
        expect(off.color(`--ds-hue-${n}-soft`).a, `hue-${n}-soft is transparent`).toBe(0);
        expect(same(off.color(`--ds-hue-${n}-solid`), on.color('--ds-well-strong')), `hue-${n}-solid is the strong well`).toBe(true);
      }
      expect(same(off.color('--ds-on-hue'), on.color('--ds-ink'))).toBe(true);
      for (const t of ['--ds-hue-6', '--ds-hue-7', ...[1, 2, 3, 4, 5, 6].map((n) => `--ds-chart-seq-${n}`), ...[1, 2, 3, 4, 5, 6, 7].map((n) => `--ds-chart-div-${n}`)]) {
        expect(grey(over(off.color(t), canvas)), `${t} is grey`).toBe(true);
      }
      expect(off.lookup('--ds-wash-hero')).toBe('none');
      expect(off.lookup('--ds-wash-empty')).toBe('none');
      expect(same(off.color('--ds-studio'), on.color('--ds-ink'))).toBe(true);
      expect(same(off.color('--ds-studio-soft'), on.color('--ds-well-strong'))).toBe(true);
      expect(same(off.color('--ds-art-soft'), on.color('--ds-raised'))).toBe(true);
      // With colour ON the same tokens are colour: a mutation that left them neutral would pass the block above.
      expect(grey(over(on.color('--ds-hue-6'), canvas))).toBe(false);
      expect(on.color('--ds-hue-2-soft').a).toBe(1);
      expect(on.lookup('--ds-wash-hero')).toMatch(/radial-gradient/);
    });
  }

  for (const [name, blocks] of Object.entries(CONTEXTS)) {
    it(`${name}: with colour off a chart still tells its series and its steps apart (no two series, ramp steps or diverging poles the same grey)`, () => {
      const off = resolverOf([OFF_TOKENS, ...blocks]);
      const canvas = off.color('--ds-canvas');
      const tokenOf = (cls: string) => /var\((--ds-[\w-]+)\)/.exec(cls)![1];
      const seen = (t: string) => over(off.color(t), canvas);
      const apart = (a: string, b: string) => ratio(seen(a), seen(b)) >= 1.1;
      // The first four series in CHART_HUE_ORDER (two keep their hue, hues 6 and 7 go grey): pairwise apart.
      const series = [0, 1, 2, 3].map((i) => tokenOf(design.chartHue('fill', i)!));
      const distance = (a: Rgba, b: Rgba) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
      for (let a = 0; a < series.length; a++) {
        for (let b = a + 1; b < series.length; b++) expect(distance(seen(series[a]), seen(series[b])), `${series[a]} vs ${series[b]}`).toBeGreaterThanOrEqual(40);
      }
      expect(apart('--ds-hue-6', '--ds-hue-7'), 'hue-6 vs hue-7').toBe(true);
      // Both ramps become one ordered grey ramp: every neighbour a visible step, each way monotonic, the poles apart.
      for (const [prefix, n] of [['--ds-chart-seq-', 6], ['--ds-chart-div-', 7]] as const) {
        const steps = Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
        const lum = steps.map((t) => luminance(seen(t)));
        const rising = lum[n - 1] > lum[0];
        for (let i = 1; i < n; i++) {
          expect(apart(steps[i - 1], steps[i]), `${steps[i - 1]} vs ${steps[i]}`).toBe(true);
          expect(lum[i] > lum[i - 1], `${steps[i]} keeps the order`).toBe(rising);
        }
      }
      expect(apart('--ds-chart-div-1', '--ds-chart-div-7'), 'the diverging poles').toBe(true);
    });
  }

  it('the art scope goes back to the plain card when colour is off', () => {
    expect(OFF_ART.get('--ds-art-soft')).toBe('var(--ds-raised)');
    expect(OFF_ART.get('--ds-art-edge')).toBe('var(--ds-hairline)');
    expect(OFF_ART.get('--ds-art-glow')).toBe('transparent');
  });

  it('no component change is needed: every colour recipe reads only tokens, and every token it reads is either new (turned off here) or older and unchanged', () => {
    const recipes = [
      ...design.HUE_MARK.dot, ...design.HUE_MARK.fill, ...design.HUE_MARK.stroke, ...design.HUE_TEXT, ...design.HUE_SOFT_BG, ...design.HUE_SOLID,
      ...design.CHART_SEQ_FILL, ...design.CHART_SEQ_BG, ...design.CHART_DIV_FILL, ...design.CHART_DIV_BG,
      design.WASH_HERO, design.WASH_EMPTY, design.ART_SOFT_BG, design.ART_EDGE, design.STUDIO_SOFT_BG, design.STUDIO_MARK, design.hueChip(3), design.chartHue('fill', 2)!
    ];
    for (const r of recipes) {
      expect(r, r).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|oklch\(/i);
      for (const [, t] of r.matchAll(/var\((--ds-[\w-]+)\)/g)) expect(NEW_TOKENS.includes(t) || ROOT_TOKENS.has(t), `${r} reads ${t}`).toBe(true);
    }
    // The new hues 6 and 7 as marks go grey with the switch (the chart order's third and fourth series).
    expect(design.chartHue('fill', 2)).toBe('fill-[var(--ds-hue-6)]');
  });
});
