import { useState, useEffect, useRef } from 'react';
import { Project, ComicState, AppStep, ComicPanel, Character, Item, Location, StyleVariant, PageStudioPage } from '../types';
import { startBackgroundGeneration, cancelGeneration } from '../services/generationManager';
import { DEFAULT_PRICING_CONFIG } from '../services/pricingConfig';
import { buildDefaultContinuityState, validateContinuityState } from '../services/continuity';
import {
  createGenerationNotification,
  loadProjectCards,
  loadProjectState,
  isCardOnly,
  markStateLoaded,
  saveProject,
  deleteProject as deleteProjectRecord,
  saveImage,
  getImageUrl
} from '../services/db';
import { useAuth } from '../contexts/AuthContext';
import { IMAGE_TRANSFORMS } from '../services/projectStorage';
import { applyStyleLockResolution } from '../services/styleLock';
import { getDefaultStoryPlanningState, recommendStoryPlanning } from '../services/storyPlanning';
import { makeDefaultComicAgentSettings, normalizeComicAgentSettings } from '../services/comicAgentSettings';
import { makeDefaultComicAgentRun, syncAgentRunWithState } from '../services/comicAgentRun';
import { isStudioV4Project } from '../services/studioDeepLink';
import { TOAST, Z } from '../components/chat/studioDesign';

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

const mapLegacyStepToCurrentEnum = (step: number, flowVersion: number) => {
  if (flowVersion >= FLOW_VERSION) return step;
  // Older saved projects used step 1 for Style. The reserved STORY_PLANNING enum
  // now lives at 1, so legacy steps from that point forward shift into today's enum.
  return step >= AppStep.STORY_PLANNING ? step + 1 : step;
};

const applyStateMigrations = (state: ComicState): ComicState => {
  const sourceFlowVersion = typeof state.flowVersion === 'number' ? state.flowVersion : 0;
  const migratedStepOrder = remapLegacyStepOrder(state.step, sourceFlowVersion);
  const migratedMaxOrder = remapLegacyStepOrder(state.maxStepReached, sourceFlowVersion);
  let nextStep = mapLegacyStepToCurrentEnum(migratedStepOrder, sourceFlowVersion);
  let nextMax = mapLegacyStepToCurrentEnum(migratedMaxOrder, sourceFlowVersion);

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
    agentSettings: normalizeComicAgentSettings(state.agentSettings),
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
  const repaired = applyStyleLockResolution(migrated).state;
  return {
    ...repaired,
    agentRun: syncAgentRunWithState(repaired)
  };
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

const didStateMigrationRequireSave = (before: ComicState, after: ComicState) =>
  didStyleLockRepairOccur(before, after) ||
  !before.agentRun ||
  before.flowVersion !== after.flowVersion;

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
  agentSettings: makeDefaultComicAgentSettings(),
  agentRun: makeDefaultComicAgentRun(),
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

/**
 * Comic Studio (v4) visibility is server-owned: it is published only from the studio Share
 * sheet, and the database refuses client is_public changes on v4 rows. A client update to
 * a v4 project therefore never carries isPublic/publishedAt (the stored values are kept).
 */
export const withoutStudioVisibility = (project: Project, updates: Partial<Project>): Partial<Project> => {
  if (!isStudioV4Project(project) || !updates) return updates;
  if (!('isPublic' in updates) && !('publishedAt' in updates)) return updates;
  const { isPublic: _isPublic, publishedAt: _publishedAt, ...rest } = updates;
  return rest;
};

type ProjectUpdate = Partial<Project> | ((prev: Project) => Partial<Project>);

export const STATE_LOAD_FAILED_SAVE = "Couldn't load this comic to save your change. Try again.";
export const STATE_LOAD_FAILED = "Couldn't load this comic. Try again.";

/** A short notice the app shell does not render itself (the hook has no UI): one at a time, gone after 6 s. */
const showProjectNotice = (message: string) => {
  if (typeof document === 'undefined' || !document.body) return;
  const id = 'project-state-notice';
  document.getElementById(id)?.remove();
  const el = document.createElement('div');
  el.id = id;
  el.setAttribute('role', 'alert');
  el.className = `${TOAST} ${Z.toast} fixed bottom-6 left-1/2 w-max max-w-[calc(100vw-32px)] -translate-x-1/2`;
  el.textContent = message;
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), 6000);
};

