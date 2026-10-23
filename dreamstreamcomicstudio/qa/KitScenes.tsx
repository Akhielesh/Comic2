// Component scenes for the QA harness (P1-QA): `/qa/comic-qa.html?surface=kit&kit=<scene>`.
//
// The studio/board/editor/reader surfaces cover the real shell. These scenes mount single feature
// components that the shell only reaches after a few clicks (or after wave-2 wiring), on the same
// synthetic fixtures and the same recording controller, so the layout harness can measure them at
// 320–1440 px in both themes:
//   breakdown   BreakdownCard: Easy plan · Pro status (a busy page, a low-QC flag) · Pro cost ·
//               the compact gate subset · a stale cover
//   refs        RefStrip inside a cast card (+N, the sheet hint) and the RefsCard chat card
//   refs-drawer the RefsDrawer open on Maya with an offline upload transport: a file whose name
//               contains "slow" stays uploading, "bad" is rejected, "dup" comes back as a near
//               duplicate, anything else succeeds (the spec feeds real PNGs through the picker)
//   timeline    BookTimeline expanded and compact, the versions chat card
//   art         procedural art: every style preset thumbnail, every empty-state illustration,
//               layout glyphs and balloon previews (run it with theme=light and theme=dark)
// Nothing here talks to the network or spends; the upload transport is a local fake.

import React from 'react';
import { pageSpecHash, type Card, type ComicDoc, type Msg, type RefAsset, type RefOwner } from '../shared/comic/doc';
import { STYLE_PRESETS } from '../shared/comic/stylePresets';
import { BreakdownCard } from '../components/comicstudio/breakdown/BreakdownCard';
import { RefsCard } from '../components/comicstudio/refs/RefsCard';
import { RefsDrawer } from '../components/comicstudio/refs/RefsDrawer';
import { RefStrip } from '../components/comicstudio/refs/RefStrip';
import { RefUploadError, type UploadTransport } from '../components/comicstudio/refs/useRefUpload';
import { BookTimeline } from '../components/comicstudio/timeline/BookTimeline';
import { VersionsCard } from '../components/comicstudio/timeline/VersionsCard';
import { EmptyArt, type EmptyArtVariant } from '../components/comicstudio/library/procedural/EmptyArt';
import { PresetThumb } from '../components/comicstudio/library/procedural/PresetThumb';
import { LayoutGlyph } from '../components/comicstudio/library/procedural/LayoutGlyph';
import { BubblePreview } from '../components/comicstudio/library/procedural/BubblePreview';
import { QA_NOW, qaAsset } from '../components/comicstudio/testing/qaFixtures';
import { qaSceneFromParams, recordQaOp, useQaController, type QaParams } from '../components/comicstudio/testing/qaController';

export const KIT_SCENES = ['breakdown', 'refs', 'refs-drawer', 'timeline', 'art'] as const;
export type KitScene = (typeof KIT_SCENES)[number];
export const isKitScene = (v: unknown): v is KitScene => typeof v === 'string' && (KIT_SCENES as readonly string[]).includes(v);

const MSG: Msg = { id: 'm_kit', role: 'assistant', text: '', at: QA_NOW };

// ── Doc variants ─────────────────────────────────────────────────────────────

const clone = (d: ComicDoc): ComicDoc => JSON.parse(JSON.stringify(d)) as ComicDoc;

/** Pro status: page 1 drawn with a low QC score, page 2 rendering, page 3 failed, the cover stale. */
const statusDoc = (base: ComicDoc): ComicDoc => {
  const d = clone(base);
  const [p1, p2, p3] = d.pages;
  if (p1) {
    p1.render = {
      ...p1.render,
      status: 'ready',
      asset: p1.render.asset || qaAsset('kit-p1', 1237, 1856),
      specHash: pageSpecHash(d, p1),
      costUsd: 0.06,
      qc: { score: 0.31, issues: ['Arjun is missing from panel 2', 'Maya’s scarf changed from red to orange'], checkedAt: QA_NOW }
    };
  }
  if (p2) p2.render = { ...p2.render, status: 'rendering', updatedAt: QA_NOW };
  if (p3) p3.render = { ...p3.render, status: 'failed', error: 'The image model timed out after 90 s. Nothing was charged.' };
  d.cover = { ...d.cover, render: { ...d.cover.render, status: 'ready', specHash: 'stale0000' } };
  return d;
};

