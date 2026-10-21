import { describe, expect, it } from 'vitest';
import {
  COMIC_STUDIO_URL_VIEW,
  findStudioProjectForDeepLink,
  formatStudioProgress,
  isStudioV4Project,
  normalizeStudioDeepLinkUrl,
  resolveProjectView,
  resolveStudioDeepLink,
  routeStudioDeepLink,
  studioPageProgress,
  studioViewFromUrlParam,
  studioViewToUrlParam
} from './studioDeepLink';

describe('studioDeepLink', () => {
  it('uses id links for modern editor deep links', () => {
    const target = resolveStudioDeepLink(new URLSearchParams('view=editor&id=project-123'));

    expect(target).toEqual({ id: 'project-123', view: 'editor', source: 'id' });
  });

  it('uses board as the project id fallback for legacy editor links', () => {
    const target = resolveStudioDeepLink(new URLSearchParams('board=8d062c80-a79f-4255-a4fa-37764afafb92&view=editor'));

    expect(target).toEqual({
      id: '8d062c80-a79f-4255-a4fa-37764afafb92',
      view: 'editor',
      source: 'board'
    });
  });

  it('normalizes board links to id links and removes board', () => {
    const target = resolveStudioDeepLink(new URLSearchParams('view=pagestudio&board=board-1'));
    expect(target).not.toBeNull();

    const normalized = normalizeStudioDeepLinkUrl(new URL('https://dreamstreamstudio.ai/?view=pagestudio&board=board-1'), target!);

    expect(normalized.searchParams.get('view')).toBe('pagestudio');
    expect(normalized.searchParams.get('id')).toBe('board-1');
    expect(normalized.searchParams.has('board')).toBe(false);
  });

  it('ignores non-studio views', () => {
    expect(resolveStudioDeepLink(new URLSearchParams('view=dashboard&board=board-1'))).toBeNull();
    expect(resolveStudioDeepLink(new URLSearchParams('view=read&id=project-1'))).toBeNull();
    expect(resolveStudioDeepLink(new URLSearchParams('view=codestudio&id=project-1'))).toBeNull();
  });

  it('finds the project that owns a legacy board/page id', () => {
    const projects = [
      { id: 'project-1', state: { pageStudio: { pages: [{ id: 'page-a' }] } } },
      { id: 'project-2', state: { pageStudio: { activePageId: 'board-1', pages: [{ id: 'page-b' }] } } }
    ];

    const match = findStudioProjectForDeepLink(projects, {
      id: 'board-1',
      source: 'board'
    });

    expect(match?.id).toBe('project-2');
  });

  it('does not treat board ids as page ids for modern id links', () => {
    const projects = [
      { id: 'project-1', state: { pageStudio: { activePageId: 'project-2' } } },
      { id: 'project-2', state: {} }
    ];

    const match = findStudioProjectForDeepLink(projects, {
      id: 'project-2',
      source: 'id'
    });

    expect(match?.id).toBe('project-2');
  });
});

