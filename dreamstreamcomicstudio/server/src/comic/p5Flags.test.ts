// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { P5_FLAGS, P5_FLAGS_OFF, P5_FLAG_ENV, P5_FLAG_MAX, p5FlagOn, p5FlagsFor, p5StageOf } from './p5Flags.js';

describe('p5Flags', () => {
  it('names the three W1 flags', () => {
    expect(P5_FLAG_ENV).toEqual({ storyFixes: 'COMIC_STORY_FIXES', runChains: 'COMIC_RUN_CHAINS', qcV2: 'COMIC_QC_V2' });
    expect(P5_FLAGS).toEqual(['storyFixes', 'runChains', 'qcV2']);
  });

  it('reads off, admins and all (case and spaces ignored)', () => {
    expect(p5StageOf('storyFixes', { COMIC_STORY_FIXES: 'off' })).toBe('off');
    expect(p5StageOf('storyFixes', { COMIC_STORY_FIXES: ' Admins ' })).toBe('admins');
    expect(p5StageOf('storyFixes', { COMIC_STORY_FIXES: 'ALL' })).toBe('all');
    expect(p5StageOf('qcV2', { COMIC_QC_V2: 'everyone' })).toBe('all');
  });

  it('scene chains are available to every author by default, with explicit off and admins rollback stages', () => {
    expect(P5_FLAG_MAX).toEqual({});
    for (const value of ['all', 'ALL', ' everyone ']) {
      expect(p5StageOf('runChains', { COMIC_RUN_CHAINS: value })).toBe('all');
      expect(p5FlagOn('runChains', false, { COMIC_RUN_CHAINS: value })).toBe(true);
    }
    expect(p5StageOf('runChains', {})).toBe('all');
    expect(p5StageOf('runChains', { COMIC_RUN_CHAINS: 'admins' })).toBe('admins');
    expect(p5FlagOn('runChains', false, { COMIC_RUN_CHAINS: 'admins' })).toBe(false);
    expect(p5StageOf('runChains', { COMIC_RUN_CHAINS: 'off' })).toBe('off');
    expect(p5StageOf('runChains', { COMIC_RUN_CHAINS: 'invalid' })).toBe('off');
    expect(p5FlagsFor(false, { COMIC_STORY_FIXES: 'all', COMIC_RUN_CHAINS: 'all', COMIC_QC_V2: 'all' })).toEqual({ storyFixes: true, runChains: true, qcV2: true });
  });

  it('reads unset, empty and unknown values as off', () => {
    for (const value of [undefined, '', '  ', 'maybe', 'enabled', 'admins,all', '2'])
      expect(p5StageOf('qcV2', { COMIC_QC_V2: value })).toBe('off');
    expect(p5StageOf('qcV2', {})).toBe('off');
  });

  it('a bare switch admits admins only (the house rule for every COMIC_* stage)', () => {
    expect(p5StageOf('qcV2', { COMIC_QC_V2: 'on' })).toBe('admins');
    expect(p5FlagOn('qcV2', false, { COMIC_QC_V2: 'true' })).toBe(false);
    expect(p5FlagOn('qcV2', true, { COMIC_QC_V2: 'true' })).toBe(true);
  });

  it('admins admits admins only; all admits everyone; off admits no one', () => {
    const env = { COMIC_STORY_FIXES: 'admins', COMIC_RUN_CHAINS: 'admins', COMIC_QC_V2: 'all' };
    expect(p5FlagsFor(true, env)).toEqual({ storyFixes: true, runChains: true, qcV2: true });
    expect(p5FlagsFor(false, env)).toEqual({ storyFixes: false, runChains: false, qcV2: true });
    expect(p5FlagsFor(false, { COMIC_STORY_FIXES: 'off', COMIC_RUN_CHAINS: 'off', COMIC_QC_V2: 'off' })).toEqual(P5_FLAGS_OFF);
  });

  it('each flag reads only its own variable', () => {
    expect(p5FlagsFor(true, { COMIC_RUN_CHAINS: 'admins' })).toEqual({ storyFixes: false, runChains: true, qcV2: false });
    expect(p5FlagsFor(true, { COMIC_QC_V2: 'all' })).toEqual({ storyFixes: false, runChains: true, qcV2: true });
  });

  it('defaults only scene continuity on, and the result cannot be changed afterwards', () => {
    expect(p5FlagsFor(true, {})).toEqual({ storyFixes: false, runChains: true, qcV2: false });
    expect(Object.values(P5_FLAGS_OFF).every((v) => v === false)).toBe(true);
    expect(Object.isFrozen(p5FlagsFor(true, {}))).toBe(true);
  });
});
