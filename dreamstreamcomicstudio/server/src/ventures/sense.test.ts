import { describe, it, expect } from 'vitest';
import { signalToGoal, goalAlreadyOpen } from './sense.js';

describe('signalToGoal', () => {
  it('turns an error signal into a high-priority fix goal', () => {
    const g = signalToGoal({ type: 'error', message: 'TypeError: x is not a function' })!;
    expect(g.kind).toBe('fix');
    expect(g.priority).toBe(5);
    expect(g.title).toContain('Fix runtime error');
  });

  it('turns feedback into a feature goal', () => {
    const g = signalToGoal({ type: 'feedback', message: 'please add dark mode' })!;
    expect(g.kind).toBe('feature');
    expect(g.title).toContain('Address feedback');
  });

  it('does not create a goal for health signals', () => {
    expect(signalToGoal({ type: 'health', message: 'ok' })).toBeNull();
  });

  it('ignores an empty message', () => {
    expect(signalToGoal({ type: 'error', message: '   ' })).toBeNull();
  });

  it('collapses whitespace and truncates long messages', () => {
    const g = signalToGoal({ type: 'error', message: 'a\n\n   b ' + 'x'.repeat(300) })!;
    expect(g.title.length).toBeLessThan(200);
    expect(g.title).toContain('a b');
  });
});

describe('goalAlreadyOpen', () => {
  const goals = [
    { title: 'Fix runtime error: boom', status: 'proposed' },
    { title: 'Old fix', status: 'shipped' }
  ];
  it('detects an existing open goal with the same title', () => {
    expect(goalAlreadyOpen('Fix runtime error: boom', goals)).toBe(true);
  });
  it('ignores shipped/closed goals of the same title', () => {
    expect(goalAlreadyOpen('Old fix', goals)).toBe(false);
  });
  it('is false for a new title', () => {
    expect(goalAlreadyOpen('Fix runtime error: other', goals)).toBe(false);
  });
});
