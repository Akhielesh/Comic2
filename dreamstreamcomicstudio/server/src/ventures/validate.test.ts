import { describe, it, expect } from 'vitest';
import {
  parseCreateVenture,
  parseCreateGoal,
  parseBudget,
  parseStatusChange,
  parseCheckpointDecision
} from './validate.js';

describe('parseCreateVenture', () => {
  it('accepts a valid name (+ trims)', () => {
    const r = parseCreateVenture({ name: '  Habit Tracker  ', summary: 'a SaaS' });
    expect(r.valid).toBe(true);
    expect(r.value).toEqual({ name: 'Habit Tracker', summary: 'a SaaS', scope: undefined });
  });
  it('rejects a missing name', () => {
    const r = parseCreateVenture({});
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/name is required/);
  });
  it('rejects an over-long name', () => {
    expect(parseCreateVenture({ name: 'x'.repeat(201) }).valid).toBe(false);
  });
});

describe('parseCreateGoal', () => {
  it('accepts a valid goal', () => {
    const r = parseCreateGoal({ title: 'Landing page', kind: 'feature', priority: 10 });
    expect(r.valid).toBe(true);
    expect(r.value).toMatchObject({ title: 'Landing page', kind: 'feature', priority: 10 });
  });
  it('rejects an unknown kind', () => {
    const r = parseCreateGoal({ title: 'x', kind: 'bogus' });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/kind must be one of/);
  });
  it('rejects a negative priority', () => {
    expect(parseCreateGoal({ title: 'x', priority: -1 }).valid).toBe(false);
  });
  it('requires a title', () => {
    expect(parseCreateGoal({ title: '   ' }).valid).toBe(false);
  });
});

describe('parseBudget', () => {
  it('accepts numeric caps and nulls', () => {
    const r = parseBudget({ usdPerDay: 5, usdTotal: 50, maxTokens: null });
    expect(r.valid).toBe(true);
    expect(r.value).toEqual({ usdPerDay: 5, usdTotal: 50, maxTokens: null, maxContainerMinutes: null });
  });
  it('rejects a negative cap', () => {
    const r = parseBudget({ usdPerDay: -1 });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/usdPerDay/);
  });
  it('rejects a non-numeric cap', () => {
    expect(parseBudget({ usdTotal: 'lots' }).valid).toBe(false);
  });
});

describe('parseStatusChange', () => {
  it('accepts allowed user statuses', () => {
    expect(parseStatusChange({ status: 'paused' }).value).toBe('paused');
    expect(parseStatusChange({ status: 'active' }).value).toBe('active');
    expect(parseStatusChange({ status: 'archived' }).value).toBe('archived');
  });
  it('rejects an illegal status (e.g. draft)', () => {
    expect(parseStatusChange({ status: 'draft' }).valid).toBe(false);
  });
});

describe('parseCheckpointDecision', () => {
  it('maps approve/deny synonyms', () => {
    expect(parseCheckpointDecision({ decision: 'approve' }).value).toBe('approved');
    expect(parseCheckpointDecision({ decision: 'Approved' }).value).toBe('approved');
    expect(parseCheckpointDecision({ decision: 'deny' }).value).toBe('denied');
    expect(parseCheckpointDecision({ decision: 'reject' }).value).toBe('denied');
  });
  it('rejects anything else', () => {
    expect(parseCheckpointDecision({ decision: 'maybe' }).valid).toBe(false);
  });
});
