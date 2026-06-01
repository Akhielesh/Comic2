import { Type } from '@google/genai';
import { Scene, Character, Item, Location, DialogueBlock, ContinuityBible, SceneContinuityBinding } from '../../../types.js';
import {
  AnalyzeScriptResponse,
  StoryOutlineResponse,
  StoryDraftResponse,
  StoryToolResponse,
  ExtractWorldResponse,
  PanelBreakdownResponse,
  ContinuitySummaryResponse,
  ContinuityAuditResponse,
  TestLabReportResponse
} from '../../../apiTypes.js';
import { createClient } from './client.js';
import { extractJson, ensureArray, isString } from './json.js';
import { buildUsage } from './usage.js';
import { withRetry, withTimeout } from './utils.js';
import { TEXT_MODEL, TEXT_REQUEST_TIMEOUT_MS } from '../config.js';
import { ScriptSegment, segmentScript } from './scriptSegmentation.js';

const resolveTextModel = (modelOverride?: string) => {
  const candidate = modelOverride?.trim();
  return candidate || TEXT_MODEL;
};

type AnalyzeScriptDiagnostics = {
  ungroundedCharactersDropped: number;
  rawExcerptFallbackCount: number;
  segmentCount: number;
  fallbackSceneCount: number;
  coreEntityDrops: number;
  plotDriftCorrections: number;
};

type EntityDropReason =
  | 'NOT_IN_SCRIPT'
  | 'LOW_DESCRIPTION_QUALITY'
  | 'DUPLICATE_NORMALIZED_NAME';

type DroppedEntityDiagnostic = {
  name: string;
  kind: 'character' | 'item' | 'location';
  reason: EntityDropReason;
};

type WorldExtractionDiagnostics = {
  input_scene_count: number;
  entity_counts: {
    characters: number;
    items: number;
    locations: number;
  };
  filtered_entity_count: number;
  dropped_entities: DroppedEntityDiagnostic[];
  ungrounded_characters_dropped: number;
};

const MAX_WORLD_CHARACTER_COUNT = 12;
const MAX_WORLD_ITEM_COUNT = 20;
const MAX_WORLD_LOCATION_COUNT = 12;

const normalizeEntityName = (value: string) =>
  value
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

const readStructuredObject = (value: unknown, allowedKeys: string[]) => {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const output: Record<string, string> = {};
  for (const key of allowedKeys) {
    const candidate = source[key];
    if (typeof candidate !== 'string') continue;
    const normalized = candidate.trim();
    if (!normalized) continue;
    output[key] = normalized;
  }
  return Object.keys(output).length > 0 ? output : undefined;
};

// Keep grounded, named entities alive when the model returns a thin description by
// synthesizing one from the structured fields it did fill — otherwise the entity is
// dropped for LOW_DESCRIPTION_QUALITY and disappears from the world (and "Generate All").
const ensureEntityDescription = (
  rawDescription: string,
  structured: Record<string, string> | undefined,
  name: string
): string => {
  const trimmed = rawDescription.trim();
  if (trimmed.length >= 8) return trimmed;
  if (structured) {
    const parts = Object.values(structured)
      .map((value) => String(value || '').trim())
      .filter((value) => value && value.toLowerCase() !== 'unspecified');
    if (parts.length > 0) {
      const subject = name.trim() || 'Subject';
      return `${subject} — ${parts.join(', ')}`;
    }
  }
  return trimmed;
};

const normalizeForMatch = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const containsNormalizedName = (haystack: string, rawName: string) => {
  const target = normalizeForMatch(rawName);
  if (!target) return false;
  const source = normalizeForMatch(haystack);
  if (!source) return false;
  const pattern = new RegExp(`(^|\\s)${escapeRegex(target)}($|\\s)`);
  return pattern.test(source);
};

const containsNormalizedSnippet = (haystack: string, snippet: string) => {
  const target = normalizeForMatch(snippet);
  if (!target) return false;
  const source = normalizeForMatch(haystack);
  if (!source) return false;
  return source.includes(target);
};

const SCENE_RAW_EXCERPT_MAX_CHARS = 620;
const SCENE_RAW_EXCERPT_CONTEXT_CHARS = 120;

const clipExcerpt = (value: string, max = 260) => value.trim().slice(0, max).trim();

const findExcerptAnchor = (source: string, term: string) => {
  const trimmed = term.trim();
  if (!trimmed) return -1;
  const escaped = escapeRegex(trimmed).replace(/\s+/g, '\\s+');
  const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
  const match = source.match(pattern);
  return typeof match?.index === 'number' ? match.index : -1;
};

