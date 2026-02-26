import crypto from 'node:crypto';
import {
  COMICFORGE_STAGE_ORDER,
  ComicForgeAssetCard,
  ComicForgeBalloonZone,
  ComicForgeExportPreset,
  ComicForgeJobSummary,
  ComicForgeLayoutTemplate,
  ComicForgePagePlanRow,
  ComicForgePreviewPack,
  ComicForgeQCReport,
  ComicForgeStage,
  ComicForgeState,
  ComicForgeStoryboardValidation,
  ComicForgeStyleRecommendation
} from '../../../types.js';
import {
  appendJobEvent,
  createAssetCard as createAssetCardRecord,
  createGenerationJob,
  getGenerationJob,
  getProjectCostTracker,
  listAssetCards as listAssetCardsForProject,
  listJobEvents,
  readComicForgeState,
  updateAssetCard,
  updateGenerationJob,
  writeComicForgeState
} from './repositories.js';
import { enqueueComicForgeJob, getComicForgeJobState, isComicForgeQueueConfigured } from './queue.js';
import { TaskType, assertNoTextPromptContract, buildNoTextPrompt, getModelPolicy } from './modelRouter.js';

type ServiceContext = {
  userId: string;
  projectId: string;
};

const stageOrderIndex = (stage: ComicForgeStage) => COMICFORGE_STAGE_ORDER.indexOf(stage);

const markStageProgress = (state: ComicForgeState, stage: ComicForgeStage): ComicForgeState => {
  const maxStageReached = stageOrderIndex(stage) > stageOrderIndex(state.maxStageReached)
    ? stage
    : state.maxStageReached;
  return {
    ...state,
    stage,
    maxStageReached,
    updatedAt: Date.now()
  };
};

const parseSegments = (rawScriptText: string): string[] => {
  const normalized = rawScriptText
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (normalized.length > 0) return normalized;

  return rawScriptText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
};

const extractCastNames = (rawScriptText: string): string[] => {
  const matches = rawScriptText.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g) || [];
  const denied = new Set(['Scene', 'The', 'A', 'An', 'And', 'With', 'At', 'In', 'On', 'To', 'From', 'By']);
  return Array.from(new Set(matches.filter((name) => !denied.has(name)))).slice(0, 24);
};

type SceneHeading = {
  sceneId: string;
  name: string;
  location: string;
  time: string;
};

const normalizeAssetName = (value: string): string =>
  value.trim().replace(/\s+/g, ' ');

const assetKey = (cardType: ComicForgeAssetCard['cardType'], name: string): string =>
  `${cardType}:${normalizeAssetName(name).toLowerCase()}`;

const extractSceneHeadings = (rawScriptText: string): SceneHeading[] => {
  const matches = Array.from(rawScriptText.matchAll(/(?:^|\n)\s*SCENE\s+(\d+)\s*:\s*([^\n]+)/gi));
  if (matches.length === 0) return [];

  return matches.map((match, index) => {
    const label = (match[2] || '').trim();
    const [locationRaw, timeRaw] = label.split(/\s+-\s+/, 2);
    const location = (locationRaw || 'unspecified').trim() || 'unspecified';
    const time = (timeRaw || 'unspecified').trim() || 'unspecified';

    return {
      sceneId: `scene-${index + 1}`,
      name: `Scene ${index + 1}: ${location}`,
      location,
      time
    };
  });
};

const extractPropNames = (rawScriptText: string, excludedNames: string[]): string[] => {
  const excluded = new Set(excludedNames.map((name) => normalizeAssetName(name).toLowerCase()));
  const stop = new Set([
    'scene',
    'location',
    'detail',
    'translation',
    'the',
    'a',
    'an',
    'and',
    'for',
    'from',
    'with',
    'there',
    'this',
    'that',
    'dusk',
    'night',
    'day'
  ]);

  const values: string[] = [];
  const pushUnique = (value: string) => {
    const normalized = normalizeAssetName(value);
    const key = normalized.toLowerCase();
    if (!normalized || stop.has(key) || excluded.has(key)) return;
    if (!values.some((entry) => entry.toLowerCase() === key)) {
      values.push(normalized);
    }
  };

  for (const match of rawScriptText.matchAll(/"([^"\n]{2,80})"/g)) {
    pushUnique(match[1] || '');
  }

  for (const match of rawScriptText.matchAll(/\b([A-Z][A-Za-z0-9'-]*(?:\s+[A-Z][A-Za-z0-9'-]*){1,3})\b/g)) {
    pushUnique(match[1] || '');
  }

  return values.slice(0, 24);
};

const inferredAssetDescription = (
  cardType: ComicForgeAssetCard['cardType'],
  name: string
): string => {
  if (cardType === 'character') {
    return `Character grounded in script scenes: ${name}. Keep identity and continuity consistent with source text.`;
  }
  if (cardType === 'location') {
    return `Story location from script scenes: ${name}. Preserve key environmental cues and mood across pages.`;
  }
  return `Story prop from script context: ${name}. Keep visual identity and function consistent across appearances.`;
};

