// a11y.spec.ts (mobile.md §9.2/§10.4): axe-core has no serious/critical violations (color-contrast
// included) on the studio, board, editor, readers and an open sheet; the viewport stays zoomable
// (no maximum-scale / user-scalable=no, WCAG 1.4.4); the 320 px reflow project has no horizontal
// overflow (WCAG 1.4.10); and with Text size XL (html font-size 20px) there is still no overflow and
// targets keep 44 px.

import { test, expect } from './helpers/harness';
import { openSettings } from './helpers/scenes';

test.describe('accessibility', () => {
  test('axe: studio chat and board', async ({ qa }) => {
    await qa.open({ surface: 'studio', fixture: 'heist-12p' });
    await qa.check('studio', 'axe-chat', { checks: ['landmarks'], axe: true });
    await qa.open({ surface: 'studio', fixture: 'heist-12p', tab: 'pages' });
    await qa.toBoard();
    await qa.check('board', 'axe-pages', { checks: ['landmarks'], axe: true });
  });

  test('axe: page editor and settings sheet', async ({ qa }) => {
    await qa.open({ surface: 'editor', fixture: 'heist-12p', page: 1 });
    await qa.check('editor', 'axe-editor', { checks: [], axe: true });
    await qa.open({ surface: 'studio', fixture: 'heist-12p' });
    if (await openSettings(qa)) {
      await qa.settle(500);
      await qa.check('studio', 'axe-settings', { checks: [], axe: true });
    }
  });

  test('axe: immersive and public readers', async ({ qa }) => {
    await qa.open({ surface: 'reader', fixture: 'heist-12p', page: 2 }, { settle: 700 });
    await qa.check('reader', 'axe-reader', { checks: [], axe: true });
    await qa.open({ surface: 'public', fixture: 'heist-12p' }, { settle: 700 });
    await qa.check('public', 'axe-public', { checks: ['landmarks'], axe: true });
  });

  test('the viewport stays zoomable (production and QA entries)', async ({ qa, page, request }) => {
    await qa.open({ surface: 'studio', fixture: 'empty' });
    const qaMeta = await page.locator('meta[name="viewport"]').getAttribute('content');
    const prod = await (await request.get('/index.html')).text();
    const prodMeta = /<meta[^>]+name="viewport"[^>]+content="([^"]+)"/i.exec(prod)?.[1] || '';
    for (const [where, content] of [
      ['qa/comic-qa.html', qaMeta || ''],
      ['index.html', prodMeta]
    ] as const) {
      expect(content, `${where} has a viewport meta`).toContain('width=device-width');
      expect(content, `${where}: no maximum-scale`).not.toMatch(/maximum-scale/i);
      expect(content, `${where}: no user-scalable=no`).not.toMatch(/user-scalable\s*=\s*(no|0)/i);
    }
  });

  test('reflow and Text size XL: no overflow, targets keep 44 px', async ({ qa, page, device }) => {
    await qa.open({ surface: 'studio', fixture: 'heist-12p' });
    await qa.check('studio', 'reflow', { checks: ['overflow', 'offscreen'] });
    await page.addStyleTag({ content: 'html{font-size:20px !important}' });
    await qa.settle(400);
    await qa.check('studio', 'text-xl', { checks: device.coarse ? ['overflow', 'offscreen', 'hit-target'] : ['overflow', 'offscreen'] });
  });
});