const clipSceneExcerptForCharacters = (segmentText: string, characters: string[]) => {
  const source = String(segmentText || '').trim();
  if (!source) return '';
  if (source.length <= SCENE_RAW_EXCERPT_MAX_CHARS) return source;

  const validCharacters = (characters || [])
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .filter((name) => containsNormalizedName(source, name));
  if (validCharacters.length === 0) {
    return clipExcerpt(source, SCENE_RAW_EXCERPT_MAX_CHARS);
  }

  const anchors = validCharacters
    .map((name) => findExcerptAnchor(source, name))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);

  if (anchors.length === 0) {
    return clipExcerpt(source, SCENE_RAW_EXCERPT_MAX_CHARS);
  }

  const minAnchor = anchors[0];
  const maxAnchor = anchors[anchors.length - 1];
  let start = Math.max(0, minAnchor - SCENE_RAW_EXCERPT_CONTEXT_CHARS);
  let end = Math.min(source.length, maxAnchor + SCENE_RAW_EXCERPT_CONTEXT_CHARS);

  if (end - start < SCENE_RAW_EXCERPT_MAX_CHARS) {
    const deficit = SCENE_RAW_EXCERPT_MAX_CHARS - (end - start);
    const extendRight = Math.min(source.length - end, Math.ceil(deficit / 2));
    end += extendRight;
    start = Math.max(0, start - (deficit - extendRight));
  }

  if (end - start > SCENE_RAW_EXCERPT_MAX_CHARS) {
    end = start + SCENE_RAW_EXCERPT_MAX_CHARS;
  }

  const prefix = start > 0 ? '... ' : '';
  const suffix = end < source.length ? ' ...' : '';
  return `${prefix}${source.slice(start, end).trim()}${suffix}`.trim();
};

const firstWords = (value: string, maxWords: number) => {
  return value
    .trim()
    .split(/\s+/)
    .slice(0, maxWords)
    .join(' ')
    .trim();
};

const lexicalTokenSet = (value: string) => new Set(
  normalizeForMatch(value)
    .split(' ')
    .filter((token) => token.length >= 3)
);

const lexicalOverlap = (candidate: string, source: string) => {
  const candidateTokens = lexicalTokenSet(candidate);
  if (candidateTokens.size === 0) return 0;
  const sourceTokens = lexicalTokenSet(source);
  if (sourceTokens.size === 0) return 0;

  let shared = 0;
  for (const token of candidateTokens) {
    if (sourceTokens.has(token)) shared += 1;
  }
  return shared / candidateTokens.size;
};

