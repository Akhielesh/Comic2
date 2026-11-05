import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_DOCS_STAGE, platformDocsAllowed, platformKillSwitchOn } from './flags';
import { platformDocsVisible } from '../../services/platformFlags';

describe('platform flags', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('wave 1 ships to admins only', () => {
    expect(PLATFORM_DOCS_STAGE).toBe('admins');
  });

  it('the kill switch is on only for exactly "on"', () => {
    for (const v of [undefined, null, '', 'off', 'ON', 'true', '1', ' on']) expect(platformKillSwitchOn(v)).toBe(false);
    expect(platformKillSwitchOn('on')).toBe(true);
  });

  it('kill switch off hides everything, whatever the stage', () => {
    for (const stage of ['off', 'admins', 'everyone'] as const) {
      expect(platformDocsAllowed({ killSwitch: undefined, isAdmin: true, stage })).toBe(false);
    }
  });

  it('the stage admits the right users once the switch is on', () => {
    expect(platformDocsAllowed({ killSwitch: 'on', isAdmin: true })).toBe(true);
    expect(platformDocsAllowed({ killSwitch: 'on', isAdmin: false })).toBe(false);
    expect(platformDocsAllowed({ killSwitch: 'on', isAdmin: false, stage: 'everyone' })).toBe(true);
    expect(platformDocsAllowed({ killSwitch: 'on', isAdmin: true, stage: 'off' })).toBe(false);
  });

  it('the client reads VITE_PLATFORM_DOCS', () => {
    vi.stubEnv('VITE_PLATFORM_DOCS', '');
    expect(platformDocsVisible(true)).toBe(false);
    vi.stubEnv('VITE_PLATFORM_DOCS', 'on');
    expect(platformDocsVisible(true)).toBe(true);
    expect(platformDocsVisible(false)).toBe(false);
  });
});
