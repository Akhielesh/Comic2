// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { initialFallback, retryDelay, stepFallback, type Fallback, type FallbackEffect, type FallbackInput } from './linkFallback';

/** Feed inputs in order; collect every effect. */
function run(inputs: FallbackInput[], start: Fallback = initialFallback()) {
  let s = start;
  const fx: FallbackEffect[] = [];
  for (const i of inputs) {
    const r = stepFallback(s, i);
    s = r.s;
    fx.push(...r.fx);
  }
  return { s, fx };
}

describe('linkFallback', () => {
  it('falls back to the relay when P2P fails, and schedules a retry', () => {
    const { s, fx } = run([{ t: 'cam', dev: 'crib' }, { t: 'link', state: 'connecting' }, { t: 'link', state: 'failed' }]);
    expect(fx).toEqual([{ t: 'relay_on', dev: 'crib' }, { t: 'retry_in', ms: 30_000 }]);
    expect(s.relay).toBe(true);
    expect(s.retry).toBe(true);
  });

  it('counts one failure per attempt (timer + browser both say failed)', () => {
    const { s, fx } = run([{ t: 'cam', dev: 'crib' }, { t: 'link', state: 'failed' }, { t: 'link', state: 'failed' }]);
    expect(fx.filter((e) => e.t === 'retry_in')).toHaveLength(1);
    expect(s.fails).toBe(1);
  });

  it('a late P2P connect cancels the retry and drops the relay (no teardown of a working call)', () => {
    const { s, fx } = run([{ t: 'cam', dev: 'crib' }, { t: 'link', state: 'failed' }, { t: 'link', state: 'connected' }]);
    expect(fx.slice(2)).toEqual([{ t: 'retry_clear' }, { t: 'relay_off' }]);
    expect(s).toMatchObject({ relay: false, retry: false, fails: 0 });
    // The (cleared) timer firing anyway does nothing.
    expect(stepFallback(s, { t: 'retry' }).fx).toEqual([]);
  });

  it('retries P2P when the timer fires, keeping the relay until it connects', () => {
    let r = run([{ t: 'cam', dev: 'crib' }, { t: 'link', state: 'failed' }, { t: 'retry' }]);
    expect(r.fx.at(-1)).toEqual({ t: 'connect' });
    expect(r.s.relay).toBe(true);
    // Fails again: back off, no duplicate subscription.
    r = run([{ t: 'link', state: 'connecting' }, { t: 'link', state: 'failed' }], r.s);
    expect(r.fx).toEqual([{ t: 'retry_in', ms: 60_000 }]);
  });

  it('re-subscribes to the relay after the room socket reconnects', () => {
    const { s } = run([{ t: 'cam', dev: 'crib' }, { t: 'link', state: 'failed' }]);
    expect(stepFallback(s, { t: 'hello' }).fx).toEqual([{ t: 'relay_on', dev: 'crib' }]);
    // Not on the relay: nothing to restore.
    expect(stepFallback(initialFallback(), { t: 'hello' }).fx).toEqual([]);
  });

  it('switching cameras while on the relay re-subscribes to the new one', () => {
    const { s, fx } = run([{ t: 'cam', dev: 'crib' }, { t: 'link', state: 'failed' }, { t: 'cam', dev: 'playroom' }]);
    expect(fx.slice(2)).toEqual([{ t: 'retry_clear' }, { t: 'relay_on', dev: 'playroom' }]);
    expect(s).toMatchObject({ dev: 'playroom', relay: true, retry: false, fails: 0 });
  });

  it('a failure before the camera is known subscribes once it is', () => {
    const { fx } = run([{ t: 'link', state: 'failed' }, { t: 'cam', dev: 'crib' }]);
    expect(fx).toEqual([{ t: 'retry_in', ms: 30_000 }, { t: 'retry_clear' }, { t: 'relay_on', dev: 'crib' }]);
  });

  it('keeps the subscription while the camera is briefly away, and stops retrying', () => {
    const { s, fx } = run([{ t: 'cam', dev: 'crib' }, { t: 'link', state: 'failed' }, { t: 'link', state: 'closed' }, { t: 'cam', dev: null }]);
    expect(fx.slice(2)).toEqual([{ t: 'retry_clear' }]);
    expect(s.relay).toBe(true);
    // The same camera back: frames resume at once.
    expect(stepFallback(s, { t: 'cam', dev: 'crib' }).fx).toEqual([{ t: 'relay_on', dev: 'crib' }]);
  });

  it('backs off 30 s → 5 min', () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelay)).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  });
});
