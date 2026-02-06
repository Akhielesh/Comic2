import { ComicState, ImageTag } from "../types";

export type ImageTagEntry = {
  imageId: string;
  category: string;
  label?: string;
  source?: {
    type: string;
    id?: string;
    label?: string;
  };
  createdAt?: number;
};

const PREFIX_MAP: Record<string, string> = {
  COVER: "COVER",
  STYLE: "STYLE",
  CHAR: "CHAR",
  ITEM: "ITEM",
  LOC: "LOC",
  PANEL: "PANEL",
  REF: "REF",
  TEMPLATE: "TEMPLATE",
  ORPHAN: "ORPHAN"
};

export const formatTag = (prefix: string, index: number) => {
  const safe = prefix.toUpperCase();
  const padded = String(index).padStart(4, "0");
  return `${safe}-${padded}`;
};

const normalizeCategory = (category: string) => (category || "IMG").toUpperCase();

export const assignImageTags = (
  existingTags: Record<string, ImageTag> = {},
  counters: Record<string, number> = {},
  entries: ImageTagEntry[] = []
) => {
  const nextTags: Record<string, ImageTag> = { ...existingTags };
  const nextCounters: Record<string, number> = { ...counters };
  const added: string[] = [];
  const seen = new Set<string>();

  entries.forEach((entry) => {
    if (!entry?.imageId) return;
    if (nextTags[entry.imageId]) return;
    if (seen.has(entry.imageId)) return;
    seen.add(entry.imageId);

    const category = normalizeCategory(entry.category);
    const prefix = PREFIX_MAP[category] || category;
    const current = nextCounters[prefix] ?? 0;
    const index = current + 1;
    nextCounters[prefix] = index;

    nextTags[entry.imageId] = {
      imageId: entry.imageId,
      tag: formatTag(prefix, index),
      category,
      label: entry.label,
      source: entry.source,
      createdAt: entry.createdAt ?? Date.now()
    };
    added.push(entry.imageId);
  });

  return { tags: nextTags, counters: nextCounters, added };
};

const uniqueEntries = (entries: ImageTagEntry[]) => {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (!entry.imageId) return false;
    if (seen.has(entry.imageId)) return false;
    seen.add(entry.imageId);
    return true;
  });
};

export const collectStateImageEntries = (state: ComicState): ImageTagEntry[] => {
  const entries: ImageTagEntry[] = [];

  if (state.coverImageId) {
    entries.push({
      imageId: state.coverImageId,
      category: "COVER",
      label: "Cover",
      source: { type: "cover", id: state.coverTemplateId, label: "Cover" }
    });
  }

  if (state.coverTemplateImageId) {
    entries.push({
      imageId: state.coverTemplateImageId,
      category: "TEMPLATE",
      label: "Cover Template",
      source: { type: "cover_template", id: state.coverTemplateId, label: "Cover Template" }
    });
  }

  const sortedVariants = [...(state.styleVariants || [])].sort((a, b) => (a.generatedAt || 0) - (b.generatedAt || 0));
  sortedVariants.forEach((variant) => {
    if (!variant.imageId) return;
    entries.push({
      imageId: variant.imageId,
      category: "STYLE",
      label: variant.category || "Style",
      source: { type: "style", id: variant.id, label: variant.category }
    });
  });

  const sortedCharacters = [...(state.characters || [])].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  sortedCharacters.forEach((character) => {
    if (character.imageId) {
      entries.push({
        imageId: character.imageId,
        category: "CHAR",
        label: character.name || "Character",
        source: { type: "character", id: character.id, label: character.name }
      });
    }
    (character.referenceImageIds || []).forEach((refId, idx) => {
      entries.push({
        imageId: refId,
        category: "REF",
        label: `${character.name || "Character"} Ref ${idx + 1}`,
        source: { type: "character_ref", id: character.id, label: character.name }
      });
    });
  });

  const sortedItems = [...(state.items || [])].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  sortedItems.forEach((item) => {
    if (item.imageId) {
      entries.push({
        imageId: item.imageId,
        category: "ITEM",
        label: item.name || "Item",
        source: { type: "item", id: item.id, label: item.name }
      });
    }
    (item.referenceImageIds || []).forEach((refId, idx) => {
      entries.push({
        imageId: refId,
        category: "REF",
        label: `${item.name || "Item"} Ref ${idx + 1}`,
        source: { type: "item_ref", id: item.id, label: item.name }
      });
    });
  });

  const sortedLocations = [...(state.locations || [])].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  sortedLocations.forEach((location) => {
    if (location.imageId) {
      entries.push({
        imageId: location.imageId,
        category: "LOC",
        label: location.name || "Location",
        source: { type: "location", id: location.id, label: location.name }
      });
    }
    (location.referenceImageIds || []).forEach((refId, idx) => {
      entries.push({
        imageId: refId,
        category: "REF",
        label: `${location.name || "Location"} Ref ${idx + 1}`,
        source: { type: "location_ref", id: location.id, label: location.name }
      });
    });
  });

  const sortedPanels = [...(state.panels || [])].sort((a, b) => {
    if (a.sceneId !== b.sceneId) return a.sceneId - b.sceneId;
    return (a.id || "").localeCompare(b.id || "");
  });
  sortedPanels.forEach((panel) => {
    if (panel.imageId) {
      entries.push({
        imageId: panel.imageId,
        category: "PANEL",
        label: `Scene ${panel.sceneId} Panel`,
        source: { type: "panel", id: panel.id, label: `Scene ${panel.sceneId} Panel` }
      });
    }
    (panel.imageIdHistory || []).forEach((historyId, idx) => {
      entries.push({
        imageId: historyId,
        category: "PANEL",
        label: `Scene ${panel.sceneId} Panel History ${idx + 1}`,
        source: { type: "panel_history", id: panel.id, label: `Scene ${panel.sceneId} Panel` }
      });
    });
  });

  return uniqueEntries(entries);
};
