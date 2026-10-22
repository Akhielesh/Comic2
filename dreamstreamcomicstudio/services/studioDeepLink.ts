// Deep links into a comic workspace, and which workspace a project opens in.
//
// URL shapes (all resolve after auth; App holds them as a pending target until the
// project list has loaded):
//   ?view=editor&id=<projectId>       classic editor
//   ?view=pagestudio&id=<projectId>   Page Studio
//   ?view=studio&id=<projectId>       Comic Studio v4 (the conversational studio)
//   ?view=editor|pagestudio&board=<id>  legacy Page Studio board/page links (normalized to ?id=)
//
// Comic Studio v4 projects are listing rows whose `state.studioVersion === 4` (the server
// mirrors a minimal legacy-compatible state onto the projects row — see
// server/src/comic/store.ts buildLegacyProjectState). Their real document lives in
// comic_docs and is only ever edited by the v4 studio, so every "open" path routes them
// there no matter which view a link asked for.

export type StudioDeepLinkView = 'editor' | 'pagestudio' | 'comicstudio';

export type StudioDeepLinkTarget = {
  id: string;
  view: StudioDeepLinkView;
  source: 'id' | 'board';
};

/** How the v4 studio view is spelled in the URL (`?view=studio`). */
export const COMIC_STUDIO_URL_VIEW = 'studio';

/** URL `view` value for a workspace view. */
export const studioViewToUrlParam = (view: StudioDeepLinkView): string =>
  view === 'comicstudio' ? COMIC_STUDIO_URL_VIEW : view;

/** URL `view` value → workspace view (null for anything that isn't a project workspace). */
export const studioViewFromUrlParam = (raw: string | null | undefined): StudioDeepLinkView | null => {
  if (raw === 'editor' || raw === 'pagestudio') return raw;
  // `comicstudio` is accepted as an alias so a hand-typed internal view name still works.
  if (raw === COMIC_STUDIO_URL_VIEW || raw === 'comicstudio') return 'comicstudio';
  return null;
};

export const resolveStudioDeepLink = (params: URLSearchParams): StudioDeepLinkTarget | null => {
  const view = studioViewFromUrlParam(params.get('view'));
  if (!view) return null;

  const id = params.get('id')?.trim();
  if (id) {
    return { id, view, source: 'id' };
  }

  // `board` ids are Page Studio page/board ids from before ?id= existed; studio links
  // were always project-id links, so a bare board id never targets the v4 studio.
  if (view === 'comicstudio') return null;

  const board = params.get('board')?.trim();
  if (board) {
    return { id: board, view, source: 'board' };
  }

  return null;
};

export const normalizeStudioDeepLinkUrl = (url: URL, target: StudioDeepLinkTarget): URL => {
  const next = new URL(url.toString());
  next.searchParams.set('view', studioViewToUrlParam(target.view));
  next.searchParams.set('id', target.id);
  next.searchParams.delete('board');
  return next;
};

type ProjectLike = {
  id: string;
  state?: {
    pipelineMode?: string;
    pageStudio?: {
      activePageId?: string;
      pages?: Array<{ id?: string }>;
    };
  };
};

export const findStudioProjectForDeepLink = <T extends ProjectLike>(
  projects: T[],
  target: Pick<StudioDeepLinkTarget, 'id' | 'source'>
): T | undefined => {
  const byProjectId = projects.find((project) => project.id === target.id);
  if (byProjectId || target.source !== 'board') return byProjectId;

  return projects.find((project) =>
    project.state?.pageStudio?.activePageId === target.id ||
    project.state?.pageStudio?.pages?.some((page) => page.id === target.id)
  );
};

// ── Project → workspace routing ──────────────────────────────────────────────

/** `state.studioVersion` of a Comic Studio v4 project. */
export const COMIC_STUDIO_VERSION = 4;

type StudioStateLike = {
  studioVersion?: unknown;
  studioPages?: unknown;
  studioRendered?: unknown;
  pipelineMode?: unknown;
};

