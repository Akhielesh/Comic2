import { useState, useEffect, useRef } from 'react';
import { Project, ComicState, AppStep, ComicPanel, Character, Item, Location, StyleVariant, PageStudioPage } from '../types';
import { startBackgroundGeneration, cancelGeneration } from '../services/generationManager';
import { DEFAULT_PRICING_CONFIG } from '../services/pricingConfig';
import { buildDefaultContinuityState, validateContinuityState } from '../services/continuity';
import {
  CARD_STATE,
  PROJECT_CARD_STATE_KEYS,
  createGenerationNotification,
  isCardState,
  loadProjectCards,
  loadProjectState,
  isCardOnly,
  markCardOnly,
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
/** An update waiting for its comic's full state, with the library card that was in memory when it was made. */
type QueuedUpdate = { updates: ProjectUpdate; card?: Project };

export const STATE_LOAD_FAILED_SAVE = "Couldn't load this comic to save your change. Try again.";
export const STATE_LOAD_FAILED = "Couldn't load this comic. Try again.";
/** A change made on a comic shown from its library card after it failed to open: nothing of it is saved. */
export const STATE_NOT_OPENED_SAVE = "This comic didn't open, so your change wasn't saved. Open it again to keep editing.";

/** How long an open waits before each retry of a full-state load that failed (the app shows its loader meanwhile). */
export const OPEN_RETRY_DELAYS_MS = [600, 1800] as const;

export const PROJECT_NOTICE_ID = 'project-state-notice';

/**
 * A short notice the app shell does not render itself (the hook has no UI): one at a time, gone after 6 s. The
 * outer element places it (fixed, on the toast layer); the TOAST recipe, which is `relative` for its own edge and
 * countdown, styles the inner one, so it never pulls the notice back into the page flow.
 */
const showProjectNotice = (message: string) => {
  if (typeof document === 'undefined' || !document.body) return;
  document.getElementById(PROJECT_NOTICE_ID)?.remove();
  const place = document.createElement('div');
  place.id = PROJECT_NOTICE_ID;
  place.className = `pointer-events-none fixed bottom-6 left-1/2 w-max max-w-[calc(100vw-32px)] -translate-x-1/2 ${Z.toast}`;
  const el = document.createElement('div');
  el.setAttribute('role', 'alert');
  el.className = TOAST;
  el.textContent = message;
  place.appendChild(el);
  document.body.appendChild(place);
  window.setTimeout(() => place.remove(), 6000);
};

const CARD_KEYS: ReadonlySet<string> = new Set<string>(PROJECT_CARD_STATE_KEYS);
/** The Page Studio keys a card carries (projectCardStateOf): its pages and the active page. */
const CARD_PAGE_STUDIO_KEYS: ReadonlySet<string> = new Set(['pages', 'activePageId']);
/** Display URLs a save strips (sanitizeProjectForStorage): their value never reaches the row. */
const STRIPPED_ON_SAVE: ReadonlySet<string> = new Set(['coverImageUrl', 'coverTemplateImageUrl', 'styleImageUrl']);

const sameValue = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

/**
 * An update made while only a comic's library card was in memory, resolved against the full state that has since
 * loaded (`next`, over `full`) and against that card (`fromCard`). It changes a key the card does not carry (or a
 * Page Studio key other than its pages) to the value it also gives the card: a value that does not depend on the
 * comic it is applied to, so it was computed from the card, from keys the card lacks (an image-tag map rebuilt from
 * nothing, a version list of one, a style built from defaults). Changes to the card's own keys, and changes computed
 * from the comic itself (`prev`), never match.
 */
const changesKeysTheCardLacks = (full: ComicState, next: ComicState | undefined, fromCard: ComicState | undefined): boolean => {
  if (!next || next === full) return false;
  const before = full as unknown as Record<string, unknown>;
  const after = next as unknown as Record<string, unknown>;
  const card = (fromCard ?? {}) as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (CARD_KEYS.has(key) || STRIPPED_ON_SAVE.has(key) || Object.is(before[key], after[key])) continue;
    if (key === 'pageStudio') {
      const was = (before.pageStudio ?? {}) as Record<string, unknown>;
      const now = (after.pageStudio ?? {}) as Record<string, unknown>;
      const onCard = (card.pageStudio ?? {}) as Record<string, unknown>;
      for (const sub of new Set([...Object.keys(was), ...Object.keys(now)])) {
        if (CARD_PAGE_STUDIO_KEYS.has(sub) || Object.is(was[sub], now[sub])) continue;
        if (sameValue(now[sub], onCard[sub])) return true;
      }
      continue;
    }
    if (sameValue(after[key], card[key])) return true;
  }
  return false;
};