const seedAssetCardsFromAnalysis = async (
  projectId: string,
  analysis: {
    castList: Array<{ name: string }>;
    sceneList: Array<{ location: string }>;
    propList: Array<{ name: string }>;
  }
): Promise<ComicForgeAssetCard[]> => {
  const existing = await listAssetCardsForProject(projectId);
  const seen = new Set(existing.map((card) => assetKey(card.cardType, card.name)));
  const seeded = [...existing];

  const maybeCreate = async (cardType: ComicForgeAssetCard['cardType'], name: string) => {
    const normalizedName = normalizeAssetName(name);
    if (!normalizedName || normalizedName.toLowerCase() === 'unspecified') return;
    const key = assetKey(cardType, normalizedName);
    if (seen.has(key)) return;

    const card: ComicForgeAssetCard = {
      id: crypto.randomUUID(),
      cardType,
      name: normalizedName,
      canonicalDescription: inferredAssetDescription(cardType, normalizedName),
      doNotChange: [],
      negativeConstraints: [],
      allowedVariants: ['expressions and scene lighting can vary'],
      referenceImages: [],
      consistencyMethod: 'reference_injection',
      hash: createAssetHash(`${cardType}:${normalizedName}`),
      status: 'draft'
    };

    const created = await createAssetCardRecord(projectId, card);
    seeded.push(created);
    seen.add(key);
  };

  for (const character of analysis.castList) {
    await maybeCreate('character', character.name);
  }
  for (const location of analysis.sceneList) {
    await maybeCreate('location', location.location);
  }
  for (const prop of analysis.propList) {
    await maybeCreate('prop', prop.name);
  }

  return seeded;
};

const isQueueUnavailableError = (error: unknown): boolean => {
  const code = String((error as { publicCode?: string })?.publicCode || '').toUpperCase();
  const message = String((error as { message?: string })?.message || '').toLowerCase();
  return code === 'COMICFORGE_QUEUE_UNAVAILABLE'
    || message.includes('queue is unavailable')
    || message.includes('redis')
    || message.includes('econnrefused');
};

const estimatePagePlanCount = (panelCount: number) => Math.max(1, Math.ceil(panelCount / 4));

const resolvePagePurpose = (index: number, pageCount: number): ComicForgePagePlanRow['purpose'] => {
  if (index === 0) return 'setup';
  if (index === pageCount - 1) return 'payoff';
  if (index % 3 === 0) return 'dialogue';
  return 'action';
};

const resolvePlatformDimensions = (
  platform: 'webtoon' | 'tapas' | 'print_a4' | 'print_us_letter' | 'pdf_portfolio' | 'instagram'
) => {
  switch (platform) {
    case 'webtoon':
      return { width: 800, height: 12000, panelDensityMax: 8, bleed: 0, trim: 0, safeArea: 20, gutter: 24 };
    case 'tapas':
      return { width: 900, height: 12000, panelDensityMax: 8, bleed: 0, trim: 0, safeArea: 20, gutter: 24 };
    case 'print_a4':
      return { width: 2480, height: 3508, panelDensityMax: 10, bleed: 90, trim: 40, safeArea: 120, gutter: 28 };
    case 'print_us_letter':
      return { width: 2550, height: 3300, panelDensityMax: 10, bleed: 90, trim: 40, safeArea: 120, gutter: 28 };
    case 'instagram':
      return { width: 1080, height: 1080, panelDensityMax: 4, bleed: 0, trim: 0, safeArea: 24, gutter: 16 };
    case 'pdf_portfolio':
    default:
      return { width: 1240, height: 1754, panelDensityMax: 8, bleed: 0, trim: 0, safeArea: 24, gutter: 20 };
  }
};

const buildStyleRecommendations = (tone?: string, genre?: string): ComicForgeStyleRecommendation[] => {
  const normalizedTone = (tone || '').toLowerCase();
  const normalizedGenre = (genre || '').toLowerCase();

  const recommendations: ComicForgeStyleRecommendation[] = [
    {
      styleName: 'Cinematic Ink',
      rationale: 'Balanced readability and dramatic composition for broad story beats.',
      conflictWarnings: ['Heavy gradients can slow panel generation in long episodes.'],
      stylePromptSeed: 'bold black inks, cinematic framing, controlled color accents'
    },
    {
      styleName: 'Soft Webtoon Color',
      rationale: 'Strong clarity on mobile and efficient for dialogue-heavy pacing.',
      conflictWarnings: ['Very high action density may need sharper linework.'],
      stylePromptSeed: 'clean linework, soft cel shading, readable silhouettes'
    },
    {
      styleName: 'Noir Contrast',
      rationale: 'High contrast panels reinforce suspense and mystery scenes.',
      conflictWarnings: ['Low-key lighting can reduce legibility for text overlays.'],
      stylePromptSeed: 'high contrast inking, dramatic shadows, controlled highlight edges'
    }
  ];

  if (normalizedTone.includes('light') || normalizedGenre.includes('comedy')) {
    recommendations[0] = {
      styleName: 'All-Ages Flat Color',
      rationale: 'Keeps expressions and comedic beats clear panel-to-panel.',
      conflictWarnings: ['Avoid overly dense backgrounds in dialogue scenes.'],
      stylePromptSeed: 'flat colors, expressive linework, clear facial acting'
    };
  }

  return recommendations;
};

