// Pro Edit QA surface (DS-1b stub filled by PE-SHELL; master plan §1.3 DS-1b and §3.2: Program 2 owns qa/pro/** from S2):
//
//   /qa/comic-qa.html?surface=pro                          the scene index (one link per scene)
//   /qa/comic-qa.html?surface=pro&scene=<id>[&fixture=…&page=n&theme=light|dark&skin=atlas|none]
//
// Each scene mounts the REAL page editor on a synthetic fixture with the in-memory QA controller (no network, no
// spend), with COMIC_PRO_EDITOR_V2 on unless the scene says otherwise:
//
//   shell-easy           the flag on, Easy: today's editor plus the header Easy | Pro switch
//   shell-pro            Pro: the tool rail, the docked inspector (≥ 1024 px), the tool row (tablets), the phone bar
//   shell-pro-selected   Pro with the first balloon selected: rotate and height handles, the lettering panel
//   shell-pro-parts      Pro with stand-in READY parts (inspector, layers, assets), so the dock, the 1440 px left rail,
//                        the phone Layers button and the coach cards can be measured before PE-INSPECT / PE-ASSETS land
//   shell-flag-off       the flag off: exactly today's editor (the comparison scene)
//
// Requested by the packages that build on the shell (added at the S2b integration, after PE-INSPECT merged; the real
// inspector and layers parts are mounted, and PRO_EDIT_OPS_PATCHABLE stays off, so no Pro control renders — C-9):
//
//   pro-inspector-docked   Pro with the first balloon selected: the docked inspector (PE-INSPECT #7; 1280x800 in the smoke)
//   pro-inspector-empty    Pro with nothing selected: the inspector's empty state (PE-INSPECT #7)
//   pro-layers             Pro with Layers open (the 1440 rail; the phone sheet opens itself): a "Director is editing"
//                          badge on the first balloon and one empty panel group (PE-INSPECT #7)
//   compose-panels         heist-12p page 1 in frames, one border look per frame, one overlay of each kind and a multiply
//                          blend clipped to a panel, in the editor (PE-COMPOSE #6)
//   compose-panels-reader  the same page as a reader draws it (no guides, no editor)
//   pro-looks              one reader page per Pro look: a turned, taller balloon, a turned linked pair, a Pro SFX effect
//                          per page (all five across the pages) and a gradient on a warped line (PE-LETTER #18)
//
// The layout smoke reads `window.__QA_PRO_SCENES__` (published while this surface is mounted), as it reads the app
// scenes. Phones: D7 shows Easy until this device has a stored choice (useStudioMode's `comicstudio.mode`), so the Pro
// scenes record "Pro" there first and the Easy scenes clear it. Only shell-pro-parts shows the coach cards (the others
// store every card as dismissed).
// Keep the export's name and props (the harness passes the parsed Comic Studio params with `surface: 'pro'`).

import React, { useEffect, useMemo, useState } from 'react';
import type { ComicDoc, Line, Page, PageLayer } from '../../shared/comic/doc';
import { PANEL_BORDER_STYLES } from '../../shared/comic/doc';
import { DRAWN_PRO_SFX_EFFECTS, PRO_LETTERING_PRESET_IDS, letteringPresetOf, type LetterStylePatch } from '../../shared/comic/lettering/style';
import { cn } from '../../lib/utils';
import { CANVAS_BG, FOCUS_RING, HEADING, HOVER_ROW, INK, MUTED, OVERLINE } from '../../components/chat/studioDesign';
import type { QaParams } from '../../components/comicstudio/testing/qaController';
import { qaSceneFromParams, useQaController } from '../../components/comicstudio/testing/qaController';
import { PageEditor } from '../../components/comicstudio/board/PageEditor';
import { ComicPageView } from '../../components/comicstudio/board/ComicPageView';
import { LAYERS, framedDoc } from '../../components/comicstudio/compose/__fixtures__/composeDocs';
import type { ComicStudioController } from '../../components/comicstudio/useStudio';
import { PRO_COACH_CARDS, PRO_COACH_KEY, ProPartsContext, partModule, type ProPartModule, type ProPanelProps } from '../../components/comicstudio/editor/useProEditor';
import { MODE_STORAGE_KEY } from '../../components/comicstudio/useStudioMode';
import type { ProEditPartId } from '../../shared/comic/pro/types';

