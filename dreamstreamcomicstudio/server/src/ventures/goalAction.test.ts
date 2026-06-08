import { describe, it, expect } from 'vitest';
import { classifyGoalAction } from './goalAction.js';

describe('classifyGoalAction', () => {
  it('defaults build/feature goals to a no-checkpoint sandbox action', () => {
    expect(classifyGoalAction({ title: 'Build the landing page' })).toBe('run_build');
    expect(classifyGoalAction({ title: 'Add a habit data model', kind: 'feature' })).toBe('run_build');
  });

  it('routes production deploys to deploy_production', () => {
    expect(classifyGoalAction({ title: 'Deploy to production' })).toBe('deploy_production');
    expect(classifyGoalAction({ title: 'Go live with v1' })).toBe('deploy_production');
    expect(classifyGoalAction({ title: 'Launch the product' })).toBe('deploy_production');
  });

  it('treats preview/staging deploys as no-checkpoint', () => {
    expect(classifyGoalAction({ title: 'Deploy a preview build' })).toBe('deploy_preview');
    expect(classifyGoalAction({ title: 'Push to staging' })).toBe('deploy_preview');
  });

  it('flags destructive data operations', () => {
    expect(classifyGoalAction({ title: 'Drop the legacy users table' })).toBe('delete_resource');
    expect(classifyGoalAction({ title: 'Delete old deployment', detail: 'remove the resource' })).toBe('delete_resource');
  });

  it('flags external publishing', () => {
    expect(classifyGoalAction({ title: 'Publish to the app store' })).toBe('publish_external');
    expect(classifyGoalAction({ title: 'Announce launch to users' })).toBe('publish_external');
  });

  it('does not misclassify ordinary build work as risky', () => {
    expect(classifyGoalAction({ title: 'Add a delete button to the UI' })).toBe('run_build');
    expect(classifyGoalAction({ title: 'Publish loading states' })).toBe('run_build'); // no public target
  });
});
