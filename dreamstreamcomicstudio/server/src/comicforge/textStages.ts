// Real model-backed text stages for ComicForge.
//
// The pipelineService stages historically returned deterministic heuristics. These helpers
// upgrade them to LIVE model calls through the gateway (platform key, capability-aware model
// via resolveStageModel) while ALWAYS degrading gracefully: if no platform key is configured
// or the call fails/returns malformed JSON, the caller's heuristic result is used unchanged.
// That keeps the stages working offline and makes this safe to ship behind the dormant flag.

import { OPENROUTER_API_KEY, OPENROUTER_TEXT_MODEL } from '../config.js';
import { getProvider, resolveProviderContext } from '../ai/gateway.js';
import { resolveStageModel, type PipelineStage } from '../ai/stageModels.js';
import { buildNoTextPrompt, assertNoTextPromptContract } from './modelRouter.js';
import type {
  ComicForgeStructuredScriptAnalysis,
  ComicForgeStoryArchitecture,
  ComicForgeStyleBible,
  ComicForgeStyleRecommendation
} from '../../../types.js';

type JsonSchema = { name: string; schema: Record<string, unknown>; strict?: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const comicForgeAiEnabled = (): boolean => Boolean(OPENROUTER_API_KEY.trim());

/**
 * Run a JSON-returning model call for a stage. Returns `null` (never throws) when AI is
 * disabled or anything goes wrong, so callers can fall back to their heuristic.
 */
const generateJson = async (
  stage: PipelineStage,
  system: string,
  user: string,
  schema: JsonSchema
): Promise<Record<string, unknown> | null> => {
  if (!comicForgeAiEnabled()) return null;
  try {
    const { model } = await resolveStageModel(stage, OPENROUTER_TEXT_MODEL, { costPref: 'free' });
    const result = await getProvider('openrouter').generateText(
      {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        jsonSchema: schema,
        temperature: 0.6,
        fallbackModel: OPENROUTER_TEXT_MODEL
      },
      resolveProviderContext()
    );
    return isRecord(result.json) ? result.json : null;
  } catch (error) {
    console.warn(`[ComicForge AI] ${stage} stage fell back to heuristic:`, (error as Error)?.message || error);
    return null;
  }
};

const asString = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback;

const asScore = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

/**
 * Enrich a heuristic script analysis with model-derived semantics (tone/genre/cast/props/
 * density). The heuristic's structural fields (structuredScript, sceneList, panel count) are
 * preserved so downstream stages keep their invariants — only the "understanding" fields are
 * upgraded.
 */
export const enrichAnalysis = async (
  scriptText: string,
  heuristic: ComicForgeStructuredScriptAnalysis
): Promise<ComicForgeStructuredScriptAnalysis> => {
  const json = await generateJson(
    'analyze_script',
    'You are a comics script analyst. Return strict JSON describing the story. Be concise.',
    `Analyze this comic script and return tone, genre, main cast (with role + a short visual description hint), notable props, and 0-1 dialogue/action density scores.\n\nSCRIPT:\n${scriptText.slice(0, 8000)}`,
    {
      name: 'comicforge_analysis',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tone: { type: 'string' },
          genre: { type: 'string' },
          cast: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                role: { type: 'string' },
                descriptionHints: { type: 'string' }
              },
              required: ['name']
            }
          },
          props: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                descriptionHints: { type: 'string' }
              },
              required: ['name']
            }
          },
          dialogueDensityScore: { type: 'number' },
          actionDensityScore: { type: 'number' }
        },
        required: ['tone', 'genre']
      }
    }
  );

  if (!json) return heuristic;

  const cast = Array.isArray(json.cast) ? json.cast.filter(isRecord) : [];
  const props = Array.isArray(json.props) ? json.props.filter(isRecord) : [];

  return {
    ...heuristic,
    tone: asString(json.tone, heuristic.tone),
    genre: asString(json.genre, heuristic.genre),
    dialogueDensityScore: asScore(json.dialogueDensityScore, heuristic.dialogueDensityScore),
    actionDensityScore: asScore(json.actionDensityScore, heuristic.actionDensityScore),
    castList: cast.length
      ? cast.map((entry, index) => ({
          name: asString(entry.name, heuristic.castList[index]?.name || `Character ${index + 1}`),
          role: asString(entry.role, index === 0 ? 'protagonist' : 'support'),
          firstAppearancePage: heuristic.castList[index]?.firstAppearancePage || 1,
          descriptionHints: asString(entry.descriptionHints, '')
        }))
      : heuristic.castList,
    propList: props.length
      ? props.map((entry) => ({
          name: asString(entry.name, 'prop'),
          firstAppearancePage: 1,
          descriptionHints: asString(entry.descriptionHints, '')
        }))
      : heuristic.propList
  };
};

