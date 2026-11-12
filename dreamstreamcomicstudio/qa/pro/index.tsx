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
// The layout smoke reads `window.__QA_PRO_SCENES__` (published while this surface is mounted), as it reads the app
// scenes. Phones: D7 shows Easy until this device has a stored choice (useStudioMode's `comicstudio.mode`), so the Pro
// scenes record "Pro" there first and the Easy scenes clear it. Only shell-pro-parts shows the coach cards (the others
// store every card as dismissed).
// Keep the export's name and props (the harness passes the parsed Comic Studio params with `surface: 'pro'`).

import React, { useEffect, useMemo, useState } from 'react';
import { cn } from '../../lib/utils';
import { CANVAS_BG, FOCUS_RING, HEADING, HOVER_ROW, INK, MUTED, OVERLINE } from '../../components/chat/studioDesign';
import type { QaParams } from '../../components/comicstudio/testing/qaController';
import { qaSceneFromParams, useQaController } from '../../components/comicstudio/testing/qaController';
import { PageEditor } from '../../components/comicstudio/board/PageEditor';
import { PRO_COACH_CARDS, PRO_COACH_KEY, ProPartsContext, partModule, type ProPartModule, type ProPanelProps } from '../../components/comicstudio/editor/useProEditor';
import { MODE_STORAGE_KEY } from '../../components/comicstudio/useStudioMode';
import type { ProEditPartId } from '../../shared/comic/pro/types';

/** The Pro Edit scenes this surface can mount. */
export const QA_PRO_SCENES = ['shell-easy', 'shell-pro', 'shell-pro-selected', 'shell-pro-parts', 'shell-flag-off'] as const;
export type QaProScene = (typeof QA_PRO_SCENES)[number];
export const isQaProScene = (v: unknown): v is QaProScene => typeof v === 'string' && (QA_PRO_SCENES as readonly string[]).includes(v);

/** One line per scene, for the index and the smoke's annotations. */
export const QA_PRO_SCENE_TITLES: Record<QaProScene, string> = {
  'shell-easy': 'Pro editor flag on, Easy view',
  'shell-pro': 'Pro view: tool rail and docked inspector',
  'shell-pro-selected': 'Pro view with a balloon selected (rotate and height handles)',
  'shell-pro-parts': 'Pro view with stand-in ready parts (inspector, layers, assets)',
  'shell-flag-off': 'Pro editor flag off (today’s editor)'
};

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
  const pro = scene !== 'shell-easy' && scene !== 'shell-flag-off';
  // Before the editor mounts: this device's last editor choice (D7) and the coach cards (only the parts scene shows them).
  useState(() => {
    store(MODE_STORAGE_KEY, pro ? 'pro' : null);
    store(PRO_COACH_KEY, scene === 'shell-pro-parts' ? null : JSON.stringify(PRO_COACH_CARDS.map((c) => c.id)));
    return true;
  });
  const init = useMemo(() => {
    const base = qaSceneFromParams({ ...params, surface: 'editor' });
    return { ...base, mode: pro ? ('pro' as const) : ('easy' as const), caps: { ...(base.caps || {}), proEditorV2: scene !== 'shell-flag-off' } };
  }, [params, scene, pro]);
  const studio = useQaController(init);
  const doc = studio.doc;
  const pageId = studio.focusedPageId;
  // shell-pro-selected: the first balloon is selected through the studio selection (the "Show me" path).
  useEffect(() => {
    if (scene !== 'shell-pro-selected' || !doc || !pageId) return;
    const page = doc.pages.find((p) => p.id === pageId);
    const first = page?.panels.flatMap((p) => p.lines).find((l) => l.text.trim());
    if (first) studio.setSelection({ pageId, lineIds: [first.id], surface: 'page_editor' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, doc?.id, pageId]);
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