const extractSegmentCharacterHints = (segmentText: string) => {
  const names = new Set<string>();
  const regex = /^([A-Z][A-Z0-9 _'".-]{1,40}):/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(segmentText)) !== null) {
    const name = match[1].trim();
    if (name.length > 1 && name.length <= 40) names.add(name);
  }
  return Array.from(names);
};

const buildLiteralSynopsis = (segmentText: string) => {
  const firstLine = segmentText.split('\n').map((line) => line.trim()).find(Boolean) || segmentText;
  return clipExcerpt(firstWords(firstLine, 28) || 'Literal scene excerpt.');
};

const buildLiteralSetting = (segmentText: string) => {
  const heading = segmentText
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^(scene|act|int\.?|ext\.?|int\/ext|i\/e)/i.test(line));
  if (heading) return clipExcerpt(heading, 140);
  const locationMatch = segmentText.match(/\b(?:in|at|inside|outside|near|within)\s+([a-z0-9' -]{3,80})/i);
  if (locationMatch) return clipExcerpt(locationMatch[0], 140);
  return 'Script-defined location';
};

const shouldRepairNarrativeField = (candidate: string, segmentText: string) => {
  const trimmed = candidate.trim();
  if (!trimmed) return true;
  if (containsNormalizedSnippet(segmentText, trimmed)) return false;
  return lexicalOverlap(trimmed, segmentText) < 0.22;
};

const selectSegmentForScene = (
  scene: any,
  index: number,
  segments: ScriptSegment[],
  fullScript: string
): ScriptSegment => {
  if (segments.length === 0) {
    return {
      id: 1,
      order: 0,
      rawText: fullScript,
      source: 'full_script'
    };
  }

  const segmentId = Number(scene?.segmentId);
  if (Number.isFinite(segmentId)) {
    const byId = segments.find((segment) => segment.id === Math.floor(segmentId));
    if (byId) return byId;
  }

  const providedRaw = isString(scene?.rawText) ? scene.rawText.trim() : '';
  if (providedRaw) {
    const byRaw = segments.find((segment) => containsNormalizedSnippet(segment.rawText, providedRaw));
    if (byRaw) return byRaw;
  }

  const synopsis = isString(scene?.synopsis) ? scene.synopsis.trim() : '';
  if (synopsis) {
    const bySynopsis = segments.find((segment) => containsNormalizedSnippet(segment.rawText, synopsis));
    if (bySynopsis) return bySynopsis;
  }

  return segments[index] || segments[Math.max(0, segments.length - 1)];
};

const deriveSceneRawExcerpt = (
  scene: any,
  segment: ScriptSegment,
  fullScript: string
) => {
  const providedRaw = isString(scene?.rawText) ? scene.rawText.trim() : '';
  if (
    providedRaw
    && containsNormalizedSnippet(fullScript, providedRaw)
    && containsNormalizedSnippet(segment.rawText, providedRaw)
  ) {
    return {
      rawText: clipExcerpt(providedRaw, SCENE_RAW_EXCERPT_MAX_CHARS),
      usedFallback: false
    };
  }

  const synopsis = isString(scene?.synopsis) ? scene.synopsis.trim() : '';
  if (synopsis) {
    if (containsNormalizedSnippet(segment.rawText, synopsis)) {
      return {
        rawText: clipExcerpt(segment.rawText, SCENE_RAW_EXCERPT_MAX_CHARS),
        usedFallback: true
      };
    }

    const synopsisAnchor = synopsis.split(/\s+/).slice(0, 10).join(' ');
    if (synopsisAnchor && containsNormalizedSnippet(segment.rawText, synopsisAnchor)) {
      return {
        rawText: clipExcerpt(segment.rawText, SCENE_RAW_EXCERPT_MAX_CHARS),
        usedFallback: true
      };
    }
  }

  return {
    rawText: clipExcerpt(segment.rawText || synopsis || fullScript || 'Scene context unavailable.', SCENE_RAW_EXCERPT_MAX_CHARS),
    usedFallback: true
  };
};

const filterGroundedCharacterNames = (names: string[], sceneRawText: string): { names: string[]; dropped: number } => {
  const grounded = new Set<string>();
  let dropped = 0;

  for (const rawName of names) {
    const name = String(rawName || '').trim();
    if (!name) continue;
    if (containsNormalizedName(sceneRawText, name)) {
      grounded.add(name);
    } else {
      dropped += 1;
    }
  }

  return {
    names: Array.from(grounded),
    dropped
  };
};

const normalizeScenes = (
  raw: any[],
  fullScript: string,
  providedSegments?: ScriptSegment[]
): { scenes: Scene[]; diagnostics: AnalyzeScriptDiagnostics } => {
  const scriptSegments = providedSegments && providedSegments.length > 0
    ? providedSegments
    : segmentScript(fullScript);
  let ungroundedCharactersDropped = 0;
  let rawExcerptFallbackCount = 0;
  let fallbackSceneCount = 0;
  let plotDriftCorrections = 0;

  const staged = raw
    .filter((scene) => scene && (
      (isString(scene.synopsis) && scene.synopsis.trim().length > 0)
      || (isString(scene.setting) && scene.setting.trim().length > 0)
      || (isString(scene.rawText) && scene.rawText.trim().length > 0)
    ))
    .map((scene, index) => {
      const segment = selectSegmentForScene(scene, index, scriptSegments, fullScript);
      const excerpt = deriveSceneRawExcerpt(scene, segment, fullScript);
      if (excerpt.usedFallback) rawExcerptFallbackCount += 1;

      const rawCharacters = ensureArray<string>(scene.characters, []);
      const grounded = filterGroundedCharacterNames(rawCharacters, segment.rawText);
      const hinted = filterGroundedCharacterNames(extractSegmentCharacterHints(segment.rawText), segment.rawText);
      const finalCharacters = grounded.names.length > 0 ? grounded.names : hinted.names;
      const rawExcerpt = clipSceneExcerptForCharacters(segment.rawText, finalCharacters)
        || excerpt.rawText;
      ungroundedCharactersDropped += grounded.dropped;

      let synopsis = isString(scene.synopsis) ? scene.synopsis.trim() : '';
      let setting = isString(scene.setting) ? scene.setting.trim() : '';
      let sceneFallback = excerpt.usedFallback;

      if (shouldRepairNarrativeField(synopsis, segment.rawText)) {
        synopsis = buildLiteralSynopsis(segment.rawText);
        plotDriftCorrections += 1;
        sceneFallback = true;
      }
      if (shouldRepairNarrativeField(setting, segment.rawText)) {
        setting = buildLiteralSetting(segment.rawText);
        plotDriftCorrections += 1;
        sceneFallback = true;
      }
      if (sceneFallback) fallbackSceneCount += 1;

      return {
        segment,
        score: firstWords(synopsis, 40).length + firstWords(setting, 20).length,
        scene: {
          id: 0,
          rawText: rawExcerpt,
          synopsis,
          characters: finalCharacters,
          setting
        } as Scene
      };
    });

  const dedupedBySegment = new Map<number, { segment: ScriptSegment; score: number; scene: Scene }>();
  for (const entry of staged) {
    const existing = dedupedBySegment.get(entry.segment.id);
    if (!existing || entry.score > existing.score) {
      dedupedBySegment.set(entry.segment.id, entry);
    }
  }

  const scenes = Array.from(dedupedBySegment.values())
    .sort((a, b) => a.segment.order - b.segment.order)
    .map((entry, index) => ({
      ...entry.scene,
      id: index + 1
    }));

  // A scene is only useful if it carries some grounded content. If the model returned
  // nothing usable (or only contentless placeholders), rebuild literal scenes directly
  // from the source segments instead of surfacing empty cards to the user.
  const hasMeaningfulContent = (scene: Scene) => Boolean(
    (scene.synopsis && scene.synopsis.trim())
    || (scene.setting && scene.setting.trim())
    || (scene.characters && scene.characters.length > 0)
  );

  if (scenes.filter(hasMeaningfulContent).length === 0 && scriptSegments.length > 0) {
    scenes.length = 0;
    fallbackSceneCount += scriptSegments.length;
    for (const segment of scriptSegments) {
      const hinted = filterGroundedCharacterNames(extractSegmentCharacterHints(segment.rawText), segment.rawText);
      scenes.push({
        id: scenes.length + 1,
        rawText: clipSceneExcerptForCharacters(segment.rawText, hinted.names)
          || clipExcerpt(segment.rawText, SCENE_RAW_EXCERPT_MAX_CHARS),
        synopsis: buildLiteralSynopsis(segment.rawText),
        characters: hinted.names,
        setting: buildLiteralSetting(segment.rawText)
      });
    }
  }

  return {
    scenes,
    diagnostics: {
      ungroundedCharactersDropped,
      rawExcerptFallbackCount,
      segmentCount: scriptSegments.length,
      fallbackSceneCount,
      coreEntityDrops: ungroundedCharactersDropped,
      plotDriftCorrections
    }
  };
};

export const normalizeAnalyzedScenes = normalizeScenes;

const hasGoodDescription = (value: unknown) =>
  typeof value === 'string' && value.trim().length >= 8;

const buildSceneGroundingContext = (scenes: Scene[], script?: string) => {
  const rawSceneText = scenes
    .map((scene) => scene.rawText || '')
    .join('\n');

  const scriptGroundingText = [script || '', rawSceneText]
    .filter(Boolean)
    .join('\n');

  return { scriptGroundingText };
};

export const buildWorldExtractionPrompt = (sceneContext: string) => `
You are extracting world entities for a comic production pipeline.
Use ONLY the provided source excerpts. Do not use outside knowledge.

Hard rules:
- No invented characters, items, or locations. No cross-story contamination.
- Return EVERY named character, every key item, and every distinct location that appears in the scenes.
- Ground every entity directly in the provided scenes. If it is not present in the excerpts, do not return it.
- Do not add backstory, motivations, new plot beats, or future events.
- All text must be VISUAL and present-tense only (appearance, materials, environment cues).

Fill EVERY field for each entity so an artist can draw it without guessing. Never leave a field blank:
- name: the canonical name exactly as written in the script.
- description: ONE rich visual sentence of at least 12 words (silhouette, key features, colors, mood).
- Characters MUST include structured: role, ageBand, physicalTraits, outfit, colorPalette, personality, constraints.
- Items MUST include structured: itemType, material, condition, scale, visualMotif, constraints.
- Locations MUST include structured: environmentType, eraMood, lighting, landmarks, palette, constraints.
- When a detail is not stated, infer the most likely concrete visual implied by the scene rather than leaving it empty; only use "unspecified" if the scenes truly give nothing.

- Characters max: ${MAX_WORLD_CHARACTER_COUNT}
- Items max: ${MAX_WORLD_ITEM_COUNT}
- Locations max: ${MAX_WORLD_LOCATION_COUNT}

Scenes:
${sceneContext}
`;

export const filterExtractedWorldData = (
  scenes: Scene[],
  extracted: {
    characters: Character[];
    items: Item[];
    locations: Location[];
  },
  options?: { script?: string }
) => {
  const { scriptGroundingText } = buildSceneGroundingContext(scenes, options?.script);
  const dropped_entities: DroppedEntityDiagnostic[] = [];

  const filterEntityList = <T extends { name: string; description?: string }>(
    list: T[],
    kind: DroppedEntityDiagnostic['kind'],
    limit: number
  ): T[] => {
    const deduped = new Map<string, T>();

    for (const entry of list) {
      const name = String(entry.name || '').trim();
      const normalized = normalizeEntityName(name);
      const description = String(entry.description || '').trim();

      if (!normalized) {
        dropped_entities.push({
          name: name || 'Unnamed',
          kind,
          reason: 'NOT_IN_SCRIPT'
        });
        continue;
      }

      if (!hasGoodDescription(description)) {
        dropped_entities.push({
          name,
          kind,
          reason: 'LOW_DESCRIPTION_QUALITY'
        });
        continue;
      }

      if (!containsNormalizedName(scriptGroundingText, name)) {
        dropped_entities.push({
          name,
          kind,
          reason: 'NOT_IN_SCRIPT'
        });
        continue;
      }

      const existing = deduped.get(normalized);
      if (!existing) {
        deduped.set(normalized, entry);
        continue;
      }

      const existingScore = (existing.description || '').trim().length;
      const nextScore = description.length;
      if (nextScore > existingScore) {
        dropped_entities.push({
          name: existing.name || name,
          kind,
          reason: 'DUPLICATE_NORMALIZED_NAME'
        });
        deduped.set(normalized, entry);
      } else {
        dropped_entities.push({
          name,
          kind,
          reason: 'DUPLICATE_NORMALIZED_NAME'
        });
      }
    }

    return Array.from(deduped.values()).slice(0, limit);
  };

  const characters = filterEntityList(extracted.characters, 'character', MAX_WORLD_CHARACTER_COUNT);
  const items = filterEntityList(extracted.items, 'item', MAX_WORLD_ITEM_COUNT);
  const locations = filterEntityList(extracted.locations, 'location', MAX_WORLD_LOCATION_COUNT);

  const rawCount = extracted.characters.length + extracted.items.length + extracted.locations.length;
  const filteredCount = characters.length + items.length + locations.length;
  const ungroundedCharacterDrops = dropped_entities.filter(
    (entry) => entry.kind === 'character' && entry.reason === 'NOT_IN_SCRIPT'
  ).length;
  const diagnostics: WorldExtractionDiagnostics = {
    input_scene_count: scenes.length,
    entity_counts: {
      characters: characters.length,
      items: items.length,
      locations: locations.length
    },
    filtered_entity_count: Math.max(rawCount - filteredCount, 0),
    dropped_entities,
    ungrounded_characters_dropped: ungroundedCharacterDrops
  };

  return { characters, items, locations, diagnostics };
};

export const analyzeScript = async (apiKey: string, script: string, modelOverride?: string): Promise<AnalyzeScriptResponse> => {
  const ai = createClient(apiKey);
  const model = resolveTextModel(modelOverride);
  const segments = segmentScript(script);
  const segmentContext = segments
    .map((segment) => [
      `Segment ${segment.id} (source=${segment.source}, order=${segment.order + 1}):`,
      segment.rawText
    ].join('\n'))
    .join('\n\n');
  const prompt = `
    Analyze the following comic script. Break it down into individual scenes anchored to source segments.
    For each scene, provide:
    0. segmentId (must reference one of the provided Segment IDs).
    1. A synopsis (visual description of what happens).
    2. A list of characters present.
    3. The setting/location.
    4. rawText as a short verbatim excerpt from that exact source segment.
    
    Source Segments:
    ${segmentContext}

    CRITICAL:
    - Use ONLY information present in the provided script.
    - Keep chronological order exactly as written using segment order.
    - Never reference a segmentId not provided above.
    - Do NOT invent scenes, characters, items, locations, backstory, motives, or future events.
    - If details are ambiguous, keep the synopsis minimal and literal instead of guessing.
    - In synthesis and setting descriptions, focus on VISUAL CONTENT (place, lighting, mood) only.
    - DO NOT include art style, medium, or rendering terms (e.g. 'watercolor', 'noir style', '3d render').
    - Keep it style-neutral.

    NON-EMPTY OUTPUT (required):
    - Every scene MUST have a non-empty synopsis (>= 8 characters) and a non-empty setting drawn from its segment.
    - NEVER return empty strings or placeholder tokens like "", "N/A", "TBD", or "Unknown".
    - Emit exactly ONE scene per meaningful source segment. Do not split a single segment into multiple near-identical scenes, and do not emit a scene with no real action.
  `;

  const response = await withRetry(
    () => withTimeout(
      ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.INTEGER },
                segmentId: { type: Type.INTEGER },
                rawText: { type: Type.STRING },
                synopsis: { type: Type.STRING },
                characters: { type: Type.ARRAY, items: { type: Type.STRING } },
                setting: { type: Type.STRING }
              },
              required: ['segmentId', 'rawText', 'synopsis', 'characters', 'setting']
            }
          }
        }
      }),
      TEXT_REQUEST_TIMEOUT_MS,
      'Analyze script'
    ),
    3,
    2000,
    'Analyze Script'
  );

  const responseText = response.text || '';
  const rawScenes = extractJson(responseText);
  const normalized = normalizeScenes(Array.isArray(rawScenes) ? rawScenes : [], script, segments);
  const scenes = normalized.scenes;
  if (scenes.length === 0) {
    throw new Error('No scenes found in analysis response');
  }

  return {
    scenes,
    diagnostics: {
      ungroundedCharactersDropped: normalized.diagnostics.ungroundedCharactersDropped,
      rawExcerptFallbackCount: normalized.diagnostics.rawExcerptFallbackCount,
      segmentCount: normalized.diagnostics.segmentCount,
      fallbackSceneCount: normalized.diagnostics.fallbackSceneCount,
      coreEntityDrops: normalized.diagnostics.coreEntityDrops,
      plotDriftCorrections: normalized.diagnostics.plotDriftCorrections,
      sceneCount: scenes.length
    },
    prompt,
    responseText,
    usage: buildUsage(prompt, responseText, response.usageMetadata),
    model
  };
};