/** Every page planned (nothing drawn yet) — the Easy plan / gate view. */
const plannedDoc = (base: ComicDoc): ComicDoc => {
  const d = clone(base);
  for (const p of d.pages) p.render = { status: 'none', history: [] };
  d.cover = { ...d.cover, render: { status: 'none', history: [] } };
  return d;
};

const MAYA_REFS = (n: number): RefAsset[] =>
  Array.from({ length: n }, (_, i) => ({
    ...qaAsset(`maya-ref${i + 1}`, i % 3 === 0 ? 1000 : 800, i % 3 === 0 ? 800 : 1000),
    source: 'upload' as const,
    label: (['face', 'side', 'full_body', 'outfit', 'expression', 'pose', 'detail'] as const)[i % 7],
    name: `maya-${i + 1}.jpg`,
    note: i === 1 ? 'her festival outfit with the red scarf' : undefined
  }));

/** Maya gets `n` reference photos and a drawn sheet made from the first two (so newer photos show the hint). */
const refsDoc = (base: ComicDoc, n: number): { doc: ComicDoc; owner: RefOwner } => {
  const d = clone(base);
  const maya = d.cast[0];
  const refs = MAYA_REFS(n);
  maya.refs = refs;
  maya.sheet = { status: 'ready', history: [], asset: qaAsset('maya-sheet', 1600, 900), updatedAt: QA_NOW, refPaths: refs.slice(0, 2).map((r) => r.path) };
  return { doc: d, owner: { kind: 'character', id: maya.id } };
};

// ── Offline upload transport (refs-drawer) ───────────────────────────────────

/** Behaviour by file name: "slow" never finishes, "bad" is rejected, "dup" is a near duplicate. */
export const qaUploadTransport =
  (existing: () => string | undefined): UploadTransport =>
  ({ blob, params, onProgress, signal }) => {
    const name = (params.name || '').toLowerCase();
    recordQaOp('upload', { name: params.name, size: blob.size, to: params.to, label: params.label });
    if (name.includes('slow')) {
      onProgress(0.42);
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    }
    if (name.includes('bad')) return Promise.reject(new RefUploadError(422, "This image doesn't fit DreamStream's content rules, so it wasn't added.", 'CONTENT_POLICY'));
    onProgress(1);
    const ref: RefAsset = { ...qaAsset(`up-${name.replace(/[^a-z0-9]+/g, '-').slice(0, 24) || 'photo'}`, 800, 1000), source: 'upload', name: params.name };
    if (name.includes('dup')) {
      const of = existing();
      return Promise.resolve({ ref, ops: [], urls: {}, ...(of ? { notice: { kind: 'near_duplicate' as const, of } } : {}) });
    }
    return Promise.resolve({ ref, ops: [], urls: {} });
  };

// ── Scenes ───────────────────────────────────────────────────────────────────

const Frame: React.FC<{ title: string; testid: string; children: React.ReactNode; width?: number }> = ({ title, testid, children, width }) => (
  <section aria-label={title} data-testid={testid} style={{ width: '100%', maxWidth: width ?? 720, margin: '0 auto' }}>
    <h2 style={{ font: '600 12px/1.4 system-ui, sans-serif', color: 'var(--ds-muted)', margin: '0 0 6px', letterSpacing: '0.02em' }}>{title}</h2>
    {children}
  </section>
);

