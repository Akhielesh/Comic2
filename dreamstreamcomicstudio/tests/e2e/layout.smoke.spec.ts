// Layout smoke (visualqa.md §7): the per-PR regression check, a few minutes on Chromium at
// 360×740, 768×1024, 1024×768, 1280×800 and 1440×900 (light), and under the page-level Atlas skin
// (smoke-360x740-atlas) and the OS dark scheme (smoke-1440x900-dark). Runs the stress fixture through the scenes that
// broke in the v4 audit: conversation (top/bottom) with the gate, story, cast, pages, read, the page
// editor (drawn + planned), composer sheets, header sheets, settings and the public reader.
// Asserts: no page overflow / offscreen / popover / spill; no visible collisions; no clipped inputs or
// un-re-measured textareas; balloons inside the page and not colliding; the editor aside inside its
// dialog; the phone board ≥ 45 % of the height; one <main>. Known failures live in allowlist.json.
//
// App scenes (DS-1b; master plan §1.4), `@app`: every scene in qa/app/scenes, discovered at RUNTIME from the
// harness (`?surface=app` publishes window.__QA_APP_SCENES__; no list here), in light and dark, on every project
// that runs this spec — the smoke viewports 360/768/1024/1280/1440 and devices.ts APP_SMOKE_DEVICES:
// smoke-360x740-atlas (page-level Atlas skin), smoke-1440x900-dark (OS dark scheme; dark only), and the app-only
// smoke-320x640 (WCAG reflow), smoke-320x568, smoke-fold5-dual, smoke-852x393 (the redesign plan's M2 matrix,
// devices.ts APP_SCENE_MATRIX) and motion-on (prefers-reduced-motion: no-preference). On phones the page's
// <main> keeps ≥ 45 % of the height (phone-content).
// Each scene and the index: no horizontal overflow (page scroll width, nothing offscreen), exactly one <main>,
// at most one spark fill (Button `create`) in the viewport except on the ds-gallery specimens (CL-0 #5),
// coarse-pointer controls ≥ 44 px where the project emulates touch (on every screen of the page, not only the
// first), no legacy kit class in the rendered DOM, no duplicate id, axe serious/critical triaged against
// allowlist.json (the a11y helper), no console errors, and under reduced motion no animation or transition
// started at all (recorded from the first frame) and none in effect (with motion on, the entrances finish first).
// A scene that crashes fails on its own; the scenes after it are still measured.
//
// Colour budget (CL-6), `@colour`: the share of the interface in strong colour (OKLCH chroma > 0.10)
// on the real screen, every picture hidden, read from tests/e2e/baselines/colourFloors.json: working views (the board,
// the editor, the conversation) stay at or under the 6 % ceiling; each floor (landing 4 %, Library 3 %, empty screens
// 2 %, board 1 %, model picker 1 %) is measured and reported, and FAILS only when its entry says enforce:true.
//
// Pro Edit scenes (PE-SHELL (c)), `@pro`: every scene in qa/pro, discovered at RUNTIME the same way
// (`?surface=pro` publishes window.__QA_PRO_SCENES__), measured with the app scenes' assertions.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type QaHarness, type QaQuery } from './helpers/harness';
import type { ComicDevice } from './devices';
import type { CheckId } from './helpers/allowlist';
import { markConversationScroller, openComposerOptions, openMoreMenu, openQuality, openSettings, openSpend, closeTopLayer, scrollEditorTools } from './helpers/scenes';

const SMOKE_CHECKS: CheckId[] = [
  'overflow',
  'offscreen',
  'popover',
  'spill',
  'collision',
  'input-clip',
  'textarea-clip',
  'balloon-outside',
  'balloon-collision',
  'editor-aside',
  'phone-content',
  'landmarks'
];

const opts = { checks: SMOKE_CHECKS };

