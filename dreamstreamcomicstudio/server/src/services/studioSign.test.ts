import { describe, it, expect } from 'vitest';
import { signStudioBody, verifyStudioSignature } from './studioSign.js';

describe('studioSign', () => {
  const secret = 'test-secret-123';
  const body = JSON.stringify({ action: 'launch', sandboxId: 'u_1_2', files: [] });

  it('produces a sha256-prefixed hex signature', () => {
    const sig = signStudioBody(body, secret);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('round-trips: a signature verifies against its body + secret', () => {
    expect(verifyStudioSignature(body, secret, signStudioBody(body, secret))).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = signStudioBody(body, secret);
    expect(verifyStudioSignature(body + ' ', secret, sig)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    expect(verifyStudioSignature(body, 'other', signStudioBody(body, secret))).toBe(false);
  });

  it('rejects empty/missing signature or secret', () => {
    expect(verifyStudioSignature(body, secret, '')).toBe(false);
    expect(verifyStudioSignature(body, secret, undefined)).toBe(false);
    expect(verifyStudioSignature(body, '', signStudioBody(body, secret))).toBe(false);
  });
});