describe('Comic Studio v4 deep links (?view=studio)', () => {
  const projectId = '0f8c2a4e-1b7d-4c3e-9a51-6d2e8f7b3c10';

  it('resolves ?view=studio&id= to the v4 studio view', () => {
    expect(resolveStudioDeepLink(new URLSearchParams(`view=studio&id=${projectId}`))).toEqual({
      id: projectId,
      view: 'comicstudio',
      source: 'id'
    });
  });

  it('accepts the internal view name as an alias', () => {
    expect(resolveStudioDeepLink(new URLSearchParams(`view=comicstudio&id=${projectId}`))?.view).toBe('comicstudio');
  });

  it('trims the id and rejects a missing/blank one', () => {
    expect(resolveStudioDeepLink(new URLSearchParams(`view=studio&id=%20${projectId}%20`))?.id).toBe(projectId);
    expect(resolveStudioDeepLink(new URLSearchParams('view=studio'))).toBeNull();
    expect(resolveStudioDeepLink(new URLSearchParams('view=studio&id=%20%20'))).toBeNull();
  });

  it('never treats a legacy board id as a v4 studio link', () => {
    expect(resolveStudioDeepLink(new URLSearchParams('view=studio&board=board-1'))).toBeNull();
  });

  it('prefers id over board when both are present', () => {
    expect(resolveStudioDeepLink(new URLSearchParams(`view=studio&board=board-1&id=${projectId}`))).toEqual({
      id: projectId,
      view: 'comicstudio',
      source: 'id'
    });
  });

  it('normalizes to the public ?view=studio spelling', () => {
    const target = resolveStudioDeepLink(new URLSearchParams(`view=comicstudio&id=${projectId}`))!;
    const normalized = normalizeStudioDeepLinkUrl(new URL(`https://dreamstreamstudio.ai/?view=comicstudio&id=${projectId}&board=x`), target);
    expect(normalized.searchParams.get('view')).toBe(COMIC_STUDIO_URL_VIEW);
    expect(normalized.searchParams.get('id')).toBe(projectId);
    expect(normalized.searchParams.has('board')).toBe(false);
  });

  it('round-trips workspace views through the URL spelling', () => {
    expect(studioViewToUrlParam('comicstudio')).toBe('studio');
    expect(studioViewToUrlParam('editor')).toBe('editor');
    expect(studioViewToUrlParam('pagestudio')).toBe('pagestudio');
    for (const view of ['comicstudio', 'editor', 'pagestudio'] as const) {
      expect(studioViewFromUrlParam(studioViewToUrlParam(view))).toBe(view);
    }
    expect(studioViewFromUrlParam(null)).toBeNull();
    expect(studioViewFromUrlParam('dashboard')).toBeNull();
  });
});

describe('project workspace routing', () => {
  const v4 = { id: 'p-v4', state: { studioVersion: 4, pipelineMode: 'classic', studioPages: 6, studioRendered: 2 } };
  const classic = { id: 'p-classic', state: { pipelineMode: 'classic' } };
  const pageStudio = { id: 'p-pages', state: { pipelineMode: 'pagestudio' } };
  const retired = { id: 'p-forge', state: { pipelineMode: 'comicforge' } };

  it('detects v4 studio projects only by studioVersion === 4', () => {
    expect(isStudioV4Project(v4)).toBe(true);
    expect(isStudioV4Project(classic)).toBe(false);
    expect(isStudioV4Project({ id: 'x', state: { studioVersion: '4' } })).toBe(false);
    expect(isStudioV4Project({ id: 'x', state: { studioVersion: 3 } })).toBe(false);
    expect(isStudioV4Project({ id: 'x', state: null })).toBe(false);
    expect(isStudioV4Project(undefined)).toBe(false);
    expect(isStudioV4Project(null)).toBe(false);
  });

  it('routes v4 projects to the studio regardless of the requested pipeline', () => {
    expect(resolveProjectView(v4)).toBe('comicstudio');
    expect(resolveProjectView(v4, 'classic')).toBe('comicstudio');
    expect(resolveProjectView(v4, 'pagestudio')).toBe('comicstudio');
  });

  it('keeps the classic routing for everything else', () => {
    expect(resolveProjectView(classic)).toBe('editor');
    expect(resolveProjectView(pageStudio)).toBe('pagestudio');
    expect(resolveProjectView(classic, 'pagestudio')).toBe('pagestudio');
    expect(resolveProjectView(pageStudio, 'classic')).toBe('editor');
    // Retired/unknown modes fall back to the classic editor.
    expect(resolveProjectView(retired)).toBe('editor');
    // Not loaded yet: only an explicit request can pick Page Studio.
    expect(resolveProjectView(undefined)).toBe('editor');
    expect(resolveProjectView(undefined, 'pagestudio')).toBe('pagestudio');
  });

  it('reads the mirrored page progress of v4 projects', () => {
    expect(studioPageProgress(v4)).toEqual({ pages: 6, rendered: 2 });
    expect(studioPageProgress(classic)).toBeNull();
  });

  it('sanitizes malformed progress counts', () => {
    expect(studioPageProgress({ state: { studioVersion: 4 } })).toEqual({ pages: 0, rendered: 0 });
    expect(studioPageProgress({ state: { studioVersion: 4, studioPages: -2, studioRendered: 'x' } })).toEqual({ pages: 0, rendered: 0 });
    expect(studioPageProgress({ state: { studioVersion: 4, studioPages: 3.7, studioRendered: 9 } })).toEqual({ pages: 3, rendered: 3 });
    expect(studioPageProgress({ state: { studioVersion: 4, studioPages: Number.NaN, studioRendered: 1 } })).toEqual({ pages: 0, rendered: 0 });
  });

  it('formats the dashboard progress line', () => {
    expect(formatStudioProgress({ pages: 6, rendered: 2 })).toBe('2 of 6 pages');
    expect(formatStudioProgress({ pages: 1, rendered: 1 })).toBe('1 of 1 page');
    expect(formatStudioProgress({ pages: 4, rendered: 0 })).toBe('0 of 4 pages');
    expect(formatStudioProgress({ pages: 0, rendered: 0 })).toBe('No pages planned yet');
  });
});

