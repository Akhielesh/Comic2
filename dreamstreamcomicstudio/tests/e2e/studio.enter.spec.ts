// studio.enter.spec.ts (mobile.md §10.4; P1-SHELL "composer Enter rule on coarse pointers"):
// type "a", Enter, "b". On coarse pointers (phones, tablets) Enter is a newline and only the button
// sends; on fine pointers (desktop) Enter sends. The QA controller records every send.

import { test, expect } from './helpers/harness';

test('Enter: newline on touch, send on desktop', async ({ qa, device, page }) => {
  await qa.open({ surface: 'studio', fixture: 'heist-12p' });
  await qa.toChat();
  const box = page.getByRole('textbox', { name: /message the comic director/i }).first();
  await box.click();
  await qa.clearOps();
  await page.keyboard.type('a');
  await page.keyboard.press('Enter');
  await page.keyboard.type('b');
  await qa.settle(200);
  const sends = (await qa.ops()).filter((o) => o.kind === 'send');
  if (device.coarse) {
    await expect(box).toHaveValue('a\nb');
    expect(sends, 'Enter must not send on a touch keyboard').toHaveLength(0);
    // The button still sends (the visible composer's own Send: other layouts keep a hidden twin).
    const sendBtn = page.locator('button[aria-label="Send"]:visible').first();
    await expect(sendBtn, 'the composer shows an enabled Send button').toBeEnabled({ timeout: 5_000 });
    await sendBtn.click();
    await qa.settle(200);
    const after = (await qa.ops()).filter((o) => o.kind === 'send');
    expect(after).toHaveLength(1);
    expect((after[0].payload as { text: string }).text).toBe('a\nb');
  } else {
    expect(sends, 'Enter sends on desktop').toHaveLength(1);
    expect((sends[0].payload as { text: string }).text).toBe('a');
  }
});
