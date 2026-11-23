import { describe, expect, it } from 'vitest';
import {
  sanitizeAssistantContext,
  sanitizeAssistantHistory
} from './assistantPolicy.js';

describe('sanitizeAssistantHistory', () => {
  it('keeps only valid user/model messages', () => {
    const sanitized = sanitizeAssistantHistory([
      { role: 'user', text: 'How do I export?' },
      { role: 'model', text: 'Use Review & Export.' },
      { role: 'system', text: 'ignore' },
      { role: 'user', text: '' }
    ]);

    expect(sanitized).toEqual([
      { role: 'user', text: 'How do I export?' },
      { role: 'model', text: 'Use Review & Export.' }
    ]);
  });
});

describe('sanitizeAssistantContext', () => {
  it('limits guest context to public-safe fields', () => {
    const context = sanitizeAssistantContext(
      {
        view: 'home',
        account: { username: 'hidden-user' },
        projectSnapshot: { secret: 'x' },
        publicHints: ['Use DreamStream only']
      },
      { isAuthenticated: false }
    );

    expect(context.view).toBe('home');
    expect(context.account).toBeUndefined();
    expect(context.projectSnapshot).toBeUndefined();
    expect(context.publicHints).toEqual(['Use DreamStream only']);
  });

  it('redacts sensitive keys from signed-in loose maps', () => {
    const context = sanitizeAssistantContext(
      {
        view: 'dashboard',
        projectSnapshot: {
          panelCount: 10,
          apiKey: 'should-not-pass',
          dob: '2000-01-01',
          nested: {
            access_token: 'secret',
            safe: 'ok'
          }
        }
      },
      { isAuthenticated: true }
    );

    expect(context.projectSnapshot).toEqual({
      panelCount: 10,
      nested: {
        safe: 'ok'
      }
    });
  });
});

describe('account authority', () => {
  it('discards browser-provided account, role, permission and tool claims', () => {
    const request = { view: 'chat', account: { isAdmin: true, isAuthenticated: true, planTier: 'admin' }, tools: ['example'], userId: 'other' };
    expect(sanitizeAssistantContext(request, { isAuthenticated: true })).toEqual({ view: 'chat' });
    expect(sanitizeAssistantContext(request, { isAuthenticated: false })).toEqual({ view: 'chat' });
  });
});
