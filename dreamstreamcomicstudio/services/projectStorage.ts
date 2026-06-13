import { Character, ComicPanel, Item, Location, PageStudioPage, Project, StyleVariant } from "../types";
import { AGENT_EVENT_LIMIT } from "./comicAgentRun";

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

const stripPageStudioPageUrls = (page: PageStudioPage) => {
  if (page.imageId) delete (page as any).imageUrl;
  if (page.baseImageId) delete (page as any).baseImageUrl;
  page.edits?.forEach((edit) => {
    if (edit.imageId) delete (edit as any).imageUrl;
  });
};

export const sanitizeProjectForStorage = (project: Project): Project => {
  const cloned = structuredClone(project);

  cloned.state.characters.forEach(stripEntityUrls);
  cloned.state.items.forEach(stripEntityUrls);
  cloned.state.locations.forEach(stripEntityUrls);
  cloned.state.panels.forEach(stripPanelUrls);
  cloned.state.styleVariants.forEach(stripVariantUrls);
  cloned.state.pageStudio?.pages?.forEach(stripPageStudioPageUrls);
  delete (cloned.state as any).coverImageUrl;
  delete (cloned.state as any).coverTemplateImageUrl;
  delete (cloned.state as any).styleImageUrl;

  // generationStatus.logs is transient UI state appended on every tick of a run. Persisting it
  // makes project state grow unbounded (the climbing project_state_bytes). Keep the small status
  // fields for resume, but never save the log buffer — the live build screen reads it in-memory.
  const status = (cloned.state as any).generationStatus;
  if (status && Array.isArray(status.logs) && status.logs.length) {
    (cloned.state as any).generationStatus = { ...status, logs: [] };
  }

  if (cloned.state.agentRun?.events?.length) {
    cloned.state.agentRun = {
      ...cloned.state.agentRun,
      events: cloned.state.agentRun.events.slice(-AGENT_EVENT_LIMIT)
    };
  }

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
