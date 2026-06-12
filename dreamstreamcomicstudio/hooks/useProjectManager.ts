import { useState, useEffect, useRef } from 'react';
import { Project, ComicState, AppStep, ComicPanel, Character, Item, Location, StyleVariant } from '../types';
import { startBackgroundGeneration, cancelGeneration } from '../services/generationManager';
import { DEFAULT_PRICING_CONFIG } from '../services/pricingConfig';
import { buildDefaultContinuityState, validateContinuityState } from '../services/continuity';
import { createGenerationNotification, loadProjects, saveProject, deleteProject as deleteProjectRecord, saveImage, getImageUrl } from '../services/db';
import { useAuth } from '../contexts/AuthContext';
import { IMAGE_TRANSFORMS } from '../services/projectStorage';
import { applyStyleLockResolution } from '../services/styleLock';
import { getDefaultStoryPlanningState, recommendStoryPlanning } from '../services/storyPlanning';

const SAVE_DEBOUNCE_MS = 500;
const FLOW_VERSION = 4;

const stableHash = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return `h${Math.abs(hash >>> 0).toString(16)}`;
};

const computeSceneHash = (state: ComicState) =>
  stableHash(
    JSON.stringify(
      (state.scenes || []).map((scene) => ({
        id: scene.id,
        rawText: scene.rawText || '',
        synopsis: scene.synopsis || '',
        setting: scene.setting || '',
        characters: scene.characters || []
      }))
    )
  );

const computeWorldHash = (state: ComicState) =>
  stableHash(
    JSON.stringify({
      characters: (state.characters || []).map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        bio: entry.bio,
        referenceImageIds: entry.referenceImageIds || []
      })),
      items: (state.items || []).map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        referenceImageIds: entry.referenceImageIds || []
      })),
      locations: (state.locations || []).map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        referenceImageIds: entry.referenceImageIds || []
      }))
    })
  );

const remapLegacyStepOrder = (step: number, flowVersion: number) => {
  if (flowVersion < 3) {
    if (step === 2) return 3;
    if (step === 3) return 2;
  }
  return step;
};

const injectStoryPlanningStep = (step: number, flowVersion: number) => {
  if (flowVersion >= FLOW_VERSION) return step;
  // STORY_PLANNING was inserted after SCRIPT_INPUT in flow v4.
  // For legacy flows (<4), every step from prior index 1 onward shifts by +1.
  return step >= AppStep.STORY_PLANNING ? step + 1 : step;
};

const applyStateMigrations = (state: ComicState): ComicState => {
  const sourceFlowVersion = typeof state.flowVersion === 'number' ? state.flowVersion : 0;
  const migratedStepOrder = remapLegacyStepOrder(state.step, sourceFlowVersion);
  const migratedMaxOrder = remapLegacyStepOrder(state.maxStepReached, sourceFlowVersion);
  let nextStep = injectStoryPlanningStep(migratedStepOrder, sourceFlowVersion);
  let nextMax = injectStoryPlanningStep(migratedMaxOrder, sourceFlowVersion);

  const planningFromState = state.storyPlanning;
  const computedPlanning = planningFromState || (
    (state.script || '').trim() && (state.scenes || []).length > 0
      ? recommendStoryPlanning({ script: state.script || '', scenes: state.scenes || [] })
      : getDefaultStoryPlanningState()
  );
  // The Story-Planning approval gate (flow v4) is retired along with the stage itself,
  // and the manual panel-Preview stage is gone too — normalize anything saved on a
  // removed step onto its live neighbour (planning data is kept; only the step moves).
  const remapRemovedStep = (step: number) => {
    if (step === AppStep.STORY_PLANNING) return AppStep.STYLE_SELECTION;
    if (step === AppStep.COMBINED_PREVIEW) return AppStep.LAYOUT_SELECTION;
    return step;
  };
  nextStep = remapRemovedStep(nextStep);
  nextMax = Math.max(remapRemovedStep(nextMax), nextStep);

  const nextContinuity = state.continuity || buildDefaultContinuityState(state);
  const nextValidation = validateContinuityState({
    ...state,
    continuity: nextContinuity
  });
  const migrated: ComicState = {
    ...state,
    pipelineMode: state.pipelineMode || 'classic',
    step: nextStep,
    maxStepReached: nextMax,
    flowVersion: FLOW_VERSION,
    overview: state.overview || '',
    comments: state.comments || [],
    storyPlanning: computedPlanning,
    storyBuilder: state.storyBuilder,
    isFeatured: state.isFeatured ?? false,
    customAspectRatioEnabled: state.customAspectRatioEnabled ?? false,
    customAspectRatio: state.customAspectRatio,
    scriptChecklist: state.scriptChecklist,
    scriptHash: state.scriptHash || stableHash(state.script || ''),
    sceneHash: state.sceneHash || computeSceneHash(state),
    worldHash: state.worldHash || computeWorldHash(state),
    imageTags: state.imageTags || {},
    imageTagCounters: state.imageTagCounters || {},
    continuity: {
      ...nextContinuity,
      lockLevel: 'strict',
      fallbackPolicy: 'auto',
      validation: nextValidation
    }
  };
  return applyStyleLockResolution(migrated).state;
};

