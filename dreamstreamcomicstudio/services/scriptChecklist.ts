export type ScriptChecklist = {
  found: string[];
  missing: string[];
  suggestions: string[];
  updatedAt: number;
};

const hasSceneMarkers = (script: string) => /(\bscene\b\s*\d+|\bint\.|\bext\.|\binterior\b|\bexterior\b)/i.test(script);

const hasDialogueLines = (script: string) => /^[A-Z][A-Z0-9 _'".-]{2,}:\s*\S+/m.test(script);

const extractCharacterNames = (script: string) => {
  const names = new Set<string>();
  const regex = /^([A-Z][A-Z0-9 _'".-]{2,}):/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(script)) !== null) {
    const name = match[1].trim();
    if (name.length <= 32) names.add(name);
  }
  return Array.from(names);
};

const hasSettingHints = (script: string) => /(\bnight\b|\bday\b|\binterior\b|\bexterior\b|\bcity\b|\bforest\b|\broom\b|\bstreet\b|\bspaceship\b|\blab\b|\bcafe\b|\bmarket\b)/i.test(script);

export const analyzeScriptChecklist = (script: string): ScriptChecklist => {
  const trimmed = script.trim();
  const found: string[] = [];
  const missing: string[] = [];
  const suggestions: string[] = [];

  if (trimmed.length >= 50) {
    found.push('Script length looks sufficient');
  } else {
    missing.push('Script is very short');
    suggestions.push('Add a few more sentences to clarify the story flow.');
  }

  if (hasSceneMarkers(trimmed)) {
    found.push('Scene markers detected');
  } else {
    missing.push('Scene markers missing');
    suggestions.push('Add Scene headings like "Scene 1:" or INT./EXT. lines.');
  }

  if (hasDialogueLines(trimmed)) {
    found.push('Dialogue lines detected');
  } else {
    missing.push('Dialogue lines missing');
    suggestions.push('Add dialogue lines like "NAME: ..." to guide the story.');
  }

  const characterNames = extractCharacterNames(trimmed);
  if (characterNames.length > 0) {
    found.push(`Character cues found (${characterNames.length})`);
  } else {
    missing.push('Character cues missing');
    suggestions.push('Include at least one named character in ALL CAPS like "HERO:".');
  }

  if (hasSettingHints(trimmed)) {
    found.push('Setting cues detected');
  } else {
    missing.push('Setting cues missing');
    suggestions.push('Describe where/when the scene takes place (city, night, interior, etc.).');
  }

  return {
    found,
    missing,
    suggestions,
    updatedAt: Date.now()
  };
};