describe('routeStudioDeepLink', () => {
  const v4 = { id: 'p-v4', state: { studioVersion: 4 } } as { id: string; state: Record<string, unknown> };
  const classic = { id: 'p-classic', state: { pipelineMode: 'classic' } };
  const pages = { id: 'p-pages', state: { pipelineMode: 'pagestudio', pageStudio: { activePageId: 'board-9', pages: [{ id: 'page-1' }] } } };
  const projects = [v4, classic, pages];

  it('opens listed v4 projects in the studio from a studio link', () => {
    expect(routeStudioDeepLink(projects, { id: 'p-v4', view: 'comicstudio', source: 'id' })).toEqual({ kind: 'comicstudio', id: 'p-v4' });
  });

  it('opens unlisted ids in the studio (created elsewhere; the server checks ownership)', () => {
    expect(routeStudioDeepLink(projects, { id: 'p-new', view: 'comicstudio', source: 'id' })).toEqual({ kind: 'comicstudio', id: 'p-new' });
    expect(routeStudioDeepLink([], { id: 'p-new', view: 'comicstudio', source: 'id' })).toEqual({ kind: 'comicstudio', id: 'p-new' });
  });

  it('sends a classic project behind a studio link to its own workspace', () => {
    expect(routeStudioDeepLink(projects, { id: 'p-classic', view: 'comicstudio', source: 'id' })).toEqual({
      kind: 'open',
      project: classic,
      pipelineMode: 'classic'
    });
    expect(routeStudioDeepLink(projects, { id: 'p-pages', view: 'comicstudio', source: 'id' })).toEqual({
      kind: 'open',
      project: pages,
      pipelineMode: 'pagestudio'
    });
  });

  it('opens v4 projects in the studio even from old editor links', () => {
    expect(routeStudioDeepLink(projects, { id: 'p-v4', view: 'editor', source: 'id' })).toEqual({ kind: 'comicstudio', id: 'p-v4' });
    expect(routeStudioDeepLink(projects, { id: 'p-v4', view: 'pagestudio', source: 'id' })).toEqual({ kind: 'comicstudio', id: 'p-v4' });
  });

  it('keeps the classic link routing', () => {
    expect(routeStudioDeepLink(projects, { id: 'p-classic', view: 'editor', source: 'id' })).toEqual({ kind: 'open', project: classic, pipelineMode: 'classic' });
    expect(routeStudioDeepLink(projects, { id: 'p-classic', view: 'pagestudio', source: 'id' })).toEqual({ kind: 'open', project: classic, pipelineMode: 'pagestudio' });
    expect(routeStudioDeepLink(projects, { id: 'p-pages', view: 'editor', source: 'id' })).toEqual({ kind: 'open', project: pages, pipelineMode: 'pagestudio' });
    expect(routeStudioDeepLink(projects, { id: 'board-9', view: 'pagestudio', source: 'board' })).toEqual({ kind: 'open', project: pages, pipelineMode: 'pagestudio' });
    expect(routeStudioDeepLink(projects, { id: 'nope', view: 'editor', source: 'id' })).toEqual({ kind: 'missing' });
  });
});
