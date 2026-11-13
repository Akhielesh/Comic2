// Comic Studio QA harness entry (P1-QA; mobile.md §10.2, visualqa.md §7).
//
// Built ONLY when QA_BUILD=1 (vite.config.ts `qaInput`) into dist-qa/; production dist/ never contains
// it. Mounts the REAL studio shell, board, page editor and readers on synthetic fixtures with the
// in-memory QA controller (components/comicstudio/testing/qaController.ts), so Playwright can measure
// real layout on every device without auth, a backend, money or flakiness.
//
//   /qa/comic-qa.html?surface=studio|board|editor|reader|classic-reader|public|kit
//                    &kit=breakdown|refs|refs-drawer|timeline|art     (surface=kit; qa/KitScenes.tsx)
//                    &fixture=lake-1p|heist-12p|deep-40p|webtoon-20p|stress|empty|chat-14
//                    &tab=pages&page=2&lang=en&theme=light|dark&state=idle|loading|streaming|…|queued|conflict
//                    &mode=easy|pro&rtl=1&public=ok|not-found|error|slow&img=png|svg&still=1&download=0&share=1
//                    &share=live|live-public  (a published comic, Link only / Library + link: the studio's Share sheet
//                                   opens on its link-first block; the link is on this origin, the preview has no picture)
//                    &history=1    (Comic History on: caps.history, and the studio surface answers History offline
//                                   from the fake HistoryApi over the synthetic 'v5' history fixture; absent: unchanged)
//                    &variants=0   (the fixture's pages and cover carry no stored 480w/1080w variants, as comics stored
//                                   before the server kept them: the reader has no stand-in; every surface, RD-A #12)
//                    &skin=atlas   (the page-level Atlas skin, as on the comics host: html[data-ds-skin];
//                                   the studio and reader roots carry the attribute regardless)
//                    &hf=route     (fetches to Hugging Face's hosts go on to the network, where the spec's own
//                                   Playwright route answers them with stand-ins; recorded as `net` {routed}.
//                                   Absent: refused like every other origin. studio.dictation.spec.ts)
//   /qa/comic-qa.html?surface=app[&scene=<id>]&theme=light|dark&skin=atlas|none
//                                 (DS-1b: the app-wide scenes, one page each, discovered by glob from
//                                  qa/app/scenes — qa/app/index.tsx holds the scene contract; no scene = the index)
//   /qa/comic-qa.html?surface=pro[&scene=<id>]
//                                 (the Pro Edit scenes: a placeholder in qa/pro/index.tsx until Program 2 fills it)
//
// Contract with the specs (tests/e2e):
//   html[data-qa-ready]   set once the surface mounted and fonts loaded (every surface)
//   window.__qa           { params, ready, pageCount, pageIds } (the Comic Studio surfaces)
//   window.__QA_APP_SCENES__  [{ id, title }] of every app scene (surface=app; the layout smoke reads it)
//   window.__qaOps        every controller call (patch/act/send/…) and every blocked network request
//   [data-qa-crash]       a render error (the spec fails with its message instead of timing out)
// The harness never reaches the network: /api/* is answered in-page (public comic payloads from the
// fixture, 503 for everything else) and any other cross-origin fetch is refused and recorded.

import React from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import './qa-fonts.css';
import { ComicStudioShell } from '../components/comicstudio/ComicStudio';
import { BoardPane } from '../components/comicstudio/board/BoardPane';
import { ComicReaderView } from '../components/comicstudio/reader/ComicReaderView';
import { PublicComicReader } from '../components/comicstudio/PublicComicReader';
import { ImmersiveReader } from '../components/comicstudio/immersive/ImmersiveReader';
import { QA_PROJECT_ID, qaImagePaths } from '../components/comicstudio/testing/qaFixtures';
import { HistoryApiProvider } from '../components/comicstudio/history/historyApi';
import { createFakeHistoryApi } from '../components/comicstudio/history/historyApi.fake';
import { historyFixture } from '../components/comicstudio/history/__scenes__/historyFixtures';
import { parseQaParams, QA_SURFACES, qaDocFromParams, qaImageUrl, qaSceneFromParams, recordQaOp, useQaController, type QaParams, type QaRuntimeInfo } from '../components/comicstudio/testing/qaController';
import { bootDsSkin } from '../services/dsSkin';
import { COMICS_HOST } from '../services/productHost';
import { KIT_SCENES, KitSurface, isKitScene } from './KitScenes';
import { QaAppSurface, type QaAppSkin } from './app/index';
import { QaProSurface } from './pro/index';