test.describe('layout smoke @smoke', () => {
  test('conversation: bottom, top and the open gate', async ({ qa, page }) => {
    await qa.open({ surface: 'studio', fixture: 'stress', state: 'failed-send' });
    await qa.check('studio', 'conversation-bottom', opts);
    const scroller = await markConversationScroller(page);
    if (scroller) {
      await qa.scroll(scroller, 'top');
      await qa.check('studio', 'conversation-top', opts);
    }
    // The stress fixture always carries the open spend gate (qaFixtures: "Draw all twenty pages…").
    const gate = page.getByText(/Draw all twenty pages/i).first();
    await expect(gate, 'the stress fixture shows its open gate').toBeAttached();
    await gate.scrollIntoViewIfNeeded().catch(() => undefined);
    await qa.settle(250);
    await qa.check('studio', 'conversation-gate', opts);
  });

  test('streaming reply', async ({ qa }) => {
    await qa.open({ surface: 'studio', fixture: 'stress', state: 'streaming' });
    await qa.check('studio', 'streaming', opts);
  });

  for (const tab of ['story', 'cast', 'style', 'pages'] as const) {
    test(`board: ${tab}`, async ({ qa }) => {
      await qa.open({ surface: 'studio', fixture: 'stress', tab });
      await qa.toBoard();
      await qa.check('board', `${tab}-top`, opts);
      await qa.scroll('#board-panel', 'bottom');
      await qa.check('board', `${tab}-bottom`, opts);
    });
  }

  test('board: read', async ({ qa }) => {
    await qa.open({ surface: 'studio', fixture: 'stress', tab: 'read' });
    await qa.toBoard();
    await qa.check('board', 'read', opts);
    await qa.scroll('#board-panel', 'bottom');
    await qa.check('board', 'read-bottom', opts);
  });

  test('page editor: drawn page', async ({ qa, page }) => {
    await qa.open({ surface: 'editor', fixture: 'stress', page: 1 });
    await qa.check('editor', 'drawn-open', opts);
    await scrollEditorTools(page);
    await qa.check('editor', 'drawn-tools-bottom', opts);
  });

  // The lettering inspector with a balloon selected, Easy and Pro (visualqa P0-2: the aside left the
  // dialog at 1024 px). QA_SCREENSHOTS=1 also compares the classic-fixture lettering baseline.
  for (const mode of ['easy', 'pro'] as const) {
    test(`page editor: balloon selected (${mode} inspector)`, async ({ qa, page }) => {
      await qa.open({ surface: 'editor', fixture: 'heist-12p', page: 1, mode });
      const balloon = page.locator('[data-testid="balloon-hit"]').first();
      // heist-12p page 1 is lettered: no balloon here is a regression, never a skip.
      await expect(balloon, 'page 1 has an editable balloon').toBeVisible();
      await balloon.focus();
      await qa.settle(350);
      await expect.soft(page.locator('[data-testid="lettering-inspector"]').first(), 'selecting a balloon shows the lettering inspector').toBeVisible();
      await qa.check('editor', `selected-${mode}`, opts);
      await scrollEditorTools(page);
      await qa.check('editor', `selected-${mode}-tools-bottom`, opts);
      if (process.env.QA_SCREENSHOTS === '1' && mode === 'easy') {
        const pageEl = page.locator('[role="dialog"] [data-testid="comic-page"]').first();
        await expect(pageEl).toHaveScreenshot('lettering-heist-p1.png', { maxDiffPixelRatio: 0.01 });
      }
    });
  }

  test('page editor: planned page', async ({ qa, page }) => {
    await qa.open({ surface: 'editor', fixture: 'stress', page: 2 });
    await qa.check('editor', 'planned-open', opts);
    await scrollEditorTools(page);
    await qa.check('editor', 'planned-tools-bottom', opts);
  });

  test('composer sheets', async ({ qa }) => {
    await qa.open({ surface: 'studio', fixture: 'stress' });
    const opened = await openComposerOptions(qa);
    expect.soft(opened, 'the composer options are reachable').toBe(true);
    if (opened) {
      await qa.settle(400);
      await qa.check('studio', 'composer-options', opts);
      await closeTopLayer(qa.page);
    }
  });

  test('header sheets and settings', async ({ qa, page }) => {
    await qa.open({ surface: 'studio', fixture: 'stress', tab: 'pages' });
    // visualqa P0-4 (Quality / Spending popovers off-screen on phones): every sheet must be reached and
    // measured on every viewport — phones reach Quality through ⋯.
    const steps: Array<[string, () => Promise<boolean>, number]> = [
      ['header-quality', () => openQuality(qa), 400],
      ['header-spend', () => openSpend(qa), 400],
      ['header-more', () => openMoreMenu(qa), 400],
      ['settings', () => openSettings(qa), 600]
    ];
    for (const [scene, open, settle] of steps) {
      const opened = await open();
      expect.soft(opened, `${scene} is reachable`).toBe(true);
      if (!opened) continue;
      await qa.settle(settle);
      await qa.check('studio', scene, opts);
      if (scene !== 'settings') await closeTopLayer(page);
    }
  });

  test('public reader', async ({ qa, page }) => {
    await qa.open({ surface: 'public', fixture: 'stress' }, { settle: 800 });
    await qa.check('public', 'default', opts);
    await page.mouse.wheel(0, 20_000);
    await qa.settle(400);
    await qa.check('public', 'bottom', opts);
  });
});

