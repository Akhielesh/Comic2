// @vitest-environment node
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

// Code Studio is retired (ADR 0005). Ventures must stand on its own: no import may reach back
// into the removed studio generator, studio services or the studio router. designSystem and
// liveTemplate are kept chat helpers that happen to live under ai/studio/, so they are allowed.
const here = path.dirname(fileURLToPath(import.meta.url));
const FORBIDDEN = [
  /from\s+['"][^'"]*ai\/studio\/(?!designSystem\.js|liveTemplate\.js)[^'"]*['"]/,
  /from\s+['"][^'"]*services\/studio(Worker|Sign|Deploy|BuildService|Caps|Files|Repository|Ids|Github)\.js['"]/,
  /from\s+['"][^'"]*routes\/studio(Github)?\.js['"]/,
  /from\s+['"]\.\/studio(Github)?\.js['"]/,
  /\bstudioStage[A-Za-z]*\b/,
  /\bSTUDIO_(WORKER_URL|HMAC_SECRET|REQUEST_TIMEOUT_MS|MAX_CONCURRENT_PER_USER|DAILY_BUILD_MINUTES|COST_PER_AWAKE_SEC)\b/
];

const sources = [
  ...readdirSync(here)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => path.join(here, f)),
  path.join(here, '..', 'routes', 'ventures.ts')
];

describe('Ventures has no Code Studio dependency', () => {
  it('scans a real set of files', () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it.each(sources.map((f) => [path.relative(path.join(here, '..'), f), f]))('%s imports nothing from Code Studio', (_name, file) => {
    const src = readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN) expect(src).not.toMatch(pattern);
  });
});