/** The Pro Edit scenes this surface can mount. */
export const QA_PRO_SCENES = [
  'shell-easy',
  'shell-pro',
  'shell-pro-selected',
  'shell-pro-parts',
  'shell-flag-off',
  'pro-inspector-docked',
  'pro-inspector-empty',
  'pro-layers',
  'compose-panels',
  'compose-panels-reader',
  'pro-looks'
] as const;
export type QaProScene = (typeof QA_PRO_SCENES)[number];
export const isQaProScene = (v: unknown): v is QaProScene => typeof v === 'string' && (QA_PRO_SCENES as readonly string[]).includes(v);

/** One line per scene, for the index and the smoke's annotations. */
export const QA_PRO_SCENE_TITLES: Record<QaProScene, string> = {
  'shell-easy': 'Pro editor flag on, Easy view',
  'shell-pro': 'Pro view: tool rail and docked inspector',
  'shell-pro-selected': 'Pro view with a balloon selected (rotate and height handles)',
  'shell-pro-parts': 'Pro view with stand-in ready parts (inspector, layers, assets)',
  'shell-flag-off': 'Pro editor flag off (today’s editor)',
  'pro-inspector-docked': 'Pro view: the docked inspector with a balloon selected',
  'pro-inspector-empty': 'Pro view: the docked inspector with nothing selected',
  'pro-layers': 'Pro view: Layers open, a Director-is-editing badge and an empty panel group',
  'compose-panels': 'A composed page in frames with every overlay kind, in the editor',
  'compose-panels-reader': 'The same composed page as a reader sees it',
  'pro-looks': 'One page per Pro lettering look, with turned, linked and SFX balloons'
};

/** Scenes that mount the editor in Pro (the rest: Easy, the flag off, or a reader view). */
const PRO_EDITOR_SCENES: ReadonlySet<QaProScene> = new Set<QaProScene>(['shell-pro', 'shell-pro-selected', 'shell-pro-parts', 'pro-inspector-docked', 'pro-inspector-empty', 'pro-layers', 'compose-panels']);
/** Scenes that open with the first balloon selected. */
const SELECTED_SCENES: ReadonlySet<QaProScene> = new Set<QaProScene>(['shell-pro-selected', 'pro-inspector-docked']);
/** Scenes that draw pages the way a reader sees them (no editor). */
const READER_SCENES: ReadonlySet<QaProScene> = new Set<QaProScene>(['compose-panels-reader', 'pro-looks']);

declare global {
  interface Window {
    __QA_PRO_SCENES__?: Array<{ id: string; title: string }>;
  }
}

/** What the harness hands the Pro surface: the parsed Comic Studio params (fixture, theme, mode, …), on surface 'pro'. */
export type QaProParams = Omit<QaParams, 'surface'> & { surface: 'pro' };

// ── Stand-in parts (QA only): labelled as such, built from the panel props the shell hands every part ──

const StubPanel: React.FC<ProPanelProps & { title: string }> = ({ title, page, selection, footer }) => (
  <div className="flex min-w-0 flex-col gap-2" data-qa-stub-part={title}>
    <p className={cn('m-0', OVERLINE)}>{title} · QA stand-in</p>
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {page.panels.flatMap((p) => p.lines).filter((l) => l.text.trim()).slice(0, 12).map((l) => (
        <li key={l.id}>
          <button
            type="button"
            onClick={() => selection.set([l.id])}
            aria-pressed={selection.ids.includes(l.id)}
            className={`${cn('flex h-8 w-full min-w-0 items-center px-2 text-left text-[12px] coarse:h-11', HOVER_ROW, INK)} ${FOCUS_RING}`}
          >
            <span className="min-w-0 truncate">{l.text}</span>
          </button>
        </li>
      ))}
    </ul>
    <p className={cn('m-0 text-[11px]', MUTED)}>{footer}</p>
  </div>
);

const stubModule = (id: ProEditPartId, title: string): ProPartModule => ({
  part: { id, ready: true },
  Panel: (props: ProPanelProps) => <StubPanel {...props} title={title} />
});
const STUBS: Partial<Record<ProEditPartId, ProPartModule>> = {
  inspector: stubModule('inspector', 'Properties'),
  layers: stubModule('layers', 'Layers'),
  assets: stubModule('assets', 'Assets')
};
const readStubs = (id: ProEditPartId): ProPartModule => STUBS[id] ?? partModule(id);