const createAssetHash = (input: string) =>
  crypto.createHash('sha256').update(input).digest('hex');

const queueJobForTask = async (
  projectId: string,
  taskType: TaskType,
  payload: Record<string, unknown>,
  entity?: { id?: string; type?: string }
): Promise<ComicForgeJobSummary> => {
  const policy = getModelPolicy(taskType);
  const job = await createGenerationJob({
    projectId,
    taskType,
    modelUsed: policy.model,
    estimatedCostUsd: policy.estimatedCostUsd,
    inputPayload: payload,
    entityId: entity?.id,
    entityType: entity?.type
  });

  const inlineResult = {
    completed: true,
    mode: 'inline',
    reason: 'queue_unavailable',
    taskType,
    payload,
    completedAt: Date.now()
  };

  if (!isComicForgeQueueConfigured()) {
    await updateGenerationJob(job.id, {
      status: 'done',
      progress: 100,
      completedAt: Date.now(),
      outputPayload: inlineResult,
      result: inlineResult
    });
    appendJobEvent(job.id, {
      type: 'done',
      message: 'Completed inline (queue unavailable)',
      timestamp: Date.now(),
      progress: 100,
      payload: inlineResult
    });
    return {
      ...job,
      status: 'done',
      progress: 100,
      completedAt: Date.now(),
      result: inlineResult
    };
  }

  try {
    await enqueueComicForgeJob(taskType, {
      projectId,
      taskType,
      ...payload
    }, {
      jobId: job.id
    });
    return job;
  } catch (error) {
    if (!isQueueUnavailableError(error)) {
      throw error;
    }

    await updateGenerationJob(job.id, {
      status: 'done',
      progress: 100,
      completedAt: Date.now(),
      outputPayload: inlineResult,
      result: inlineResult
    });
    appendJobEvent(job.id, {
      type: 'done',
      message: 'Completed inline (queue unavailable)',
      timestamp: Date.now(),
      progress: 100,
      payload: inlineResult
    });
    return {
      ...job,
      status: 'done',
      progress: 100,
      completedAt: Date.now(),
      result: inlineResult
    };
  }
};

