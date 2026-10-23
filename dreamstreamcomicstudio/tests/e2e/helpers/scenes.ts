// Scene steps shared by the layout smoke (visualqa.md §7) and the device layout spec (mobile.md §10.4).
// Each step drives the REAL UI the way a person would (tabs, sheets, menus, scrolling) and is
// tolerant of controls a layout legitimately hides (phones move header controls into ⋯): a missing
// control is recorded as a `step-skipped` annotation instead of silently passing or failing.

import type { Locator, Page, TestInfo } from '@playwright/test';
import type { QaHarness } from './harness';

export const CONVERSATION = 'section[aria-label="Conversation"]';

/** The scroll container of the message list (the first overflow-y:auto descendant that scrolls). */
export async function markConversationScroller(page: Page): Promise<string | null> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    const all = [root, ...Array.from(root.querySelectorAll('*'))] as HTMLElement[];
    const el = all.find((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4);
    if (!el) return null;
    el.setAttribute('data-qa-scroller', 'conversation');
    return '[data-qa-scroller="conversation"]';
  }, CONVERSATION);
}

/** Click the first visible match; returns false (and annotates) when none is visible. */
export async function clickIfVisible(testInfo: TestInfo, what: string, ...candidates: Locator[]): Promise<boolean> {
  for (const c of candidates) {
    const first = c.first();
    if (await first.isVisible().catch(() => false)) {
      await first.click();
      return true;
    }
  }
  testInfo.annotations.push({ type: 'step-skipped', description: `${what}: no visible control on ${testInfo.project.name}` });
  return false;
}

export async function closeTopLayer(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
}

/** Open the header's ⋯ menu (phones keep quality/spend/settings in it). */
export async function openMoreMenu(qa: QaHarness): Promise<boolean> {
  const p = qa.page;
  return clickIfVisible(qa.testInfo, 'More menu', p.getByRole('button', { name: /^(more|more options|menu)$/i }), p.locator('button[aria-haspopup="menu"]').filter({ has: p.locator('svg') }).last());
}

export async function openSettings(qa: QaHarness): Promise<boolean> {
  const p = qa.page;
  if (!(await openMoreMenu(qa))) return false;
  await qa.settle(300);
  return clickIfVisible(qa.testInfo, 'Settings', p.getByRole('menuitem', { name: /settings/i }), p.getByRole('button', { name: /comic settings|settings/i }));
}

export async function openSpend(qa: QaHarness): Promise<boolean> {
  const p = qa.page;
  return clickIfVisible(qa.testInfo, 'Spend chip', p.getByRole('button', { name: /^spent|spend|\$\d/i }));
}

/**
 * Open the Quality sheet: the header button ("Quality: Standard") on tablets and desktops; on phones
 * it lives in the ⋯ menu (visualqa P0-4 — the phone Quality popover is exactly what broke in v4, so
 * it must be measured there too, not skipped).
 */
export async function openQuality(qa: QaHarness): Promise<boolean> {
  const p = qa.page;
  const header = p.getByRole('button', { name: /^quality:/i }).first();
  if (await header.isVisible().catch(() => false)) {
    await header.click();
    return true;
  }
  if (!(await openMoreMenu(qa))) return false;
  await qa.settle(300);
  return clickIfVisible(qa.testInfo, 'Quality', p.getByRole('menuitem', { name: /^quality/i }));
}

export async function openComposerOptions(qa: QaHarness): Promise<boolean> {
  const p = qa.page;
  return clickIfVisible(qa.testInfo, 'Composer options', p.getByRole('button', { name: /comic options|format/i }));
}

/** Board sub-tabs present right now (tab role inside the Board tablist). */
export async function boardTabs(page: Page): Promise<string[]> {
  return page.locator('[role="tablist"] [role="tab"]').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => (e.textContent || e.getAttribute('aria-label') || '').trim()).filter(Boolean));
}

/** Scroll the editor's tools aside to its end. */
export async function scrollEditorTools(page: Page): Promise<void> {
  await page.evaluate(() => {
    let s: HTMLElement | null = document.querySelector('aside[aria-label="Page tools"]');
    while (s && !(s.scrollHeight > s.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
    if (s) s.scrollTop = s.scrollHeight;
  });
  await page.waitForTimeout(300);
}