const BreakdownScene: React.FC<{ params: QaParams }> = ({ params }) => {
  const base = React.useMemo(() => qaSceneFromParams({ ...params, surface: 'studio' }).doc, [params]);
  const planned = React.useMemo(() => (base ? plannedDoc(base) : null), [base]);
  const status = React.useMemo(() => (base ? statusDoc(base) : null), [base]);
  const easy = useQaController({ doc: planned, mode: 'easy', img: params.img });
  const pro = useQaController({ doc: status, mode: 'pro', img: params.img });
  if (!planned || !status) return null;
  const pages = planned.pages.map((p) => p.id);
  const cards: Array<{ title: string; testid: string; card: Card; studio: typeof easy; compact?: boolean }> = [
    { title: 'Easy — the plan (cover + every page)', testid: 'kit-breakdown-plan', card: { type: 'breakdown', id: 'kb_plan', cover: true, view: 'plan' }, studio: easy },
    { title: 'Pro — status (a busy page, a low-QC flag, a failed page, a stale cover)', testid: 'kit-breakdown-status', card: { type: 'breakdown', id: 'kb_status', cover: true, view: 'status' }, studio: pro },
    { title: 'Pro — cost', testid: 'kit-breakdown-cost', card: { type: 'breakdown', id: 'kb_cost', cover: true, view: 'cost' }, studio: pro },
    { title: 'Compact — the gate subset', testid: 'kit-breakdown-gate', card: { type: 'breakdown', id: 'kb_gate', gateId: 'gate_qa', pageIds: pages.slice(1, 3) }, studio: easy, compact: true }
  ];
  return (
    <>
      {cards.map((c) => (
        <Frame key={c.testid} title={c.title} testid={c.testid}>
          <BreakdownCard card={c.card as Extract<Card, { type: 'breakdown' }>} message={MSG} studio={c.studio} compact={c.compact} />
        </Frame>
      ))}
    </>
  );
};

const RefsScene: React.FC<{ params: QaParams }> = ({ params }) => {
  const base = React.useMemo(() => qaSceneFromParams({ ...params, surface: 'studio' }).doc, [params]);
  const seeded = React.useMemo(() => (base ? refsDoc(base, 7) : null), [base]);
  const studio = useQaController({ doc: seeded?.doc ?? null, img: params.img });
  if (!seeded || !studio.doc) return null;
  const maya = studio.doc.cast[0];
  const transport = qaUploadTransport(() => maya.refs[0]?.path);
  return (
    <>
      <Frame title="RefStrip inside a cast card" testid="kit-refstrip" width={420}>
        <article className="rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-3">
          <p className="mb-2 text-[14px] font-semibold text-[var(--ds-ink)]">{maya.name}</p>
          <RefStrip studio={studio} owner={seeded.owner} transport={transport} />
        </article>
      </Frame>
      <Frame title="RefsCard (chat)" testid="kit-refscard" width={560}>
        <RefsCard card={{ type: 'refs', id: 'kr1', owner: seeded.owner, paths: maya.refs.slice(4).map((r) => r.path) }} message={MSG} studio={studio} />
      </Frame>
    </>
  );
};

const RefsDrawerScene: React.FC<{ params: QaParams }> = ({ params }) => {
  const base = React.useMemo(() => qaSceneFromParams({ ...params, surface: 'studio' }).doc, [params]);
  // 9 of 12: a 5-file pick fills the last 3 slots and the rest are over the cap.
  const seeded = React.useMemo(() => (base ? refsDoc(base, 9) : null), [base]);
  const studio = useQaController({ doc: seeded?.doc ?? null, img: params.img });
  const [open, setOpen] = React.useState(true);
  if (!seeded || !studio.doc) return null;
  const first = studio.doc.cast[0]?.refs[0]?.path;
  return (
    <>
      <button type="button" className="m-4 min-h-[44px] rounded-xl border border-[var(--ds-hairline)] px-4 text-[var(--ds-ink)]" onClick={() => setOpen(true)}>
        Open Maya’s photos
      </button>
      <RefsDrawer
        studio={studio}
        owner={seeded.owner}
        open={open}
        onClose={() => {
          recordQaOp('client', { type: 'close_refs' });
          setOpen(false);
        }}
        transport={qaUploadTransport(() => first)}
      />
    </>
  );
};