// ── Scene documents (synthetic; built in memory, nothing is saved) ─────────────

/** The last panel of the page loses its lines (and their balloons): an empty panel group in Layers. */
const withEmptyPanel = (doc: ComicDoc, pageId: string | null | undefined): ComicDoc => ({
  ...doc,
  pages: doc.pages.map((p) => {
    if (p.id !== pageId || p.panels.length < 2) return p;
    const last = p.panels[p.panels.length - 1];
    const gone = new Set(last.lines.map((l) => l.id));
    return { ...p, panels: p.panels.map((panel) => (panel.id === last.id ? { ...panel, lines: [] } : panel)), balloons: (p.balloons || []).filter((b) => !gone.has(b.lineId)) };
  })
});

/** heist-12p page 1 in frames: one border look per frame (cycling), one overlay of each kind, a multiply blend in a panel. */
const composeDoc = (): ComicDoc =>
  framedDoc((page: Page) => {
    page.panels = page.panels.map((panel, i) => ({ ...panel, frame: { ...panel.frame!, border: { style: PANEL_BORDER_STYLES[i % PANEL_BORDER_STYLES.length], seed: i + 1 } } }));
    const first = page.panels[0];
    const inPanel: PageLayer = { ...LAYERS.blend, id: 'ly_tone_in_panel', box: first.frame!.box, clip: first.id };
    page.layers = [LAYERS.image, LAYERS.sticker, LAYERS.shape, LAYERS.effect, LAYERS.blend, inPanel];
  });

/** A gradient between the look's own text and stroke colours (no colour of its own), on an arc warp. */
const gradientWarp = (presetId: string): LetterStylePatch => {
  const base = letteringPresetOf(presetId).base;
  return { fillGradient: { from: base.textColor, to: base.textStroke?.color ?? base.border, angle: 30 }, warp: 'arc', warpAmount: 0.5 } as LetterStylePatch;
};

/** One Pro look's page: the first balloon turned and taller, the next two linked and turned (the chain head carries
 *  the turn), one Pro SFX effect, and a gradient on a warped line. */
const lookDoc = (base: ComicDoc, lookIndex: number): ComicDoc => {
  const presetId = PRO_LETTERING_PRESET_IDS[lookIndex];
  const effect = DRAWN_PRO_SFX_EFFECTS[lookIndex % DRAWN_PRO_SFX_EFFECTS.length];
  const page = base.pages[0];
  const lines = page.panels.flatMap((p) => p.lines);
  const [first, head, member] = lines;
  const lastPanel = page.panels[page.panels.length - 1];
  const sfx: Line = { id: `${lastPanel.id}_sfx`, kind: 'sfx', text: 'KRAK!', style: { sfxEffect: effect } as unknown as LetterStylePatch } as Line;
  const warped = lines[lines.length - 1];
  const balloons = (page.balloons || []).map((b) => {
    if (first && b.lineId === first.id) return { ...b, rot: 12, minH: 0.14, pinned: true };
    if (head && b.lineId === head.id) return { ...b, rot: -8, pinned: true };
    if (member && b.lineId === member.id) return { ...b, linkTo: head?.id, pinned: true };
    return b;
  });
  const panels = page.panels.map((panel) => ({
    ...panel,
    lines: [
      ...panel.lines.map((l) => (warped && l.id === warped.id ? { ...l, style: { ...(l.style || {}), ...gradientWarp(presetId) } } : l)),
      ...(panel.id === lastPanel.id ? [sfx] : [])
    ]
  }));
  return { ...base, letterStyle: { ...(base.letterStyle || {}), presetId } as unknown as ComicDoc['letterStyle'], pages: [{ ...page, panels, balloons }] };
};

// ── Scenes ──────────────────────────────────────────────────────────────────

const store = (key: string, value: string | null) => {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* private mode: the scene still mounts */
  }
};

