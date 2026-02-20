import { Character, Item, Location, Scene } from '../types';

export type WorldGroundingDropReason =
  | 'NOT_IN_SCRIPT'
  | 'LOW_DESCRIPTION_QUALITY'
  | 'DUPLICATE_NORMALIZED_NAME';

export type WorldGroundingDrop = {
  name: string;
  kind: 'character' | 'item' | 'location';
  reason: WorldGroundingDropReason;
};

export type WorldGroundingDiagnostics = {
  input_scene_count: number;
  entity_counts: {
    characters: number;
    items: number;
    locations: number;
  };
  filtered_entity_count: number;
  dropped_entities: WorldGroundingDrop[];
  ungrounded_characters_dropped: number;
};

export type WorldGroundingLimits = {
  characters: number;
  items: number;
  locations: number;
};

export const DEFAULT_WORLD_GROUNDING_LIMITS: WorldGroundingLimits = {
  characters: 12,
  items: 20,
  locations: 12
};

export type GroundWorldEntitiesInput = {
  scenes: Scene[];
  script?: string;
  characters: Character[];
  items: Item[];
  locations: Location[];
  limits?: Partial<WorldGroundingLimits>;
};

export type GroundWorldEntitiesResult = {
  characters: Character[];
  items: Item[];
  locations: Location[];
  diagnostics: WorldGroundingDiagnostics;
};

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

const hasGoodDescription = (value: string) => value.trim().length >= 8;

const buildGroundingText = (scenes: Scene[], script?: string) => {
  const rawSceneText = (scenes || [])
    .map((scene) => scene.rawText || '')
    .join('\n');

  return [script || '', rawSceneText]
    .filter(Boolean)
    .join('\n');
};

export const groundWorldEntities = ({
  scenes,
  script,
  characters,
  items,
  locations,
  limits
}: GroundWorldEntitiesInput): GroundWorldEntitiesResult => {
  const effectiveLimits: WorldGroundingLimits = {
    ...DEFAULT_WORLD_GROUNDING_LIMITS,
    ...(limits || {})
  };
  const scriptGroundingText = buildGroundingText(scenes || [], script);
  const dropped_entities: WorldGroundingDrop[] = [];

  const filterEntityList = <T extends { name: string }>(
    list: T[],
    kind: WorldGroundingDrop['kind'],
    limit: number,
    getDescription: (entry: T) => string
  ): T[] => {
    const deduped = new Map<string, T>();
    const entries = Array.isArray(list) ? list : [];

    for (const entry of entries) {
      const name = String(entry.name || '').trim();
      const normalized = normalizeEntityName(name);
      const description = getDescription(entry).trim();

      if (!normalized) {
        dropped_entities.push({
          name: name || 'Unnamed',
          kind,
          reason: 'NOT_IN_SCRIPT'
        });
        continue;
      }

      if (!hasGoodDescription(description)) {
        dropped_entities.push({
          name,
          kind,
          reason: 'LOW_DESCRIPTION_QUALITY'
        });
        continue;
      }

      if (!containsNormalizedName(scriptGroundingText, name)) {
        dropped_entities.push({
          name,
          kind,
          reason: 'NOT_IN_SCRIPT'
        });
        continue;
      }

      const existing = deduped.get(normalized);
      if (!existing) {
        deduped.set(normalized, entry);
        continue;
      }

      const existingScore = getDescription(existing).trim().length;
      const nextScore = description.length;
      if (nextScore > existingScore) {
        dropped_entities.push({
          name: existing.name || name,
          kind,
          reason: 'DUPLICATE_NORMALIZED_NAME'
        });
        deduped.set(normalized, entry);
      } else {
        dropped_entities.push({
          name,
          kind,
          reason: 'DUPLICATE_NORMALIZED_NAME'
        });
      }
    }

    const clampedLimit = Math.max(0, Math.floor(limit));
    return Array.from(deduped.values()).slice(0, clampedLimit);
  };

  const nextCharacters = filterEntityList(
    characters || [],
    'character',
    effectiveLimits.characters,
    (entry) => entry.description || entry.bio || ''
  );
  const nextItems = filterEntityList(
    items || [],
    'item',
    effectiveLimits.items,
    (entry) => entry.description || ''
  );
  const nextLocations = filterEntityList(
    locations || [],
    'location',
    effectiveLimits.locations,
    (entry) => entry.description || ''
  );

  const rawCount = (characters || []).length + (items || []).length + (locations || []).length;
  const filteredCount = nextCharacters.length + nextItems.length + nextLocations.length;
  const ungroundedCharacterDrops = dropped_entities.filter(
    (entry) => entry.kind === 'character' && entry.reason === 'NOT_IN_SCRIPT'
  ).length;

  return {
    characters: nextCharacters,
    items: nextItems,
    locations: nextLocations,
    diagnostics: {
      input_scene_count: (scenes || []).length,
      entity_counts: {
        characters: nextCharacters.length,
        items: nextItems.length,
        locations: nextLocations.length
      },
      filtered_entity_count: Math.max(rawCount - filteredCount, 0),
      dropped_entities,
      ungrounded_characters_dropped: ungroundedCharacterDrops
    }
  };
};