// ── App scenes (DS-1b) ───────────────────────────────────────────────────────

/** The gallery shows every Button variant in every size as specimens, so it alone may hold more than one spark. */
const SPARK_SPECIMENS = new Set(['ds-gallery']);
/** One spark fill per viewport (the colour layer, CL-0 #5) on every app page but the specimen gallery. */
const sparkChecks = (scene: string): CheckId[] => (SPARK_SPECIMENS.has(scene) ? [] : ['one-spark']);
const appChecks = (device: ComicDevice, scene: string): CheckId[] => [
  'overflow',
  'offscreen',
  'landmarks',
  ...sparkChecks(scene),
  ...(device.coarse ? (['hit-target'] as const) : []),
  // M2: on a phone the page's content (its <main>) keeps ≥ 45 % of the height after any chrome.
  ...(device.kind === 'phone' ? (['phone-content'] as const) : [])
];
/** What `phone-content` measures on an app page: its one main landmark. */
const APP_CONTENT = 'main, [role="main"]';

/** Every app-page assertion at the current URL (index or scene). Soft: one run reports every scene's findings. */
const checkAppPage = async (qa: QaHarness, device: ComicDevice, scene: string, theme: 'light' | 'dark', surface: 'app' | 'pro' = 'app'): Promise<void> => {
  const where = `${scene} (${theme}) on ${qa.testInfo.project.name}`;
  if (await qa.prefersReducedMotion()) {
    // No waiting first: under reduced motion nothing may move at all, so an entrance that ignores the preference
    // fails even when it has ended by now (the recorder saw it start).
    expect.soft(await qa.motionStarts(), `${where}: under reduced motion no animation or transition started since the page loaded`).toEqual([]);
    expect.soft(await qa.animations(), `${where}: under reduced motion document.getAnimations() is empty`).toEqual([]);
  } else {
    const left = await qa.settleAnimations();
    if (left.length) qa.testInfo.annotations.push({ type: 'motion-on', description: `${where}: ${left.length} looping animation(s) after the entrances: ${left.map((a) => `${a.name} on ${a.target}`).join('; ')}` });
  }
  // The project's own viewport, not innerWidth: on phones Chromium widens the layout viewport to fit an overflow.
  const widths = await qa.pageWidths();
  expect.soft(widths.scrollWidth, `${where}: no horizontal overflow past the ${device.viewport.width} px viewport (${JSON.stringify(widths)})`).toBeLessThanOrEqual(device.viewport.width + 1);
  expect.soft(await qa.legacyClasses(), `${where}: no legacy kit class (border-black, shadow-comic, font-comic, font-display, brand-*) in the DOM`).toEqual([]);
  // A duplicated id makes <label for> / aria-labelledby name the wrong element; axe files duplicate-id-aria under
  // "incomplete", which the a11y helper does not report.
  expect.soft(await qa.duplicateIds(), `${where}: duplicate ids`).toEqual([]);
  await qa.check(surface, `${scene}-${theme}`, { checks: appChecks(device, scene), axe: true, hinge: null, contentSelector: APP_CONTENT });
  // The 44 px check measures only controls fully on screen: walk the rest of the page too (app scenes scroll the
  // document), and count the sparks in each of those viewports as well.
  if (device.coarse) await qa.eachScrollStep((top) => qa.check(surface, `${scene}-${theme}-y${top}`, { checks: ['hit-target', ...sparkChecks(scene)], hinge: null }));
};

/** One page's open and measurement: a crash or a throw fails that page (soft), and every later scene is still measured. */
const measured = async (qa: QaHarness, label: string, body: () => Promise<void>): Promise<void> => {
  try {
    await body();
  } catch (e) {
    const errors = qa.pageErrors.splice(0);
    expect.soft(`${e instanceof Error ? e.message : String(e)}${errors.length ? ` (page errors: ${errors.join(' | ')})` : ''}`, `${label} opens and is measured`).toBe('');
  }
};

