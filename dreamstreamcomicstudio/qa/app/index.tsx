// App-wide QA surface (DS-1b; master plan §1.3 DS-1b, §1.4 layout smoke):
//
//   /qa/comic-qa.html?surface=app                    the scene index (one link per scene)
//   /qa/comic-qa.html?surface=app&scene=<id>         one scene, as a whole page
//                    &theme=light|dark               `.dark` on <html> (services/theme.ts's class)
//                    &skin=atlas|none                html[data-ds-skin="atlas"] as on the comics host / removed
//
// Scene contract (shared by every package that adds a scene): each file `qa/app/scenes/<id>.tsx`
// default-exports `{ id, title, Scene }` (QaAppScene below) with `id` equal to the file name. A scene is a
// whole page: it paints its own canvas and renders exactly ONE `<main>` (the layout smoke checks the
// landmark), never reaches the network and never spends. Scenes are discovered by glob, never listed by
// hand: adding a file is all it takes for the harness index, `window.__QA_APP_SCENES__` and the layout smoke
// (tests/e2e/layout.smoke.spec.ts `@app`, which reads the list at runtime) to pick it up. A file that breaks
// the contract is not mounted; it is listed as a problem on the index (`[data-qa-app-problem]`), and both
// qa/ComicQaApp.test.tsx and the smoke fail on it.

import React from 'react';
import { cn } from '../../lib/utils';
import { CANVAS_BG, FOCUS_RING, HEADING, HOVER_ROW, INK, MUTED, OVERLINE, RADIUS_PANEL, STATUS_INK, STATUS_SURFACE, CHIP, CHIP_VARIANT } from '../../components/chat/studioDesign';
import { bootDsSkin, DS_SKIN_ATTR } from '../../services/dsSkin';
import { COMICS_HOST } from '../../services/productHost';

/** What every `qa/app/scenes/<id>.tsx` default-exports. */
export interface QaAppScene {
  /** Equals the file name (`recipes` for scenes/recipes.tsx): the `?scene=` value. */
  id: string;
  /** One line for the index. */
  title: string;
  /** The whole page (it renders its own `<main>`). */
  Scene: React.ComponentType;
}

/** A scene file that breaks the contract (never mounted; listed on the index). */
export interface QaAppSceneProblem {
  file: string;
  reason: string;
}

export interface QaAppSceneIndex {
  /** Valid scenes, sorted by id. */
  scenes: readonly QaAppScene[];
  problems: readonly QaAppSceneProblem[];
}

export type QaAppTheme = 'light' | 'dark';
/** `atlas`: the page-level skin (as on the comics host); `none`: no skin on <html> (the apex today). */
export type QaAppSkin = 'atlas' | 'none';

/** What the layout smoke reads to discover the scenes (id and title only; set while the app surface is mounted). */
export interface QaAppSceneEntry {
  id: string;
  title: string;
}

declare global {
  interface Window {
    __QA_APP_SCENES__?: QaAppSceneEntry[];
    __QA_APP_SCENE_PROBLEMS__?: QaAppSceneProblem[];
  }
}

/** A scene id: lowercase kebab-case, as a file name and a `?scene=` value. */
export const QA_APP_SCENE_ID = /^[a-z][a-z0-9-]{0,47}$/;
const SCENE_FILE = /(?:^|\/)scenes\/([^/]+)\.tsx$/;

const isComponent = (v: unknown): v is React.ComponentType =>
  typeof v === 'function' || (typeof v === 'object' && v !== null && '$$typeof' in v);

/**
 * Validate glob results (`{ '<path>/scenes/<file>.tsx': module }`) against the scene contract. Pure, so the
 * test feeds it fake scene modules.
 */
export const collectAppScenes = (modules: Record<string, unknown>): QaAppSceneIndex => {
  const scenes: QaAppScene[] = [];
  const problems: QaAppSceneProblem[] = [];
  for (const [path, mod] of Object.entries(modules)) {
    const file = SCENE_FILE.exec(path)?.[1];
    const fail = (reason: string) => problems.push({ file: path, reason });
    if (!file) {
      fail('not a qa/app/scenes/<id>.tsx file');
      continue;
    }
    if (!QA_APP_SCENE_ID.test(file)) {
      fail(`the file name "${file}" is not a kebab-case scene id`);
      continue;
    }
    const def = (mod as { default?: unknown } | null)?.default;
    if (typeof def !== 'object' || def === null) {
      fail('no default export of { id, title, Scene }');
      continue;
    }
    const { id, title, Scene } = def as Partial<Record<keyof QaAppScene, unknown>>;
    if (id !== file) fail(`id ${JSON.stringify(id)} must equal the file name "${file}"`);
    else if (typeof title !== 'string' || !title.trim()) fail('title must be a non-empty string');
    else if (!isComponent(Scene)) fail('Scene must be a React component');
    else if (scenes.some((s) => s.id === id)) fail(`duplicate id "${id}"`);
    else scenes.push({ id, title: title.trim(), Scene });
  }
  scenes.sort((a, b) => a.id.localeCompare(b.id));
  problems.sort((a, b) => a.file.localeCompare(b.file));
  return { scenes, problems };
};

/** Every scene in qa/app/scenes (eager: the QA bundle is built for measuring, not for size). */
export const APP_SCENES: QaAppSceneIndex = collectAppScenes(import.meta.glob(['./scenes/*.tsx', '!./scenes/*.test.tsx', '!./scenes/*.spec.tsx'], { eager: true }));