const ProScene: React.FC<{ params: QaProParams; scene: QaProScene }> = ({ params, scene }) => {
  const pro = PRO_EDITOR_SCENES.has(scene);
  // Before the editor mounts: this device's last editor choice (D7) and the coach cards (only the parts scene shows them).
  useState(() => {
    store(MODE_STORAGE_KEY, pro ? 'pro' : null);
    store(PRO_COACH_KEY, scene === 'shell-pro-parts' ? null : JSON.stringify(PRO_COACH_CARDS.map((c) => c.id)));
    return true;
  });
  const init = useMemo(() => {
    const base = qaSceneFromParams({ ...params, surface: 'editor' });
    const composed = scene === 'compose-panels' || scene === 'compose-panels-reader' ? composeDoc() : null;
    const doc = composed ?? (scene === 'pro-layers' && base.doc ? withEmptyPanel(base.doc, base.focusedPageId) : base.doc);
    const focusedPageId = composed ? composed.pages[0].id : base.focusedPageId;
    return { ...base, doc, focusedPageId, mode: pro ? ('pro' as const) : ('easy' as const), caps: { ...(base.caps || {}), proEditorV2: scene !== 'shell-flag-off' } };
  }, [params, scene, pro]);
  const qa = useQaController(init);
  // pro-layers: the director is editing the first balloon (the badge on its Layers row and the presence outline).
  const presenceLine = scene === 'pro-layers' ? qa.doc?.pages.find((p) => p.id === qa.focusedPageId)?.panels.flatMap((p) => p.lines)[0]?.id : undefined;
  const studio: ComicStudioController = useMemo(
    () => (presenceLine ? { ...qa, presence: { pageId: qa.focusedPageId ?? undefined, lineIds: [presenceLine], label: 'Moving a balloon', at: 0 } } : qa),
    [qa, presenceLine]
  );
  const doc = studio.doc;
  const pageId = studio.focusedPageId;
  // shell-pro-selected, pro-inspector-docked: the first balloon is selected through the studio selection (the "Show me" path).
  useEffect(() => {
    if (!SELECTED_SCENES.has(scene) || !doc || !pageId) return;
    const page = doc.pages.find((p) => p.id === pageId);
    const first = page?.panels.flatMap((p) => p.lines).find((l) => l.text.trim());
    if (first) studio.setSelection({ pageId, lineIds: [first.id], surface: 'page_editor' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, doc?.id, pageId]);
  // pro-layers: open Layers wherever this width keeps it, once the (lazy) Pro view is there — the phone bar's sheet, the
  // 768 tablet's drawer, or the docked inspector's Layers tab (1024–1439). The 1440 rail shows Layers by itself.
  useEffect(() => {
    if (scene !== 'pro-layers') return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      if (document.querySelector('[data-testid="pro-layers-sheet"], [data-testid="pro-left-rail"]')) return;
      const button = document.querySelector<HTMLButtonElement>('[data-testid="toolbar-layers"], [data-testid="pro-drawer-layers"]');
      const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.trim() === 'Layers');
      if (button && button.getAttribute('aria-expanded') !== 'true' && button.getAttribute('aria-pressed') !== 'true') {
        button.click();
        return;
      }
      if (tab) {
        // The scene stands in for the user's tap, so the tab's own colour fade (a response to a press) is held still for
        // that one switch: the smoke's reduced-motion probe counts only what the page starts by itself.
        if (tab.getAttribute('aria-selected') !== 'true') {
          const still = document.createElement('style');
          still.textContent = '[role="tab"]{transition:none!important}';
          document.head.appendChild(still);
          tab.click();
          requestAnimationFrame(() => requestAnimationFrame(() => still.remove()));
        }
        return;
      }
      tries += 1;
      if (tries < 60) timer = setTimeout(open, 50);
    };
    open();
    return () => timer && clearTimeout(timer);
  }, [scene]);
  if (READER_SCENES.has(scene)) return <ReaderScene params={params} scene={scene} studio={studio} />;
  return (
    <main id="qa-main" aria-labelledby="qa-pro-scene-title" data-qa-pro-scene={scene} data-qa-surface={params.surface} className={cn('min-h-[100dvh] min-w-0', CANVAS_BG, INK)}>
      <h1 id="qa-pro-scene-title" className="sr-only">
        {QA_PRO_SCENE_TITLES[scene]}
      </h1>
      {doc && pageId ? (
        <ProPartsContext.Provider value={scene === 'shell-pro-parts' ? readStubs : null}>
          <PageEditor studio={studio} doc={doc} pageId={pageId} />
        </ProPartsContext.Provider>
      ) : (
        <p className={cn('m-0 px-4 py-6 text-[length:var(--ds-text-sm)]', MUTED)}>This fixture has no page to edit.</p>
      )}
    </main>
  );
};