const TimelineScene: React.FC<{ params: QaParams }> = ({ params }) => {
  const scene = React.useMemo(() => qaSceneFromParams({ ...params, surface: 'studio' }), [params]);
  const studio = useQaController(scene);
  const doc = studio.doc;
  if (!doc) return null;
  const drawn = doc.pages.find((p) => p.render.status === 'ready') || doc.pages[0];
  return (
    <>
      <Frame title="Book timeline (dock)" testid="kit-timeline" width={1400}>
        <div className="rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)]">
          <BookTimeline studio={studio} />
        </div>
      </Frame>
      <Frame title="Book timeline (compact)" testid="kit-timeline-compact" width={1400}>
        <div className="rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)]">
          <BookTimeline studio={studio} compact />
        </div>
      </Frame>
      {drawn && (
        <Frame title="Versions card (chat)" testid="kit-versions" width={560}>
          <VersionsCard card={{ type: 'versions', id: 'kv1', target: { kind: 'page', id: drawn.id } }} message={MSG} studio={studio} />
        </Frame>
      )}
    </>
  );
};

const EMPTY_VARIANTS: EmptyArtVariant[] = ['pages', 'cast', 'style', 'reader', 'studio', 'media'];

const ArtScene: React.FC<{ params: QaParams }> = ({ params }) => {
  const doc = React.useMemo(() => qaSceneFromParams({ ...params, surface: 'studio' }).doc, [params]);
  const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))', gap: 12 };
  return (
    <>
      <Frame title={`Style presets (${STYLE_PRESETS.length})`} testid="kit-presets" width={1200}>
        <ul style={{ ...grid, listStyle: 'none', margin: 0, padding: 0 }}>
          {STYLE_PRESETS.map((p) => (
            <li key={p.id} data-preset={p.id} style={{ minWidth: 0 }}>
              <PresetThumb preset={p} />
              <p className="mt-1 truncate text-[12px] text-[var(--ds-ink)]">{p.name}</p>
            </li>
          ))}
        </ul>
      </Frame>
      <Frame title="Empty states" testid="kit-empty" width={1200}>
        <ul style={{ ...grid, gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', listStyle: 'none', margin: 0, padding: 0 }}>
          {EMPTY_VARIANTS.map((v) => (
            <li key={v} data-empty={v} className="rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-2" style={{ minWidth: 0 }}>
              <EmptyArt variant={v} />
            </li>
          ))}
        </ul>
      </Frame>
      {doc && (
        <Frame title="Layout glyphs and balloon previews" testid="kit-glyphs" width={1200}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
            {doc.pages.slice(0, 6).map((p) => (
              <LayoutGlyph key={p.id} page={p} aspect={doc.format.pageAspect} size={p.n % 2 ? 28 : 56} />
            ))}
            {(['speech', 'thought', 'caption', 'sfx'] as const).map((k) => (
              <BubblePreview key={k} kind={k} style={{}} size={56} />
            ))}
          </div>
        </Frame>
      )}
    </>
  );
};

/** The kit surface: one scene per URL, inside a scrolling <main>. */
export const KitSurface: React.FC<{ params: QaParams; scene: KitScene }> = ({ params, scene }) => (
  <div style={{ height: '100dvh', width: '100%', overflow: 'hidden', background: 'var(--ds-canvas)' }}>
    <main id="qa-main" aria-label={`QA kit: ${scene}`} data-kit={scene} style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden', padding: 'calc(var(--sa-top, 0px) + 12px) 12px calc(var(--sa-bottom, 0px) + 24px)', display: 'flex', flexDirection: 'column', gap: 20 }}>
      {scene === 'breakdown' && <BreakdownScene params={params} />}
      {scene === 'refs' && <RefsScene params={params} />}
      {scene === 'refs-drawer' && <RefsDrawerScene params={params} />}
      {scene === 'timeline' && <TimelineScene params={params} />}
      {scene === 'art' && <ArtScene params={params} />}
    </main>
  </div>
);
