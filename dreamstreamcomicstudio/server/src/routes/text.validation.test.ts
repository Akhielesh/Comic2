import { describe, expect, it } from 'vitest';
import { validateExtractWorldBody } from './text.validation.js';

describe('validateExtractWorldBody', () => {
  it('returns 400 when scenes is missing', () => {
    const result = validateExtractWorldBody({ script: 'Scene 1: test' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error.message).toBe('scenes array is required');
  });

  it('returns 400 with strict script error code when script is missing', () => {
    const result = validateExtractWorldBody({ scenes: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error.details?.code).toBe('SCRIPT_REQUIRED_FOR_WORLD_EXTRACTION');
  });

  it('accepts valid scenes + script', () => {
    const result = validateExtractWorldBody({ scenes: [{ id: 1 }], script: '  Scene 1: test  ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.isArray(result.scenes)).toBe(true);
    expect(result.script).toBe('Scene 1: test');
  });
});
