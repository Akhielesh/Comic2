// Comic Studio QA harness entry (P1-QA; mobile.md §10.2, visualqa.md §7).
//
// Built ONLY when QA_BUILD=1 (vite.config.ts `qaInput`) into dist-qa/; production dist/ never contains
// it. Mounts the REAL studio shell, board, page editor and readers on synthetic fixtures with the
// in-memory QA controller (components/comicstudio/testing/qaController.ts), so Playwright can measure
// real layout on every device without auth, a backend, money or flakiness.
//
//   /qa/comic-qa.html?surface=studio|board|editor|reader|classic-reader|public|kit
//                    &kit=breakdown|refs|refs-drawer|timeline|art     (surface=kit; qa/KitScenes.tsx)
//                    &fixture=lake-1p|heist-12p|deep-40p|webtoon-20p|stress|empty
//                    &tab=pages&page=2&lang=en&theme=light|dark&state=idle|loading|streaming|…
//                    &mode=easy|pro&rtl=1&public=ok|not-found|error|slow&img=png|svg&still=1&download=0&share=1
//
// Contract with the specs (tests/e2e):
//   html[data-qa-ready]   set once the surface mounted and fonts loaded
//   window.__qa           { params, ready, pageCount, pageIds }
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
import { QA_PROJECT_ID, makeQaDoc, qaImagePaths } from '../components/comicstudio/testing/qaFixtures';
import { parseQaParams, qaImageUrl, qaSceneFromParams, recordQaOp, useQaController, type QaParams } from '../components/comicstudio/testing/qaController';
import { KIT_SCENES, KitSurface, isKitScene } from './KitScenes';

const FULL: React.CSSProperties = { height: '100dvh', width: '100%', overflow: 'hidden' };

// ── Network shim ─────────────────────────────────────────────────────────────

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const publicPayload = (params: QaParams) => {
  const doc = makeQaDoc(params.fixture, { rtl: params.rtl });
  const urls: Record<string, string> = {};
  for (const path of qaImagePaths(doc)) {
    const url = qaImageUrl(path, params.img);
    if (url) urls[path] = url;
  }
  return { doc, urls };
};

const installNetworkShim = (params: QaParams) => {
  const realFetch = window.fetch.bind(window);
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

const Studio: React.FC<{ params: QaParams }> = ({ params }) => {
  const studio = useQaController(React.useMemo(() => qaSceneFromParams(params), [params]));
  return (
    <div style={FULL}>
      <ComicStudioShell studio={studio} onBack={() => recordQaOp('client', { type: 'back' })} />
    </div>
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

const Surface: React.FC<{ params: QaParams }> = ({ params }) => {
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

/** The whole harness for one URL. Exported so a future Settings → Gallery "Comic Studio stress" entry can reuse it. */
export const ComicQaApp: React.FC<{ params: QaParams }> = ({ params }) => {
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

const boot = () => {
  const el = document.getElementById('root');
  if (!el) return;
  const params = parseQaParams(window.location.search, { webdriver: navigator.webdriver === true });
  try {
    window.localStorage.setItem('ds.theme.v1', params.theme);
  } catch {
    /* private mode: the class below still applies the theme */
  }
  document.documentElement.classList.toggle('dark', params.theme === 'dark');
  if (params.still) document.documentElement.setAttribute('data-qa-still', '1');
  window.__qaOps = window.__qaOps || [];
  const doc = params.state === 'loading' || params.state === 'load-error' ? null : makeQaDoc(params.fixture, { rtl: params.rtl });
  window.__qa = { params, ready: false, pageCount: doc?.pages.length ?? 0, pageIds: doc?.pages.map((p) => p.id) ?? [] };
  installNetworkShim(params);
  createRoot(el).render(<ComicQaApp params={params} />);
};

boot();