const FULL: React.CSSProperties = { height: '100dvh', width: '100%', overflow: 'hidden' };

// ── Surfaces and parameters ──────────────────────────────────────────────────

/** Every surface the harness mounts: Comic Studio's (qaController QA_SURFACES) and the app-wide ones (DS-1b). */
export const QA_HARNESS_SURFACES = [...QA_SURFACES, 'app', 'pro'] as const;
export type QaHarnessSurface = (typeof QA_HARNESS_SURFACES)[number];

/** The harness URL: the Comic Studio params, plus the app-wide surfaces with `scene=` and `skin=` (DS-1b). */
export type QaHarnessParams = Omit<QaParams, 'surface'> & {
  surface: QaHarnessSurface;
  /** surface=app|pro: the scene to mount (null: the index). */
  scene?: string | null;
  /** `skin=atlas` boots the page-level skin, `skin=none` keeps <html> unskinned; null leaves the boot default. */
  skin?: QaAppSkin | null;
};

/** Parse a harness URL: exactly parseQaParams for the Comic Studio surfaces, plus `surface=app|pro`, `scene=` and `skin=`. */
export const parseQaHarnessParams = (search: string, env: { webdriver?: boolean } = {}): QaHarnessParams => {
  const base = parseQaParams(search, env);
  const q = new URLSearchParams(search);
  const surface = q.get('surface');
  const scene = (q.get('scene') || '').trim().slice(0, 64);
  const skin = q.get('skin');
  return {
    ...base,
    surface: surface === 'app' || surface === 'pro' ? surface : base.surface,
    scene: scene || null,
    skin: skin === 'atlas' || skin === 'none' ? skin : null
  };
};

/** A Comic Studio surface (everything qaController knows), as opposed to the app-wide ones. */
const isStudioParams = (p: QaHarnessParams): p is QaParams => p.surface !== 'app' && p.surface !== 'pro';

// ── Network shim ─────────────────────────────────────────────────────────────

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const publicPayload = (params: Omit<QaParams, 'surface'>) => {
  const doc = qaDocFromParams(params);
  const urls: Record<string, string> = {};
  for (const path of qaImagePaths(doc)) {
    const url = qaImageUrl(path, params.img);
    if (url) urls[path] = url;
  }
  return { doc, urls };
};

/** Hugging Face and its file CDNs (huggingface.co, hf.co and their subdomains), where the voice model's weights live. */
const isHuggingFaceHost = (host: string) => ['huggingface.co', 'hf.co'].some((h) => host === h || host.endsWith(`.${h}`));

const installNetworkShim = (params: Omit<QaParams, 'surface'>) => {
  const realFetch = window.fetch.bind(window);
  // ?hf=route: the spec answers Hugging Face itself (route.fulfill), so its requests must reach the network layer.
  const routeHuggingFace = new URLSearchParams(window.location.search).get('hf') === 'route';
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let url: URL;
    try {
      url = new URL(raw, window.location.href);
    } catch {
      return realFetch(input, init);
    }
    const sameOrigin = url.origin === window.location.origin;
    if (url.pathname.startsWith('/api/')) {
      recordQaOp('net', { method: init?.method || 'GET', path: url.pathname });
      const pub = /^\/api\/comic\/public\/(s\/)?([^/]+)$/.exec(url.pathname);
      if (pub && (init?.method || 'GET').toUpperCase() === 'GET') {
        if (params.publicResult === 'slow') return new Promise<Response>(() => undefined);
        if (params.publicResult === 'not-found') return json(404, { error: { message: 'This comic is private or no longer exists.', code: 'NOT_FOUND' } });
        if (params.publicResult === 'error') return json(500, { error: { message: 'The comic could not be loaded right now.', code: 'INTERNAL' } });
        const payload = publicPayload(params);
        if (pub[1]) {
          return json(200, {
            publication: { slug: pub[2], title: payload.doc.brief.title, allowDownload: params.allowDownload, languages: [payload.doc.format.language], showCreator: false, publishedAt: payload.doc.updatedAt },
            ...payload
          });
        }
        return json(200, payload);
      }
      if (/\/event$/.test(url.pathname)) return new Response(null, { status: 204 });
      return json(503, { error: { message: 'QA harness: no backend (the studio never calls the network here).', code: 'NOT_AVAILABLE' } });
    }
    if (!sameOrigin && routeHuggingFace && url.protocol === 'https:' && isHuggingFaceHost(url.hostname)) {
      recordQaOp('net', { routed: url.origin + url.pathname });
      return realFetch(input, init);
    }
    if (!sameOrigin && !/^(data|blob):/.test(url.protocol)) {
      recordQaOp('net', { blocked: url.origin + url.pathname });
      return json(503, { error: { message: 'QA harness: external requests are disabled.' } });
    }
    return realFetch(input, init);
  };
};