export const generateStoryOutline = async (
  apiKey: string,
  inputs: { genre?: string; tone?: string; setting?: string; characters?: string; conflict?: string; ending?: string; length?: string; },
  modelOverride?: string
): Promise<StoryOutlineResponse> => {
  const ai = createClient(apiKey);
  const model = resolveTextModel(modelOverride);
  const prompt = `
    You are a story architect for a comic.
    Create a concise outline with 5-8 beats.
    Genre: ${inputs.genre || 'Unknown'}
    Tone: ${inputs.tone || 'Balanced'}
    Setting: ${inputs.setting || 'Unknown'}
    Characters: ${inputs.characters || 'Unknown'}
    Conflict: ${inputs.conflict || 'Unknown'}
    Ending: ${inputs.ending || 'Open'}
    Length: ${inputs.length || 'medium'}

    Return the outline as bullet points.
  `;

  const response = await withRetry(
    () => withTimeout(
      ai.models.generateContent({ model, contents: prompt }),
      TEXT_REQUEST_TIMEOUT_MS,
      'Story outline'
    ),
    2,
    1500,
    'Story Outline'
  );

  const responseText = response.text || '';
  return {
    outline: responseText,
    prompt,
    responseText,
    usage: buildUsage(prompt, responseText, response.usageMetadata),
    model
  };
};