test.describe('app scenes @smoke @app', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`every app scene (${theme})`, async ({ qa, device }) => {
      test.skip(!qa.themes.includes(theme), `this project measures ${qa.themes.join(' and ')} only`);
      await qa.recordMotionStarts();
      // still=0: the motion assertions need the page's real animations (still=1 zeroes every duration).
      await qa.open({ surface: 'app', theme, still: false });
      const { scenes, problems } = await qa.appScenes();
      // A budget per page, so the growing scene list (one per DS package) never outgrows the config's 90 s.
      test.setTimeout(30_000 + 15_000 * (scenes.length + 1));
      expect.soft(problems, 'every qa/app/scenes file keeps the scene contract (qa/app/index.tsx)').toEqual([]);
      expect(scenes.length, 'the harness index lists the app scenes (window.__QA_APP_SCENES__)').toBeGreaterThan(0);
      qa.testInfo.annotations.push({ type: 'app-scenes', description: scenes.map((s) => s.id).join(', ') });
      await test.step(`index (${theme})`, () => measured(qa, `index (${theme})`, () => checkAppPage(qa, device, 'index', theme)));
      for (const { id } of scenes) {
        await test.step(`${id} (${theme})`, () =>
          measured(qa, `${id} (${theme})`, async () => {
            await qa.open({ surface: 'app', scene: id, theme, still: false });
            await expect.soft(qa.page.locator(`[data-qa-app-scene="${id}"]`), `${id} mounts`).toBeAttached();
            await checkAppPage(qa, device, id, theme);
          })
        );
      }
    });
  }
});

// ── Pro Edit scenes (PE-SHELL (c)) ─────────────────────────────────────────────

test.describe('pro scenes @smoke @pro', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`every Pro Edit scene (${theme})`, async ({ qa, device }) => {
      test.skip(!qa.themes.includes(theme), `this project measures ${qa.themes.join(' and ')} only`);
      await qa.recordMotionStarts();
      await qa.open({ surface: 'pro', theme, still: false });
      const scenes = await qa.proScenes();
      test.setTimeout(30_000 + 15_000 * (scenes.length + 1));
      expect(scenes.length, 'the harness index lists the Pro Edit scenes (window.__QA_PRO_SCENES__)').toBeGreaterThan(0);
      qa.testInfo.annotations.push({ type: 'pro-scenes', description: scenes.map((s) => s.id).join(', ') });
      await test.step(`index (${theme})`, () => measured(qa, `pro index (${theme})`, () => checkAppPage(qa, device, 'index', theme, 'pro')));
      for (const { id } of scenes) {
        await test.step(`${id} (${theme})`, () =>
          measured(qa, `${id} (${theme})`, async () => {
            await qa.open({ surface: 'pro', scene: id, theme, still: false });
            await expect.soft(qa.page.locator(`[data-qa-pro-scene="${id}"]`), `${id} mounts`).toBeAttached();
            await checkAppPage(qa, device, id, theme, 'pro');
          })
        );
      }
    });
  }
});

// ── Colour budget (CL-6) ─────────────────────────────────────────

interface ColourScene {
  id: string;
  open: QaQuery;
  /** Measure the board pane (the phone shows the conversation first). */
  board?: boolean;
}
interface ColourFloors {
  chromaMin: number;
  ceiling: { share: number; scenes: ColourScene[] };
  floors: Array<ColourScene & { floor: number; enforce: boolean; switchedOnBy: string }>;
}
const FLOORS: ColourFloors = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'baselines/colourFloors.json'), 'utf8'));

/**
 * What the colour budget hides before it measures: the art is content, not the interface. Pictures, video, canvases
 * and SVG images; comic art drawn in the DOM (anything marked data-comic-art or data-art);
 * and any element painted with an inline background image (a cover or a page drawn as a CSS background).
 */
const ART_HIDDEN_SELECTOR = 'img, picture, video, canvas, svg image, [data-comic-art], [data-art], [style*="background-image"], [style*="url("]';
/**
 * The strong-colour share of the viewport: the art hidden (ART_HIDDEN_SELECTOR), one screenshot, then every second
 * pixel's OKLCH chroma in the page itself (no image library).
 */