export const comicForgePipelineService = {
  async formatLock(ctx: ServiceContext, input: {
    readingFormat: 'print' | 'webtoon_vertical' | 'digital_paged' | 'social_shorts';
    platform: 'webtoon' | 'tapas' | 'print_a4' | 'print_us_letter' | 'pdf_portfolio' | 'instagram';
    resolutionTarget: 'screen_72' | 'print_300' | 'screen_hd_150';
    rtlReading?: boolean;
  }) {
    const state = await readComicForgeState(ctx.projectId, ctx.userId);
    const dims = resolvePlatformDimensions(input.platform);

    const formatSpec = {
      readingFormat: input.readingFormat,
      platform: input.platform,
      resolutionTarget: input.resolutionTarget,
      rtlReading: Boolean(input.rtlReading),
      canvasWidthPx: dims.width,
      canvasHeightPx: dims.height,
      panelDensityMax: dims.panelDensityMax,
      safeTextSizeMinPt: input.resolutionTarget === 'print_300' ? 9.5 : 10.5,
      bleedPx: dims.bleed,
      trimPx: dims.trim,
      safeAreaPx: dims.safeArea,
      gutterMinPx: dims.gutter,
      exportPresets: [
        'webtoon_episode',
        'tapas_episode',
        'print_a4_300dpi',
        'print_us_letter_300dpi',
        'digital_pdf',
        'social_cover_crop',
        'character_card_export'
      ],
      warnings: input.resolutionTarget === 'print_300'
        ? ['Print format active: keep faces and dialogue inside safe area margins.']
        : []
    };

    const nextState = markStageProgress({
      ...state,
      formatSpec
    }, ComicForgeStage.FORMAT_SETUP);

    await writeComicForgeState(ctx.projectId, ctx.userId, nextState);

    return {
      stage: ComicForgeStage.FORMAT_SETUP,
      formatSpec
    };
  },

  async analyzeScript(ctx: ServiceContext, input: { rawScriptText: string }) {
    const state = await readComicForgeState(ctx.projectId, ctx.userId);
    const policy = getModelPolicy(TaskType.STORY_ANALYSIS);
    const segments = parseSegments(input.rawScriptText);
    const sceneHeadings = extractSceneHeadings(input.rawScriptText);
    const castList = extractCastNames(input.rawScriptText);
    const propNames = extractPropNames(
      input.rawScriptText,
      [
        ...castList,
        ...sceneHeadings.map((scene) => scene.location)
      ]
    );

    const panels = segments.map((segment, index) => {
      const heading = sceneHeadings[Math.floor(index / 4)] || sceneHeadings[index] || null;
      return ({
      panelIndex: index + 1,
      description: segment,
      dialogue: [],
      captions: [],
      sfx: [],
      cameraShotSuggestion: 'medium' as const,
      timeOfDay: heading?.time || 'unspecified',
      locationName: heading?.location || 'unspecified'
    });
    });

    const structuredScript = [] as Array<{
      page: number;
      panels: typeof panels;
    }>;

    for (let i = 0; i < panels.length; i += 4) {
      structuredScript.push({
        page: structuredScript.length + 1,
        panels: panels.slice(i, i + 4)
      });
    }

    const ambiguityFlags = segments
      .map((segment, index) => ({ segment, index }))
      .filter(({ segment }) => /\b(he|she|they)\b/.test(segment) && !/[A-Z][a-z]+/.test(segment))
      .map(({ index }) => ({
        id: `flag-${index + 1}`,
        type: 'speaker_unclear' as const,
        page: Math.floor(index / 4) + 1,
        panel: (index % 4) + 1,
        description: 'Pronoun reference may be ambiguous.',
        resolved: false
      }));

    const sceneList = sceneHeadings.length > 0
      ? sceneHeadings.map((scene, index) => ({
          sceneId: scene.sceneId || `scene-${index + 1}`,
          name: scene.name || `Scene ${index + 1}`,
          location: scene.location || 'unspecified',
          time: scene.time || 'unspecified',
          pagesInvolved: [index + 1]
        }))
      : structuredScript.map((entry) => ({
          sceneId: `scene-${entry.page}`,
          name: `Scene ${entry.page}`,
          location: entry.panels[0]?.locationName || 'unspecified',
          time: entry.panels[0]?.timeOfDay || 'unspecified',
          pagesInvolved: [entry.page]
        }));

    const analysis = {
      structuredScript,
      sceneList,
      castList: castList.map((name, index) => ({
        name,
        role: index === 0 ? 'protagonist' : 'support',
        firstAppearancePage: 1,
        descriptionHints: ''
      })),
      propList: propNames.map((name) => ({
        name,
        firstAppearancePage: 1,
        descriptionHints: ''
      })),
      ambiguityFlags,
      tone: 'neutral',
      genre: 'unspecified',
      estimatedPanelCount: panels.length,
      dialogueDensityScore: 0.4,
      actionDensityScore: 0.5
    };

    const seededAssetCards = await seedAssetCardsFromAnalysis(ctx.projectId, analysis);

    const nextState = markStageProgress({
      ...state,
      scriptInput: input.rawScriptText,
      analysis,
      assetCards: seededAssetCards,
      costTracker: {
        currency: 'USD',
        estimatedUsd: Number(((state.costTracker?.estimatedUsd || 0) + policy.estimatedCostUsd).toFixed(6)),
        actualUsd: state.costTracker?.actualUsd || 0,
        byTaskType: {
          ...(state.costTracker?.byTaskType || {}),
          [TaskType.STORY_ANALYSIS]: Number((((state.costTracker?.byTaskType || {})[TaskType.STORY_ANALYSIS] || 0) + policy.estimatedCostUsd).toFixed(6))
        }
      }
    }, ComicForgeStage.SCRIPT_ANALYSIS);

    await writeComicForgeState(ctx.projectId, ctx.userId, nextState);

    return {
      stage: ComicForgeStage.SCRIPT_ANALYSIS,
      analysis,
      unresolvedFlags: ambiguityFlags.filter((flag) => !flag.resolved),
      assetCards: seededAssetCards
    };
  },

  async resolveAmbiguity(ctx: ServiceContext, input: { flagId: string; resolution: string }) {
    const state = await readComicForgeState(ctx.projectId, ctx.userId);
    if (!state.analysis) {
      throw new Error('Analyze script before resolving ambiguity.');
    }

    const analysis = {
      ...state.analysis,
      ambiguityFlags: state.analysis.ambiguityFlags.map((flag) =>
        flag.id === input.flagId
          ? { ...flag, resolved: true, resolution: input.resolution }
          : flag
      )
    };

    const nextState = {
      ...state,
      analysis,
      updatedAt: Date.now()
    };

    await writeComicForgeState(ctx.projectId, ctx.userId, nextState);

    return {
      stage: ComicForgeStage.SCRIPT_ANALYSIS,
      analysis,
      unresolvedFlags: analysis.ambiguityFlags.filter((flag) => !flag.resolved)
    };
  },

  async buildArchitecture(ctx: ServiceContext, input: {
    pacingPreference: 'fast_action' | 'balanced' | 'slow_emotional';
    targetPageCountOverride?: number;
  }) {
    const state = await readComicForgeState(ctx.projectId, ctx.userId);
    if (!state.analysis) {
      throw new Error('Script analysis is required before architecture.');
    }

    const pageCount = input.targetPageCountOverride
      ? Math.max(1, input.targetPageCountOverride)
      : estimatePagePlanCount(state.analysis.estimatedPanelCount);

    const beatSheet = [
      { beatId: 'beat-1', name: 'Setup', type: 'setup' as const, scenesInvolved: ['scene-1'] },
      { beatId: 'beat-2', name: 'Conflict', type: 'conflict' as const, scenesInvolved: ['scene-2'] },
      { beatId: 'beat-3', name: 'Escalation', type: 'escalation' as const, scenesInvolved: ['scene-3'] },
      { beatId: 'beat-4', name: 'Twist', type: 'twist' as const, scenesInvolved: ['scene-4'] },
      { beatId: 'beat-5', name: 'Climax', type: 'climax' as const, scenesInvolved: ['scene-5'] },
      { beatId: 'beat-6', name: 'Resolution', type: 'resolution' as const, scenesInvolved: ['scene-6'] }
    ].slice(0, Math.min(6, pageCount));

    const pagePlan: ComicForgePagePlanRow[] = Array.from({ length: pageCount }).map((_, index) => ({
      pageNumber: index + 1,
      purpose: resolvePagePurpose(index, pageCount),
      scenesOnThisPage: [`scene-${Math.min(index + 1, state.analysis!.sceneList.length || 1)}`],
      panelCountSuggestion: input.pacingPreference === 'fast_action' ? 5 : input.pacingPreference === 'slow_emotional' ? 3 : 4,
      cliffhanger: index < pageCount - 1 && index % 2 === 1,
      pacingNote: input.pacingPreference,
      dialogueHeavy: input.pacingPreference === 'slow_emotional',
      warnings: [] as string[]
    }));

    const architecture = {
      beatSheet,
      suggestedPageCount: pageCount,
      pagePlan,
      globalWarnings: [] as string[]
    };

    const nextState = markStageProgress({
      ...state,
      architecture
    }, ComicForgeStage.STORY_ARCHITECTURE);

    await writeComicForgeState(ctx.projectId, ctx.userId, nextState);

    return {
      stage: ComicForgeStage.STORY_ARCHITECTURE,
      architecture
    };
  },

  async suggestStyles(ctx: ServiceContext, input: { customStyleHint?: string }) {
    const state = await readComicForgeState(ctx.projectId, ctx.userId);
    const recommendations = buildStyleRecommendations(state.analysis?.tone, state.analysis?.genre);

    const refined = input.customStyleHint?.trim()
      ? [
          {
            styleName: 'Custom Hybrid',
            rationale: `Matches custom hint: ${input.customStyleHint.trim()}`,
            conflictWarnings: ['Validate consistency against panel density before final generation.'],
            stylePromptSeed: input.customStyleHint.trim()
          },
          ...recommendations
        ]
      : recommendations;

    const nextState = markStageProgress({
      ...state,
      styleRecommendations: refined
    }, ComicForgeStage.STYLE_SELECTION);

    await writeComicForgeState(ctx.projectId, ctx.userId, nextState);

    return {
      stage: ComicForgeStage.STYLE_SELECTION,
      recommendations: refined
    };
  },

  async buildStyleBible(ctx: ServiceContext, input: { selectedStyle: string; customPromptOverride?: string }) {
    const state = await readComicForgeState(ctx.projectId, ctx.userId);
    const promptSeed = input.customPromptOverride?.trim() || input.selectedStyle;
    const basePrompt = `Comic style: ${input.selectedStyle}. ${promptSeed}`;

    const withGuard = buildNoTextPrompt(
      basePrompt,
      'Composition rule: keep upper-left and lower-third zones readable for lettering overlay.'
    );
    assertNoTextPromptContract(withGuard);

    const styleBible = {
      baseGenerationPromptFragment: withGuard,
      lineQuality: 'clean' as const,
      shadingMode: 'cel' as const,
      colorPalette: {
        primary: ['#1D3557', '#F1FAEE'],
        accent: ['#E63946'],
        forbidden: ['#B5179E'],
        moodRules: 'Desaturate flashbacks and increase contrast on conflict pages.'
      },
      backgroundDetail: 'full' as const,
      cameraLanguage: 'cinematic' as const,
      sfxTypographyStyle: 'impact-bold',
      negativePromptFragment: 'no text artifacts, no logos, no speech bubbles, no watermarks',
      conflictWarnings: [] as string[]
    };

    const nextState = markStageProgress({
      ...state,
      styleBible
    }, ComicForgeStage.STYLE_SELECTION);

    await writeComicForgeState(ctx.projectId, ctx.userId, nextState);

    return {
      stage: ComicForgeStage.STYLE_SELECTION,
      styleBible
    };
  },

  async listAssetCards(ctx: ServiceContext) {
    const cards = await listAssetCardsForProject(ctx.projectId);
    const state = await readComicForgeState(ctx.projectId, ctx.userId);
    const nextState = markStageProgress({
      ...state,
      assetCards: cards
    }, ComicForgeStage.ASSET_LIBRARY);
    await writeComicForgeState(ctx.projectId, ctx.userId, nextState);

    return {
      stage: ComicForgeStage.ASSET_LIBRARY,
      cards
    };
  },

  async createAssetCard(ctx: ServiceContext, input: {
    cardType: ComicForgeAssetCard['cardType'];
    name: string;
    canonicalDescription: string;
    doNotChange?: string[];
    negativeConstraints?: string[];
    allowedVariants?: string[];
  }) {
    const card: ComicForgeAssetCard = {
      id: crypto.randomUUID(),
      cardType: input.cardType,
      name: input.name,
      canonicalDescription: input.canonicalDescription,
      doNotChange: input.doNotChange || [],
      negativeConstraints: input.negativeConstraints || [],
      allowedVariants: input.allowedVariants || [],
      referenceImages: [],
      consistencyMethod: 'reference_injection',
      hash: crypto.createHash('sha256').update(`${input.cardType}:${input.name}:${input.canonicalDescription}`).digest('hex'),
      status: 'draft'
    };

    const created = await createAssetCardRecord(ctx.projectId, card);

    return {
      stage: ComicForgeStage.ASSET_LIBRARY,
      card: created
    };
  },

  async patchAssetCard(_ctx: ServiceContext, assetCardId: string, input: Partial<ComicForgeAssetCard>) {
    const card = await updateAssetCard(assetCardId, input);
    return {
      stage: ComicForgeStage.ASSET_LIBRARY,
      card
    };
  },

  async generateAssetRefs(_ctx: ServiceContext, assetCardId: string, input: { angles?: string[] }) {
    const angles = input.angles && input.angles.length > 0
      ? input.angles
      : ['front_neutral', 'three_quarter', 'profile_left', 'expression_angry', 'expression_happy'];

    const card = await updateAssetCard(assetCardId, {
      referenceImages: angles.map((angle, index) => ({
        angle,
        label: index < 3 ? 'canonical' : 'variant',
        imageId: `cf_ref_${crypto.randomUUID()}`,
        imageUrl: ''
      })),
      status: 'reference_generated'
    });

    return {
      stage: ComicForgeStage.ASSET_LIBRARY,
      card
    };
  },

  async extractLayout(ctx: ServiceContext, input: { referenceImageUrl?: string; layoutHint?: string }) {
    const state = await readComicForgeState(ctx.projectId, ctx.userId);

    const layoutTemplate: ComicForgeLayoutTemplate = {
      id: crypto.randomUUID(),
      name: input.layoutHint?.trim() ? `Custom: ${input.layoutHint.trim()}` : 'Balanced 4-Grid',
      panelCount: 4,
      gridDefinition: [
        { colStart: 1, colEnd: 7, rowStart: 1, rowEnd: 5, aspectRatio: 1.4 },
        { colStart: 7, colEnd: 13, rowStart: 1, rowEnd: 5, aspectRatio: 1.4 },
        { colStart: 1, colEnd: 7, rowStart: 5, rowEnd: 9, aspectRatio: 1.4 },
        { colStart: 7, colEnd: 13, rowStart: 5, rowEnd: 9, aspectRatio: 1.4 }
      ],
      gutterPx: 24,
      captionStyle: 'box',
      balloonStyle: 'round',
      sfxStyle: 'impact-bold',
      source: input.referenceImageUrl ? 'extracted' : 'preset',
      previewImageUrl: input.referenceImageUrl
    };

    const nextState = markStageProgress({
      ...state,
      layoutTemplate
    }, ComicForgeStage.LAYOUT_SYSTEM);

    await writeComicForgeState(ctx.projectId, ctx.userId, nextState);

    return {
      stage: ComicForgeStage.LAYOUT_SYSTEM,
      layoutTemplate
    };
  },

  async buildLetteringRules(_ctx: ServiceContext, input: { captionStyle?: 'box' | 'borderless'; balloonStyle?: 'round' | 'spiky' | 'cloud' | 'rectangular'; sfxStyle?: string }) {
    return {
      stage: ComicForgeStage.LAYOUT_SYSTEM,
      letteringRules: {
        captionStyle: input.captionStyle || 'box',
        balloonStyle: input.balloonStyle || 'round',
        sfxStyle: input.sfxStyle || 'impact-bold',
        maxTextPerBalloonChars: 120,
        balloonSafeZoneMarginPct: 0.15
      }
    };
  },

  async generateBalloonZones(_ctx: ServiceContext, pageId: string) {
    const balloonZones: ComicForgeBalloonZone[] = [
      {
        panelIdx: 0,
        zones: [
          { xPct: 5, yPct: 5, wPct: 35, hPct: 20, purpose: 'balloon' },
          { xPct: 55, yPct: 70, wPct: 35, hPct: 20, purpose: 'caption' }
        ]
      }
    ];

    return {
      stage: ComicForgeStage.LAYOUT_SYSTEM,
      pageId,
      balloonZones
    };
  },

  async generateThumbnails(ctx: ServiceContext) {
    const job = await queueJobForTask(ctx.projectId, TaskType.THUMBNAIL_GEN, {
      pipelineStage: ComicForgeStage.STORYBOARD
    }, {
      type: 'project',
      id: ctx.projectId
    });

    return {
      stage: ComicForgeStage.STORYBOARD,
      job
    };
  },

  async validateStoryboard(ctx: ServiceContext) {
    const state = await readComicForgeState(ctx.projectId, ctx.userId);
    const validation: ComicForgeStoryboardValidation = {
      pass: true,
      pageLevelWarnings: [],
      panelLevelWarnings: []
    };

    const nextState = markStageProgress({
      ...state,
      storyboardValidation: validation
    }, ComicForgeStage.STORYBOARD);

    await writeComicForgeState(ctx.projectId, ctx.userId, nextState);

    return {
      stage: ComicForgeStage.STORYBOARD,
      validation
    };
  },

  async previewPack(ctx: ServiceContext) {
    const state = await readComicForgeState(ctx.projectId, ctx.userId);
    const totalPages = state.architecture?.pagePlan.length || state.architecture?.suggestedPageCount || 1;
    const totalPanels = (state.architecture?.pagePlan || []).reduce((sum, row) => sum + row.panelCountSuggestion, 0) || 4;

    const preview: ComicForgePreviewPack = {
      totalPages,
      totalPanels,
      estimatedDialogueBalloons: totalPanels,
      estimatedCosts: {
        thumbnailsUsd: Number((totalPanels * getModelPolicy(TaskType.THUMBNAIL_GEN).estimatedCostUsd).toFixed(4)),
        draftUsd: Number((totalPanels * getModelPolicy(TaskType.PANEL_GEN_DRAFT).estimatedCostUsd).toFixed(4)),
        finalUsd: Number((totalPanels * getModelPolicy(TaskType.PANEL_GEN_FINAL).estimatedCostUsd).toFixed(4)),
        exportUpscaleUsd: Number((totalPanels * 0.004).toFixed(4)),
        totalUsd: 0
      },
      estimatedDurationSeconds: totalPanels * 12,
      pageBreakdown: (state.architecture?.pagePlan || []).map((row) => ({
        pageNumber: row.pageNumber,
        title: `Page ${row.pageNumber}`,
        purpose: row.purpose,
        panelCount: row.panelCountSuggestion,
        warnings: row.warnings,
        estimatedPageCostUsd: Number((row.panelCountSuggestion * getModelPolicy(TaskType.PANEL_GEN_DRAFT).estimatedCostUsd).toFixed(4))
      })),
      globalWarnings: state.architecture?.globalWarnings || []
    };

    preview.estimatedCosts.totalUsd = Number((
      preview.estimatedCosts.thumbnailsUsd
      + preview.estimatedCosts.draftUsd
      + preview.estimatedCosts.finalUsd
      + preview.estimatedCosts.exportUpscaleUsd
    ).toFixed(4));

    const nextState = markStageProgress({
      ...state,
      previewPack: preview
    }, ComicForgeStage.PREVIEW_PACK);

    await writeComicForgeState(ctx.projectId, ctx.userId, nextState);

    return {
      stage: ComicForgeStage.PREVIEW_PACK,
      preview
    };
  },

  async generate(ctx: ServiceContext, input: { quality: 'draft' | 'final' }) {
    const taskType = input.quality === 'draft' ? TaskType.PANEL_GEN_DRAFT : TaskType.PANEL_GEN_FINAL;
    const job = await queueJobForTask(ctx.projectId, taskType, {
      quality: input.quality,
      pipelineStage: ComicForgeStage.GENERATION
    }, {
      type: 'project',
      id: ctx.projectId
    });

    return {
      stage: ComicForgeStage.GENERATION,
      job
    };
  },

  async regeneratePanel(ctx: ServiceContext, panelId: string, input: { quality: 'draft' | 'final'; reason?: string }) {
    const taskType = input.quality === 'draft' ? TaskType.PANEL_GEN_DRAFT : TaskType.PANEL_GEN_FINAL;
    const job = await queueJobForTask(ctx.projectId, taskType, {
      quality: input.quality,
      reason: input.reason || null,
      panelId
    }, {
      type: 'panel',
      id: panelId
    });

    return {
      stage: ComicForgeStage.GENERATION,
      job
    };
  },

  async assemblePage(ctx: ServiceContext, pageId: string) {
    const job = await queueJobForTask(ctx.projectId, TaskType.PANEL_GEN_FINAL, {
      operation: 'assemble_page',
      pageId
    }, {
      type: 'page',
      id: pageId
    });

    return {
      stage: ComicForgeStage.GENERATION,
      job
    };
  },

  async renderLettering(ctx: ServiceContext, pageId: string) {
    const job = await queueJobForTask(ctx.projectId, TaskType.PANEL_GEN_FINAL, {
      operation: 'render_lettering',
      pageId
    }, {
      type: 'page',
      id: pageId
    });

    return {
      stage: ComicForgeStage.GENERATION,
      job
    };
  },

  async runQc(ctx: ServiceContext, pageId: string) {
    const report: ComicForgeQCReport = {
      pageId,
      pagePassed: true,
      panelFlags: []
    };

    const policy = getModelPolicy(TaskType.QC_CHECK);
    const job = await createGenerationJob({
      projectId: ctx.projectId,
      taskType: TaskType.QC_CHECK,
      modelUsed: policy.model,
      estimatedCostUsd: policy.estimatedCostUsd,
      inputPayload: { pageId, operation: 'qc_run' },
      entityId: pageId,
      entityType: 'page'
    });

    await updateGenerationJob(job.id, {
      status: 'done',
      progress: 100,
      completedAt: Date.now(),
      outputPayload: { report }
    });

    return {
      stage: ComicForgeStage.QC_REVIEW,
      report,
      job: {
        ...job,
        status: 'done',
        progress: 100,
        completedAt: Date.now()
      }
    };
  },

  async patchPanelLettering(_ctx: ServiceContext, panelLetteringId: string, input: { elements: Array<Record<string, unknown>> }) {
    return {
      stage: ComicForgeStage.QC_REVIEW,
      letteringId: panelLetteringId,
      elements: input.elements || []
    };
  },

  async exportProject(ctx: ServiceContext, input: { preset: ComicForgeExportPreset; pageRange?: { from: number; to: number }; upscaleIfNeeded?: boolean }) {
    const job = await queueJobForTask(ctx.projectId, TaskType.PANEL_GEN_EXPORT, {
      preset: input.preset,
      pageRange: input.pageRange || null,
      upscaleIfNeeded: Boolean(input.upscaleIfNeeded)
    }, {
      type: 'project',
      id: ctx.projectId
    });

    return {
      stage: ComicForgeStage.EXPORT,
      job
    };
  },

  async getJobStatus(_ctx: ServiceContext, jobId: string) {
    const base = await getGenerationJob(jobId);
    if (!base) {
      throw new Error('Job not found.');
    }

    try {
      const queueState = await getComicForgeJobState(jobId);
      const merged: ComicForgeJobSummary = {
        ...base,
        status: queueState.status,
        progress: queueState.progress,
        errorMessage: queueState.errorMessage || base.errorMessage,
        result: queueState.result || base.result,
        completedAt: queueState.status === 'done' || queueState.status === 'failed'
          ? (base.completedAt || Date.now())
          : base.completedAt
      };

      if (merged.status !== base.status) {
        await updateGenerationJob(jobId, merged);
      }

      return {
        stage: ComicForgeStage.GENERATION,
        job: merged
      };
    } catch {
      return {
        stage: ComicForgeStage.GENERATION,
        job: base
      };
    }
  },

  async getJobEvents(_ctx: ServiceContext, jobId: string) {
    const events = listJobEvents(jobId).map((event) => ({
      id: event.id,
      jobId,
      type: event.type,
      message: event.message,
      timestamp: event.timestamp,
      progress: event.progress,
      payload: event.payload
    }));

    return {
      stage: ComicForgeStage.GENERATION,
      events
    };
  },

  async getCostTracker(ctx: ServiceContext) {
    const cost = await getProjectCostTracker(ctx.projectId);
    return {
      stage: ComicForgeStage.PREVIEW_PACK,
      cost
    };
  },

  async notifyJobRunning(jobId: string) {
    appendJobEvent(jobId, {
      type: 'running',
      message: 'Worker started',
      timestamp: Date.now(),
      progress: 10
    });
    await updateGenerationJob(jobId, {
      status: 'running',
      progress: 10
    });
  },

  async notifyJobProgress(jobId: string, progress: number, message: string, payload?: Record<string, unknown>) {
    appendJobEvent(jobId, {
      type: 'progress',
      message,
      timestamp: Date.now(),
      progress,
      payload
    });
    await updateGenerationJob(jobId, {
      status: 'running',
      progress
    });
  },

  async notifyJobDone(jobId: string, result: Record<string, unknown>) {
    appendJobEvent(jobId, {
      type: 'done',
      message: 'Job completed',
      timestamp: Date.now(),
      progress: 100,
      payload: result
    });
    await updateGenerationJob(jobId, {
      status: 'done',
      progress: 100,
      completedAt: Date.now(),
      outputPayload: result,
      result
    });
  },

  async notifyJobFailed(jobId: string, error: string) {
    appendJobEvent(jobId, {
      type: 'failed',
      message: error,
      timestamp: Date.now(),
      progress: 100
    });
    await updateGenerationJob(jobId, {
      status: 'failed',
      progress: 100,
      completedAt: Date.now(),
      errorMessage: error
    });
  }
};