export const generateStoryDraft = async (
  apiKey: string,
  inputs: { outline?: string; genre?: string; tone?: string; setting?: string; characters?: string; length?: string; },
  modelOverride?: string
): Promise<StoryDraftResponse> => {
  const ai = createClient(apiKey);
  const model = resolveTextModel(modelOverride);
  const prompt = `
    You are a comic script writer.
    Write a short script with scene headings and dialogue.
    Genre: ${inputs.genre || 'Unknown'}
    Tone: ${inputs.tone || 'Balanced'}
    Setting: ${inputs.setting || 'Unknown'}
    Characters: ${inputs.characters || 'Unknown'}
    Length: ${inputs.length || 'medium'}
    Outline:
    ${inputs.outline || 'No outline provided.'}

    Format:
    Scene 1: ...
    CHARACTER: "Dialogue"
  `;

  const response = await withRetry(
    () => withTimeout(
      ai.models.generateContent({ model, contents: prompt }),
      TEXT_REQUEST_TIMEOUT_MS,
      'Story draft'
    ),
    2,
    1500,
    'Story Draft'
  );

  const responseText = response.text || '';
  return {
    script: responseText,
    prompt,
    responseText,
    usage: buildUsage(prompt, responseText, response.usageMetadata),
    model
  };
};

