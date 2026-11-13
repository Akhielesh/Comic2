// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolveBuildInfo } from './buildInfo.js';

describe('backend image identity', () => {
  const image = { gitSha: 'c'.repeat(40), buildTimestamp: '2026-11-13T12:00:00Z' };

  it('reports the running image even when the durable container retains older runtime variables', () => {
    expect(resolveBuildInfo(image, { GIT_SHA: '0fd10c38', BUILD_TIMESTAMP: '2026-11-12T12:00:00Z' })).toEqual(image);
  });

  it('keeps existing host environment fallbacks when no image metadata is available', () => {
    expect(resolveBuildInfo(undefined, { RAILWAY_GIT_COMMIT_SHA: 'railway-build', RAILWAY_DEPLOYMENT_TIMESTAMP: 'railway-time' })).toEqual({
      gitSha: 'railway-build', buildTimestamp: 'railway-time'
    });
    expect(resolveBuildInfo(null, { GIT_SHA: 'runtime', RAILWAY_GIT_COMMIT_SHA: 'older' }, 'started')).toEqual({
      gitSha: 'runtime', buildTimestamp: 'started'
    });
  });

  it('does not let an unversioned local Docker build mask useful runtime metadata', () => {
    expect(resolveBuildInfo({ gitSha: 'unknown', buildTimestamp: 'unknown' }, { GIT_SHA: 'ci-boot' }, 'started')).toEqual({
      gitSha: 'ci-boot', buildTimestamp: 'started'
    });
    expect(resolveBuildInfo({}, {}, 'started')).toEqual({ gitSha: 'unknown', buildTimestamp: 'started' });
  });
});
