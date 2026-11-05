// studio.keyboard.spec.ts (mobile.md §10.4; P1-SHELL acceptance): with the on-screen keyboard up —
// Android: the layout viewport shrinks by 336 px (resizes-content); iOS: only the visual viewport
// shrinks (stubbed visualViewport) — the composer textarea and Send stay fully visible above the
// keyboard, Send keeps a 44 px target, the header stays at the top with no document scroll, the
// phone tab bar hides, the last message ends above the composer, and a composer sheet opens above
// the keyboard.

import { test, expect } from './helpers/harness';
import { closeKeyboard, openKeyboard } from './helpers/keyboard';

test.describe('composer above the on-screen keyboard', () => {
  test.beforeEach(({ device }) => {
    test.skip(!device.coarse, 'on-screen keyboards are a touch-device concern');
  });

  test('textarea, Send and header stay visible; tab bar hides', async ({ qa, device, page }) => {
    await qa.open({ surface: 'studio', fixture: 'heist-12p' }, { keyboardStub: true });
    await qa.toChat();
    const box = page.getByRole('textbox', { name: /message the comic director/i }).first();
    await expect(box).toBeVisible();
    await box.click();
    await box.fill('Make page 2 moodier and keep the rain');
    const { visibleBottom, mode } = await openKeyboard(page, device);
    test.info().annotations.push({ type: 'keyboard', description: `${mode}, visible bottom ${Math.round(visibleBottom)}px` });

    const rects = await page.evaluate(() => {
      const r = (el: Element | null) => (el ? (({ top, bottom, left, right, width, height }) => ({ top, bottom, left, right, width, height }))(el.getBoundingClientRect()) : null);
      const ta = document.querySelector('textarea[aria-label="Message the Comic Director"]');
      const send = document.querySelector('button[aria-label="Send"]');
      const after = send ? getComputedStyle(send, '::after') : null;
      const header = document.querySelector('header') || document.querySelector('.gesture-root > :not(button)');
      const tabbar = document.querySelector('[data-tabbar]') as HTMLElement | null;
      const dock = document.querySelector('[data-composer-dock]');
      const msgs = Array.from(document.querySelectorAll('section[aria-label="Conversation"] [data-message-id], section[aria-label="Conversation"] article, section[aria-label="Conversation"] li'));
      const lastVisible = msgs.map((m) => m.getBoundingClientRect()).filter((b) => b.height > 0 && b.bottom > 0).pop() || null;
      return {
        ta: r(ta),
        send: r(send),
        sendAfter: after ? { w: parseFloat(after.width) || 0, h: parseFloat(after.height) || 0 } : null,
        header: r(header),
        tabbarShown: !!tabbar && tabbar.offsetParent !== null && getComputedStyle(tabbar).display !== 'none',
        dockTop: dock ? dock.getBoundingClientRect().top : null,
        lastBottom: lastVisible ? lastVisible.bottom : null,
        scrollY: window.scrollY,
        kbOpen: document.documentElement.classList.contains('kb-open')
      };
    });
    expect.soft(rects.ta, 'composer textarea').not.toBeNull();
    expect.soft(rects.send, 'Send button').not.toBeNull();
    if (rects.ta) {
      expect.soft(rects.ta.top, 'textarea top on screen').toBeGreaterThanOrEqual(-1);
      expect.soft(rects.ta.bottom, 'textarea above the keyboard').toBeLessThanOrEqual(visibleBottom + 2);
    }
    if (rects.send) {
      expect.soft(rects.send.bottom, 'Send above the keyboard').toBeLessThanOrEqual(visibleBottom + 2);
      const w = Math.max(rects.send.width, rects.sendAfter?.w || 0);
      const h = Math.max(rects.send.height, rects.sendAfter?.h || 0);
      expect.soft(Math.min(w, h), 'Send hit target ≥ 44').toBeGreaterThanOrEqual(44);
    }
    expect.soft(rects.scrollY, 'no document scroll').toBe(0);
    if (rects.header) expect.soft(rects.header.top, 'header stays at the top').toBeGreaterThanOrEqual(-1);
    if (device.kind === 'phone') {
      expect.soft(rects.kbOpen, 'html.kb-open while the keyboard is up').toBe(true);
      expect.soft(rects.tabbarShown, 'tab bar hides with the keyboard').toBe(false);
    }
    expect.soft(rects.dockTop, 'the composer dock ([data-composer-dock]) is on the page').not.toBeNull();
    if (rects.lastBottom !== null && rects.dockTop !== null) expect.soft(rects.lastBottom, 'last message ends above the composer').toBeLessThanOrEqual(rects.dockTop + 1);

    // A composer sheet opens ABOVE the keyboard.
    const opener = page.getByRole('button', { name: /comic options|add images or a script/i }).first();
    const canOpen = await opener.isVisible().catch(() => false);
    expect.soft(canOpen, 'a composer sheet opener is visible with the keyboard up').toBe(true);
    if (canOpen) {
      await opener.click();
      await qa.settle(400);
      const sheetBottom = await page.evaluate(() => {
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"],[role="menu"]')).filter((d) => (d as HTMLElement).offsetParent !== null || getComputedStyle(d).position === 'fixed');
        const last = dialogs[dialogs.length - 1];
        return last ? last.getBoundingClientRect().bottom : null;
      });
      expect.soft(sheetBottom, 'the composer sheet opened').not.toBeNull();
      if (sheetBottom !== null) expect.soft(sheetBottom, 'composer sheet sits above the keyboard').toBeLessThanOrEqual(visibleBottom + 2);
    }
    await closeKeyboard(page, device);
  });
});