type StudioProjectLike = { id?: string; state?: unknown } | null | undefined;

const studioStateOf = (project: StudioProjectLike): StudioStateLike | null => {
  const state = project?.state;
  return state && typeof state === 'object' ? (state as StudioStateLike) : null;
};

/** True for projects created by (or imported into) the conversational Comic Studio v4. */
export const isStudioV4Project = (project: StudioProjectLike): boolean =>
  studioStateOf(project)?.studioVersion === COMIC_STUDIO_VERSION;

export type ProjectWorkspaceView = 'comicstudio' | 'editor' | 'pagestudio';

/**
 * The workspace a project opens in. v4 projects always open the v4 studio — the classic
 * editor would show an empty wizard over them and its autosave would rewrite the
 * mirrored listing state. Everything else keeps the classic routing: Page Studio when
 * asked for (or saved as such), otherwise the classic editor (unknown/retired pipeline
 * modes such as 'comicforge' fall back to it so old projects still open).
 */
export const resolveProjectView = (
  project: StudioProjectLike,
  expectedPipelineMode?: string | null
): ProjectWorkspaceView => {
  if (isStudioV4Project(project)) return 'comicstudio';
  const mode = expectedPipelineMode || studioStateOf(project)?.pipelineMode;
  return mode === 'pagestudio' ? 'pagestudio' : 'editor';
};

export interface StudioPageProgress {
  /** Pages in the plan. */
  pages: number;
  /** Pages with a finished render (never more than `pages`). */
  rendered: number;
}

const countOf = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** Rendered/planned page counts the server mirrors onto a v4 listing row (null for classic projects). */
export const studioPageProgress = (project: StudioProjectLike): StudioPageProgress | null => {
  if (!isStudioV4Project(project)) return null;
  const state = studioStateOf(project);
  const pages = countOf(state?.studioPages);
  return { pages, rendered: Math.min(countOf(state?.studioRendered), pages) };
};

/** "2 of 6 pages" — the dashboard's progress line for a v4 comic. */
export const formatStudioProgress = (progress: StudioPageProgress): string => {
  if (progress.pages === 0) return 'No pages planned yet';
  return `${progress.rendered} of ${progress.pages} ${progress.pages === 1 ? 'page' : 'pages'}`;
};

export type StudioDeepLinkRoute<T> =
  /** Open the v4 studio on this project id (it loads by id; the server checks ownership). */
  | { kind: 'comicstudio'; id: string }
  /** Open a listed classic project in its workspace. */
  | { kind: 'open'; project: T; pipelineMode: 'classic' | 'pagestudio' }
  /** A classic/Page Studio link whose project isn't in the user's list. */
  | { kind: 'missing' };

/**
 * Where a workspace deep link should land once the project list has loaded.
 *  - ?view=studio: a listed classic project opens its own workspace; a listed v4 project —
 *    or one the list doesn't know yet (created in another tab) — opens the studio.
 *  - ?view=editor|pagestudio: a v4 project still opens the studio (old links / bookmarks);
 *    classic projects keep the requested workspace; unknown ids are "missing".
 */
export const routeStudioDeepLink = <T extends ProjectLike>(
  projects: T[],
  target: StudioDeepLinkTarget
): StudioDeepLinkRoute<T> => {
  const matched = findStudioProjectForDeepLink(projects, target);
  const classicMode = (project: T): 'classic' | 'pagestudio' =>
    project.state?.pipelineMode === 'pagestudio' ? 'pagestudio' : 'classic';

  if (target.view === 'comicstudio') {
    if (matched && !isStudioV4Project(matched)) return { kind: 'open', project: matched, pipelineMode: classicMode(matched) };
    return { kind: 'comicstudio', id: target.id };
  }
  if (!matched) return { kind: 'missing' };
  if (isStudioV4Project(matched)) return { kind: 'comicstudio', id: matched.id };
  return { kind: 'open', project: matched, pipelineMode: target.view === 'pagestudio' ? 'pagestudio' : classicMode(matched) };
};