export const migrateComicStateForFlow = (state: ComicState) => applyStateMigrations(state);

const didStyleLockRepairOccur = (before: ComicState, after: ComicState) => {
  return (
    before.selectedStyleId !== after.selectedStyleId ||
    before.stylePrompt !== after.stylePrompt ||
    before.styleImageId !== after.styleImageId ||
    before.styleImageUrl !== after.styleImageUrl ||
    before.styleLockStatus !== after.styleLockStatus ||
    before.styleLockResolvedAt !== after.styleLockResolvedAt
  );
};

const hasLegacyStepShift = (state: ComicState): boolean => {
  if (typeof state.flowVersion !== 'number') return false;
  if (state.flowVersion >= FLOW_VERSION) return false;

  const legacyReferenceBuilderStep = 2;
  const hasLegacyIndicators =
    typeof state.coverTemplateId === 'undefined' &&
    state.step >= legacyReferenceBuilderStep &&
    (
      (state.characters?.length || 0) > 0 ||
      (state.items?.length || 0) > 0 ||
      (state.locations?.length || 0) > 0 ||
      (state.panels?.length || 0) > 0 ||
      state.layoutType !== 'grid'
    );

  const hasModernIndicators =
    typeof state.coverTemplateId !== 'undefined' ||
    typeof state.styleLockStatus !== 'undefined' ||
    typeof state.styleLockResolvedAt !== 'undefined' ||
    typeof state.panelPlanVersion !== 'undefined';

  return hasLegacyIndicators && !hasModernIndicators;
};

const migrateHydratedCoverAndFlowState = async (
  state: ComicState,
  overrides: Partial<ComicState> = {},
  options?: { useThumbTransform?: boolean }
): Promise<ComicState> => {
  const coverTransform = options?.useThumbTransform ? IMAGE_TRANSFORMS.thumb : IMAGE_TRANSFORMS.editor;
  const coverImageUrl = state.coverImageId
    ? await getImageUrl(state.coverImageId, { transform: coverTransform })
    : state.coverImageUrl;
  const coverTemplateImageUrl = state.coverTemplateImageId
    ? await getImageUrl(state.coverTemplateImageId, { transform: IMAGE_TRANSFORMS.editor })
    : state.coverTemplateImageUrl;
  const needsStepShift = hasLegacyStepShift(state);

  return applyStateMigrations({
    ...state,
    ...overrides,
    coverImageUrl,
    coverTemplateImageUrl,
    step: needsStepShift ? state.step + 1 : state.step,
    maxStepReached: needsStepShift ? state.maxStepReached + 1 : state.maxStepReached,
    textLayout: state.textLayout || 'caption',
    pricingConfig: state.pricingConfig || structuredClone(DEFAULT_PRICING_CONFIG),
  });
};

const INITIAL_STATE: ComicState = {
  pipelineMode: 'classic',
  step: AppStep.SCRIPT_INPUT,
  maxStepReached: AppStep.SCRIPT_INPUT,
  flowVersion: FLOW_VERSION,
  script: '',
  storyPlanning: getDefaultStoryPlanningState(),
  scriptChecklist: undefined,
  scenes: [],
  continuitySummary: '',
  continuity: {
    bible: {
      version: 1,
      entities: [],
      sceneBindings: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    },
    lockLevel: 'strict',
    fallbackPolicy: 'auto',
    validation: {
      isValid: true,
      missingEntityIds: [],
      issues: [],
      updatedAt: Date.now()
    }
  },
  overview: '',
  comments: [],
  storyBuilder: undefined,
  isFeatured: false,
  coverImageId: undefined,
  coverImageUrl: undefined,
  coverPrompt: '',
  coverTemplateId: undefined,
  coverTemplateImageId: undefined,
  coverTemplateImageUrl: undefined,
  textLayout: 'caption',
  pricingConfig: structuredClone(DEFAULT_PRICING_CONFIG),
  imageTags: {},
  imageTagCounters: {},
  styleVariants: [],
  selectedStyleId: undefined,
  stylePrompt: '',
  styleImageId: undefined,
  styleImageUrl: undefined,
  styleLockStatus: 'missing',
  styleLockResolvedAt: undefined,
  styleCategory: '',
  styleAspectRatio: '1:1',
  customAspectRatioEnabled: false,
  customAspectRatio: undefined,
  imageResolution: '1K',
  characters: [],
  items: [],
  locations: [],
  layoutType: 'grid',
  customLayoutPrompt: undefined,
  panels: [],
};

