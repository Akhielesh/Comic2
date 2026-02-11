import { useState, useEffect, useRef } from 'react';
import { Project, ComicState, AppStep, ComicPanel, Character, Item, Location, StyleVariant } from '../types';
import { startBackgroundGeneration, cancelGeneration } from '../services/generationManager';
import { DEFAULT_PRICING_CONFIG } from '../services/pricingConfig';
import { buildDefaultContinuityState, validateContinuityState } from '../services/continuity';
import { createGenerationNotification, loadProjects, saveProject, deleteProject as deleteProjectRecord, saveImage, getImageUrl } from '../services/db';

const STORAGE_KEY = 'dreamstream_projects';
const SAVE_DEBOUNCE_MS = 500;
const FLOW_VERSION = 3;

const remapStep = (step: number) => {
  if (step === 2) return 3;
  if (step === 3) return 2;
  return step;
};

const applyStateMigrations = (state: ComicState): ComicState => {
  const flowVersion = state.flowVersion ?? 1;
  const nextStep = flowVersion === FLOW_VERSION ? state.step : remapStep(state.step);
  const nextMax = flowVersion === FLOW_VERSION ? state.maxStepReached : remapStep(state.maxStepReached);
  const nextContinuity = state.continuity || buildDefaultContinuityState(state);
  const nextValidation = validateContinuityState({
    ...state,
    continuity: nextContinuity
  });
  return {
    ...state,
    step: nextStep,
    maxStepReached: nextMax,
    flowVersion: FLOW_VERSION,
    overview: state.overview || '',
    comments: state.comments || [],
    storyBuilder: state.storyBuilder,
    isFeatured: state.isFeatured ?? false,
    customAspectRatioEnabled: state.customAspectRatioEnabled ?? false,
    customAspectRatio: state.customAspectRatio,
    scriptChecklist: state.scriptChecklist,
    imageTags: state.imageTags || {},
    imageTagCounters: state.imageTagCounters || {},
    continuity: {
      ...nextContinuity,
      lockLevel: 'strict',
      fallbackPolicy: 'auto',
      validation: nextValidation
    }
  };
};

const hasLegacyStepShift = (state: ComicState): boolean => {
  const isLegacyFlow = (state.flowVersion ?? 1) < FLOW_VERSION;
  return (
    isLegacyFlow &&
    typeof state.coverTemplateId === 'undefined' &&
    state.step >= 2 &&
    (state.characters.length > 0 ||
      state.items.length > 0 ||
      state.locations.length > 0 ||
      state.panels.length > 0 ||
      state.layoutType !== 'grid')
  );
};

const migrateHydratedCoverAndFlowState = async (
  state: ComicState,
  overrides: Partial<ComicState> = {}
): Promise<ComicState> => {
  const coverImageUrl = state.coverImageId ? await getImageUrl(state.coverImageId) : state.coverImageUrl;
  const coverTemplateImageUrl = state.coverTemplateImageId
    ? await getImageUrl(state.coverTemplateImageId)
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
    step: AppStep.SCRIPT_INPUT,
    maxStepReached: AppStep.SCRIPT_INPUT,
    flowVersion: 2,
    script: '',
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
      const migratedState = await migrateHydratedCoverAndFlowState(project.state, {
        panels,
        characters,
        items,
        locations,
        styleVariants,
      });

      return {
        ...project,
        state: migratedState
      };
  };

  const hydrateProjectCover = async (project: Project): Promise<Project> => {
      const migratedState = await migrateHydratedCoverAndFlowState(project.state);

      return {
        ...project,
        state: migratedState
      };
  };

  const migrateLegacyProject = async (project: Project): Promise<Project> => {
      const migrateImage = async (url?: string) => {
        if (!url) return { imageId: undefined as string | undefined, imageUrl: undefined as string | undefined };
        if (url.startsWith('data:')) {
          const imageId = await saveImage(url);
          const imageUrl = (await getImageUrl(imageId)) || url;
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
      const needsStepShift =
        typeof project.state.coverTemplateId === 'undefined' &&
        project.state.step >= 2 &&
        (project.state.characters.length > 0 ||
          project.state.items.length > 0 ||
          project.state.locations.length > 0 ||
          project.state.panels.length > 0 ||
          project.state.layoutType !== 'grid');
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
      const storedProjects = await loadProjects();
      if (storedProjects.length > 0) {
        const hydrated = await Promise.all(storedProjects.map(hydrateProjectCover));
        setProjects(hydrated);
        return;
      }

      const legacy = localStorage.getItem(STORAGE_KEY);
      if (legacy) {
        const parsed: Project[] = JSON.parse(legacy);
        const migrated = await Promise.all(parsed.map(migrateLegacyProject));
        await Promise.all(migrated.map(saveProject));
        const hydrated = await Promise.all(migrated.map(hydrateProjectCover));
        setProjects(hydrated);
      }
    } catch (e) {
      console.error("Failed to load projects", e);
    }
  };

  useEffect(() => {
    loadAllProjects();
  }, []);

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

  const hydrateProjectAssets = async (projectId: string) => {
    const target = projects.find((p) => p.id === projectId);
    if (!target) return;
    const hydrated = await hydrateProject(target);
    setProjects((prev) => prev.map((p) => (p.id === projectId ? hydrated : p)));
  };

  const startGeneration = (projectId: string) => {
    const project = getProject(projectId);
    if (!project) return;

    // Start the background process
    startBackgroundGeneration(
        project,
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