// ── Surfaces ─────────────────────────────────────────────────────────────────

class CrashBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error('[qa] surface crashed:', error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" data-qa-crash={this.state.error.message.slice(0, 300)} style={{ padding: 16, fontFamily: 'system-ui', background: '#fff', color: '#7f1d1d' }}>
        QA surface crashed: {this.state.error.message}
      </div>
    );
  }
}

/**
 * `&history=1`: the studio's History panel reads the in-memory fake HistoryApi over the synthetic 'v5' history fixture
 * (a week of moments), so the layout harness can open and measure it with no backend. Only then: without the param
 * the tree is exactly the old one (no provider, and qaSceneFromParams leaves caps.history off).
 */
const QaHistory: React.FC<{ on: boolean; children: React.ReactNode }> = ({ on, children }) => {
  const api = React.useMemo(() => {
    if (!on) return null;
    const f = historyFixture('v5');
    return createFakeHistoryApi({ live: () => f.live, versions: f.versions });
  }, [on]);
  return api ? <HistoryApiProvider api={api}>{children}</HistoryApiProvider> : <>{children}</>;
};

const Studio: React.FC<{ params: QaParams }> = ({ params }) => {
  const studio = useQaController(React.useMemo(() => qaSceneFromParams(params), [params]));
  return (
    <QaHistory on={params.history}>
      <div style={FULL}>
        <ComicStudioShell studio={studio} onBack={() => recordQaOp('client', { type: 'back' })} />
      </div>
    </QaHistory>
  );
};

const Board: React.FC<{ params: QaParams }> = ({ params }) => {
  const studio = useQaController(React.useMemo(() => qaSceneFromParams(params), [params]));
  return (
    <div style={{ ...FULL, display: 'flex', flexDirection: 'column', background: 'var(--ds-well)' }}>
      <main id="qa-main" style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <BoardPane studio={studio} />
      </main>
    </div>
  );
};

const Reader: React.FC<{ params: QaParams; classic: boolean }> = ({ params, classic }) => {
  const studio = useQaController(React.useMemo(() => qaSceneFromParams(params), [params]));
  if (!studio.doc) return null;
  if (classic) {
    return (
      <div style={{ ...FULL, background: 'var(--ds-canvas)' }}>
        <main id="qa-main" style={{ height: '100%', minHeight: 0 }}>
          <ComicReaderView doc={studio.doc} urlFor={studio.urlFor} />
        </main>
      </div>
    );
  }
  return (
    <div style={FULL}>
      <main id="qa-main" style={{ height: '100%' }}>
        <ImmersiveReader
          doc={studio.doc}
          urlFor={studio.urlFor}
          initialPage={params.page ?? undefined}
          intro={false}
          allowDownload={params.allowDownload}
          // share=1: a published comic's link (same origin, never fetched — only handed to the share sheet).
          endCard={params.share ? { shareUrl: `${window.location.origin}/c/qa-${params.fixture}` } : undefined}
          onExit={() => recordQaOp('client', { type: 'exit_reader' })}
        />
      </main>
    </div>
  );
};

