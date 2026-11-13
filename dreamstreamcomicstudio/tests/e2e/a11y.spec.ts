// a11y.spec.ts (mobile.md §9.2/§10.4): axe-core has no serious/critical violations (color-contrast
// included) on the studio, board, editor, readers and an open sheet; the viewport stays zoomable
// (no maximum-scale / user-scalable=no, WCAG 1.4.4); the 320 px reflow project has no horizontal
// overflow (WCAG 1.4.10); and with Text size XL (html font-size 20px) there is still no overflow and
// targets keep 44 px. Account Settings (FX-6): the real app's Settings page has 0 unnamed controls, every field is
// named by its own label (never by its hint), the photo upload is a button, and on a phone the email is not cut and
// the Profile heading is on the first screen.

import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect } from './helpers/harness';
import { openSettings } from './helpers/scenes';

// ── Account Settings (FX-6) ────────────────────────────────────────────────────
// The main app has no QA scene, so this opens the QA build's real index.html (`?view=settings`) signed in with a
// MADE-UP local session: a fake token that exists only in this headless browser. Every request is answered here:
// Supabase reads get one made-up profile row, /api/* gets 503 (no backend), anything else off this origin is
// refused. Nothing leaves the machine and nothing is paid.
// 24 characters: an everyday address. (A field cannot wrap, so a much longer one is still cut at phone widths.)
const SETTINGS_EMAIL = 'reader.one@settings.test';
const SETTINGS_USER = {
  id: '00000000-0000-4000-8000-0000000000f6',
  aud: 'authenticated',
  role: 'authenticated',
  email: SETTINGS_EMAIL,
  email_confirmed_at: '2026-01-01T00:00:00Z',
  app_metadata: { provider: 'email' },
  user_metadata: {},
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z'
};
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

async function openAccountSettings(page: Page, baseURL: string, query = 'view=settings'): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const token = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: SETTINGS_USER.id, aud: 'authenticated', role: 'authenticated', email: SETTINGS_EMAIL, exp: now + 86_400, iat: now })}.local-qa-not-a-signature`;
  const session = { access_token: token, token_type: 'bearer', expires_in: 86_400, expires_at: now + 86_400, refresh_token: 'local-qa', user: SETTINGS_USER };
  const origin = new URL(baseURL).origin;
  await page.route('**/*', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
    if (url.origin === origin && !url.pathname.startsWith('/api/')) return route.continue();
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const single = /vnd\.pgrst\.object/.test(req.headers()['accept'] || '');
    if (url.pathname.startsWith('/auth/v1/user')) return json(200, SETTINGS_USER);
    if (url.pathname.startsWith('/auth/v1/')) return json(200, session);
    if (url.pathname.startsWith('/rest/v1/profiles') && single) return json(200, { id: SETTINGS_USER.id, username: 'settings_reader', avatar_url: null, marketing_consent: false });
    if (url.pathname.startsWith('/rest/v1/profile_private') && req.method() === 'GET') {
      const row = { id: SETTINGS_USER.id, dob: '1990-01-01', first_name: 'Settings', last_name: 'Reader', phone_number: null };
      return json(200, single ? row : [row]);
    }
    if (url.pathname.startsWith('/rest/v1/')) return single ? json(406, { code: 'PGRST116', message: 'no rows' }) : json(200, []);
    if (url.origin === origin) return json(503, { error: { message: 'Local QA: no backend', code: 'UNAVAILABLE' } });
    return route.abort('blockedbyclient');
  });
  await page.addInitScript((s) => {
    try {
      localStorage.setItem('dreamstream_auth_token', JSON.stringify(s));
    } catch {
      /* storage blocked: the page then shows signed out and the test fails on the heading */
    }
  }, session);
  await page.goto(`/?${query}`, { waitUntil: 'domcontentloaded' });
}

/** Visible form fields with no name of their own: no <label for>, no aria-label(ledby). A hint is not a name. */
const unlabelledFields = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select')]
      .filter((el) => el.type !== 'hidden' && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')
      .filter((el) => !(el.labels && [...el.labels].some((l) => l.textContent?.trim())) && !el.getAttribute('aria-label')?.trim() && !el.getAttribute('aria-labelledby'))
      .map((el) => `${el.tagName.toLowerCase()}[type=${el.getAttribute('type') || ''}] placeholder="${el.getAttribute('placeholder') || ''}"`)
  );

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

  test('Account Settings: every control has a name, fields by their label, phones see the email and the first setting', async ({ page, device }, testInfo) => {
    await openAccountSettings(page, testInfo.project.use.baseURL || 'http://127.0.0.1:4179');
    const heading = page.getByRole('heading', { level: 2, name: 'Profile' });
    await expect(heading).toBeVisible({ timeout: 30_000 });

    // Fields are named by their own labels (Username and Phone used to be named by their hints, Email, Date of birth
    // and the invite link had no name at all).
    await expect(page.getByLabel('Email', { exact: true })).toHaveValue(SETTINGS_EMAIL);
    await expect(page.getByLabel(/^Username/)).toHaveValue('settings_reader');
    await expect(page.getByLabel(/^Phone Number$/)).toHaveAttribute('type', 'tel');
    await expect(page.getByLabel(/^Date of Birth/)).toHaveValue('1990-01-01');
    await expect(page.getByLabel('Your invite link')).toBeAttached();
    expect(await unlabelledFields(page), 'every visible field has a label or an aria name').toEqual([]);

    // The photo upload is a real button the keyboard reaches.
    const upload = page.getByRole('button', { name: /profile photo/i });
    await upload.focus();
    await expect(upload).toBeFocused();

    // 0 unnamed controls (axe's naming rules over the whole page).
    const names = await new AxeBuilder({ page })
      .withRules(['button-name', 'link-name', 'label', 'select-name', 'input-button-name', 'aria-command-name', 'aria-input-field-name', 'aria-toggle-field-name'])
      .analyze();
    expect(names.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`)), 'unnamed controls on Settings').toEqual([]);

    // The email is not cut from 360 px up (85 px of it was hidden at 390 when the fields sat beside the photo).
    const vp = page.viewportSize() || device.viewport;
    const email = await page.getByLabel('Email', { exact: true }).evaluate((el: HTMLInputElement) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    if (vp.width >= 360) expect(email.scroll, `the email field shows the whole address at ${vp.width} px (${JSON.stringify(email)})`).toBeLessThanOrEqual(email.client + 1);

    // Below md the section list is one row of chips, so the Profile heading is on the first screen of a phone (it
    // started at y = 695 at 390x844 under the 600 px list), and a deep link scrolls its chip into view.
    if (vp.width < 768) {
      const top = (await heading.boundingBox())?.y ?? Number.POSITIVE_INFINITY;
      expect(top, `the Profile heading starts above y = 400 at ${vp.width}x${vp.height}`).toBeLessThan(400);
      await page.goto('/?view=settings&tab=legal', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { level: 2, name: 'Legal' })).toBeVisible({ timeout: 30_000 });
      const chip = page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Legal' });
      const box = await chip.boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= vp.width + 1, `the Legal chip is scrolled into view (${JSON.stringify(box)})`).toBe(true);
    }
  });
});
