import { describe, it, expect } from 'vitest';
import { buildVentureEvent, redactSecrets } from './events.js';

describe('redactSecrets', () => {
  it('masks OpenAI-style keys', () => {
    expect(redactSecrets('key sk-abcd1234efgh5678 here')).toBe('key [redacted] here');
  });
  it('masks NVIDIA + Google + GitHub tokens', () => {
    expect(redactSecrets('nvapi-abcdefgh1234')).toBe('[redacted]');
    expect(redactSecrets('AIzaSyABCDEFGHIJKLMNOP')).toBe('[redacted]');
    expect(redactSecrets('ghp_abcdefgh12345678')).toBe('[redacted]');
  });
  it('leaves ordinary text untouched', () => {
    expect(redactSecrets('built the landing page and shipped a preview')).toBe(
      'built the landing page and shipped a preview'
    );
  });
});

describe('buildVentureEvent', () => {
  it('fills defaults and normalizes snake_case row shape', () => {
    const e = buildVentureEvent({ ventureId: 'v1', userId: 'u1', kind: 'tick.started' });
    expect(e.venture_id).toBe('v1');
    expect(e.user_id).toBe('u1');
    expect(e.kind).toBe('tick.started');
    expect(e.level).toBe('info');
    expect(e.source).toBe('engine');
    expect(e.message).toBeNull();
    expect(e.data).toBeNull();
    expect(e.cost_usd).toBeNull();
    expect(typeof e.created_at).toBe('string');
  });

  it('redacts secrets in the message and preserves provided fields', () => {
    const e = buildVentureEvent({
      ventureId: 'v1',
      userId: 'u1',
      kind: 'error',
      level: 'error',
      message: 'failed with token sk-supersecretkey123456',
      costUsd: 0.42,
      model: 'google/gemini-2.5-flash',
      source: 'scheduler'
    });
    expect(e.message).toBe('failed with token [redacted]');
    expect(e.level).toBe('error');
    expect(e.cost_usd).toBe(0.42);
    expect(e.model).toBe('google/gemini-2.5-flash');
    expect(e.source).toBe('scheduler');
  });

  it('drops non-finite cost', () => {
    const e = buildVentureEvent({ ventureId: 'v1', userId: 'u1', kind: 'tick.completed', costUsd: Number.NaN });
    expect(e.cost_usd).toBeNull();
  });

  it('truncates very long messages (after redaction)', () => {
    // Use spaced words so the secret-redactor (which collapses 40+ char runs) doesn't fire.
    const e = buildVentureEvent({ ventureId: 'v1', userId: 'u1', kind: 'error', message: 'lorem ipsum '.repeat(400) });
    expect(e.message?.length).toBe(2000);
  });
});