export const runStoryToolPrompt = async (
  apiKey: string,
  script: string,
  instruction: string,
  history: Array<{ role: 'user' | 'model'; text: string }> = [],
  modelOverride?: string
): Promise<StoryToolResponse> => {
  const ai = createClient(apiKey);
  const model = resolveTextModel(modelOverride);
  const systemInstruction = `
    You are a story analysis helper for a comic creation app.
    Use only the provided script context.
    Follow the user instruction exactly and keep the response concise.
    If asked for a strict format, return only that format.

    Script:
    ${script}
  `;

  const response = await withRetry(
    () => withTimeout(
      ai.models.generateContent({
        model,
        contents: [
          { role: 'user', parts: [{ text: systemInstruction }] },
          ...history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
          { role: 'user', parts: [{ text: instruction }] }
        ]
      }),
      TEXT_REQUEST_TIMEOUT_MS,
      'Story tool'
    ),
    2,
    1200,
    'Story Tool'
  );

  const responseText = response.text || '';
  return {
    text: responseText,
    prompt: `${systemInstruction}\n\nInstruction: ${instruction}`,
    responseText,
    usage: buildUsage(instruction, responseText, response.usageMetadata),
    model
  };
};

export const extractWorldDetails = async (
  apiKey: string,
  scenes: Scene[],
  script?: string,
  modelOverride?: string
): Promise<ExtractWorldResponse> => {
  const model = resolveTextModel(modelOverride);
  if (!scenes || scenes.length === 0) {
    return {
      characters: [],
      items: [],
      locations: [],
      prompt: '',
      responseText: '',
      model,
      diagnostics: {
        input_scene_count: 0,
        entity_counts: { characters: 0, items: 0, locations: 0 },
        filtered_entity_count: 0,
        dropped_entities: [],
        ungrounded_characters_dropped: 0
      }
    };
  }
  const ai = createClient(apiKey);
  const sceneContext = scenes.map((scene) => [
    `Scene ${scene.id}:`,
    `Raw Script Excerpt: ${scene.rawText || ''}`,
    `Known Scene Characters: ${(scene.characters || []).join(', ') || 'None listed'}`
  ].join('\n')).join('\n\n');
  const prompt = buildWorldExtractionPrompt(sceneContext);

  const response = await withRetry(
    () => ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            characters: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  name: { type: Type.STRING },
                  bio: { type: Type.STRING },
                  description: { type: Type.STRING },
                  structured: {
                    type: Type.OBJECT,
                    properties: {
                      role: { type: Type.STRING },
                      ageBand: { type: Type.STRING },
                      physicalTraits: { type: Type.STRING },
                      outfit: { type: Type.STRING },
                      colorPalette: { type: Type.STRING },
                      personality: { type: Type.STRING },
                      constraints: { type: Type.STRING }
                    }
                  }
                },
                required: ['id', 'name', 'bio', 'description']
              }
            },
            items: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  name: { type: Type.STRING },
                  description: { type: Type.STRING },
                  structured: {
                    type: Type.OBJECT,
                    properties: {
                      itemType: { type: Type.STRING },
                      material: { type: Type.STRING },
                      condition: { type: Type.STRING },
                      scale: { type: Type.STRING },
                      visualMotif: { type: Type.STRING },
                      constraints: { type: Type.STRING }
                    }
                  }
                },
                required: ['id', 'name', 'description']
              }
            },
            locations: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  name: { type: Type.STRING },
                  description: { type: Type.STRING },
                  structured: {
                    type: Type.OBJECT,
                    properties: {
                      environmentType: { type: Type.STRING },
                      eraMood: { type: Type.STRING },
                      lighting: { type: Type.STRING },
                      landmarks: { type: Type.STRING },
                      palette: { type: Type.STRING },
                      constraints: { type: Type.STRING }
                    }
                  }
                },
                required: ['id', 'name', 'description']
              }
            }
          },
          required: ['characters', 'items', 'locations']
        }
      }
    }),
    3,
    2000,
    'Extract World'
  );

  const responseText = response.text || '';
  const data = extractJson(responseText) || {};

  const extractedCharacters: Character[] = ensureArray<any>(data.characters).map((c) => {
    const name = isString(c?.name) ? c.name.trim() : 'Unnamed';
    const structured = readStructuredObject(c?.structured, [
      'role',
      'ageBand',
      'physicalTraits',
      'outfit',
      'colorPalette',
      'personality',
      'constraints'
    ]);
    return {
      id: crypto.randomUUID(),
      name,
      bio: isString(c?.bio) ? c.bio.trim() : '',
      description: ensureEntityDescription(isString(c?.description) ? c.description : '', structured, name),
      structured,
      referenceImageIds: []
    };
  });

  const extractedItems: Item[] = ensureArray<any>(data.items).map((i) => {
    const name = isString(i?.name) ? i.name.trim() : 'Unnamed';
    const structured = readStructuredObject(i?.structured, [
      'itemType',
      'material',
      'condition',
      'scale',
      'visualMotif',
      'constraints'
    ]);
    return {
      id: crypto.randomUUID(),
      name,
      description: ensureEntityDescription(isString(i?.description) ? i.description : '', structured, name),
      structured,
      referenceImageIds: []
    };
  });

  const extractedLocations: Location[] = ensureArray<any>(data.locations).map((l) => {
    const name = isString(l?.name) ? l.name.trim() : 'Unnamed';
    const structured = readStructuredObject(l?.structured, [
      'environmentType',
      'eraMood',
      'lighting',
      'landmarks',
      'palette',
      'constraints'
    ]);
    return {
      id: crypto.randomUUID(),
      name,
      description: ensureEntityDescription(isString(l?.description) ? l.description : '', structured, name),
      structured,
      referenceImageIds: []
    };
  });

  const { characters, items, locations, diagnostics } = filterExtractedWorldData(scenes, {
    characters: extractedCharacters,
    items: extractedItems,
    locations: extractedLocations
  }, { script });

  console.info('[WORLD_EXTRACTION_DIAGNOSTICS]', diagnostics);

  return {
    characters,
    items,
    locations,
    prompt,
    responseText,
    diagnostics,
    usage: buildUsage(prompt, responseText, response.usageMetadata),
    model
  };
};