/**
 * Put <html> in the asked look: `.dark` for the theme; for the skin, `atlas` boots it exactly as the comics
 * host does (attribute + the two body-font preloads, services/dsSkin.ts), `none` removes the attribute and
 * null leaves it as the page booted. Returns a function that restores the previous class and attribute.
 */
export const applyQaAppLook = (doc: Document, look: { theme: QaAppTheme; skin: QaAppSkin | null }): (() => void) => {
  const root = doc.documentElement;
  const hadDark = root.classList.contains('dark');
  const hadSkin = root.getAttribute(DS_SKIN_ATTR);
  root.classList.toggle('dark', look.theme === 'dark');
  if (look.skin === 'atlas') bootDsSkin({ document: doc, hostname: COMICS_HOST });
  else if (look.skin === 'none') root.removeAttribute(DS_SKIN_ATTR);
  return () => {
    root.classList.toggle('dark', hadDark);
    if (hadSkin === null) root.removeAttribute(DS_SKIN_ATTR);
    else root.setAttribute(DS_SKIN_ATTR, hadSkin);
  };
};

/** The index link for one scene, keeping the look of the index. */
export const appSceneHref = (id: string, look: { theme: QaAppTheme; skin: QaAppSkin | null }): string => {
  const q = new URLSearchParams({ surface: 'app', scene: id });
  if (look.theme === 'dark') q.set('theme', 'dark');
  if (look.skin) q.set('skin', look.skin);
  return `?${q.toString()}`;
};

const QaAppIndex: React.FC<{ index: QaAppSceneIndex; theme: QaAppTheme; skin: QaAppSkin | null }> = ({ index, theme, skin }) => (
  <main id="qa-main" aria-labelledby="qa-app-title" data-qa-app-index="" className={cn('min-h-[100dvh] min-w-0 px-4 py-6 sm:px-6', CANVAS_BG, INK)}>
    <div className="mx-auto flex max-w-3xl min-w-0 flex-col gap-6">
      <header className="flex min-w-0 flex-col gap-1">
        <p className={cn('m-0', OVERLINE)}>QA harness</p>
        <h1 id="qa-app-title" className={cn('m-0 text-[length:var(--ds-text-lg)]', HEADING)}>
          App scenes
        </h1>
        <p className={cn('m-0 text-[length:var(--ds-text-sm)]', MUTED)}>
          Each scene is one page of the app on synthetic data. The layout smoke measures every one of them at 320 to 1440 px, light and dark.
        </p>
      </header>
      {index.problems.length > 0 && (
        <section role="alert" aria-label="Scene files that break the contract" className={cn('border p-4', RADIUS_PANEL, STATUS_SURFACE.error)}>
          <p className={cn('m-0 text-[length:var(--ds-text-sm)] font-medium', STATUS_INK.error)}>
            {index.problems.length === 1 ? 'One scene file breaks the contract and is not mounted:' : `${index.problems.length} scene files break the contract and are not mounted:`}
          </p>
          <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
            {index.problems.map((p) => (
              <li key={p.file} data-qa-app-problem={p.file} className={cn('min-w-0 text-[length:var(--ds-text-sm)] [overflow-wrap:anywhere]', INK)}>
                {p.file}: {p.reason}
              </li>
            ))}
          </ul>
        </section>
      )}
      {index.scenes.length === 0 ? (
        <p className={cn('m-0 text-[length:var(--ds-text-sm)]', MUTED)}>No scenes yet: add a file to qa/app/scenes.</p>
      ) : (
        <ul aria-label="Scenes" className="m-0 flex list-none flex-col gap-1 p-0">
          {index.scenes.map((s) => (
            <li key={s.id} className="min-w-0">
              <a
                href={appSceneHref(s.id, { theme, skin })}
                data-qa-app-scene-link={s.id}
                className={cn('flex min-h-11 min-w-0 items-center justify-between gap-3 px-3 py-2 no-underline', HOVER_ROW, FOCUS_RING, INK)}
              >
                <span className="min-w-0 text-[length:var(--ds-text-base)] font-medium [overflow-wrap:anywhere]">{s.title}</span>
                <span className={cn(CHIP, CHIP_VARIANT.outline, 'shrink-0')}>{s.id}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  </main>
);

/**
 * The app surface: the index, or one scene as a whole page. An unknown scene throws (the harness's crash
 * boundary turns it into `[data-qa-crash]`, which `open()` reports), exactly as an unknown kit scene does.
 * `index` defaults to the glob; the test passes fake scene modules through collectAppScenes.
 */
export const QaAppSurface: React.FC<{ scene: string | null; theme: QaAppTheme; skin: QaAppSkin | null; index?: QaAppSceneIndex }> = ({ scene, theme, skin, index = APP_SCENES }) => {
  React.useLayoutEffect(() => applyQaAppLook(document, { theme, skin }), [theme, skin]);
  React.useLayoutEffect(() => {
    window.__QA_APP_SCENES__ = index.scenes.map(({ id, title }) => ({ id, title }));
    window.__QA_APP_SCENE_PROBLEMS__ = index.problems.map((p) => ({ ...p }));
    return () => {
      delete window.__QA_APP_SCENES__;
      delete window.__QA_APP_SCENE_PROBLEMS__;
    };
  }, [index]);
  if (scene === null) return <QaAppIndex index={index} theme={theme} skin={skin} />;
  const found = index.scenes.find((s) => s.id === scene);
  if (!found) throw new Error(`Unknown app scene "${scene}" (one of ${index.scenes.map((s) => s.id).join(', ') || 'none'})`);
  const { Scene } = found;
  return (
    <div data-qa-app-scene={found.id} className="contents">
      <Scene />
    </div>
  );
};
