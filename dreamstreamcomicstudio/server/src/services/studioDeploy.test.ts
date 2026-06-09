import { describe, it, expect } from 'vitest';
import { normalizeTarget, deployProjectName, deploySandboxId, normalizeDeployResult } from './studioDeploy.js';

describe('studioDeploy.normalizeTarget', () => {
  it('accepts known targets, defaults to cloudflare', () => {
    expect(normalizeTarget('vercel')).toBe('vercel');
    expect(normalizeTarget('supabase')).toBe('supabase');
    expect(normalizeTarget('cloudflare')).toBe('cloudflare');
    expect(normalizeTarget('nonsense')).toBe('cloudflare');
    expect(normalizeTarget(undefined)).toBe('cloudflare');
  });
});

describe('studioDeploy.deployProjectName', () => {
  it('produces a valid Cloudflare Pages project name', () => {
    const name = deployProjectName('My Cool App!!', 'abc123def456');
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    expect(name.length).toBeLessThanOrEqual(58);
    expect(name).toContain('my-cool-app');
  });
  it('handles missing title/id', () => {
    expect(deployProjectName(undefined, undefined)).toBe('ds-app');
  });
});

describe('studioDeploy.deploySandboxId', () => {
  it('scopes per user + project and strips unsafe chars', () => {
    expect(deploySandboxId('user-1', 'proj/../x')).toBe('u_user-1_projx');
    expect(deploySandboxId('u2')).toBe('u_u2_app');
  });
});

describe('studioDeploy.normalizeDeployResult', () => {
  it('maps a live url', () => {
    expect(normalizeDeployResult({ status: 'live', url: 'https://x.pages.dev' })).toEqual({ status: 'live', url: 'https://x.pages.dev' });
  });
  it('maps an error', () => {
    expect(normalizeDeployResult({ status: 'error', message: 'build failed' })).toEqual({ status: 'error', message: 'build failed' });
  });
  it('handles a missing/empty reply', () => {
    expect(normalizeDeployResult(null).status).toBe('error');
  });
  it('falls back to queued when no url yet', () => {
    expect(normalizeDeployResult({ status: 'building' })).toEqual({ status: 'building', message: undefined });
  });
});