/** Replace the canned beat sheet / page purposes with a model-authored plan. */
export const enrichArchitecture = async (
  analysis: ComicForgeStructuredScriptAnalysis,
  pageCount: number,
  pacingPreference: string,
  heuristic: ComicForgeStoryArchitecture
): Promise<ComicForgeStoryArchitecture> => {
  const json = await generateJson(
    'story_outline',
    'You are a comics story editor. Plan beats and page purposes. Return strict JSON.',
    `Tone: ${analysis.tone}. Genre: ${analysis.genre}. Pacing: ${pacingPreference}. Target pages: ${pageCount}. Produce a beat sheet and, for each of the ${pageCount} pages, a purpose (one of: setup, action, dialogue, twist, payoff, transition), a panel count (2-6), and whether it ends on a cliffhanger.`,
    {
      name: 'comicforge_architecture',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          beats: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                type: { type: 'string', enum: ['setup', 'conflict', 'escalation', 'twist', 'climax', 'resolution'] }
              },
              required: ['name', 'type']
            }
          },
          pages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                purpose: { type: 'string', enum: ['setup', 'action', 'dialogue', 'twist', 'payoff', 'transition'] },
                panelCount: { type: 'number' },
                cliffhanger: { type: 'boolean' }
              },
              required: ['purpose', 'panelCount']
            }
          }
        },
        required: ['beats', 'pages']
      }
    }
  );

  if (!json) return heuristic;

  const beats = Array.isArray(json.beats) ? json.beats.filter(isRecord) : [];
  const pages = Array.isArray(json.pages) ? json.pages.filter(isRecord) : [];

  const beatSheet = beats.length
    ? beats.map((beat, index) => ({
        beatId: `beat-${index + 1}`,
        name: asString(beat.name, `Beat ${index + 1}`),
        type: (['setup', 'conflict', 'escalation', 'twist', 'climax', 'resolution'].includes(String(beat.type))
          ? beat.type
          : 'conflict') as ComicForgeStoryArchitecture['beatSheet'][number]['type'],
        scenesInvolved: heuristic.beatSheet[index]?.scenesInvolved || [`scene-${index + 1}`]
      }))
    : heuristic.beatSheet;

  const pagePlan = pages.length
    ? heuristic.pagePlan.map((row, index) => {
        const aiPage = pages[index];
        if (!aiPage) return row;
        const purpose = ['setup', 'action', 'dialogue', 'twist', 'payoff', 'transition'].includes(String(aiPage.purpose))
          ? (aiPage.purpose as ComicForgeStoryArchitecture['pagePlan'][number]['purpose'])
          : row.purpose;
        const panelCount = typeof aiPage.panelCount === 'number'
          ? Math.min(6, Math.max(2, Math.round(aiPage.panelCount)))
          : row.panelCountSuggestion;
        return {
          ...row,
          purpose,
          panelCountSuggestion: panelCount,
          cliffhanger: typeof aiPage.cliffhanger === 'boolean' ? aiPage.cliffhanger : row.cliffhanger
        };
      })
    : heuristic.pagePlan;

  return {
    ...heuristic,
    beatSheet,
    pagePlan
  };
};

/** Model-authored style recommendations, replacing the static three. */
export const enrichStyleRecommendations = async (
  tone: string,
  genre: string,
  customStyleHint: string | undefined,
  heuristic: ComicForgeStyleRecommendation[]
): Promise<ComicForgeStyleRecommendation[]> => {
  const json = await generateJson(
    'story_tool',
    'You are an art director for comics. Recommend distinct visual styles. Return strict JSON.',
    `Tone: ${tone}. Genre: ${genre}.${customStyleHint ? ` Creative hint: ${customStyleHint}.` : ''} Recommend 3 distinct comic art styles. For each give styleName, a one-line rationale, up to 2 conflictWarnings, and a stylePromptSeed (comma-separated image-prompt keywords).`,
    {
      name: 'comicforge_styles',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          styles: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                styleName: { type: 'string' },
                rationale: { type: 'string' },
                conflictWarnings: { type: 'array', items: { type: 'string' } },
                stylePromptSeed: { type: 'string' }
              },
              required: ['styleName', 'stylePromptSeed']
            }
          }
        },
        required: ['styles']
      }
    }
  );

  if (!json) return heuristic;
  const styles = Array.isArray(json.styles) ? json.styles.filter(isRecord) : [];
  if (!styles.length) return heuristic;

  return styles.map((style) => ({
    styleName: asString(style.styleName, 'Custom Style'),
    rationale: asString(style.rationale, 'Model-recommended style.'),
    conflictWarnings: Array.isArray(style.conflictWarnings)
      ? style.conflictWarnings.filter((w): w is string => typeof w === 'string')
      : [],
    stylePromptSeed: asString(style.stylePromptSeed, asString(style.styleName, 'clean comic linework'))
  }));
};

