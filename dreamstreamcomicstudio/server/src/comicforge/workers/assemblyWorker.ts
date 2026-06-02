// Page assembly. Generation currently produces one full image per page, so "assembly"
// resolves the project's generated page images into an ordered page set (the basis the
// lettering + export workers consume). When per-panel compositing lands, this is where the
// grid layout would be applied.

import { listProjectPageImages } from './pageAssets.js';

export const runAssemblyWorker = async (payload: Record<string, unknown>) => {
  const projectId = typeof payload.projectId === 'string' ? payload.projectId : '';
  if (!projectId) {
    throw new Error('assemble_page job is missing projectId.');
  }

  const pages = await listProjectPageImages(projectId);

  return {
    assembled: true,
    projectId,
    pageCount: pages.length,
    pages: pages.map((page, index) => ({
      pageNumber: index + 1,
      imageId: page.imageId,
      imageUrl: page.imageUrl
    })),
    completedAt: Date.now()
  };
};