type HasImage = { id?: unknown; imageId?: string; imageUrl?: string };

/**
 * The signed preview URLs a library card already holds, carried onto the full state that replaces it (same image
 * id only), so a card changed from the dashboard keeps its cover. In memory only: a save strips every URL.
 */
const carryCardDisplayUrls = (card: ComicState, full: ComicState): ComicState => {
  const overlay = <T extends HasImage>(target: T[] | undefined, from: T[] | undefined): T[] | undefined => {
    if (!Array.isArray(target) || !Array.isArray(from)) return target;
    const signed = new Map(from.filter((e) => e && e.imageId && e.imageUrl).map((e) => [`${String(e.id)}\u0000${e.imageId}`, e.imageUrl]));
    if (!signed.size) return target;
    return target.map((e) => {
      const url = e && !e.imageUrl && e.imageId ? signed.get(`${String(e.id)}\u0000${e.imageId}`) : undefined;
      return url ? { ...e, imageUrl: url } : e;
    });
  };
  const next: ComicState = { ...full };
  if (!next.coverImageUrl && card.coverImageUrl && next.coverImageId && next.coverImageId === card.coverImageId) next.coverImageUrl = card.coverImageUrl;
  if (!next.coverTemplateImageUrl && card.coverTemplateImageUrl && next.coverTemplateImageId && next.coverTemplateImageId === card.coverTemplateImageId) {
    next.coverTemplateImageUrl = card.coverTemplateImageUrl;
  }
  const panels = overlay(full.panels, card.panels);
  if (panels) next.panels = panels;
  const variants = overlay(full.styleVariants, card.styleVariants);
  if (variants) next.styleVariants = variants;
  if (full.pageStudio?.pages && card.pageStudio?.pages) {
    const pages = overlay(full.pageStudio.pages, card.pageStudio.pages);
    if (pages) next.pageStudio = { ...full.pageStudio, pages };
  }
  return next;
};

