import { Type } from '@google/genai';
import { Scene, Character, Item, Location, DialogueBlock } from '../../../types.js';
import {
  AnalyzeScriptResponse,
  StoryOutlineResponse,
  StoryDraftResponse,
  ExtractWorldResponse,
  PanelBreakdownResponse,
  ContinuitySummaryResponse,
  TestLabReportResponse
} from '../../../apiTypes.js';
import { createClient } from './client.js';
import { extractJson, ensureArray, isString } from './json.js';
import { buildUsage } from './usage.js';
import { withRetry, withTimeout } from './utils.js';
import { TEXT_MODEL, TEXT_REQUEST_TIMEOUT_MS } from '../config.js';

const normalizeScenes = (raw: any[]): Scene[] => {
  return raw
    .filter((s) => s && isString(s.synopsis) && isString(s.setting))
    .map((scene, index) => ({
      id: index + 1,
      rawText: isString(scene.rawText) ? scene.rawText : '',
      synopsis: scene.synopsis,
      characters: ensureArray<string>(scene.characters, []),
      setting: scene.setting
    }));
};

export const analyzeScript = async (apiKey: string, script: string): Promise<AnalyzeScriptResponse> => {
  const ai = createClient(apiKey);
  const prompt = `
    Analyze the following comic script. Break it down into individual scenes.
    For each scene, provide:
    1. A synopsis (visual description of what happens).
    2. A list of characters present.
    3. The setting/location.
    
    Script:
    ${script}
  `;

  const response = await withRetry(
    () => withTimeout(
      ai.models.generateContent({
        model: TEXT_MODEL,
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
              required: ['id', 'synopsis', 'characters', 'setting']
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
  const scenes = normalizeScenes(Array.isArray(rawScenes) ? rawScenes : []);
  if (scenes.length === 0) {
    throw new Error('No scenes found in analysis response');
  }

  return {
    scenes,
    prompt,
    responseText,
    usage: buildUsage(prompt, responseText, response.usageMetadata),
    model: TEXT_MODEL
  };
};

export const generateStoryOutline = async (
  apiKey: string,
  inputs: { genre?: string; tone?: string; setting?: string; characters?: string; conflict?: string; ending?: string; length?: string; }
): Promise<StoryOutlineResponse> => {
  const ai = createClient(apiKey);
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
      ai.models.generateContent({ model: TEXT_MODEL, contents: prompt }),
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
    model: TEXT_MODEL
  };
};

export const generateStoryDraft = async (
  apiKey: string,
  inputs: { outline?: string; genre?: string; tone?: string; setting?: string; characters?: string; length?: string; }
): Promise<StoryDraftResponse> => {
  const ai = createClient(apiKey);
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
      ai.models.generateContent({ model: TEXT_MODEL, contents: prompt }),
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
    model: TEXT_MODEL
  };
};

export const extractWorldDetails = async (apiKey: string, scenes: Scene[]): Promise<ExtractWorldResponse> => {
  if (!scenes || scenes.length === 0) {
    return { characters: [], items: [], locations: [], prompt: '', responseText: '', model: TEXT_MODEL };
  }
  const ai = createClient(apiKey);
  const sceneContext = scenes.map(s => `Scene ${s.id}: ${s.synopsis} (Chars: ${s.characters?.join(', ') || ''})`).join('\n');
  const prompt = `
    Based on these scenes, extract the visual definitions for the comic.
    
    1. Characters: Identify main characters. Include a short bio (personality/backstory) and a precise visual description for an artist.
    2. Items: Identify key props or items that appear (e.g., weapons, artifacts, vehicles).
    3. Locations: Identify key recurring settings/backgrounds.
    
    Scenes:
    ${sceneContext}
  `;

  const response = await withRetry(
    () => ai.models.generateContent({
      model: TEXT_MODEL,
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

  const characters: Character[] = ensureArray<any>(data.characters).map((c) => ({
    id: crypto.randomUUID(),
    name: isString(c?.name) ? c.name : 'Unnamed',
    bio: isString(c?.bio) ? c.bio : '',
    description: isString(c?.description) ? c.description : '',
    referenceImageIds: []
  }));

  const items: Item[] = ensureArray<any>(data.items).map((i) => ({
    id: crypto.randomUUID(),
    name: isString(i?.name) ? i.name : 'Unnamed',
    description: isString(i?.description) ? i.description : '',
    referenceImageIds: []
  }));

  const locations: Location[] = ensureArray<any>(data.locations).map((l) => ({
    id: crypto.randomUUID(),
    name: isString(l?.name) ? l.name : 'Unnamed',
    description: isString(l?.description) ? l.description : '',
    referenceImageIds: []
  }));

  return {
    characters,
    items,
    locations,
    prompt,
    responseText,
    usage: buildUsage(prompt, responseText, response.usageMetadata),
    model: TEXT_MODEL
  };
};

export const generatePanelBreakdown = async (
  apiKey: string,
  scene: Scene,
  style: string,
  layoutType: string,
  panelCount: number
): Promise<PanelBreakdownResponse> => {
  if (!scene || !scene.synopsis) {
    return { panels: [], prompt: '', responseText: '', model: TEXT_MODEL };
  }

  const ai = createClient(apiKey);
  const prompt = `
      Act as a comic book editor.
      Break this scene into exactly ${panelCount} distinct comic panels based on the synopsis.
      Style: ${style}.
      Layout: ${layoutType}.
      
      Scene Synopsis: ${scene.synopsis}
      
      Return JSON array of panels. Each panel must include:
      - description: visual prompt for the artist (no text in image)
      - dialogue: a short line of text or caption (must not be empty)
      - dialogueBlocks: optional array of dialogue objects (kind: speech/caption/narration, speaker optional, text, side optional left/right/center).

      Every panel must include at least one dialogue or caption line. If unsure, add a short narration caption.
    `;

  const response = await withRetry(
    () => ai.models.generateContent({
      model: TEXT_MODEL,
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
              }
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
    model: TEXT_MODEL
  };
};

export const updateContinuitySummary = async (
  apiKey: string,
  currentSummary: string | undefined,
  scene: Scene,
  panels: Array<{ description: string; dialogue: string }>
): Promise<ContinuitySummaryResponse> => {
  const ai = createClient(apiKey);
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
      model: TEXT_MODEL,
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
    model: TEXT_MODEL
  };
};

export const analyzeTestLabReport = async (
  apiKey: string,
  report: Record<string, unknown>
): Promise<TestLabReportResponse> => {
  const ai = createClient(apiKey);
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
        model: TEXT_MODEL,
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
    model: TEXT_MODEL
  };
};