export const useProjectManager = () => {
  const { user, loading: authLoading } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const saveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pendingSavesRef = useRef<Map<string, Project>>(new Map());

  const scheduleSave = (project: Project) => {
    pendingSavesRef.current.set(project.id, project);
    const existing = saveTimersRef.current.get(project.id);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      const latest = pendingSavesRef.current.get(project.id);
      pendingSavesRef.current.delete(project.id);
      saveTimersRef.current.delete(project.id);
      if (latest) void saveProject(latest);
    }, SAVE_DEBOUNCE_MS);
    saveTimersRef.current.set(project.id, handle);
  };

  useEffect(() => {
    return () => {
      saveTimersRef.current.forEach((handle) => clearTimeout(handle));
      saveTimersRef.current.clear();
      pendingSavesRef.current.forEach((project) => {
        void saveProject(project);
      });
      pendingSavesRef.current.clear();
    };
  }, []);

  const hydrateProject = async (project: Project): Promise<Project> => {
    const hydratePanel = async (panel: ComicPanel) => {
      const imageUrl = panel.imageId ? await getImageUrl(panel.imageId) : panel.imageUrl;
      const imageUrlHistory = panel.imageIdHistory
        ? await Promise.all(panel.imageIdHistory.map((id) => getImageUrl(id)))
        : [];
      return { ...panel, imageUrl, imageUrlHistory };
    };

    const hydrateEntity = async <T extends Character | Item | Location>(entity: T): Promise<T> => {
      const imageUrl = entity.imageId ? await getImageUrl(entity.imageId) : entity.imageUrl;
      return { ...entity, imageUrl };
    };

    const hydrateVariant = async (variant: StyleVariant) => {
      const imageUrl = variant.imageId ? await getImageUrl(variant.imageId) : variant.imageUrl;
      return { ...variant, imageUrl };
    };

    const panels = await Promise.all(project.state.panels.map(hydratePanel));
    const characters = await Promise.all(project.state.characters.map(hydrateEntity));
    const items = await Promise.all(project.state.items.map(hydrateEntity));
    const locations = await Promise.all(project.state.locations.map(hydrateEntity));
    const styleVariants = await Promise.all(project.state.styleVariants.map(hydrateVariant));

    // Hydrate the persisted style reference image
    const styleImageUrl = project.state.styleImageId
      ? await getImageUrl(project.state.styleImageId)
      : project.state.styleImageUrl;

    const migratedState = await migrateHydratedCoverAndFlowState(project.state, {
      panels,
      characters,
      items,
      locations,
      styleVariants,
      styleImageUrl,
    }, { useThumbTransform: false });

    const hydratedProject: Project = {
      ...project,
      state: migratedState
    };

    if (didStyleLockRepairOccur(project.state, migratedState)) {
      void saveProject(hydratedProject);
    }

    return hydratedProject;
  };

  const hydrateProjectCover = async (project: Project): Promise<Project> => {
    let panelOverrides: ComicPanel[] | undefined;
    const firstPanelWithImageIdIndex = project.state.panels.findIndex(
      (panel) => !panel.imageUrl && (!!panel.imageId || (panel.imageIdHistory?.length || 0) > 0)
    );
    if (firstPanelWithImageIdIndex >= 0) {
      const target = project.state.panels[firstPanelWithImageIdIndex];
      const previewImageId = target.imageId || target.imageIdHistory?.[target.imageIdHistory.length - 1];
      const hydratedPanelUrl = previewImageId
        ? await getImageUrl(previewImageId, { transform: IMAGE_TRANSFORMS.thumb })
        : undefined;
      if (hydratedPanelUrl) {
        panelOverrides = [...project.state.panels];
        panelOverrides[firstPanelWithImageIdIndex] = {
          ...target,
          imageUrl: hydratedPanelUrl
        };
      }
    }

    let styleOverrides: StyleVariant[] | undefined;
    const firstStyleWithImageIdIndex = project.state.styleVariants.findIndex((variant) => !variant.imageUrl && !!variant.imageId);
    if (firstStyleWithImageIdIndex >= 0) {
      const target = project.state.styleVariants[firstStyleWithImageIdIndex];
      const hydratedStyleUrl = await getImageUrl(target.imageId!, { transform: IMAGE_TRANSFORMS.thumb });
      if (hydratedStyleUrl) {
        styleOverrides = [...project.state.styleVariants];
        styleOverrides[firstStyleWithImageIdIndex] = {
          ...target,
          imageUrl: hydratedStyleUrl
        };
      }
    }

    const migratedState = await migrateHydratedCoverAndFlowState(
      project.state,
      {
        ...(panelOverrides ? { panels: panelOverrides } : {}),
        ...(styleOverrides ? { styleVariants: styleOverrides } : {})
      },
      { useThumbTransform: true }
    );

    const hydratedProject: Project = {
      ...project,
      state: migratedState
    };
    if (didStyleLockRepairOccur(project.state, migratedState)) {
      void saveProject(hydratedProject);
    }
    return hydratedProject;
  };

  const migrateLegacyProject = async (project: Project): Promise<Project> => {
    const migrateImage = async (url?: string) => {
      if (!url) return { imageId: undefined as string | undefined, imageUrl: undefined as string | undefined };
      if (url.startsWith('data:')) {
        const imageId = await saveImage(url);
        const imageUrl = (await getImageUrl(imageId, { transform: IMAGE_TRANSFORMS.editor })) || url;
        return { imageId, imageUrl };
      }
      return { imageId: undefined, imageUrl: url };
    };

    const migratePanel = async (panel: any) => {
      const migrated = await migrateImage(panel.imageUrl);
      const historyIds: string[] = [];
      if (Array.isArray(panel.imageIdHistory)) {
        historyIds.push(...panel.imageIdHistory);
      }
      if (Array.isArray(panel.imageUrlHistory)) {
        for (const url of panel.imageUrlHistory) {
          const result = await migrateImage(url);
          if (result.imageId) historyIds.push(result.imageId);
        }
      }
      return {
        ...panel,
        imageId: migrated.imageId,
        imageUrl: migrated.imageUrl,
        imageIdHistory: historyIds
      } as ComicPanel;
    };

    const migrateEntity = async <T extends Character | Item | Location>(entity: T): Promise<T> => {
      const migrated = await migrateImage(entity.imageUrl);
      const refIds: string[] = [];
      const legacyEntity = entity as T & { referenceImages?: string[] };
      if (Array.isArray(entity.referenceImageIds)) {
        refIds.push(...entity.referenceImageIds);
      }
      if (Array.isArray(legacyEntity.referenceImages)) {
        for (const refUrl of legacyEntity.referenceImages) {
          const result = await migrateImage(refUrl);
          if (result.imageId) refIds.push(result.imageId);
        }
      }
      return {
        ...entity,
        imageId: migrated.imageId,
        imageUrl: migrated.imageUrl,
        referenceImageIds: refIds
      } as T;
    };

    const migrateVariant = async (variant: any) => {
      const migrated = await migrateImage(variant.imageUrl);
      return {
        ...variant,
        imageId: migrated.imageId,
        imageUrl: migrated.imageUrl
      } as StyleVariant;
    };

    const panels = await Promise.all(project.state.panels.map(migratePanel));
    const characters = await Promise.all(project.state.characters.map(migrateEntity));
    const items = await Promise.all(project.state.items.map(migrateEntity));
    const locations = await Promise.all(project.state.locations.map(migrateEntity));
    const styleVariants = await Promise.all(project.state.styleVariants.map(migrateVariant));
    const migratedCover = await migrateImage((project.state as any).coverImageUrl || (project as any).coverImage);
    const migratedCoverTemplate = await migrateImage((project.state as any).coverTemplateImageUrl);
    const needsStepShift = hasLegacyStepShift(project.state);
    const migratedStep = needsStepShift ? project.state.step + 1 : project.state.step;
    const migratedMaxStep = needsStepShift ? project.state.maxStepReached + 1 : project.state.maxStepReached;

    const migratedState = applyStateMigrations({
      ...project.state,
      panels,
      characters,
      items,
      locations,
      styleVariants,
      coverImageId: migratedCover.imageId,
      coverImageUrl: migratedCover.imageUrl,
      coverTemplateImageId: migratedCoverTemplate.imageId,
      coverTemplateImageUrl: migratedCoverTemplate.imageUrl,
      coverTemplateId: project.state.coverTemplateId,
      coverPrompt: project.state.coverPrompt || '',
      step: migratedStep,
      maxStepReached: migratedMaxStep,
      textLayout: project.state.textLayout || 'caption',
      pricingConfig: project.state.pricingConfig || structuredClone(DEFAULT_PRICING_CONFIG),
    });

    return {
      ...project,
      state: migratedState
    };
  };

  const loadAllProjects = async () => {
    try {
      if (!user) {
        setProjects([]);
        return;
      }

      const storedProjects = await loadProjects();
      const hydrated = await Promise.all(storedProjects.map(hydrateProjectCover));
      setProjects(hydrated);
    } catch (e) {
      console.error("Failed to load projects", e);
    }
  };

  useEffect(() => {
    if (authLoading) return;
    void loadAllProjects();
  }, [authLoading, user?.id]);

  const createProject = (name: string): Project => {
    const newProject: Project = {
      id: crypto.randomUUID(),
      name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      state: { ...INITIAL_STATE }
    };
    setProjects(prev => [newProject, ...prev]);
    void saveProject(newProject);
    return newProject;
  };

  const updateProject = (id: string, updates: Partial<Project> | ((prev: Project) => Partial<Project>)) => {
    setProjects(prevProjects => {
      const newProjects = prevProjects.map(p => {
        if (p.id === id) {
          const newValues = typeof updates === 'function' ? updates(p) : updates;
          return { ...p, ...newValues, updatedAt: Date.now() };
        }
        return p;
      });
      const updated = newProjects.find(p => p.id === id);
      if (updated) {
        scheduleSave(updated);
      }
      return newProjects;
    });
  };

  // Wrapper to call standard updateProject but also persist to storage (handled by updateProject logic above if we lift saveProjects out or duplicate)
  // To avoid race conditions in React state vs LocalStorage, we rely on the setProjects functional update callback pattern mostly.

  const deleteProject = (id: string) => {
    setProjects(prev => prev.filter(p => p.id !== id));
    const existing = saveTimersRef.current.get(id);
    if (existing) clearTimeout(existing);
    saveTimersRef.current.delete(id);
    pendingSavesRef.current.delete(id);
    void deleteProjectRecord(id);
  };

  const duplicateProject = (id: string) => {
    const original = projects.find(p => p.id === id);
    if (original) {
      const copy: Project = {
        ...original,
        id: crypto.randomUUID(),
        name: `${original.name} (Copy)`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        state: {
          ...original.state,
          panels: [], // Reset generated panels on duplicate? Or keep? Let's keep for "forking".
          generationStatus: undefined // Reset active generation
        }
      };
      setProjects(prev => [copy, ...prev]);
      void saveProject(copy);
    }
  };

  const getProject = (id: string) => projects.find(p => p.id === id);

  const hydrateProjectAssets = async (projectId: string): Promise<Project | undefined> => {
    const target = projects.find((p) => p.id === projectId);
    if (!target) return undefined;
    const hydrated = await hydrateProject(target);
    setProjects((prev) => prev.map((p) => (p.id === projectId ? hydrated : p)));
    return hydrated;
  };

  const startGeneration = (projectId: string) => {
    const project = getProject(projectId);
    if (!project) return;
    const { state: repairedState, resolution, changed } = applyStyleLockResolution(project.state);
    if (!resolution.resolved) {
      updateProject(projectId, {
        state: repairedState
      });
      return;
    }
    const generationProject = changed
      ? {
        ...project,
        state: repairedState
      }
      : project;
    if (changed) {
      updateProject(projectId, {
        state: repairedState
      });
    }

    // Start the background process
    startBackgroundGeneration(
      generationProject,
      updateProject, // Pass the updater
      (pid, panels) => {
        void createGenerationNotification(pid, project.name);
      }
    );
  };

  const stopGeneration = (projectId: string) => {
    cancelGeneration(projectId);
  };

  return {
    projects,
    createProject,
    updateProject,
    deleteProject,
    duplicateProject,
    getProject,
    startGeneration,
    stopGeneration,
    reloadProjects: loadAllProjects,
    hydrateProjectAssets
  };
};
