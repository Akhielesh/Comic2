import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { billedLlm, newTextSpendTracker } from './jobs.js';
import { encodeUpload } from './assets.js';
import { fakeBilling, newSession, plannedDoc, scriptedLlm, testContext } from './orchestrator.fakes.js';
import { StudioError } from './types.js';

describe('billing on abandoned text calls', () => {
  it('a cancelled call is billed at an estimate, never released (the upstream request keeps running)', async () => {
    const session = newSession(plannedDoc());
    const billing = fakeBilling();
    const ctx = testContext(session, { billing, llm: scriptedLlm({ writer: [new StudioError('CANCELLED', 'Cancelled.')] }) });
    const tracker = newTextSpendTracker();
    const llm = billedLlm(ctx, { stage: 'plan', operation: 'comic.text.writer', tracker });
    await expect(llm.complete({ role: 'writer', messages: [{ role: 'user', content: 'Plan 10 pages.' }], maxTokens: 16000 })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(billing.released).toHaveLength(0);
    expect(billing.settled).toHaveLength(1);
    expect(billing.settled[0].costUsd).toBeGreaterThan(0);
    expect(tracker).toMatchObject({ calls: 1, estimated: true });
    expect(tracker.usd).toBeGreaterThan(0);
  });

  it('a call that fails before sending (e.g. rate limit) is released', async () => {
    const session = newSession(plannedDoc());
    const billing = fakeBilling();
    const ctx = testContext(session, { billing, llm: scriptedLlm({ writer: [new StudioError('RATE_LIMIT', 'Busy.')] }) });
    const llm = billedLlm(ctx, { stage: 'plan', operation: 'comic.text.writer', tracker: newTextSpendTracker() });
    await expect(llm.complete({ role: 'writer', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(billing.released).toHaveLength(1);
    expect(billing.settled).toHaveLength(0);
  });
});

describe('upload decode limits', () => {
  it('rejects images over the pixel cap before decoding them', async () => {
    // 9000×9000 single-colour PNG: tiny on disk, 81 MP decoded.
    const png = await sharp({ create: { width: 9000, height: 9000, channels: 3, background: '#ffffff' } }).png({ compressionLevel: 9 }).toBuffer();
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
    await expect(encodeUpload(dataUrl)).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 413 });
  });
});
