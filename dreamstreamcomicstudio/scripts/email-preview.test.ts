import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// docs/email/previews is what reviewers read for an email's copy. When a template's wording changes
// (the confirmation email no longer says "One click to confirm" or "you won't hear from us again"),
// the checked-in previews must change with it: regenerate them with `npx tsx scripts/email-preview.ts`.
// Every footer carries the year it is rendered in (shared/email/layout.ts), so that year is not
// compared: the previews stay current on 1 January without a change to any template.
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREVIEWS = path.join(APP, 'docs', 'email', 'previews');
const html = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.html')).sort();
const withoutYear = (page: string) => page.replace(/© \d{4} /g, '© YEAR ');

/** Render every preview into a fresh folder (with `now`, the clock the renderer sees), and list the stale checked-in ones. */
function stalePreviews(now?: string): { fresh: string[]; stale: string[] } {
  const out = mkdtempSync(path.join(tmpdir(), 'email-previews-'));
  try {
    const env = { ...process.env };
    if (now) {
      // A clock fixed at `now` for the renderer's process (and the one tsx starts for it).
      const clock = path.join(out, 'clock.mjs');
      writeFileSync(
        clock,
        `const Real = Date; const shift = Real.parse(${JSON.stringify(now)}) - Real.now();
class Fixed extends Real { constructor(...a) { if (a.length) super(...a); else super(Real.now() + shift); } static now() { return Real.now() + shift; } }
globalThis.Date = Fixed;\n`
      );
      env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import ${JSON.stringify(clock)}`.trim();
    }
    execFileSync(process.execPath, [path.join(APP, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/email-preview.ts', '--out', out], { cwd: APP, stdio: 'pipe', env });
    const fresh = html(out);
    const stale = fresh.filter((f) => withoutYear(readFileSync(path.join(PREVIEWS, f), 'utf8')) !== withoutYear(readFileSync(path.join(out, f), 'utf8')));
    return { fresh, stale };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

it('the checked-in email previews are what the templates render today', () => {
  const { fresh, stale } = stalePreviews();
  expect(fresh.length).toBeGreaterThan(10);
  expect(html(PREVIEWS)).toEqual(fresh);
  expect(stale, 'regenerate with: npx tsx scripts/email-preview.ts').toEqual([]);
}, 60_000);

it('a new year alone never makes them stale (the footer\'s year is the only thing the clock changes)', () => {
  const { fresh, stale } = stalePreviews('2027-01-01T00:00:05Z');
  expect(fresh.length).toBeGreaterThan(10);
  expect(stale).toEqual([]);
}, 60_000);