export const generatePanelBreakdown = async (
  apiKey: string,
  scene: Scene,
  style: string,
  layoutType: string,
  panelCount: number,
  continuityBible?: ContinuityBible,
  sceneBindings?: SceneContinuityBinding[],
  previousPanelContext?: Array<{ panelId?: string; sceneId?: number; description: string; dialogue?: string }>,
  modelOverride?: string,
  continuitySummary?: string
): Promise<PanelBreakdownResponse> => {
  const model = resolveTextModel(modelOverride);
  if (!scene || !scene.synopsis) {
    return { panels: [], prompt: '', responseText: '', model };
  }

  const ai = createClient(apiKey);
  // Only this scene's binding is relevant to its panels; other scenes' bindings were pure
  // bloat re-sent on every call (cross-scene narrative now comes from the continuity
  // summary above). Fall back to all bindings if this scene can't be matched — no regression.
  const formatBinding = (b: SceneContinuityBinding) =>
    `- Scene ${b.sceneId}: required(${b.requiredEntityIds.join(', ') || 'none'}), location(${b.locationId || 'none'})`;
  const sceneBinding = sceneBindings?.find((b) => b.sceneId === scene.id);
  const sceneBindingLine = sceneBinding
    ? formatBinding(sceneBinding)
    : (sceneBindings && sceneBindings.length ? sceneBindings.map(formatBinding).join('\n') : 'None provided');
  const prompt = `
      Act as a comic book editor.
      Break this scene into exactly ${panelCount} distinct comic panels based on the synopsis.
      Style: ${style}.
      Layout: ${layoutType}.
      Continuity mode is strict. Do not introduce new characters, props, or settings unless explicitly listed in allowed continuity entities.
      Every output entry must describe exactly one single frame.
      Never describe split panels, two-part layouts, montages, top-half/bottom-half compositions, or triptychs.
      Do not include panel numbering text in descriptions (forbidden examples: "Panel 1", "Panel 2").
      
      Scene Synopsis: ${scene.synopsis}
      Scene Raw Excerpt: ${scene.rawText || ''}
      Scene Characters: ${(scene.characters || []).join(', ') || 'Unknown'}
      Scene Setting: ${scene.setting || 'Unknown'}
      Story so far (summary of earlier scenes — keep this scene visually and narratively consistent with it):
      ${continuitySummary?.trim() || 'This is the opening; there are no earlier scenes yet.'}
      Allowed continuity entities:
      ${continuityBible?.entities?.map((entity) => `- [${entity.kind}] ${entity.name}: ${entity.description}`).join('\n') || 'None provided'}
      Scene continuity bindings:
      ${sceneBindingLine}
      Previous panel context:
      ${previousPanelContext?.map((panel, idx) => `- Prev ${idx + 1}: ${panel.description} | ${panel.dialogue || ''}`).join('\n') || 'None provided'}
      
      Return JSON array of panels. Each panel must include:
      - description: visual prompt for the artist (no text in image)
      - dialogue: a short line of text or caption (must not be empty)
      - dialogueBlocks: optional array of dialogue objects (kind: speech/caption/narration, speaker optional, text, side optional left/right/center).
      - requiredEntityIds: array of entity IDs that must remain visible/consistent in this panel.
      - locationId: the locked location entity id for this panel.
      - continuityNotes: short note describing continuity constraints to preserve.

      Every panel must include at least one dialogue or caption line. If unsure, add a short narration caption.
      Keep character identity visually consistent across all panels.
      Ensure each description can be generated as a single full-bleed image frame.
    `;

  const response = await withRetry(
    () => ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              description: { type: Type.STRING, description: 'Visual prompt for the artist' },
              dialogue: { type: Type.STRING, description: 'Speech bubble text or caption' },
              dialogueBlocks: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    kind: { type: Type.STRING },
                    speaker: { type: Type.STRING },
                    text: { type: Type.STRING },
                    side: { type: Type.STRING }
                  }
                }
              },
              requiredEntityIds: { type: Type.ARRAY, items: { type: Type.STRING } },
              locationId: { type: Type.STRING },
              continuityNotes: { type: Type.STRING }
            }
          }
        }
      }
    }),
    3,
    1000,
    'Panel Breakdown'
  );

  const responseText = response.text || '';
  const panels = extractJson(responseText) || [];
  return {
    panels,
    prompt,
    responseText,
    usage: buildUsage(prompt, responseText, response.usageMetadata),
    model
  };
};

