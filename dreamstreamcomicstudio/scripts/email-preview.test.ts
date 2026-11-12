import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// docs/email/previews is what reviewers read for an email's copy. When a template's wording changes
// (the confirmation email no longer says "One click to confirm" or "you won't hear from us again"),
// the checked-in previews must change with it: regenerate them with `npx tsx scripts/email-preview.ts`.
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREVIEWS = path.join(APP, 'docs', 'email', 'previews');
const html = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.html')).sort();

it('the checked-in email previews are what the templates render today', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'email-previews-'));
  try {
    execFileSync(process.execPath, [path.join(APP, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/email-preview.ts', '--out', out], { cwd: APP, stdio: 'pipe' });
    const fresh = html(out);
    expect(fresh.length).toBeGreaterThan(10);
    expect(html(PREVIEWS)).toEqual(fresh);
    const stale = fresh.filter((f) => readFileSync(path.join(PREVIEWS, f), 'utf8') !== readFileSync(path.join(out, f), 'utf8'));
    expect(stale, 'regenerate with: npx tsx scripts/email-preview.ts').toEqual([]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);
