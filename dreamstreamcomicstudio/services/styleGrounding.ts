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
