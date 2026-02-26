import { ComicForgeState, PipelineMode, Project, createDefaultComicForgeState } from '../../types';

export const COMICFORGE_PIPELINE_MODE: PipelineMode = 'comicforge';

export const isComicForgeProject = (project?: Project | null): boolean =>
  !!project && project.state?.pipelineMode === COMICFORGE_PIPELINE_MODE;

export const ensureComicForgeState = (project?: Project | null): ComicForgeState => {
  if (project?.state?.comicforge) {
    return {
      ...project.state.comicforge,
      updatedAt: project.state.comicforge.updatedAt || Date.now()
    };
  }
  return createDefaultComicForgeState();
};

export const buildComicForgeProjectPatch = (
  project: Project,
  nextComicForgeState: ComicForgeState,
  options?: { setPipelineMode?: PipelineMode }
): Partial<Project> => {
  const pipelineMode = options?.setPipelineMode || COMICFORGE_PIPELINE_MODE;
  return {
    state: {
      ...project.state,
      pipelineMode,
      comicforge: {
        ...nextComicForgeState,
        updatedAt: Date.now()
      }
    }
  };
};
