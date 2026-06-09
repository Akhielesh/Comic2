import { describe, it, expect, beforeEach } from 'vitest';
import { getDeployUrl, setDeployUrl } from './studioDeployUrl';

describe('studioDeployUrl', () => {
  beforeEach(() => { try { window.localStorage.clear(); } catch { /* ignore */ } });

  it('stores + reads a project deploy url', () => {
    setDeployUrl('p1', 'https://my-app.pages.dev');
    expect(getDeployUrl('p1')).toBe('https://my-app.pages.dev');
  });

  it('scopes per project and returns null when unset', () => {
    setDeployUrl('p1', 'https://a.vercel.app');
    expect(getDeployUrl('p2')).toBeNull();
    expect(getDeployUrl(null)).toBeNull();
    expect(getDeployUrl(undefined)).toBeNull();
  });

  it('ignores non-http values and clears on null', () => {
    setDeployUrl('p1', 'javascript:alert(1)');
    expect(getDeployUrl('p1')).toBeNull();
    setDeployUrl('p1', 'https://ok.pages.dev');
    setDeployUrl('p1', null);
    expect(getDeployUrl('p1')).toBeNull();
  });
});
