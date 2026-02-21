export type ExtractWorldBodyValidationResult =
  | {
    ok: true;
    scenes: unknown[];
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

  return {
    ok: true,
    scenes,
    script: script.trim()
  };
};