export const continuityAudit = async (
  apiKey: string,
  payload: {
    script?: string;
    continuityBible?: ContinuityBible;
    sceneBindings?: SceneContinuityBinding[];
    panels: Array<{
      id?: string;
      sceneId: number;
      description: string;
      dialogue?: string;
      requiredEntityIds?: string[];
      locationId?: string;
    }>;
  },
  modelOverride?: string
): Promise<ContinuityAuditResponse> => {
  const ai = createClient(apiKey);
  const model = resolveTextModel(modelOverride);
  const prompt = `
You are a comic continuity auditor.
Evaluate each panel for continuity drift using the script, continuity bible, and scene bindings.
Return JSON with:
- panelScores: array of { panelId, sceneId, driftScore (0-1), issues[], suggestedFix, requiredEntityIds[], locationId }
- overallScore: 0-1
- summary: short paragraph.

Script:
${payload.script || 'Not provided'}

Continuity bible:
${JSON.stringify(payload.continuityBible || {})}

Scene bindings:
${JSON.stringify(payload.sceneBindings || [])}

Panels:
${JSON.stringify(payload.panels || [])}
  `;

  const response = await withRetry(
    () => withTimeout(
      ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              panelScores: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    panelId: { type: Type.STRING },
                    sceneId: { type: Type.INTEGER },
                    driftScore: { type: Type.NUMBER },
                    issues: { type: Type.ARRAY, items: { type: Type.STRING } },
                    suggestedFix: { type: Type.STRING },
                    requiredEntityIds: { type: Type.ARRAY, items: { type: Type.STRING } },
                    locationId: { type: Type.STRING }
                  }
                }
              },
              overallScore: { type: Type.NUMBER },
              summary: { type: Type.STRING }
            },
            required: ['panelScores', 'overallScore', 'summary']
          }
        }
      }),
      TEXT_REQUEST_TIMEOUT_MS,
      'Continuity audit'
    ),
    2,
    1200,
    'Continuity Audit'
  );

  const responseText = response.text || '';
  const data = extractJson(responseText) || {};
  const panelScores = ensureArray<any>(data.panelScores).map((panel) => ({
    panelId: isString(panel?.panelId) ? panel.panelId : undefined,
    sceneId: Number(panel?.sceneId || 0),
    driftScore: Number(panel?.driftScore || 0),
    issues: ensureArray<string>(panel?.issues, []),
    suggestedFix: isString(panel?.suggestedFix) ? panel.suggestedFix : undefined,
    requiredEntityIds: ensureArray<string>(panel?.requiredEntityIds, []),
    locationId: isString(panel?.locationId) ? panel.locationId : undefined
  }));

  return {
    panelScores,
    overallScore: Number(data.overallScore || 0),
    summary: isString(data.summary) ? data.summary : '',
    prompt,
    responseText,
    usage: buildUsage(prompt, responseText, response.usageMetadata),
    model
  };
};

export const updateContinuitySummary = async (
  apiKey: string,
  currentSummary: string | undefined,
  scene: Scene,
  panels: Array<{ description: string; dialogue: string }>,
  modelOverride?: string
): Promise<ContinuitySummaryResponse> => {
  const ai = createClient(apiKey);
  const model = resolveTextModel(modelOverride);
  const prompt = `
Update the running continuity summary for this comic.
Keep it under 120 words. Focus on visual continuity, key characters, and setting.

Current Summary:
${currentSummary || 'None'}

New Scene:
${scene.synopsis}

Panels:
${panels.map((p, i) => `Panel ${i + 1}: ${p.description} | ${p.dialogue || ''}`).join('\n')}
  `;

  const response = await withRetry(
    () => ai.models.generateContent({
      model,
      contents: prompt
    }),
    3,
    1000,
    'Continuity Update'
  );

  const responseText = response.text || '';
  return {
    summary: responseText || currentSummary || '',
    prompt,
    responseText,
    usage: buildUsage(prompt, responseText, response.usageMetadata),
    model
  };
};

export const analyzeTestLabReport = async (
  apiKey: string,
  report: Record<string, unknown>,
  modelOverride?: string
): Promise<TestLabReportResponse> => {
  const ai = createClient(apiKey);
  const model = resolveTextModel(modelOverride);
  const prompt = `
You are a senior QA engineer analyzing a comic studio Test Lab run.
Provide a structured analysis with:
- Findings (what stands out)
- Likely Causes (performance, prompt quality, provider limits)
- Recommendations (specific improvements)
- Next Tests (what to try next)

Test Run JSON:
${JSON.stringify(report, null, 2)}
  `;

  const response = await withRetry(
    () => withTimeout(
      ai.models.generateContent({
        model,
        contents: prompt
      }),
      TEXT_REQUEST_TIMEOUT_MS,
      'Test Lab report'
    ),
    2,
    1500,
    'Test Lab Report'
  );

  const responseText = response.text || '';
  return {
    text: responseText,
    prompt,
    responseText,
    usage: buildUsage(prompt, responseText, response.usageMetadata),
    model
  };
};
