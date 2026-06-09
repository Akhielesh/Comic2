import { describe, it, expect } from 'vitest';
import { withModelTimeout, withTimeout } from './utils.js';

describe('withModelTimeout', () => {
  it('resolves the wrapped promise when it finishes in time', async () => {
    await expect(withModelTimeout(Promise.resolve('ok'), 1000, 'Test')).resolves.toBe('ok');
  });

  it('throws a tagged 504 MODEL_TIMEOUT with a user-safe message on timeout', async () => {
    const slow = new Promise((r) => setTimeout(r, 50));
    await expect(withModelTimeout(slow, 5, 'Panel breakdown')).rejects.toMatchObject({
      status: 504,
      publicCode: 'MODEL_TIMEOUT'
    });
    // The public message must be free of internal labels / ms.
    try {
      await withModelTimeout(new Promise((r) => setTimeout(r, 50)), 5, 'Panel breakdown');
    } catch (e) {
      expect((e as { publicMessage: string }).publicMessage).toContain('faster model');
      expect((e as { publicMessage: string }).publicMessage).not.toContain('Panel breakdown');
    }
  });
});

describe('withTimeout', () => {
  it('throws a plain (untagged) error on timeout — for tool/HTTP calls', async () => {
    const slow = new Promise((r) => setTimeout(r, 50));
    await expect(withTimeout(slow, 5, 'DuckDuckGo')).rejects.toThrow(/timed out/);
    try {
      await withTimeout(new Promise((r) => setTimeout(r, 50)), 5, 'DuckDuckGo');
    } catch (e) {
      expect((e as { status?: number }).status).toBeUndefined();
    }
  });
});