const StudioSurface: React.FC<{ params: QaParams }> = ({ params }) => {
  switch (params.surface) {
    case 'board':
      return <Board params={params} />;
    case 'reader':
      return <Reader params={params} classic={false} />;
    case 'classic-reader':
      return <Reader params={params} classic />;
    case 'kit':
      if (!isKitScene(params.kit)) throw new Error(`Unknown kit scene "${params.kit ?? ''}" (one of ${KIT_SCENES.join(', ')})`);
      return <KitSurface params={params} scene={params.kit} />;
    case 'public':
      return (
        <div style={FULL}>
          <PublicComicReader projectId={QA_PROJECT_ID} onClose={() => recordQaOp('client', { type: 'close_public' })} />
        </div>
      );
    case 'editor':
    case 'studio':
    default:
      return <Studio params={params} />;
  }
};

const Surface: React.FC<{ params: QaHarnessParams }> = ({ params }) => {
  if (isStudioParams(params)) return <StudioSurface params={params} />;
  if (params.surface === 'app') return <QaAppSurface scene={params.scene ?? null} theme={params.theme} skin={params.skin ?? null} />;
  return <QaProSurface params={{ ...params, surface: 'pro' }} scene={params.scene ?? null} />;
};

/**
 * The whole harness for one URL. Exported so a future Settings → Gallery "Comic Studio stress" entry can reuse it.
 * Takes Comic Studio params (parseQaParams) or harness params (parseQaHarnessParams, which adds the app-wide surfaces).
 */
export const ComicQaApp: React.FC<{ params: QaHarnessParams }> = ({ params }) => {
  React.useEffect(() => {
    let cancelled = false;
    const markReady = () => {
      if (cancelled) return;
      const layout = document.querySelector('[data-layout]')?.getAttribute('data-layout') || undefined;
      if (window.__qa) Object.assign(window.__qa, { ready: true, layout });
      document.documentElement.setAttribute('data-qa-ready', '1');
    };
    const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
    void Promise.resolve(fonts?.ready).finally(() => requestAnimationFrame(() => requestAnimationFrame(markReady)));
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <CrashBoundary>
      <Surface params={params} />
    </CrashBoundary>
  );
};

// ── Boot ─────────────────────────────────────────────────────────────────────

/** What boot() puts on <html> and window for one URL. */
export interface QaBootState {
  /** `.dark` on <html> (and the stored theme). */
  dark: boolean;
  /** `data-qa-still` on <html> (every duration zeroed, qa-fonts.css). */
  still: boolean;
  /** `?skin=atlas`: boot the page-level skin exactly as the comics host does (attribute, token registration, local font preloads). */
  atlasSkin: boolean;
  /** window.__qa: it describes a comic fixture, so only the Comic Studio surfaces get one (the app-wide surfaces publish __QA_APP_SCENES__). */
  qa?: QaRuntimeInfo;
}

/** The page state for one URL's params. Pure: boot() applies it, and the test checks it per surface. */
export const qaBootState = (params: QaHarnessParams): QaBootState => {
  const state: QaBootState = { dark: params.theme === 'dark', still: params.still, atlasSkin: params.skin === 'atlas' };
  if (isStudioParams(params)) {
    const doc = params.state === 'loading' || params.state === 'load-error' ? null : qaDocFromParams(params);
    state.qa = { params, ready: false, pageCount: doc?.pages.length ?? 0, pageIds: doc?.pages.map((p) => p.id) ?? [] };
  }
  return state;
};

const boot = () => {
  const el = document.getElementById('root');
  if (!el) return;
  const params = parseQaHarnessParams(window.location.search, { webdriver: navigator.webdriver === true });
  const state = qaBootState(params);
  try {
    window.localStorage.setItem('ds.theme.v1', params.theme);
  } catch {
    /* private mode: the class below still applies the theme */
  }
  document.documentElement.classList.toggle('dark', state.dark);
  if (state.still) document.documentElement.setAttribute('data-qa-still', '1');
  // Without ?skin=atlas only the studio/reader roots are skinned (the apex case).
  if (state.atlasSkin) bootDsSkin({ document, hostname: COMICS_HOST });
  window.__qaOps = window.__qaOps || [];
  if (state.qa) window.__qa = state.qa;
  installNetworkShim(params);
  createRoot(el).render(<ComicQaApp params={params} />);
};

boot();
