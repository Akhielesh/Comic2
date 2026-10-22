// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { INSTANT_DELAY_MS, initialFallback, retryDelay, stepFallback, type Fallback, type FallbackEffect, type FallbackInput } from './linkFallback';

/** Feed inputs in order; collect every effect. */
function run(inputs: FallbackInput[], start: Fallback = initialFallback(false)) {
  let s = start;
  const fx: FallbackEffect[] = [];
  for (const i of inputs) {
    const r = stepFallback(s, i);
    s = r.s;
    fx.push(...r.fx);
  }
  return { s, fx };
}

const on = (dev: string, instant = false): FallbackEffect => ({ t: 'relay_on', dev, instant });

describe('linkFallback: fallback when P2P can’t connect', () => {
  it('falls back to the relay when P2P fails, and schedules a retry', () => {
    const { s, fx } = run([{ t: 'cam', dev: 'crib' }, { t: 'link', state: 'connecting' }, { t: 'link', state: 'failed' }]);
    expect(fx).toEqual([on('crib'), { t: 'retry_in', ms: 30_000 }]);
    expect(s.relay).toBe(true);
    expect(s.retry).toBe(true);
  });

  it('counts one failure per attempt (timer + browser both say failed)', () => {
    const { s, fx } = run([{ t: 'cam', dev: 'crib' }, { t: 'link', state: 'failed' }, { t: 'link', state: 'failed' }]);
    expect(fx.filter((e) => e.t === 'retry_in')).toHaveLength(1);
    expect(s.fails).toBe(1);
  });

  it('a late P2P connect cancels the retry; the relay goes once the direct picture is on screen', () => {
    let r = run([{ t: 'cam', dev: 'crib' }, { t: 'link', state: 'failed' }, { t: 'link', state: 'connected' }]);
    expect(r.fx.slice(2)).toEqual([{ t: 'retry_clear' }]);
    expect(r.s).toMatchObject({ relay: true, retry: false, fails: 0 });
    // The (cleared) timer firing anyway does nothing.
    expect(stepFallback(r.s, { t: 'retry' }).fx).toEqual([]);
    r = run([{ t: 'rendered' }], r.s);
    expect(r.fx).toEqual([{ t: 'relay_off' }]);
    expect(r.s.relay).toBe(false);
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
    expect(stepFallback(s, { t: 'hello' }).fx).toEqual([on('crib')]);
    // Not on the relay: nothing to restore.
    expect(stepFallback(initialFallback(), { t: 'hello' }).fx).toEqual([]);
  });

  it('switching cameras while on the relay re-subscribes to the new one', () => {
    const { s, fx } = run([{ t: 'cam', dev: 'crib' }, { t: 'link', state: 'failed' }, { t: 'cam', dev: 'playroom' }]);
    expect(fx.slice(2)).toEqual([{ t: 'retry_clear' }, on('playroom')]);
    expect(s).toMatchObject({ dev: 'playroom', relay: true, retry: false, fails: 0 });
  });

  it('a failure before the camera is known subscribes once it is', () => {
    const { fx } = run([{ t: 'link', state: 'failed' }, { t: 'cam', dev: 'crib' }]);
    expect(fx).toEqual([{ t: 'retry_in', ms: 30_000 }, { t: 'retry_clear' }, on('crib')]);
  });

  it('keeps the subscription while the camera is briefly away, and stops retrying', () => {
    const { s, fx } = run([{ t: 'cam', dev: 'crib' }, { t: 'link', state: 'failed' }, { t: 'link', state: 'closed' }, { t: 'cam', dev: null }]);
    expect(fx.slice(2)).toEqual([{ t: 'retry_clear' }]);
    expect(s.relay).toBe(true);
    // The same camera back: frames resume at once.
    expect(stepFallback(s, { t: 'cam', dev: 'crib' }).fx).toEqual([on('crib')]);
  });

  it('backs off 30 s → 5 min', () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelay)).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  });
});

