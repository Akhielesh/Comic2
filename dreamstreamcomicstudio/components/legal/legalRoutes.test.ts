// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HISTORY_LAYERS_KEY } from '../comicstudio/mobile/backStack';
import {
  BACK_LAYERS_STATE_KEY,
  LEGAL_DOCS,
  LEGAL_DOC_IDS,
  LEGAL_ENTRY_STATE_KEY,
  isLegalDocId,
  keepLegalEntryMark,
  legalDocForPath,
  legalEntryState,
  legalPath,
  syncLegalPath,
  viewForHistoryEntry
} from './legalRoutes';

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

  it('reads the view a history entry names, the way App restores one from an address', () => {
    const restorable = (v: string, id: string | null) => ['gallery', 'settings', 'privacy'].includes(v) || (v === 'read' && !!id) || (v === 'editor' && id === 'p-open');
    const at = (href: string) => {
      const u = new URL(href, 'https://dreamstreamstudio.ai');
      return viewForHistoryEntry({ pathname: u.pathname, search: u.search }, restorable);
    };
    expect(at('/?view=gallery')).toEqual({ view: 'gallery' });
    expect(at('/?view=settings&tab=legal')).toEqual({ view: 'settings' });
    expect(at('/?view=privacy')).toEqual({ view: 'privacy' });
    expect(at('/share/tok-123')).toEqual({ view: 'shared', shareToken: 'tok-123' });
    expect(at('/models')).toEqual({ view: 'models' });
    expect(at('/')).toEqual({ view: 'home' });
    expect(at('/?newsletter=confirmed')).toEqual({ view: 'home' });
    // A reader or workspace entry carries its ?id= (App reopens that comic or project).
    expect(at('/?view=read&id=c1')).toEqual({ view: 'read', id: 'c1' });
    expect(at('/?view=editor&id=p-open')).toEqual({ view: 'editor', id: 'p-open' });
    // Not restorable, or not an address App restores a view from: the caller falls back.
    for (const href of ['/?view=read', '/?view=editor&id=p1', '/?view=auth', '/c/some-comic', '/auth/callback', '/share/a/b', '/models/x']) {
      expect(at(href), href).toBeNull();
    }
  });

  it('is wired into App.tsx: Back from a legal page restores the view the entry names, and header navigation adds one entry', () => {
    const app = read('../../App.tsx');
    const restore = app.slice(app.indexOf('const restoreViewFromHistory = () => {'), app.indexOf('const openLegal = '));
    expect(restore).toContain('RESTORABLE_VIEWS.has(v as AppView) ||');
    expect(restore).toContain("(v === 'auth' && !user) ||");
    // A reader entry reopens its comic, a workspace entry its project, a profile entry the profile.
    expect(restore).toContain("(v === 'read' && !!id) ||");
    expect(restore).toContain('void navigateToReader(entry.id, readerOrigin);');
    // Back to the comic the reader already has loaded shows it again: no fetch, no view counted, no loader.
    expect(restore).toMatch(/if \(entry\.id === activeProjectId && \(publicProject\?\.id === entry\.id \|\| projects\.some\(\(project\) => project\.id === entry\.id\)\)\) \{\s*setReturnView\(readerOrigin\);\s*setCurrentView\('reader'\);\s*return;\s*\}\s*void navigateToReader/);
    expect(restore).toContain('(!!studioViewFromUrlParam(v) && !!id) ||');
    expect(restore).toContain('if (entry.id === activeProjectId) setCurrentView(workspace);');
    expect(restore).toContain("else setPendingStudioTarget({ id: entry.id, view: workspace, source: 'id' });");
    expect(restore).toContain("(v === 'profile' && !!viewedProfile)");
    // Legal links outside the shared footer push the document's own entry: the reader's, once it has
    // left its layer (a /share/<token> entry is never rewritten to /privacy), in ComicReader and in
    // SharedViewer, and the Comics landing's, the home page's and the sign-up form's consent links
    // (legalEntryPoints.test.tsx renders those). None opens a document in place any more.
    expect(app).toMatch(/const openLegal = \(doc: LegalDocId\) => \(\) => \{\s*pushLegalPath\(doc\);\s*setCurrentView\(doc\);/);
    for (const component of ['ComicsLanding', 'HomePage', 'AuthPage', 'ComicReader', 'SharedViewer']) {
      const start = app.indexOf(`<${component}\n`);
      const props = app.slice(start, app.indexOf('/>', start));
      expect(start, component).toBeGreaterThan(-1);
      expect(props, component).toContain("onOpenPrivacy={openLegal('privacy')}");
      expect(props, component).toContain("onOpenTerms={openLegal('terms')}");
    }
    // The reader's footer (ComicReader, also inside SharedViewer) opens the other four documents through
    // openLegal too (ComicReader wraps it in leaveTo, so it runs after the reader left its layer).
    for (const component of ['ComicReader', 'SharedViewer']) {
      const start = app.indexOf(`<${component}\n`);
      expect(app.slice(start, app.indexOf('/>', start)), component).toContain('onOpenLegal={(doc) => openLegal(doc)()}');
    }
    expect(app.match(/onOpenPrivacy=\{openLegal\('privacy'\)\}/g)).toHaveLength(5);
    expect(app.match(/onOpenTerms=\{openLegal\('terms'\)\}/g)).toHaveLength(5);
    // Only the shared footer, which pushes the entry itself (LegalMicroLinks), still gets the bare setter.
    expect(app.match(/onOpenPrivacy=\{\(\) => setCurrentView\('privacy'\)\}/g)).toHaveLength(1);
    expect(app.match(/onOpenTerms=\{\(\) => setCurrentView\('terms'\)\}/g)).toHaveLength(1);
    // The address sync keeps a legal entry's mark (the page's Back button reads it).
    expect(app).toContain("window.history.replaceState(keepLegalEntryMark(window.history.state), '', url);")
    for (const page of ['PrivacyPolicy', 'TermsOfService', 'AcceptableUsePolicy', 'CopyrightPolicy', 'CookiesNotice', 'SubprocessorsPage']) {
      expect(app).toContain(`<${page} onBack={leaveLegalPage} onHistoryBack={restoreViewFromHistory} onOpenDoc={setCurrentView} />`);
    }
    // handleNavigate's top-level branch: exactly one pushState, and no clearReaderUrlParams() (it
    // pushed a duplicate entry first, which became a dead Back press on a legal page). The entry
    // being left keeps its ?view=, which is what Back restores.
    const branchStart = app.indexOf('isLegalDocId(view)\n    ) {');
    const branch = app.slice(branchStart, app.indexOf('const goToAuth', branchStart));
    expect(branchStart).toBeGreaterThan(-1);
    // One entry per move: a legal document's through pushLegalPath (marked; none for the document
    // already shown, none on a back-stack layer's entry), any other view's by one pushState.
    expect(branch).toContain("if (isLegalDocId(view)) pushLegalPath(view);\n        else window.history.pushState({}, '', url);");
    expect(branch.match(/pushState\(/g)).toHaveLength(1);
    expect(branch).not.toContain('clearReaderUrlParams(');
    expect(branch).not.toContain('replaceState(');
  });

  it('is wired into App.tsx: the stream-only hand-off and the date-of-birth prompt wait while a legal page is open', () => {
    const app = read('../../App.tsx');
    const redirectStart = app.indexOf('if (streamOnlyRedirectedRef.current) return;');
    const redirect = app.slice(redirectStart, app.indexOf('}, [', redirectStart) + 80);
    expect(redirectStart).toBeGreaterThan(-1);
    // Checked before the hand-off, and re-run when the view changes, so it happens once they leave the page.
    expect(redirect.indexOf('if (isOnLegalPage(currentView)) return;')).toBeGreaterThan(-1);
    expect(redirect.indexOf('if (isOnLegalPage(currentView)) return;')).toBeLessThan(redirect.indexOf("openLiveApp('/live.html'"));
    expect(redirect).toContain('}, [authLoading, user, isAdmin, allowedProducts, currentView]);');
    const dobStart = app.indexOf('if (!needsDobCompletion || hasPromptedDobThisSession) return;');
    const dob = app.slice(dobStart, app.indexOf("openSettings('profile');", dobStart));
    expect(dobStart).toBeGreaterThan(-1);
    expect(dob).toContain('if (isOnLegalPage(currentView)) return;');
  });

  it('marks an in-app legal entry, and the address sync keeps only that mark', () => {
    expect(legalEntryState()).toEqual({ [LEGAL_ENTRY_STATE_KEY]: true });
    expect(keepLegalEntryMark({ [LEGAL_ENTRY_STATE_KEY]: true, csLayers: ['reader:x'] })).toEqual({ [LEGAL_ENTRY_STATE_KEY]: true });
    for (const state of [null, undefined, {}, { csLayers: ['reader:x'] }, { [LEGAL_ENTRY_STATE_KEY]: 'yes' }, 'x']) expect(keepLegalEntryMark(state)).toEqual({});
  });

  it('reads the back stack\'s layers under the key the back stack writes them', () => {
    expect(BACK_LAYERS_STATE_KEY).toBe(HISTORY_LAYERS_KEY);
  });

  it('is served by the SPA fallback, and the Pages middleware passes these paths through untouched', () => {
    expect(read('../../public/_redirects')).toMatch(/^\/\*\s+\/index\.html\s+200$/m);
    const routes = JSON.parse(read('../../public/_routes.json')) as { exclude: string[] };
    for (const d of LEGAL_DOCS) expect(routes.exclude).not.toContain(d.path);
    const middleware = read('../../functions/_middleware.ts');
    for (const d of LEGAL_DOCS) expect(middleware).not.toContain(`'${d.path}'`);
  });
});