async function strongColourShare(qa: QaHarness, chromaMin: number): Promise<number> {
  const page = qa.page;
  const style = await page.addStyleTag({ content: `${ART_HIDDEN_SELECTOR} { visibility: hidden !important; }` });
  await qa.settle(150);
  const shot = (await page.screenshot()).toString('base64');
  await style.evaluate((el) => (el as Element).remove());
  return page.evaluate(
    async ({ b64, min }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
      const lin = (v: number) => {
        const x = v / 255;
        return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      let strong = 0;
      let total = 0;
      for (let y = 0; y < height; y += 2) {
        for (let x = 0; x < width; x += 2) {
          const i = (y * width + x) * 4;
          const [r, g, b] = [lin(data[i]), lin(data[i + 1]), lin(data[i + 2])];
          const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
          const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
          const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
          const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
          const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
          total += 1;
          if (Math.hypot(A, B) > min) strong += 1;
        }
      }
      return total ? strong / total : 0;
    },
    { b64: shot, min: chromaMin }
  );
}

const openColourScene = async (qa: QaHarness, scene: ColourScene, theme: 'light' | 'dark'): Promise<void> => {
  await qa.open({ ...scene.open, theme }, { settle: 600 });
  if (scene.board) await qa.toBoard();
};
const pct = (x: number) => `${(x * 100).toFixed(2)} %`;

test.describe('colour budget @smoke @colour', () => {
  test('the floors file is well formed: five floors, each with its switch-on owner; the ceiling is 6 %', () => {
    expect(FLOORS.ceiling.share).toBe(0.06);
    expect(FLOORS.chromaMin).toBe(0.1);
    expect(FLOORS.floors.map((f) => [f.id, f.floor])).toEqual([['landing', 0.04], ['library', 0.03], ['empty', 0.02], ['board', 0.01], ['model-picker', 0.01]]);
    for (const f of FLOORS.floors) expect(f.switchedOnBy.length, f.id).toBeGreaterThan(5);
  });

  test('the measurement hides the art: the landing draws pages in the DOM, and every one is hidden', async ({ qa }) => {
    await openColourScene(qa, FLOORS.floors.find((f) => f.id === 'landing')!, 'light');
    const art = await qa.page.evaluate((sel) => {
      const drawn = [...document.querySelectorAll('[data-comic-art], [data-art], [style*="background-image"]')];
      return { drawn: drawn.length, missed: drawn.filter((el) => !el.matches(sel)).length };
    }, ART_HIDDEN_SELECTOR);
    expect(art.drawn, 'the landing shows drawn example pages').toBeGreaterThan(0);
    expect(art.missed, 'drawn art the colour budget would count as interface').toBe(0);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`working views stay at or under the ${FLOORS.ceiling.share * 100} % ceiling (${theme})`, async ({ qa }) => {
      test.setTimeout(30_000 + 20_000 * FLOORS.ceiling.scenes.length);
      for (const scene of FLOORS.ceiling.scenes) {
        await openColourScene(qa, scene, theme);
        const share = await strongColourShare(qa, FLOORS.chromaMin);
        qa.testInfo.annotations.push({ type: 'colour-share', description: `${scene.id} (${theme}): ${pct(share)}` });
        expect.soft(share, `${scene.id} (${theme}) strong colour ${pct(share)} > ceiling ${pct(FLOORS.ceiling.share)}`).toBeLessThanOrEqual(FLOORS.ceiling.share);
      }
    });

    test(`the colour floors are measured; an enforced floor fails under its share (${theme})`, async ({ qa }) => {
      test.setTimeout(30_000 + 20_000 * FLOORS.floors.length);
      for (const floor of FLOORS.floors) {
        await openColourScene(qa, floor, theme);
        const share = await strongColourShare(qa, FLOORS.chromaMin);
        qa.testInfo.annotations.push({ type: 'colour-floor', description: `${floor.id} (${theme}): ${pct(share)} against ${pct(floor.floor)}${floor.enforce ? ' (enforced)' : ' (reported)'}` });
        if (floor.enforce) expect.soft(share, `${floor.id} (${theme}) strong colour ${pct(share)} < floor ${pct(floor.floor)}`).toBeGreaterThanOrEqual(floor.floor);
      }
    });
  }
});
