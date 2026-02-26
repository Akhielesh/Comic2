import {
  Character,
  Item,
  Location,
  CharacterStructuredDetails,
  ItemStructuredDetails,
  LocationStructuredDetails
} from '../types';

const clean = (value: unknown) => String(value || '').trim();

const joinParts = (parts: string[]) => parts.filter(Boolean).join('. ').trim();

export const buildCharacterStructuredDescription = (
  name: string,
  structured?: CharacterStructuredDetails,
  fallbackDescription?: string
) => {
  const parts = [
    clean(structured?.role) ? `${name} is ${clean(structured?.role)}` : '',
    clean(structured?.physicalTraits) ? `Physical traits: ${clean(structured?.physicalTraits)}` : '',
    clean(structured?.outfit) ? `Outfit: ${clean(structured?.outfit)}` : '',
    clean(structured?.colorPalette) ? `Palette: ${clean(structured?.colorPalette)}` : '',
    clean(structured?.personality) ? `Personality cues: ${clean(structured?.personality)}` : '',
    clean(structured?.constraints) ? `Constraints: ${clean(structured?.constraints)}` : ''
  ];
  const structuredDescription = joinParts(parts);
  return structuredDescription || clean(fallbackDescription);
};

export const buildItemStructuredDescription = (
  name: string,
  structured?: ItemStructuredDetails,
  fallbackDescription?: string
) => {
  const parts = [
    clean(structured?.itemType) ? `${name} type: ${clean(structured?.itemType)}` : '',
    clean(structured?.material) ? `Material: ${clean(structured?.material)}` : '',
    clean(structured?.condition) ? `Condition: ${clean(structured?.condition)}` : '',
    clean(structured?.scale) ? `Scale: ${clean(structured?.scale)}` : '',
    clean(structured?.visualMotif) ? `Motif: ${clean(structured?.visualMotif)}` : '',
    clean(structured?.constraints) ? `Constraints: ${clean(structured?.constraints)}` : ''
  ];
  const structuredDescription = joinParts(parts);
  return structuredDescription || clean(fallbackDescription);
};

export const buildLocationStructuredDescription = (
  name: string,
  structured?: LocationStructuredDetails,
  fallbackDescription?: string
) => {
  const parts = [
    clean(structured?.environmentType) ? `${name} environment: ${clean(structured?.environmentType)}` : '',
    clean(structured?.eraMood) ? `Era/mood: ${clean(structured?.eraMood)}` : '',
    clean(structured?.lighting) ? `Lighting: ${clean(structured?.lighting)}` : '',
    clean(structured?.landmarks) ? `Landmarks: ${clean(structured?.landmarks)}` : '',
    clean(structured?.palette) ? `Palette: ${clean(structured?.palette)}` : '',
    clean(structured?.constraints) ? `Constraints: ${clean(structured?.constraints)}` : ''
  ];
  const structuredDescription = joinParts(parts);
  return structuredDescription || clean(fallbackDescription);
};

export const syncCharacterDescription = (character: Character): Character => ({
  ...character,
  description: buildCharacterStructuredDescription(character.name, character.structured, character.description),
  bio: clean(character.bio) || buildCharacterStructuredDescription(character.name, character.structured, character.description)
});

export const syncItemDescription = (item: Item): Item => ({
  ...item,
  description: buildItemStructuredDescription(item.name, item.structured, item.description)
});

export const syncLocationDescription = (location: Location): Location => ({
  ...location,
  description: buildLocationStructuredDescription(location.name, location.structured, location.description)
});
