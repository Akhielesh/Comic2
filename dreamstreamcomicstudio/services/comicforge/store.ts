import { create } from 'zustand';
import {
  COMICFORGE_STAGE_ORDER,
  ComicForgeJobSummary,
  ComicForgeStage,
  ComicForgeState,
  Project,
  createDefaultComicForgeState
} from '../../types';
import { ensureComicForgeState } from './stateSync';

type ComicForgeStore = {
  projectId: string | null;
  state: ComicForgeState;
  lastJob?: ComicForgeJobSummary;
  initializeFromProject: (project: Project | null) => void;
  setState: (updater: ComicForgeState | ((prev: ComicForgeState) => ComicForgeState)) => void;
  setStage: (stage: ComicForgeStage) => void;
  approveStage: (stage: ComicForgeStage) => void;
  isStageUnlocked: (stage: ComicForgeStage) => boolean;
  setLastJob: (job?: ComicForgeJobSummary) => void;
  reset: () => void;
};

const stageIndex = (stage: ComicForgeStage) => COMICFORGE_STAGE_ORDER.indexOf(stage);

const cloneState = (state: ComicForgeState): ComicForgeState => JSON.parse(JSON.stringify(state)) as ComicForgeState;

const updateMaxStage = (state: ComicForgeState, stage: ComicForgeStage): ComicForgeStage => {
  const currentIndex = stageIndex(state.maxStageReached);
  const nextIndex = stageIndex(stage);
  return nextIndex > currentIndex ? stage : state.maxStageReached;
};

const approveStageImpl = (state: ComicForgeState, stage: ComicForgeStage): ComicForgeState => {
  const now = Date.now();
  const approvalIndex = stageIndex(stage);
  const updatedApprovals = state.approvals.map((entry) => {
    if (entry.stage === stage) {
      return {
        ...entry,
        approved: true,
        approvedAt: now
      };
    }
    return entry;
  });

  const nextStage = COMICFORGE_STAGE_ORDER[Math.min(approvalIndex + 1, COMICFORGE_STAGE_ORDER.length - 1)];

  return {
    ...state,
    approvals: updatedApprovals,
    stage: nextStage,
    maxStageReached: updateMaxStage(state, nextStage),
    updatedAt: now
  };
};

const isStageUnlockedImpl = (state: ComicForgeState, stage: ComicForgeStage): boolean => {
  const idx = stageIndex(stage);
  if (idx <= 0) return true;
  const previous = COMICFORGE_STAGE_ORDER[idx - 1];
  return Boolean(state.approvals.find((entry) => entry.stage === previous)?.approved);
};

export const useComicForgeStore = create<ComicForgeStore>((set, get) => ({
  projectId: null,
  state: createDefaultComicForgeState(),
  initializeFromProject: (project) => {
    set({
      projectId: project?.id || null,
      state: project ? cloneState(ensureComicForgeState(project)) : createDefaultComicForgeState(),
      lastJob: undefined
    });
  },
  setState: (updater) => {
    set((prev) => ({
      state: typeof updater === 'function'
        ? (updater as (state: ComicForgeState) => ComicForgeState)(prev.state)
        : updater
    }));
  },
  setStage: (stage) => {
    set((prev) => {
      if (!isStageUnlockedImpl(prev.state, stage)) return prev;
      return {
        ...prev,
        state: {
          ...prev.state,
          stage,
          maxStageReached: updateMaxStage(prev.state, stage),
          updatedAt: Date.now()
        }
      };
    });
  },
  approveStage: (stage) => {
    set((prev) => ({
      ...prev,
      state: approveStageImpl(prev.state, stage)
    }));
  },
  isStageUnlocked: (stage) => isStageUnlockedImpl(get().state, stage),
  setLastJob: (job) => set({ lastJob: job }),
  reset: () => set({ projectId: null, state: createDefaultComicForgeState(), lastJob: undefined })
}));
