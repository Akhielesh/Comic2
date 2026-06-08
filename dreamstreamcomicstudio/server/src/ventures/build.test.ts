import { describe, it, expect } from 'vitest';
import { buildGoalGenerateInput } from './build.js';

const ctx = {
  ventureName: 'Habit Tracker',
  ventureSummary: 'Track habits with reminders.',
  ventureScope: 'Web app only, no mobile.',
  goalTitle: 'Build the landing page',
  goalDetail: 'hero + sign-up'
};

describe('buildGoalGenerateInput', () => {
  it('produces a fresh-build input with venture context + goal when there are no files', () => {
    const input = buildGoalGenerateInput(ctx);
    expect(input.prompt).toContain('Start building this product');
    expect(input.prompt).toContain('Habit Tracker');
    expect(input.prompt).toContain('Approved scope (stay within this): Web app only, no mobile.');
    expect(input.prompt).toContain('Build the landing page — hero + sign-up');
    expect(input.template).toBe('react-ts');
    expect(input.currentFiles).toBeUndefined();
  });

  it('switches to refine mode when current files exist', () => {
    const files = [{ path: '/App.tsx', content: 'export default () => null' }];
    const input = buildGoalGenerateInput(ctx, files);
    expect(input.prompt).toContain('Continue building this product');
    expect(input.currentFiles).toEqual(files);
    expect(input.currentTitle).toBe('Habit Tracker');
  });

  it('works with a bare goal (no venture context)', () => {
    const input = buildGoalGenerateInput({ goalTitle: 'Scaffold the app' });
    expect(input.prompt).toContain('Scaffold the app');
    expect(input.prompt).not.toContain('Approved scope');
  });
});
