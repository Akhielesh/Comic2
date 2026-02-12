import { Character, ComicPanel, Item, Location, Project, StyleVariant } from "../types";

export const MAX_IMAGE_HISTORY = 5;

export type ImageTransformPreset = {
  width?: number;
  height?: number;
  quality?: number;
  format?: "origin" | "webp" | "avif";
};

export const IMAGE_TRANSFORMS = {
  thumb: { width: 320, quality: 65, format: "webp" } as ImageTransformPreset,
  editor: { width: 1024, quality: 75, format: "webp" } as ImageTransformPreset,
};

const stripEntityUrls = (entity: Character | Item | Location) => {
  delete (entity as any).imageUrl;
  delete (entity as any).referenceImageUrls;
  delete (entity as any).referenceImages;
};

const stripPanelUrls = (panel: ComicPanel) => {
  delete (panel as any).imageUrl;
  delete (panel as any).imageUrlHistory;
};

const stripVariantUrls = (variant: StyleVariant) => {
  delete (variant as any).imageUrl;
};

export const sanitizeProjectForStorage = (project: Project): Project => {
  const cloned = structuredClone(project);

  cloned.state.characters.forEach(stripEntityUrls);
  cloned.state.items.forEach(stripEntityUrls);
  cloned.state.locations.forEach(stripEntityUrls);
  cloned.state.panels.forEach(stripPanelUrls);
  cloned.state.styleVariants.forEach(stripVariantUrls);
  delete (cloned.state as any).coverImageUrl;
  delete (cloned.state as any).coverTemplateImageUrl;

  return cloned;
};

export const prependCappedHistory = (history: string[] | undefined, value?: string, cap = MAX_IMAGE_HISTORY): string[] => {
  const base = Array.isArray(history) ? history : [];
  if (!value) return base.slice(0, cap);
  return [value, ...base].slice(0, cap);
};

export const appendCappedHistory = (history: string[] | undefined, value?: string, cap = MAX_IMAGE_HISTORY): string[] => {
  const base = Array.isArray(history) ? history : [];
  if (!value) return base.slice(-cap);
  return [...base, value].slice(-cap);
};
