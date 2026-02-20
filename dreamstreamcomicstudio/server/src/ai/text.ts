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

const resolveTextModel = (modelOverride?: string) => {
  const candidate = modelOverride?.trim();
  return candidate || TEXT_MODEL;
};

const filterGroundedCharacterNames = (names: string[], sceneRawText: string, fullScript: string): string[] => {
  const grounded = new Set<string>();
  for (const rawName of names) {
    const name = String(rawName || '').trim();
    if (!name) continue;
    if (containsNormalizedName(sceneRawText, name) || containsNormalizedName(fullScript, name)) {
      grounded.add(name);
    }
  }
  return Array.from(grounded);
};

const normalizeScenes = (raw: any[], fullScript: string): Scene[] => {
  return raw
    .filter((s) => s && isString(s.synopsis) && isString(s.setting))
    .map((scene, index) => {
      const rawText = isString(scene.rawText) && scene.rawText.trim().length > 0 ? scene.rawText : scene.synopsis;
      const rawCharacters = ensureArray<string>(scene.characters, []);
      const characters = filterGroundedCharacterNames(rawCharacters, rawText, fullScript);
      return {
        id: index + 1,
        rawText,
        synopsis: scene.synopsis,
        characters,
        setting: scene.setting
      };
    });
};

type WorldExtractionDiagnostics = {
  input_scene_count: number;
  entity_counts: {
    characters: number;
    items: number;
    locations: number;
  };
  filtered_entity_count: number;
};

const MAX_WORLD_CHARACTER_COUNT = 12;
const MAX_WORLD_ITEM_COUNT = 20;
const MAX_WORLD_LOCATION_COUNT = 12;

const normalizeEntityName = (value: string) =>
  value
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

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

const hasGoodDescription = (value: unknown) =>
  typeof value === 'string' && value.trim().length >= 8;

const dedupeByName = <T extends { name: string; description?: string }>(list: T[]): T[] => {
  const byName = new Map<string, T>();
  for (const entry of list) {
    const key = normalizeEntityName(entry.name || '');
    if (!key) continue;
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, entry);
      continue;
    }
    const existingScore = (existing.description || '').trim().length;
    const nextScore = (entry.description || '').trim().length;
    if (nextScore > existingScore) {
      byName.set(key, entry);
    }
  }
  return Array.from(byName.values());
};

const buildSceneGroundingContext = (scenes: Scene[]) => {
  const sceneText = scenes
    .map((scene) => [
      scene.synopsis || '',
      scene.setting || '',
      ...(scene.characters || [])
    ].join(' '))
    .join('\n');
  const sceneCharacterNames = new Set(
    scenes
      .flatMap((scene) => scene.characters || [])
      .map((name) => normalizeEntityName(name))
      .filter(Boolean)
  );
  return { sceneText, sceneCharacterNames };
};

