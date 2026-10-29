// Probe-only vitest config: the qa-hunt worktree's node_modules is a symlink into another checkout,
// so Vite's fs allow-list denies `?url` asset imports (fonts) resolved through it. Same config as
// vite.config.ts plus that real path. Used only as `npx vitest run --config tests/probe/vitest.probe.config.ts`.
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, mergeConfig, type ConfigEnv, type UserConfig } from 'vite';
import base from '../../vite.config';

const root = path.resolve(__dirname, '../..');
const realNodeModules = fs.realpathSync(path.join(root, 'node_modules'));

export default defineConfig(async (env: ConfigEnv) => {
  const resolved = (typeof base === 'function' ? await (base as (e: ConfigEnv) => UserConfig | Promise<UserConfig>)(env) : base) as UserConfig;
  return mergeConfig(resolved, { server: { fs: { allow: [root, realNodeModules] } } });
});
