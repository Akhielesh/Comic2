import type { Scene } from '../../../types.js';

export type ExtractWorldBodyValidationResult =
  | {
    ok: true;
    scenes: Scene[];
    script: string;
  }
  | {
    ok: false;
    status: number;
    error: {
      message: string;
      details?: {
        code: 'SCRIPT_REQUIRED_FOR_WORLD_EXTRACTION';
      };
    };
  };

export const validateExtractWorldBody = (body: unknown): ExtractWorldBodyValidationResult => {
  const payload = (body && typeof body === 'object') ? (body as Record<string, unknown>) : {};
  const scenes = payload.scenes;
  const script = payload.script;

  const isScene = (value: unknown): value is Scene => {
    if (!value || typeof value !== 'object') return false;
    const scene = value as Record<string, unknown>;
    return Number.isFinite(Number(scene.id))
      && typeof scene.rawText === 'string'
      && typeof scene.synopsis === 'string'
      && typeof scene.setting === 'string'
      && Array.isArray(scene.characters)
      && scene.characters.every((name) => typeof name === 'string');
  };

  if (!Array.isArray(scenes)) {
    return {
      ok: false,
      status: 400,
      error: {
        message: 'scenes array is required'
      }
    };
  }

  if (typeof script !== 'string' || !script.trim()) {
    return {
      ok: false,
      status: 400,
      error: {
        message: 'script is required for world extraction',
        details: {
          code: 'SCRIPT_REQUIRED_FOR_WORLD_EXTRACTION'
        }
      }
    };
  }

  const typedScenes = scenes.filter(isScene);
  if (typedScenes.length !== scenes.length) {
    return {
      ok: false,
      status: 400,
      error: {
        message: 'scenes array contains invalid scene payloads'
      }
    };
  }

  return {
    ok: true,
    scenes: typedScenes,
    script: script.trim()
  };
};