export const buildWorldExtractionPrompt = (sceneContext: string) => `
You are extracting world entities for a comic production pipeline.
Use ONLY the provided scenes. Do not use outside knowledge.

Hard rules:
- No invented characters, items, or locations.
- No cross-story contamination.
- Return canonical names and concise visual descriptions.
- Ground every entity directly in the provided scenes.
- Do not add backstory, motivations, new plot beats, or future events.
- Descriptions must be visual and present-tense only (appearance, materials, environment cues).
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
  }
) => {
  const { sceneText, sceneCharacterNames } = buildSceneGroundingContext(scenes);

  const dedupedCharacters = dedupeByName(extracted.characters);
  const dedupedItems = dedupeByName(extracted.items);
  const dedupedLocations = dedupeByName(extracted.locations);

  const characters = dedupedCharacters
    .filter((entry) => {
      const normalized = normalizeEntityName(entry.name || '');
      if (!normalized || !hasGoodDescription(entry.description)) return false;
      return sceneCharacterNames.has(normalized) || containsNormalizedName(sceneText, entry.name);
    })
    .slice(0, MAX_WORLD_CHARACTER_COUNT);

  const items = dedupedItems
    .filter((entry) => {
      if (!entry.name || !hasGoodDescription(entry.description)) return false;
      return containsNormalizedName(sceneText, entry.name);
    })
    .slice(0, MAX_WORLD_ITEM_COUNT);

  const locations = dedupedLocations
    .filter((entry) => {
      if (!entry.name || !hasGoodDescription(entry.description)) return false;
      return containsNormalizedName(sceneText, entry.name);
    })
    .slice(0, MAX_WORLD_LOCATION_COUNT);

  const rawCount = extracted.characters.length + extracted.items.length + extracted.locations.length;
  const filteredCount = characters.length + items.length + locations.length;
  const diagnostics: WorldExtractionDiagnostics = {
    input_scene_count: scenes.length,
    entity_counts: {
      characters: characters.length,
      items: items.length,
      locations: locations.length
    },
    filtered_entity_count: Math.max(rawCount - filteredCount, 0)
  };

  return { characters, items, locations, diagnostics };
};

export const analyzeScript = async (apiKey: string, script: string, modelOverride?: string): Promise<AnalyzeScriptResponse> => {
  const ai = createClient(apiKey);
  const model = resolveTextModel(modelOverride);
  const prompt = `
    Analyze the following comic script. Break it down into individual scenes.
    For each scene, provide:
    1. A synopsis (visual description of what happens).
    2. A list of characters present.
    3. The setting/location.
    4. rawText as a short verbatim excerpt from that exact scene in the provided script.
    
    Script:
    ${script}

    CRITICAL:
    - Use ONLY information present in the provided script.
    - Keep chronological order exactly as written.
    - Do NOT invent scenes, characters, items, locations, backstory, motives, or future events.
    - If details are ambiguous, keep the synopsis minimal and literal instead of guessing.
    - In synthesis and setting descriptions, focus on VISUAL CONTENT (place, lighting, mood) only.
    - DO NOT include art style, medium, or rendering terms (e.g. 'watercolor', 'noir style', '3d render').
    - Keep it style-neutral.
  `;

  const response = await withRetry(
    () => withTimeout(
      ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.INTEGER },
                rawText: { type: Type.STRING },
                synopsis: { type: Type.STRING },
                characters: { type: Type.ARRAY, items: { type: Type.STRING } },
                setting: { type: Type.STRING }
              },
              required: ['id', 'rawText', 'synopsis', 'characters', 'setting']
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
  const scenes = normalizeScenes(Array.isArray(rawScenes) ? rawScenes : [], script);
  if (scenes.length === 0) {
    throw new Error('No scenes found in analysis response');
  }

  return {
    scenes,
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

export const extractWorldDetails = async (apiKey: string, scenes: Scene[], modelOverride?: string): Promise<ExtractWorldResponse> => {
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
        filtered_entity_count: 0
      }
    };
  }
  const ai = createClient(apiKey);
  const sceneContext = scenes.map((scene) => [
    `Scene ${scene.id}:`,
    `Raw: ${scene.rawText || ''}`,
    `Synopsis: ${scene.synopsis || ''}`,
    `Setting: ${scene.setting || ''}`,
    `Characters: ${(scene.characters || []).join(', ') || 'None listed'}`
  ].join('\n')).join('\n\n');
  const prompt = buildWorldExtractionPrompt(sceneContext);

  const response = await withRetry(
    () => ai.models.generateContent({
      model,
      contents: prompt,
      config: {
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
                  description: { type: Type.STRING }
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
                  description: { type: Type.STRING }
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
                  description: { type: Type.STRING }
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

  const extractedCharacters: Character[] = ensureArray<any>(data.characters).map((c) => ({
    id: crypto.randomUUID(),
    name: isString(c?.name) ? c.name.trim() : 'Unnamed',
    bio: isString(c?.bio) ? c.bio.trim() : '',
    description: isString(c?.description) ? c.description.trim() : '',
    referenceImageIds: []
  }));

  const extractedItems: Item[] = ensureArray<any>(data.items).map((i) => ({
    id: crypto.randomUUID(),
    name: isString(i?.name) ? i.name.trim() : 'Unnamed',
    description: isString(i?.description) ? i.description.trim() : '',
    referenceImageIds: []
  }));

  const extractedLocations: Location[] = ensureArray<any>(data.locations).map((l) => ({
    id: crypto.randomUUID(),
    name: isString(l?.name) ? l.name.trim() : 'Unnamed',
    description: isString(l?.description) ? l.description.trim() : '',
    referenceImageIds: []
  }));

  const { characters, items, locations, diagnostics } = filterExtractedWorldData(scenes, {
    characters: extractedCharacters,
    items: extractedItems,
    locations: extractedLocations
  });

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
  modelOverride?: string
): Promise<PanelBreakdownResponse> => {
  const model = resolveTextModel(modelOverride);
  if (!scene || !scene.synopsis) {
    return { panels: [], prompt: '', responseText: '', model };
  }

  const ai = createClient(apiKey);
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
      Scene Characters: ${(scene.characters || []).join(', ') || 'Unknown'}
      Scene Setting: ${scene.setting || 'Unknown'}
      Allowed continuity entities:
      ${continuityBible?.entities?.map((entity) => `- [${entity.kind}] ${entity.name}: ${entity.description}`).join('\n') || 'None provided'}
      Scene continuity bindings:
      ${sceneBindings?.map((binding) => `- Scene ${binding.sceneId}: required(${binding.requiredEntityIds.join(', ') || 'none'}), location(${binding.locationId || 'none'})`).join('\n') || 'None provided'}
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
${JSON.stringify(payload.continuityBible || {}, null, 2)}

Scene bindings:
${JSON.stringify(payload.sceneBindings || [], null, 2)}

Panels:
${JSON.stringify(payload.panels || [], null, 2)}
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
