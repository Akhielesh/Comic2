// Self-tests for the harness itself (P1-QA): every assertion must be able to FAIL. Synthetic pages
// seed one defect per check and the scanner has to report it (and nothing on a clean page); the
// allowlist must be valid, scoped and owner-tagged. Runs in the `harness-selftest` project only.

import { expect, test } from '@playwright/test';
import { scanLayout } from './helpers/layoutAsserts';
import { loadAllowlist, triage, validateAllowlist, type Allowlist, type Finding } from './helpers/allowlist';

const BASE_CSS = `<style>*{box-sizing:border-box} body{margin:0;font:16px/1.4 sans-serif} button{font:inherit}</style>`;
const page = (body: string) => `<!doctype html><html><head><meta name="viewport" content="width=device-width">${BASE_CSS}</head><body>${body}</body></html>`;
const checksOf = (fs: Finding[]) => [...new Set(fs.map((f) => f.check))].sort();

test.describe('layout scanner', () => {
  test('a clean page has no findings', async ({ page: p }) => {
    await p.setContent(
      page(`<main><nav aria-label="x" data-tabbar><button style="width:48px;height:48px">A</button></nav>
        <p style="width:300px">Short calm text.</p><button style="width:120px;height:48px;margin:8px">Save</button></main>`)
    );
    const f = await scanLayout(p, { checks: ['overflow', 'offscreen', 'clip', 'self-clip', 'spill', 'collision', 'popover', 'landmarks', 'hit-target', 'hover-only'] });
    expect(f.map((x) => `${x.check}:${x.sig}:${x.detail}`)).toEqual([]);
  });

  test('page overflow and offscreen elements', async ({ page: p }) => {
    await p.setContent(page(`<main><div style="width:1400px;height:20px;background:#ccc">wide</div></main>`));
    const f = await scanLayout(p, { checks: ['overflow', 'offscreen'] });
    expect(checksOf(f)).toEqual(['offscreen', 'overflow']);
  });

  test('horizontal scrollers are allowed (internal scrolling)', async ({ page: p }) => {
    await p.setContent(page(`<main><div style="overflow-x:auto;width:300px"><div style="width:1400px">chips chips chips</div></div></main>`));
    expect(await scanLayout(p, { checks: ['overflow', 'offscreen'] })).toEqual([]);
  });

  test('clipping by a hidden ancestor, but not with an ellipsis or a line clamp', async ({ page: p }) => {
    await p.setContent(
      page(`<main>
        <div style="overflow:hidden;width:100px;height:40px"><span style="display:inline-block;width:300px">clipped text that runs off</span></div>
        <div style="overflow:hidden;width:100px"><span style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">ellipsis text that is long</span></div>
        <div style="overflow:hidden;width:100px;height:40px"><p style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:0">clamped text clamped text clamped text clamped text</p></div>
      </main>`)
    );
    const f = await scanLayout(p, { checks: ['clip', 'self-clip'] });
    expect(f.filter((x) => x.check === 'clip').map((x) => x.label)).toEqual(['clipped text that runs off']);
    expect(f.filter((x) => x.check === 'self-clip')).toEqual([]);
  });

  test('spill of an unbroken word and a clipped input', async ({ page: p }) => {
    await p.setContent(
      page(`<main><p style="width:120px">Supercalifragilisticexpialidociouslylongunbrokenword</p>
        <input aria-label="Title" style="width:80px" value="A very long title that cannot fit in this field">
        <input aria-label="Ok" style="width:80px;text-overflow:ellipsis" value="A very long title that cannot fit">
        <textarea aria-label="Notes" style="height:30px;overflow:hidden">line one\nline two\nline three\nline four</textarea></main>`)
    );
    const f = await scanLayout(p, { checks: ['spill', 'input-clip', 'textarea-clip'] });
    expect(checksOf(f)).toEqual(['input-clip', 'spill', 'textarea-clip']);
    expect(f.find((x) => x.check === 'input-clip')?.label).toMatch(/Title/);
  });

  test('visible text collisions, but not popovers over content', async ({ page: p }) => {
    await p.setContent(
      page(`<main style="position:relative;height:300px">
        <span style="position:absolute;left:10px;top:10px">Overlapping label one</span>
        <span style="position:absolute;left:30px;top:14px">Overlapping label two</span>
        <span style="position:absolute;left:10px;top:200px">Under the menu</span>
        <div role="menu" style="position:absolute;left:0;top:190px;background:#fff;padding:8px"><span>Menu item text</span></div>
      </main>`)
    );
    const f = await scanLayout(p, { checks: ['collision'] });
    expect(f).toHaveLength(1);
    expect(f[0].label).toBe('Overlapping label one <> Overlapping label two');
  });

  test('hit-area pseudo-elements are not text spill', async ({ page: p }) => {
    await p.setContent(page(`<style>.tap-target{position:relative}.tap-target::after{content:"";position:absolute;left:50%;top:50%;width:44px;height:44px;transform:translate(-50%,-50%)}</style><main><button class="tap-target" style="font-size:12px">1</button></main>`));
    expect(await scanLayout(p, { checks: ['spill'] })).toEqual([]);
  });

  test('a listbox scrolled inside a strip is not an offscreen popover', async ({ page: p }) => {
    await p.setContent(page(`<main><div style="overflow-x:auto;width:300px"><div role="listbox" aria-label="Timeline" style="width:2000px;display:flex">pages</div></div></main>`));
    expect(await scanLayout(p, { checks: ['popover'] })).toEqual([]);
  });

  test('popovers outside the viewport', async ({ page: p }) => {
    await p.setContent(page(`<main><div role="dialog" aria-label="Spend" style="position:fixed;left:700px;top:10px;width:300px;height:80px;background:#eee">Spend</div></main>`));
    const f = await scanLayout(p, { checks: ['popover'] });
    expect(f.map((x) => x.check)).toEqual(['popover']);
  });

  test('balloons outside the page and colliding', async ({ page: p }) => {
    await p.setContent(
      page(`<main><div data-testid="comic-page" data-page-id="pg_1" style="position:relative;width:300px;height:400px;margin:40px;overflow:visible;background:#fafafa">
        <svg width="300" height="400" style="position:absolute;inset:0;overflow:visible">
          <g data-testid="balloon" data-line-id="l1" class="ds-lettering-balloon"><rect x="-30" y="10" width="120" height="50"/></g>
          <g data-testid="balloon" data-line-id="l2" class="ds-lettering-balloon"><rect x="100" y="200" width="120" height="60"/></g>
          <g data-testid="balloon" data-line-id="l3" class="ds-lettering-balloon"><rect x="120" y="210" width="120" height="60"/></g>
        </svg></div></main>`)
    );
    const f = await scanLayout(p, { checks: ['balloon-outside', 'balloon-collision'] });
    expect(f.filter((x) => x.check === 'balloon-outside').map((x) => x.label)).toEqual(['l1']);
    expect(f.filter((x) => x.check === 'balloon-collision').map((x) => x.label)).toEqual(['l2 × l3']);
  });

  test('editor aside past its dialog', async ({ page: p }) => {
    await p.setContent(page(`<main><div role="dialog" style="position:fixed;left:0;top:0;width:600px;height:400px;overflow:hidden;display:flex"><div style="flex:none;width:400px"></div><aside aria-label="Page tools" style="flex:none;width:400px">Tools</aside></div></main>`));
    const f = await scanLayout(p, { checks: ['editor-aside'] });
    expect(f.map((x) => x.check)).toContain('editor-aside');
  });

  test('44 px hit targets: small targets and stolen corners fail, ::after expansion passes', async ({ page: p }) => {
    await p.setContent(
      page(`<style>.tap{position:relative}.tap::after{content:"";position:absolute;inset:-10px}</style><main style="padding:40px">
        <button aria-label="Tiny" style="width:24px;height:24px;margin:30px">x</button>
        <button aria-label="Expanded" class="tap" style="width:28px;height:28px;margin:30px;border:0">y</button>
        <button aria-label="Round" style="width:44px;height:44px;border-radius:50%;margin:30px;border:0">o</button>
        <div style="position:relative;margin:30px"><button aria-label="Big" style="width:60px;height:60px">z</button><span style="position:absolute;left:44px;top:0;width:20px;height:20px;background:red;display:block">!</span></div>
      </main>`)
    );
    const f = await scanLayout(p, { checks: ['hit-target'] });
    expect(f.map((x) => x.label).sort()).toEqual(['Big', 'Tiny']);
  });

  test('floating chrome over a target is layering, a neighbour in the flow is not', async ({ page: p }) => {
    await p.setContent(
      page(`<main style="padding:40px;position:relative">
        <button aria-label="Tile" style="width:60px;height:60px;display:block;margin:0">tile</button>
        <div style="position:absolute;left:40px;top:40px;width:200px;pointer-events:none"><button aria-label="Jump" style="pointer-events:auto;width:60px;height:24px;margin-left:20px;margin-top:2px">j</button></div>
        <div style="margin-top:20px"><button aria-label="Left" style="width:44px;height:44px;margin:0">l</button><button aria-label="Overlap" style="width:44px;height:44px;margin-left:-6px;position:relative">o</button></div>
      </main>`)
    );
    const f = await scanLayout(p, { checks: ['hit-target'] });
    // Tile: a probe lands on the floating pill (ignored). Jump: genuinely small. Left: its neighbour overlaps it.
    expect(f.map((x) => x.label).sort()).toEqual(['Jump', 'Left']);
  });

  test('hover-only controls on touch', async ({ page: p }) => {
    await p.setContent(page(`<main><div style="opacity:0.2"><button aria-label="Delete">del</button></div><div style="opacity:0;pointer-events:none"><button aria-label="Hidden">h</button></div></main>`));
    const f = await scanLayout(p, { checks: ['hover-only'] });
    expect(f.map((x) => x.label)).toEqual(['Delete']);
  });

  test('safe areas and the hinge', async ({ page: p }) => {
    await p.setContent(page(`<main><button aria-label="Top" style="position:fixed;top:4px;left:300px;width:48px;height:48px">t</button><button aria-label="Fold" style="position:fixed;top:200px;left:380px;width:48px;height:48px">f</button></main>`));
    const f = await scanLayout(p, { checks: ['safe-area', 'hinge'], safeArea: { top: 40, right: 0, bottom: 0, left: 0 }, hinge: { start: 400, end: 400 } });
    expect(f.map((x) => `${x.check}:${x.label}`).sort()).toEqual(['hinge:Fold', 'safe-area:Top']);
  });

  test('landmarks and the layout class', async ({ page: p }) => {
    await p.setContent(page(`<div class="gesture-root" data-layout="split"><main>a</main><main>b</main><div data-tabbar style="height:50px">tabs</div></div>`));
    const f = await scanLayout(p, { checks: ['landmarks', 'layout-class'], expectLayout: 'single' });
    expect(f.map((x) => x.check).sort()).toEqual(['landmarks', 'landmarks', 'layout-class']);
  });
});

