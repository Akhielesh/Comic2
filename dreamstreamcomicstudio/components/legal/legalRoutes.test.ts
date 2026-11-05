// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LEGAL_DOCS, LEGAL_DOC_IDS, isLegalDocId, legalDocForPath, legalPath, syncLegalPath } from './legalRoutes';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('legal routes', () => {
  it('gives every document one real, unique path', () => {
    expect(LEGAL_DOC_IDS).toEqual(['terms', 'privacy', 'acceptable-use', 'copyright', 'cookies', 'subprocessors']);
    expect(LEGAL_DOCS.map((d) => d.path)).toEqual(['/terms', '/privacy', '/acceptable-use', '/copyright', '/cookies', '/subprocessors']);
    expect(new Set(LEGAL_DOCS.map((d) => d.path)).size).toBe(LEGAL_DOCS.length);
    expect(legalPath('cookies')).toBe('/cookies');
  });

  it('maps paths (trailing slashes, case and aliases too) to documents, and nothing else', () => {
    for (const d of LEGAL_DOCS) {
      expect(legalDocForPath(d.path)).toBe(d.id);
      expect(legalDocForPath(`${d.path}/`)).toBe(d.id);
      expect(legalDocForPath(d.path.toUpperCase())).toBe(d.id);
    }
    expect(legalDocForPath('/terms-of-service')).toBe('terms');
    expect(legalDocForPath('/privacy-policy')).toBe('privacy');
    expect(legalDocForPath('/dmca')).toBe('copyright');
    for (const other of ['/', '', null, undefined, '/models', '/c/abc', '/privacy/extra', '/live', '/share/x']) {
      expect(legalDocForPath(other)).toBeNull();
    }
  });

  it('names the documents with one name each ("Terms of Service", never "Terms & Conditions")', () => {
    expect(LEGAL_DOCS.find((d) => d.id === 'terms')?.title).toBe('Terms of Service');
    expect(LEGAL_DOCS.find((d) => d.id === 'terms')?.label).toBe('Terms of Service');
    for (const d of LEGAL_DOCS) expect(`${d.title} ${d.label}`).not.toMatch(/Conditions/);
  });

  it('keeps the address bar on the document path, and resets it when you leave', () => {
    const consent = new URL('https://dreamstreamstudio.ai/?view=privacy#google-user-data');
    expect(syncLegalPath(consent, 'privacy')).toBe(true);
    expect(consent.toString()).toBe('https://dreamstreamstudio.ai/privacy#google-user-data');

    const leaving = new URL('https://dreamstreamstudio.ai/cookies');
    expect(syncLegalPath(leaving, 'gallery')).toBe(false);
    expect(leaving.pathname).toBe('/');

    const elsewhere = new URL('https://dreamstreamstudio.ai/models');
    expect(syncLegalPath(elsewhere, 'models')).toBe(false);
    expect(elsewhere.pathname).toBe('/models');
    expect(isLegalDocId('settings')).toBe(false);
  });

  it('is wired into App.tsx: every document is a view, restorable from ?view=, opened from its path and rendered', () => {
    const app = read('../../App.tsx');
    for (const id of LEGAL_DOC_IDS) {
      expect(app).toMatch(new RegExp(`\\| '${id}'`));
      expect(app).toMatch(new RegExp(`effectiveView === '${id}' && \\(`));
    }
    const restorable = /const RESTORABLE_VIEWS = new Set<AppView>\(\[([\s\S]*?)\]\);/.exec(app)?.[1] ?? '';
    for (const id of LEGAL_DOC_IDS) expect(restorable).toContain(`'${id}'`);
    expect(app).toContain('legalDocForPath(window.location.pathname)');
    expect(app).toContain('syncLegalPath(url, currentView)');
  });

  it('is served by the SPA fallback, and the Pages middleware passes these paths through untouched', () => {
    expect(read('../../public/_redirects')).toMatch(/^\/\*\s+\/index\.html\s+200$/m);
    const routes = JSON.parse(read('../../public/_routes.json')) as { exclude: string[] };
    for (const d of LEGAL_DOCS) expect(routes.exclude).not.toContain(d.path);
    const middleware = read('../../functions/_middleware.ts');
    for (const d of LEGAL_DOCS) expect(middleware).not.toContain(`'${d.path}'`);
  });
});
