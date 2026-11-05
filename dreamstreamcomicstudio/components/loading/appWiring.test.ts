// @vitest-environment node
/**
 * How App.tsx uses the loaders (App itself is too wired to auth, Supabase and the project store to mount in
 * a unit test, so this reads its source, narrowly):
 * - the full-screen boot screen is only for the boot itself (auth, key check) and leaving the comics host;
 *   opening a project or a comic keeps the shell and its header and loads inside the content area;
 * - the route Suspense falls back to the destination-shaped RouteFallback, inside the shell;
 * - the boot status probe is the one the wake hint reads (no new request);
 * - the old comic "DS" tile loader is gone.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP = readFileSync(path.join(fileURLToPath(new URL('../..', import.meta.url)), 'App.tsx'), 'utf8');

describe('App.tsx loading wiring', () => {
  it('returns the full-screen boot screen only while booting or leaving the comics host, never while opening a project', () => {
    const boot = APP.match(/if \(!publicComicActive && \(([^)]*)\)\) \{\s*return <AppLoader\b/);
    expect(boot, 'the boot early return').not.toBeNull();
    expect(boot![1]).toContain('authLoading');
    expect(boot![1]).toContain('isCheckingKey');
    expect(boot![1]).not.toContain('isHydratingProject');
    expect(APP.match(/return <AppLoader\b/g)).toHaveLength(1);
  });

  it('opens a project inside the content area, under the header, with the comic mark', () => {
    expect(APP).toMatch(/\) : isHydratingProject \? \(\s*<ContentLoader label="[^"]+" studio="comic" fill=\{showSharedHeader \? 'content' : 'viewport'\} \/>/);
  });

  it('falls back to a destination-shaped skeleton for lazy views', () => {
    expect(APP).toContain('<Suspense fallback={<RouteFallback view={effectiveView} />}>');
    expect(APP).not.toContain('<Suspense fallback={<AppLoader');
  });

  it('feeds the existing boot status probe to the wake hint, and sends nothing new', () => {
    expect(APP).toContain('trackBackendWake(checkSystemStatus())');
    expect(APP.match(/checkSystemStatus\(\)/g)).toHaveLength(1);
  });

  it('no longer defines its own comic-tile loader', () => {
    expect(APP).not.toMatch(/const AppLoader\b/);
    expect(APP).toContain("from './components/loading'");
  });
});