test.describe('allowlist', () => {
  test('allowlist.json is valid, scoped and owner-tagged', () => {
    expect(validateAllowlist(loadAllowlist())).toEqual([]);
  });

  test('triage separates false positives, known failures and new findings', () => {
    const list: Allowlist = {
      version: 1,
      falsePositives: [{ id: 'fp', check: 'collision', owner: 'P1-QA', reason: 'floating pill by design', match: { label: 'Jump' } }],
      knownFailures: [{ id: 'kf', check: 'hit-target', owner: 'P1-SHELL', reason: 'chip row targets are 32 px', projects: ['galaxy-*'], match: { ctx: 'Board' }, removeBy: 'wave3' }],
      knownTestFailures: []
    };
    const w = { project: 'galaxy-s8-360', surface: 'studio', scene: 'chat' };
    const findings: Finding[] = [
      { check: 'collision', sig: 'button', label: 'Jump to latest', ctx: '' },
      { check: 'hit-target', sig: 'button', label: 'Story', ctx: 'Board' },
      { check: 'hit-target', sig: 'button', label: 'Send', ctx: 'Composer' }
    ];
    const t = triage(findings, w, list);
    expect(t.allowed.map((a) => a.entry.id)).toEqual(['fp', 'kf']);
    expect(t.fresh.map((f) => f.label)).toEqual(['Send']);
    expect(triage(findings, { ...w, project: 'pixel-8' }, list).fresh.map((f) => f.label)).toEqual(['Story', 'Send']);
  });

  test('validation rejects unscoped or ownerless known failures', () => {
    const bad: Allowlist = {
      version: 1,
      falsePositives: [],
      knownFailures: [{ id: 'everything', check: 'collision', owner: 'someone', reason: 'x', removeBy: '' } as never],
      knownTestFailures: [{ id: 'everything', test: '(', owner: 'P1-X', reason: 'r', mode: 'maybe' as never }]
    };
    const problems = validateAllowlist(bad).join('\n');
    expect(problems).toMatch(/owner must be a package id/);
    expect(problems).toMatch(/reason is required/);
    expect(problems).toMatch(/removeBy/);
    expect(problems).toMatch(/must be scoped/);
    expect(problems).toMatch(/duplicate id/);
    expect(problems).toMatch(/mode must be/);
    expect(problems).toMatch(/not a valid regex/);
  });
});
