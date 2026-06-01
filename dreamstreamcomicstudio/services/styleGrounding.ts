import { Scene } from '../types';

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim();

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const getSceneEntityNames = (scenes: Scene[] = []): string[] => {
  const names = new Set<string>();
  for (const scene of scenes) {
    for (const name of scene.characters || []) {
      const normalized = String(name || '').trim();
      if (!normalized) continue;
      names.add(normalized);
    }
  }
  return Array.from(names);
};

export const stripEntityNamesFromStyleText = (text: string, names: string[]): string => {
  const value = String(text || '');
  if (!value.trim()) return '';
  let output = value;
  for (const name of names) {
    const pattern = new RegExp(`\\b${escapeRegex(name)}\\b`, 'gi');
    output = output.replace(pattern, '');
  }
  return normalizeWhitespace(output);
};

export const buildStyleOnlyNotes = (input: {
  customNotes?: string;
  scenes?: Scene[];
}) => {
  const names = getSceneEntityNames(input.scenes || []);
  const scrubbed = stripEntityNamesFromStyleText(input.customNotes || '', names);
  return scrubbed;
};

/**
 * Mood/atmosphere context for a style preview, derived from a real scene so the look
 * reflects the user's actual story. Named characters are stripped — the preview stays a
 * style study (environment, lighting, tone only), not a plot illustration.
 */
export const buildSceneContextForStyle = (scene?: Scene): string => {
  if (!scene) return '';
  const names = getSceneEntityNames([scene]);
  const setting = stripEntityNamesFromStyleText(scene.setting || '', names);
  const synopsis = stripEntityNamesFromStyleText(scene.synopsis || '', names);
  const parts: string[] = [];
  if (setting) parts.push(`Setting and atmosphere: ${setting}`);
  if (synopsis) parts.push(`Opening moment: ${synopsis}`);
  return parts.join('. ');
};