type HasImage = { id?: unknown; imageId?: string; imageUrl?: string };

/**
 * The signed URLs the in-memory copy already holds (a library card's previews, or an opened comic's images),
 * carried onto the state loaded to replace it (same image id only), so a card changed from the dashboard keeps its
 * cover and a refreshed comic keeps its pictures. In memory only: a save strips every URL.
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
  if (!next.styleImageUrl && card.styleImageUrl && next.styleImageId && next.styleImageId === card.styleImageId) next.styleImageUrl = card.styleImageUrl;
  const panels = overlay(full.panels, card.panels);
  if (panels) next.panels = panels;
  const variants = overlay(full.styleVariants, card.styleVariants);
  if (variants) next.styleVariants = variants;
  const characters = overlay(full.characters, card.characters);
  if (characters) next.characters = characters;
  const items = overlay(full.items, card.items);
  if (items) next.items = items;
  const locations = overlay(full.locations, card.locations);
  if (locations) next.locations = locations;
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
  // Saves sent and not yet answered, per id (a 2.5 MB upsert can take a while on a slow uplink).
  const inflightSavesRef = useRef<Map<string, Set<Promise<void>>>>(new Map());
  // When each id's last save was answered: a library list requested before then may predate it.
  const lastSaveSettledRef = useRef<Map<string, number>>(new Map());
  // A visibility (isPublic) change made here, per id: `settledAt` is Infinity until the save that carries it is
  // answered. Until a library list newer than that, the local value wins over the row's.
  const visibilityEditsRef = useRef<Map<string, { seq: number; settledAt: number }>>(new Map());
  const visibilitySeqRef = useRef(0);
  // The project list as of the last change, kept synchronously (React state lags a render): the card-only
  // decisions below must see what a save would see.
  const projectsRef = useRef<Project[]>([]);
  // Updates made while a comic's full state loads, applied in order once it is in (EGRESS-DB E1).
  const queuedUpdatesRef = useRef<Map<string, QueuedUpdate[]>>(new Map());
  const stateLoadsRef = useRef<Map<string, Promise<Project | undefined>>>(new Map());
  const deletedIdsRef = useRef<Set<string>>(new Set());
  // Comics whose open failed while only their card was in memory: App then shows the card in the workspace
  // (its best-effort fallback), and every change made there would be computed from keys the card lacks.
  const openFailedIdsRef = useRef<Set<string>>(new Set());

  const commitProjects = (next: Project[] | ((prev: Project[]) => Project[])) => {
    const value = typeof next === 'function' ? next(projectsRef.current) : next;
    projectsRef.current = value;
    setProjects(value);
    return value;
  };

  const persist = (project: Project): Promise<void> => {
    const id = project.id;
    const visibilitySeq = visibilityEditsRef.current.get(id)?.seq;
    const run = saveProject(project).catch((error) => console.warn('[projects] save failed', id, error));
    const inflight = inflightSavesRef.current.get(id) ?? new Set<Promise<void>>();
    inflight.add(run);
    inflightSavesRef.current.set(id, inflight);
    void run.then(() => {
      inflight.delete(run);
      if (inflight.size === 0 && inflightSavesRef.current.get(id) === inflight) inflightSavesRef.current.delete(id);
      const settledAt = Date.now();
      lastSaveSettledRef.current.set(id, settledAt);
      const visibility = visibilityEditsRef.current.get(id);
      if (visibility && visibility.seq === visibilitySeq && visibility.settledAt === Infinity) visibility.settledAt = settledAt;
    });
    return run;
  };

  /** True when a change of this comic made here is waiting to save, saving, or was saved after `since`. */
  const hasLocalSaveSince = (id: string, since: number) =>
    pendingSavesRef.current.has(id) ||
    (inflightSavesRef.current.get(id)?.size ?? 0) > 0 ||
    (lastSaveSettledRef.current.get(id) ?? -Infinity) >= since;

  const scheduleSave = (project: Project) => {
    // Unreachable by design (a flagged id's changes are queued, and the flags change in the same step as the
    // state): a card, or a copy older than the row, is never saved (saveProject would refuse it too).
    if (isCardOnly(project.id)) {
      console.warn('[projects] a change reached the save of a comic whose full state is not loaded', project.id);
      return;
    }
    pendingSavesRef.current.set(project.id, project);
    const existing = saveTimersRef.current.get(project.id);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      const latest = pendingSavesRef.current.get(project.id);
      pendingSavesRef.current.delete(project.id);
      saveTimersRef.current.delete(project.id);
      if (latest) void persist(latest);
    }, SAVE_DEBOUNCE_MS);
    saveTimersRef.current.set(project.id, handle);
  };

  useEffect(() => {
    return () => {
      saveTimersRef.current.forEach((handle) => clearTimeout(handle));
      saveTimersRef.current.clear();
      pendingSavesRef.current.forEach((project) => {
        void persist(project);
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
      void persist(hydratedProject);
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

  /**
   * A full comic held in memory, with the row columns the server writes (moderation holds, a classic public share,
   * like and view counters) taken from the library card: none of those writes changes updated_at, and a save sends
   * is_public back, so a stale value would undo a hold (and the database would then refuse every save) or unpublish
   * a share. The local isPublic stays only while a change of it made here may be newer than the list. A copy older
   * than the row (`stale`) takes the row's name, cover and time as well.
   */
  const withRowColumns = (held: Project, card: Project, requestedAt: number, stale: boolean): Project => {
    const visibility = visibilityEditsRef.current.get(held.id);
    const localVisibility = !!visibility && visibility.settledAt >= requestedAt;
    const next: Project = {
      ...held,
      likesCount: card.likesCount,
      viewsCount: card.viewsCount,
      contentRating: card.contentRating,
      ...(localVisibility ? {} : { isPublic: card.isPublic }),
      ...(stale ? { name: card.name, coverImage: card.coverImage, updatedAt: card.updatedAt, authorName: card.authorName } : {})
    };
    if (next.contentRating === undefined) delete next.contentRating;
    return next;
  };

  const loadAllProjects = async () => {
    try {
      setProjectsLoaded(false);
      if (!user) {
        commitProjects([]);
        setProjectsLoaded(true);
        return;
      }

      const requestedAt = Date.now();
      const cards = await loadProjectCards();
      // Synchronous from here until every listed id is flagged, so no update lands between a decision and its flag.
      // A full comic held in memory is never replaced by its card (a workspace may be showing it, and an edit made
      // there from a card would be computed from keys the card lacks). It stays full when the row has not changed
      // since, or when a change of it made here is waiting, saving, or saved after this list was asked for.
      // Otherwise the row changed elsewhere: the copy stays in memory, flagged, so its next change or open loads the
      // newer state first. Every other listed comic is a card, flagged.
      const held = new Map(projectsRef.current.map((p) => [p.id, p]));
      const fullHeld = new Set<string>();
      const staleHeld = new Set<string>();
      for (const card of cards) {
        const existing = held.get(card.id);
        if (existing && !isCardState(existing.state)) {
          const current = !isCardOnly(card.id) && (existing.updatedAt === card.updatedAt || hasLocalSaveSince(card.id, requestedAt));
          if (current) {
            fullHeld.add(card.id);
          } else {
            staleHeld.add(card.id);
            markCardOnly(card.id);
          }
        } else {
          markCardOnly(card.id);
        }
      }

      const fresh = await Promise.all(cards.filter((card) => !fullHeld.has(card.id) && !staleHeld.has(card.id)).map(hydrateCardThumbnails));
      const freshById = new Map(fresh.map((card) => [card.id, card]));
      commitProjects((prev) => {
        const live = new Map(prev.map((p) => [p.id, p]));
        const next: Project[] = [];
        for (const card of cards) {
          if (deletedIdsRef.current.has(card.id)) continue;
          const current = live.get(card.id);
          if (current && !isCardState(current.state)) {
            // Full in memory (held, or loaded while the previews were signed): never a card over it.
            // A copy the row had moved past takes the row's name and cover too, unless a change made here since
            // (applied once its newer state loaded during the previews) is on its way to the row.
            next.push(withRowColumns(current, card, requestedAt, staleHeld.has(card.id) && !hasLocalSaveSince(card.id, requestedAt)));
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

  /**
   * A state built from a library card (a component that still holds the card spread it and changed a key) is the
   * card's keys plus that change: it is laid over the full state, never put in its place. Page Studio is the one
   * card key that is itself partial ({ pages, activePageId }), so it is merged a level down.
   */
  const overFullState = (full: ComicState, fromCard: ComicState): ComicState => {
    const { [CARD_STATE]: _marker, ...patch } = fromCard as ComicState & { [CARD_STATE]?: true };
    const merged: ComicState = { ...full, ...patch };
    if (full.pageStudio && patch.pageStudio) merged.pageStudio = { ...full.pageStudio, ...patch.pageStudio };
    return merged;
  };

  /**
   * Apply one update to a project whose full state is in memory, then schedule its save. `card` is the library card
   * that was in memory when a queued update was made: an update that sets a key the card lacks to a value computed
   * from the card (changesKeysTheCardLacks) is dropped, never saved over the full state.
   */
  const applyUpdate = (id: string, updates: ProjectUpdate, card?: Project) => {
    let updated: Project | undefined;
    let refused = false;
    commitProjects(prevProjects => prevProjects.map(p => {
      if (p.id !== id) return p;
      let newValues = typeof updates === 'function' ? updates(p) : updates;
      if (newValues?.state && isCardState(newValues.state) && !isCardState(p.state)) {
        newValues = { ...newValues, state: overFullState(p.state, newValues.state) };
      }
      if (card && newValues?.state) {
        const onCard = typeof updates === 'function' ? updates(card) : updates;
        if (changesKeysTheCardLacks(p.state, newValues.state, onCard?.state)) {
          refused = true;
          return p;
        }
      }
      const next = { ...p, ...withoutStudioVisibility(p, newValues), updatedAt: Date.now() };
      if (next.isPublic !== p.isPublic) {
        visibilitySeqRef.current += 1;
        visibilityEditsRef.current.set(id, { seq: visibilitySeqRef.current, settledAt: Infinity });
      }
      updated = next;
      return next;
    }));
    if (refused) console.warn('[projects] dropped a change computed from the library card, not the comic', id);
    if (updated) scheduleSave(updated);
  };

  const flushQueuedUpdates = (id: string) => {
    const queued = queuedUpdatesRef.current.get(id);
    if (!queued) return;
    queuedUpdatesRef.current.delete(id);
    for (const { updates, card } of queued) applyUpdate(id, updates, card);
  };

  /** True while the in-memory copy may not be saved: a card, or a full copy older than the row. */
  const needsStateLoad = (id: string) => {
    if (isCardOnly(id)) return true;
    const current = projectsRef.current.find((p) => p.id === id);
    return !!current && isCardState(current.state);
  };

  /** Saves of this comic still in flight: a state load waits for them, so it never reads what they replace. */
  const settleSaves = async (id: string) => {
    const inflight = inflightSavesRef.current.get(id);
    if (inflight?.size) await Promise.all([...inflight]);
  };

  /**
   * The comic with its full state (EGRESS-DB E1): a card (or a copy older than the row) loads its state once (one
   * request per id at a time), after any save of it in flight, and is replaced by it in the same step as its flag is
   * cleared; then the updates queued meanwhile apply. A full project resolves as it is. Rejects when the state cannot
   * be loaded; the queued updates are then dropped, with a notice.
   */
  const ensureProjectState = (id: string): Promise<Project | undefined> => {
    if (!projectsRef.current.some((p) => p.id === id)) return Promise.resolve(undefined);
    if (!needsStateLoad(id)) {
      flushQueuedUpdates(id);
      return Promise.resolve(projectsRef.current.find((p) => p.id === id));
    }
    const inflight = stateLoadsRef.current.get(id);
    if (inflight) return inflight;
    const run = settleSaves(id)
      .then(() => loadProjectState(id))
      .then(({ state, updatedAt }) => {
        if (deletedIdsRef.current.has(id) || !projectsRef.current.some((p) => p.id === id)) return undefined;
        markStateLoaded(id);
        openFailedIdsRef.current.delete(id);
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
    const current = projectsRef.current.find((p) => p.id === id);
    if (!current) return;
    if (openFailedIdsRef.current.has(id) && isCardState(current.state)) {
      // The comic failed to open and a workspace may be showing its card: whatever it computes there is built from
      // keys the card lacks (an image-tag map from nothing, a version list of one), so nothing of it is saved, and
      // no load is started that would let it land on the full state. Opening the comic again retries.
      showProjectNotice(STATE_NOT_OPENED_SAVE);
      return;
    }
    if (needsStateLoad(id)) {
      // A card holds a subset of the comic: the change waits for the full state, so it is never saved over it.
      const entry: QueuedUpdate = { updates, card: isCardState(current.state) ? current : undefined };
      const queue = queuedUpdatesRef.current.get(id);
      if (queue) queue.push(entry);
      else queuedUpdatesRef.current.set(id, [entry]);
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
    openFailedIdsRef.current.delete(id);
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

  // A comic that failed to open is still returned as its card (App's fallback shows it, with its own way back to
  // the library); updateProject refuses every change made on it until it opens.
  const getProject = (id: string) => projects.find(p => p.id === id);

  /** ensureProjectState for an open: a failed load is retried (OPEN_RETRY_DELAYS_MS) while the app shows its loader. */
  const loadStateForOpen = async (projectId: string): Promise<Project | undefined> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await ensureProjectState(projectId);
      } catch (error) {
        const delay = OPEN_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !projectsRef.current.some((p) => p.id === projectId)) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  };

  const hydrateProjectAssets = async (projectId: string): Promise<Project | undefined> => {
    const target = projectsRef.current.find((p) => p.id === projectId);
    if (!target) return undefined;
    // v4 studio comics sign their own assets through /api/comic (see hydrateStudioCover).
    if (isStudioV4Project(target)) return target;
    // Opening a comic listed as a card loads its full state first (rejects when it cannot).
    let full: Project | undefined;
    try {
      full = await loadStateForOpen(projectId);
    } catch (error) {
      if (projectsRef.current.some((p) => p.id === projectId && isCardState(p.state))) openFailedIdsRef.current.add(projectId);
      showProjectNotice(STATE_LOAD_FAILED);
      throw error;
    }
    openFailedIdsRef.current.delete(projectId);
    if (!full) return undefined;
    if (isStudioV4Project(full)) return full;
    const hydrated = await hydrateProject(full);
    commitProjects((prev) => prev.map((p) => {
      if (p.id !== projectId) return p;
      // The row columns a reload took meanwhile stay; a change that landed while the images were signed (a
      // generation tick) is kept too, and only the signed URLs carry over onto it.
      if (p.state === full!.state || isCardState(p.state)) return { ...p, state: hydrated.state };
      return { ...p, state: carryCardDisplayUrls(hydrated.state, p.state) };
    }));
    return projectsRef.current.find((p) => p.id === projectId) ?? hydrated;
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
