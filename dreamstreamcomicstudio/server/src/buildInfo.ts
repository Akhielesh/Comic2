import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface BuildInfo {
  gitSha: string;
  buildTimestamp: string;
}

/** Image metadata wins over runtime variables, which can outlive an image rollout in a container DO. */
export function resolveBuildInfo(image: unknown, env: NodeJS.ProcessEnv, now = new Date().toISOString()): BuildInfo {
  const metadata = image && typeof image === 'object' ? image as Partial<BuildInfo> : {};
  const bakedSha = typeof metadata.gitSha === 'string' && /^[a-f0-9]{40}$/i.test(metadata.gitSha) ? metadata.gitSha : undefined;
  const bakedTimestamp = typeof metadata.buildTimestamp === 'string' && Number.isFinite(Date.parse(metadata.buildTimestamp))
    ? metadata.buildTimestamp : undefined;
  return {
    gitSha: bakedSha
      || env.GIT_SHA?.trim()
      || env.RAILWAY_GIT_COMMIT_SHA?.trim()
      || env.VERCEL_GIT_COMMIT_SHA?.trim()
      || env.CF_PAGES_COMMIT_SHA?.trim()
      || 'unknown',
    buildTimestamp: (bakedSha && bakedTimestamp)
      || env.BUILD_TIMESTAMP?.trim()
      || env.RAILWAY_DEPLOYMENT_TIMESTAMP?.trim()
      || env.CF_PAGES_COMMIT_TIMESTAMP?.trim()
      || now
  };
}

function readImageBuildInfo(): unknown {
  try {
    return JSON.parse(readFileSync(path.resolve(process.cwd(), 'build-info.json'), 'utf8'));
  } catch {
    // Local development and the dormant Railway Dockerfile use their existing environment fallbacks.
    return undefined;
  }
}

export const BUILD_INFO = resolveBuildInfo(readImageBuildInfo(), process.env);