describe('linkFallback: the instant picture', () => {
  const start = () => initialFallback(true);
  const wait: FallbackEffect = { t: 'instant_in', ms: INSTANT_DELAY_MS };
  const due: FallbackInput = { t: 'instant_due' };

  it('gives the direct picture a second; if it isn’t through, subscribes; drops it once the direct one has drawn a frame', () => {
    let r = run([{ t: 'cam', dev: 'crib' }, { t: 'link', state: 'connecting' }], start());
    expect(r.fx).toEqual([wait]);
    expect(r.s.relay).toBe(false);
    r = run([due], r.s);
    expect(r.fx).toEqual([on('crib', true)]);
    expect(r.s).toMatchObject({ relay: true, early: true, pending: false });
    // Connected is not enough: the relay picture stays until the direct one is on screen.
    r = run([{ t: 'link', state: 'connected' }], r.s);
    expect(r.fx).toEqual([]);
    expect(r.s.relay).toBe(true);
    r = run([{ t: 'rendered' }], r.s);
    expect(r.fx).toEqual([{ t: 'relay_off' }]);
    expect(r.s).toMatchObject({ relay: false, early: false });
  });

  it('a direct picture that connects within its head start never touches the relay (home Wi-Fi)', () => {
    const r = run([{ t: 'cam', dev: 'crib' }, { t: 'link', state: 'connecting' }, { t: 'link', state: 'connected' }, due, { t: 'rendered' }], start());
    expect(r.fx).toEqual([wait, { t: 'instant_clear' }]);
    expect(r.s.relay).toBe(false);
  });

  it('works when the camera arrives together with the call', () => {
    const { fx, s } = run([{ t: 'link', state: 'connecting' }, { t: 'cam', dev: 'crib' }, due], start());
    expect(fx).toEqual([wait, on('crib', true)]);
    expect(s.early).toBe(true);
  });

  it('a rendered frame before the call connects changes nothing', () => {
    const { fx } = run([{ t: 'cam', dev: 'crib' }, { t: 'link', state: 'connecting' }, due, { t: 'rendered' }], start());
    expect(fx).toEqual([wait, on('crib', true)]);
  });

  it('if the direct picture fails, the instant picture becomes the fallback (re-sent as a real subscription)', () => {
    const { fx, s } = run([{ t: 'cam', dev: 'crib' }, { t: 'link', state: 'connecting' }, due, { t: 'link', state: 'failed' }], start());
    expect(fx).toEqual([wait, on('crib', true), on('crib'), { t: 'retry_in', ms: 30_000 }]);
    expect(s).toMatchObject({ relay: true, early: false });
    // Retrying doesn't make it "instant" again.
    const r = run([{ t: 'retry' }, { t: 'link', state: 'connecting' }], s);
    expect(r.fx).toEqual([{ t: 'connect' }]);
    expect(r.s.early).toBe(false);
  });

  it('a camera that is full fails at once: the head start is cancelled, the relay is the picture', () => {
    const { fx } = run([{ t: 'cam', dev: 'crib' }, { t: 'link', state: 'connecting' }, { t: 'link', state: 'failed' }, due], start());
    expect(fx).toEqual([wait, { t: 'instant_clear' }, on('crib'), { t: 'retry_in', ms: 30_000 }]);
  });

  it('bridges a direct picture that drops for more than a moment (ICE reconnecting)', () => {
    let r = run([{ t: 'cam', dev: 'crib' }, { t: 'link', state: 'connecting' }, { t: 'link', state: 'connected' }, { t: 'rendered' }], start());
    r = run([{ t: 'link', state: 'reconnecting' }, due], r.s);
    expect(r.fx).toEqual([wait, on('crib', true)]);
    r = run([{ t: 'link', state: 'connected' }, { t: 'rendered' }], r.s);
    expect(r.fx).toEqual([{ t: 'relay_off' }]);
  });

  it('the camera hanging up drops the instant picture (a fallback one stays for its return)', () => {
    const { fx, s } = run([{ t: 'cam', dev: 'crib' }, { t: 'link', state: 'connecting' }, due, { t: 'link', state: 'closed' }], start());
    expect(fx).toEqual([wait, on('crib', true), { t: 'relay_off' }]);
    expect(s.relay).toBe(false);
  });

  it('audio-only viewers need no picture: off drops (or cancels) the instant relay; on while connecting schedules it', () => {
    let r = run([{ t: 'cam', dev: 'crib' }, { t: 'link', state: 'connecting' }, due, { t: 'instant', on: false }], start());
    expect(r.fx).toEqual([wait, on('crib', true), { t: 'relay_off' }]);
    expect(r.s).toMatchObject({ relay: false, instant: false });
    r = run([{ t: 'link', state: 'connecting' }], r.s);
    expect(r.fx).toEqual([]);
    r = run([{ t: 'instant', on: true }, due], r.s);
    expect(r.fx).toEqual([wait, on('crib', true)]);
    // Turned off while still waiting: the timer is cancelled.
    const c = run([{ t: 'cam', dev: 'crib' }, { t: 'link', state: 'connecting' }, { t: 'instant', on: false }, due], start());
    expect(c.fx).toEqual([wait, { t: 'instant_clear' }]);
    // A real fallback is kept even for audio-only (the sound rides on it).
    const f = run([{ t: 'link', state: 'failed' }, { t: 'instant', on: false }], r.s);
    expect(f.s.relay).toBe(true);
  });

  it('re-subscribes after a room reconnect with the same kind of subscription', () => {
    const { s } = run([{ t: 'cam', dev: 'crib' }, { t: 'link', state: 'connecting' }, due], start());
    expect(stepFallback(s, { t: 'hello' }).fx).toEqual([on('crib', true)]);
  });
});