export const useProjectManager = () => {
  const { user, loading: authLoading } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const saveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pendingSavesRef = useRef<Map<string, Project>>(new Map());
  // The project list as of the last change, kept synchronously (React state lags a render): the card-only
  // decisions below must see what a save would see.
  const projectsRef = useRef<Project[]>([]);
  // Updates made to a card while its full state loads, applied in order once it is in (EGRESS-DB E1).
  const queuedUpdatesRef = useRef<Map<string, ProjectUpdate[]>>(new Map());
  const stateLoadsRef = useRef<Map<string, Promise<Project | undefined>>>(new Map());
  const deletedIdsRef = useRef<Set<string>>(new Set());

  const commitProjects = (next: Project[] | ((prev: Project[]) => Project[])) => {
    const value = typeof next === 'function' ? next(projectsRef.current) : next;
    projectsRef.current = value;
    setProjects(value);
    return value;
  };

  const persist = (project: Project) => {
    saveProject(project).catch((error) => console.warn('[projects] save failed', project.id, error));
  };

  const scheduleSave = (project: Project) => {
    // A card is never saved (saveProject would refuse it too): its full state loads first.
    if (isCardOnly(project.id)) return;
    pendingSavesRef.current.set(project.id, project);
    const existing = saveTimersRef.current.get(project.id);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      const latest = pendingSavesRef.current.get(project.id);
      pendingSavesRef.current.delete(project.id);
      saveTimersRef.current.delete(project.id);
      if (latest) persist(latest);
    }, SAVE_DEBOUNCE_MS);
    saveTimersRef.current.set(project.id, handle);
  };

  useEffect(() => {
    return () => {
      saveTimersRef.current.forEach((handle) => clearTimeout(handle));
      saveTimersRef.current.clear();
      pendingSavesRef.current.forEach((project) => {
        persist(project);
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

	    const hydratePageStudioPage = async (page: PageStudioPage): Promise<PageStudioPage> => {
	      const imageUrl = page.imageId ? await getImageUrl(page.imageId) : page.imageUrl;
	      const baseImageUrl = page.baseImageId
	        ? await getImageUrl(page.baseImageId)
	        : page.baseImageUrl || imageUrl;
	      const edits = page.edits
	        ? await Promise.all(page.edits.map(async (edit) => ({
	            ...edit,
	            imageUrl: edit.imageId ? await getImageUrl(edit.imageId) : edit.imageUrl
	          })))
	        : [];
	      return {
	        ...page,
	        imageUrl,
	        baseImageUrl,
	        edits
	      };
	    };

	    const panels = await Promise.all(project.state.panels.map(hydratePanel));
	    const characters = await Promise.all(project.state.characters.map(hydrateEntity));
	    const items = await Promise.all(project.state.items.map(hydrateEntity));
	    const locations = await Promise.all(project.state.locations.map(hydrateEntity));
	    const styleVariants = await Promise.all(project.state.styleVariants.map(hydrateVariant));
	    const pageStudio = project.state.pageStudio
	      ? {
	          ...project.state.pageStudio,
	          pages: await Promise.all(project.state.pageStudio.pages.map(hydratePageStudioPage))
	        }
	      : project.state.pageStudio;

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
	      pageStudio,
	      styleImageUrl,
	    }, { useThumbTransform: false });

    const hydratedProject: Project = {
      ...project,
      state: migratedState
    };

    if (didStateMigrationRequireSave(project.state, migratedState)) {
      persist(hydratedProject);
    }

    return hydratedProject;
  };

  // Comic Studio v4 rows carry a server-mirrored listing state (studioVersion: 4) over a
  // document that lives in comic_docs. Only the cover thumbnail is signed here: the
  // classic flow migrations would "repair" that state and write it back over the
  // server's mirror on every dashboard load.
  const hydrateStudioCover = async (project: Project): Promise<Project> => {
    const coverImageId = project.state.coverImageId;
    if (!coverImageId) return project;
    const coverImageUrl = await getImageUrl(coverImageId, { transform: IMAGE_TRANSFORMS.thumb }).catch(() => undefined);
    return coverImageUrl ? { ...project, state: { ...project.state, coverImageUrl } } : project;
  };

  // A library card (EGRESS-DB E1) is a state subset: only its preview images are signed here. The classic flow
  // migrations need the whole state, so they run (and save) when the comic is opened (hydrateProject), never on a
  // card, and nothing here is ever saved.
  const hydrateCardThumbnails = async (project: Project): Promise<Project> => {
    if (isStudioV4Project(project)) return hydrateStudioCover(project);
    const state = project.state;
    const thumb = (id: string) => getImageUrl(id, { transform: IMAGE_TRANSFORMS.thumb }).catch(() => undefined);

    let panels = state.panels;
    const firstPanelIndex = panels.findIndex(
      (panel) => !panel.imageUrl && (!!panel.imageId || (panel.imageIdHistory?.length || 0) > 0)
    );
    if (firstPanelIndex >= 0) {
      const target = panels[firstPanelIndex];
      const previewImageId = target.imageId || target.imageIdHistory?.[target.imageIdHistory.length - 1];
      const imageUrl = previewImageId ? await thumb(previewImageId) : undefined;
      if (imageUrl) {
        panels = [...panels];
        panels[firstPanelIndex] = { ...target, imageUrl };
      }
    }

    let styleVariants = state.styleVariants;
    const firstStyleIndex = styleVariants.findIndex((variant) => !variant.imageUrl && !!variant.imageId);
    if (firstStyleIndex >= 0) {
      const target = styleVariants[firstStyleIndex];
      const imageUrl = await thumb(target.imageId!);
      if (imageUrl) {
        styleVariants = [...styleVariants];
        styleVariants[firstStyleIndex] = { ...target, imageUrl };
      }
    }

    let pageStudio = state.pageStudio;
    if (pageStudio?.pages?.length) {
      pageStudio = {
        ...pageStudio,
        pages: await Promise.all(pageStudio.pages.map(async (page) => ({
          ...page,
          imageUrl: page.imageId ? await thumb(page.imageId) : page.imageUrl
        })))
      };
    }

    const coverImageUrl = state.coverImageId ? await thumb(state.coverImageId) : state.coverImageUrl;
    const coverTemplateImageUrl = state.coverTemplateImageId
      ? await getImageUrl(state.coverTemplateImageId, { transform: IMAGE_TRANSFORMS.editor }).catch(() => undefined)
      : state.coverTemplateImageUrl;

    return {
      ...project,
      state: {
        ...state,
        panels,
        styleVariants,
        ...(pageStudio ? { pageStudio } : {}),
        coverImageUrl,
        coverTemplateImageUrl
      }
    };
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
      setProjectsLoaded(false);
      if (!user) {
        commitProjects([]);
        setProjectsLoaded(true);
        return;
      }

      const { projects: cards, fullBefore } = await loadProjectCards();
      // Synchronous from here until the decision is recorded: loadProjectCards has just flagged every listed id
      // card-only. A full project this tab already holds stays (and is flagged full again) when the row has not
      // changed since, or when an edit of it is waiting to save; any other listed comic becomes its card, so a
      // newer remote edit always forces a fresh load before the next save.
      const held = new Map(projectsRef.current.map((p) => [p.id, p]));
      const kept = new Map<string, Project>();
      for (const card of cards) {
        const existing = held.get(card.id);
        if (!existing || !fullBefore.has(card.id)) continue;
        if (existing.updatedAt === card.updatedAt || pendingSavesRef.current.has(card.id)) {
          markStateLoaded(card.id);
          kept.set(card.id, existing);
        }
      }

      const fresh = await Promise.all(cards.filter((card) => !kept.has(card.id)).map(hydrateCardThumbnails));
      const freshById = new Map(fresh.map((card) => [card.id, card]));
      commitProjects((prev) => {
        const live = new Map(prev.map((p) => [p.id, p]));
        const next: Project[] = [];
        for (const card of cards) {
          if (deletedIdsRef.current.has(card.id)) continue;
          const current = live.get(card.id);
          if (kept.has(card.id)) {
            next.push(current ?? kept.get(card.id)!);
          } else if (!isCardOnly(card.id) && current) {
            // Its full state loaded while the previews were signed: keep it, never a card over it.
            next.push(current);
          } else {
            next.push(freshById.get(card.id) ?? card);
          }
        }
        return next;
      });
    } catch (e) {
      console.error("Failed to load projects", e);
    } finally {
      setProjectsLoaded(true);
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
    commitProjects(prev => [newProject, ...prev]);
    persist(newProject);
    return newProject;
  };

  /** Apply one update to a project whose full state is in memory, then schedule its save. */
  const applyUpdate = (id: string, updates: ProjectUpdate) => {
    let updated: Project | undefined;
    commitProjects(prevProjects => prevProjects.map(p => {
      if (p.id !== id) return p;
      const newValues = typeof updates === 'function' ? updates(p) : updates;
      updated = { ...p, ...withoutStudioVisibility(p, newValues), updatedAt: Date.now() };
      return updated;
    }));
    if (updated) scheduleSave(updated);
  };

  const flushQueuedUpdates = (id: string) => {
    const queued = queuedUpdatesRef.current.get(id);
    if (!queued) return;
    queuedUpdatesRef.current.delete(id);
    for (const updates of queued) applyUpdate(id, updates);
  };

  /**
   * The comic with its full state (EGRESS-DB E1): a card loads its state once (one request per id at a time),
   * replaces the card with it, then applies the updates queued meanwhile. A full project resolves as it is.
   * Rejects when the state cannot be loaded; the queued updates are then dropped, with a notice.
   */
  const ensureProjectState = (id: string): Promise<Project | undefined> => {
    if (!projectsRef.current.some((p) => p.id === id)) return Promise.resolve(undefined);
    if (!isCardOnly(id)) {
      flushQueuedUpdates(id);
      return Promise.resolve(projectsRef.current.find((p) => p.id === id));
    }
    const inflight = stateLoadsRef.current.get(id);
    if (inflight) return inflight;
    const run = loadProjectState(id)
      .then(({ state, updatedAt }) => {
        // loadProjectState has just flagged the id full: the card is replaced in this same turn.
        commitProjects((prev) => prev.map((p) => (p.id === id ? { ...p, state: carryCardDisplayUrls(p.state, state), updatedAt } : p)));
        flushQueuedUpdates(id);
        return projectsRef.current.find((p) => p.id === id);
      })
      .catch((error) => {
        const dropped = queuedUpdatesRef.current.get(id)?.length ?? 0;
        queuedUpdatesRef.current.delete(id);
        if (dropped > 0) showProjectNotice(STATE_LOAD_FAILED_SAVE);
        console.warn('[projects] could not load the full state', id, error);
        throw error;
      })
      .finally(() => {
        stateLoadsRef.current.delete(id);
      });
    stateLoadsRef.current.set(id, run);
    return run;
  };

  const updateProject = (id: string, updates: ProjectUpdate) => {
    if (!projectsRef.current.some((p) => p.id === id)) return;
    if (isCardOnly(id)) {
      // A card holds a subset of the comic: the change waits for the full state, so it is never saved over it.
      const queue = queuedUpdatesRef.current.get(id);
      if (queue) queue.push(updates);
      else queuedUpdatesRef.current.set(id, [updates]);
      void ensureProjectState(id).catch(() => undefined);
      return;
    }
    applyUpdate(id, updates);
  };

  const deleteProject = (id: string) => {
    deletedIdsRef.current.add(id);
    commitProjects(prev => prev.filter(p => p.id !== id));
    const existing = saveTimersRef.current.get(id);
    if (existing) clearTimeout(existing);
    saveTimersRef.current.delete(id);
    pendingSavesRef.current.delete(id);
    queuedUpdatesRef.current.delete(id);
    void deleteProjectRecord(id);
  };

  const duplicateProject = async (id: string) => {
    const listed = projectsRef.current.find(p => p.id === id);
    // A v4 studio comic's content lives in comic_docs (server-owned); copying the listing
    // row alone would produce a comic with no document. The dashboard disables the action.
    if (!listed || isStudioV4Project(listed)) return;
    // A copy of a card would be a copy of a subset: the copy is made from the full state.
    let original: Project | undefined;
    try {
      original = await ensureProjectState(id);
    } catch {
      showProjectNotice(STATE_LOAD_FAILED);
      return;
    }
    if (!original || isStudioV4Project(original)) return;
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
    commitProjects(prev => [copy, ...prev]);
    persist(copy);
  };

  const getProject = (id: string) => projects.find(p => p.id === id);

  const hydrateProjectAssets = async (projectId: string): Promise<Project | undefined> => {
    const target = projectsRef.current.find((p) => p.id === projectId);
    if (!target) return undefined;
    // v4 studio comics sign their own assets through /api/comic (see hydrateStudioCover).
    if (isStudioV4Project(target)) return target;
    // Opening a comic listed as a card loads its full state first (rejects when it cannot).
    const full = await ensureProjectState(projectId);
    if (!full) return undefined;
    if (isStudioV4Project(full)) return full;
    const hydrated = await hydrateProject(full);
    commitProjects((prev) => prev.map((p) => (p.id === projectId ? hydrated : p)));
    return hydrated;
  };

  const startGeneration = async (projectId: string) => {
    // A generation reads and writes the whole comic: never from a card.
    let project: Project | undefined;
    try {
      project = await ensureProjectState(projectId);
    } catch {
      showProjectNotice(STATE_LOAD_FAILED);
      return;
    }
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
    const projectName = project.name;
    startBackgroundGeneration(
      generationProject,
      updateProject, // Pass the updater
      (pid, panels) => {
        void createGenerationNotification(pid, projectName);
      }
    );
  };

  const stopGeneration = (projectId: string) => {
    cancelGeneration(projectId);
  };

  return {
    projects,
    projectsLoaded,
    createProject,
    updateProject,
    deleteProject,
    duplicateProject,
    getProject,
    startGeneration,
    stopGeneration,
    reloadProjects: loadAllProjects,
    hydrateProjectAssets,
    ensureProjectState
  };
};