/** The reader-side scenes: pages drawn as a reader draws them (ComicPageView without guides or the editor). */
const ReaderScene: React.FC<{ params: QaProParams; scene: QaProScene; studio: ComicStudioController }> = ({ params, scene, studio }) => {
  const doc = studio.doc;
  const pages = useMemo(() => {
    if (!doc) return [];
    if (scene === 'pro-looks') {
      return PRO_LETTERING_PRESET_IDS.map((id, i) => {
        const d = lookDoc(doc, i);
        return { key: id, title: letteringPresetOf(id).name, doc: d, page: d.pages[0] };
      });
    }
    const page = doc.pages.find((p) => p.id === studio.focusedPageId) ?? doc.pages[0];
    return page ? [{ key: page.id, title: `Page ${page.n}`, doc, page }] : [];
  }, [doc, scene, studio.focusedPageId]);
  const urlForPath = (path: string, widthPx?: number) => studio.urlFor(path, widthPx ? { width: widthPx } : undefined);
  return (
    <main id="qa-main" aria-labelledby="qa-pro-scene-title" data-qa-pro-scene={scene} data-qa-surface={params.surface} className={cn('min-h-[100dvh] min-w-0 px-4 py-4', CANVAS_BG, INK)}>
      <h1 id="qa-pro-scene-title" className="sr-only">
        {QA_PRO_SCENE_TITLES[scene]}
      </h1>
      <ul className="m-0 grid min-w-0 list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
        {pages.map((p) => (
          <li key={p.key} className="flex min-w-0 flex-col gap-1" data-qa-pro-page={p.key}>
            <h2 className={cn('m-0', OVERLINE)}>{p.title}</h2>
            <ComicPageView doc={p.doc} page={p.page} imageUrl={studio.urlFor(p.page.render.asset)} urlForPath={urlForPath} paper />
          </li>
        ))}
      </ul>
    </main>
  );
};

const Index: React.FC<{ params: QaProParams; unknown: string | null }> = ({ params, unknown }) => (
  <main id="qa-main" aria-labelledby="qa-pro-title" data-qa-pro="index" data-qa-surface={params.surface} className={cn('min-h-[100dvh] min-w-0 px-4 py-6 sm:px-6', CANVAS_BG, INK)}>
    <div className="mx-auto flex max-w-3xl min-w-0 flex-col gap-2">
      <p className={cn('m-0', OVERLINE)}>QA harness</p>
      <h1 id="qa-pro-title" className={cn('m-0 text-[length:var(--ds-text-lg)]', HEADING)}>
        Pro Edit scenes
      </h1>
      {unknown && <p className={cn('m-0 text-[length:var(--ds-text-sm)] [overflow-wrap:anywhere]', MUTED)}>No Pro Edit scene named “{unknown}”. Pick one below.</p>}
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {QA_PRO_SCENES.map((id) => (
          <li key={id}>
            <a href={`?surface=pro&scene=${id}`} data-qa-pro-scene-link={id} className={`${cn('flex min-h-11 min-w-0 flex-col justify-center px-3 py-2', HOVER_ROW)} ${FOCUS_RING}`}>
              <span className="text-[13px] font-semibold">{id}</span>
              <span className={cn('text-[12px] [overflow-wrap:anywhere]', MUTED)}>{QA_PRO_SCENE_TITLES[id]}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  </main>
);

export const QaProSurface: React.FC<{ params: QaProParams; scene: string | null }> = ({ params, scene }) => {
  useEffect(() => {
    window.__QA_PRO_SCENES__ = QA_PRO_SCENES.map((id) => ({ id, title: QA_PRO_SCENE_TITLES[id] }));
  }, []);
  if (scene && isQaProScene(scene)) return <ProScene params={params} scene={scene} />;
  return <Index params={params} unknown={scene} />;
};
