import { ComicState, Character, Item, Location } from "../types";
import { validateContinuityState } from "./continuity";

export type AutoReferenceTask = {
  kind: "character" | "item" | "location";
  id: string;
  name: string;
  description: string;
  /** User-uploaded reference image ids to ground the generated sheet. */
  uploadedReferenceIds: string[];
};

const hasReference = (entity: Character | Item | Location): boolean =>
  Boolean(entity.imageId) || (entity.referenceImageIds || []).length > 0;

const toTask = (
  kind: AutoReferenceTask["kind"],
  entity: Character | Item | Location
): AutoReferenceTask => ({
  kind,
  id: entity.id,
  name: entity.name,
  description:
    kind === "character"
      ? ((entity as Character).description || (entity as Character).bio || "")
      : (entity.description || ""),
  uploadedReferenceIds: entity.referenceImageIds || []
});

/**
 * Entities that need a generated reference sheet before panel generation can be
 * consistent: every entity the continuity validation flags as reference-less, plus
 * every character without any visual anchor (characters drift the most, so they get
 * sheets even when a relaxed lock level wouldn't flag them). Characters first —
 * they matter most and the list is capped to bound cost per run.
 */
export const collectAutoReferenceTasks = (state: ComicState, max = 10): AutoReferenceTask[] => {
  const flagged = new Set<string>();
  if (state.continuity?.bible) {
    for (const issue of validateContinuityState(state).issues) {
      if (issue.code === "ENTITY_REFERENCE_MISSING" && issue.entityId) {
        flagged.add(issue.entityId);
      }
    }
  }

  const tasks: AutoReferenceTask[] = [];
  const seen = new Set<string>();
  const push = (kind: AutoReferenceTask["kind"], entity: Character | Item | Location) => {
    if (seen.has(entity.id) || hasReference(entity)) return;
    seen.add(entity.id);
    tasks.push(toTask(kind, entity));
  };

  for (const character of state.characters || []) {
    push("character", character);
  }
  for (const location of state.locations || []) {
    if (flagged.has(location.id)) push("location", location);
  }
  for (const item of state.items || []) {
    if (flagged.has(item.id)) push("item", item);
  }

  return tasks.slice(0, max);
};

/** Write a generated reference image back onto the matching entity list. */
export const applyGeneratedReference = (
  state: ComicState,
  task: AutoReferenceTask,
  imageId: string,
  imageUrl: string
): Pick<ComicState, "characters" | "items" | "locations"> => {
  const patch = <T extends Character | Item | Location>(list: T[]): T[] =>
    (list || []).map((entity) => (entity.id === task.id ? { ...entity, imageId, imageUrl } : entity));

  return {
    characters: task.kind === "character" ? patch(state.characters) : state.characters,
    items: task.kind === "item" ? patch(state.items) : state.items,
    locations: task.kind === "location" ? patch(state.locations) : state.locations
  };
};