/** Model-authored style bible. The NO-TEXT contract is re-asserted on the AI output. */
export const enrichStyleBible = async (
  selectedStyle: string,
  promptSeed: string,
  heuristic: ComicForgeStyleBible
): Promise<ComicForgeStyleBible> => {
  const json = await generateJson(
    'story_tool',
    'You are a comics art director defining a style bible. Return strict JSON.',
    `Selected style: ${selectedStyle}. Seed: ${promptSeed}. Define lineQuality (clean|scratchy|bold|minimal), shadingMode (flat|cel|painterly|crosshatch|none), a color palette (primary[], accent[], forbidden[] as hex, plus moodRules), backgroundDetail (full|suggested|minimal|none), cameraLanguage (cinematic|flat|dynamic|manga-dynamic), an sfxTypographyStyle, and a baseGenerationPrompt (image-generation keywords describing the style — DO NOT mention text or speech bubbles).`,
    {
      name: 'comicforge_style_bible',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          baseGenerationPrompt: { type: 'string' },
          lineQuality: { type: 'string', enum: ['clean', 'scratchy', 'bold', 'minimal'] },
          shadingMode: { type: 'string', enum: ['flat', 'cel', 'painterly', 'crosshatch', 'none'] },
          primary: { type: 'array', items: { type: 'string' } },
          accent: { type: 'array', items: { type: 'string' } },
          forbidden: { type: 'array', items: { type: 'string' } },
          moodRules: { type: 'string' },
          backgroundDetail: { type: 'string', enum: ['full', 'suggested', 'minimal', 'none'] },
          cameraLanguage: { type: 'string', enum: ['cinematic', 'flat', 'dynamic', 'manga-dynamic'] },
          sfxTypographyStyle: { type: 'string' }
        },
        required: ['baseGenerationPrompt']
      }
    }
  );

  if (!json) return heuristic;

  const enum_ = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

  const stringArray = (value: unknown, fallback: string[]): string[] =>
    Array.isArray(value) && value.length ? value.filter((v): v is string => typeof v === 'string') : fallback;

  const baseFragment = buildNoTextPrompt(
    asString(json.baseGenerationPrompt, `Comic style: ${selectedStyle}. ${promptSeed}`),
    'Composition rule: keep upper-left and lower-third zones readable for lettering overlay.'
  );
  assertNoTextPromptContract(baseFragment);

  return {
    ...heuristic,
    baseGenerationPromptFragment: baseFragment,
    lineQuality: enum_(json.lineQuality, ['clean', 'scratchy', 'bold', 'minimal'] as const, heuristic.lineQuality),
    shadingMode: enum_(json.shadingMode, ['flat', 'cel', 'painterly', 'crosshatch', 'none'] as const, heuristic.shadingMode),
    colorPalette: {
      primary: stringArray(json.primary, heuristic.colorPalette.primary),
      accent: stringArray(json.accent, heuristic.colorPalette.accent),
      forbidden: stringArray(json.forbidden, heuristic.colorPalette.forbidden),
      moodRules: asString(json.moodRules, heuristic.colorPalette.moodRules)
    },
    backgroundDetail: enum_(json.backgroundDetail, ['full', 'suggested', 'minimal', 'none'] as const, heuristic.backgroundDetail),
    cameraLanguage: enum_(json.cameraLanguage, ['cinematic', 'flat', 'dynamic', 'manga-dynamic'] as const, heuristic.cameraLanguage),
    sfxTypographyStyle: asString(json.sfxTypographyStyle, heuristic.sfxTypographyStyle)
  };
};
