export type StudioDeepLinkView = 'editor' | 'pagestudio';

export type StudioDeepLinkTarget = {
  id: string;
  view: StudioDeepLinkView;
  source: 'id' | 'board';
};

export const resolveStudioDeepLink = (params: URLSearchParams): StudioDeepLinkTarget | null => {
  const rawView = params.get('view');
  if (rawView !== 'editor' && rawView !== 'pagestudio') return null;

  const id = params.get('id')?.trim();
  if (id) {
    return { id, view: rawView, source: 'id' };
  }

  const board = params.get('board')?.trim();
  if (board) {
    return { id: board, view: rawView, source: 'board' };
  }

  return null;
};

export const normalizeStudioDeepLinkUrl = (url: URL, target: StudioDeepLinkTarget): URL => {
  const next = new URL(url.toString());
  next.searchParams.set('view', target.view);
  next.searchParams.set('id', target.id);
  next.searchParams.delete('board');
  return next;
};

type ProjectLike = {
  id: string;
  state?: {
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
