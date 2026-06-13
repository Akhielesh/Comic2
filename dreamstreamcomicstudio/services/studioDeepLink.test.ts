import { describe, expect, it } from 'vitest';
import { findStudioProjectForDeepLink, normalizeStudioDeepLinkUrl, resolveStudioDeepLink } from './studioDeepLink';

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
