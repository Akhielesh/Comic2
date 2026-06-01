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

  const wordCount = trimmed ? trimmed.split(/\s+/).filter(Boolean).length : 0;

  // The ONLY hard requirement is enough story for the AI to work with. Everything else is
  // optional — the analyzer segments free-form prose, so scene markers, dialogue lines and
  // ALL-CAPS character names are nice-to-haves, never requirements.
  if (wordCount >= 15) {
    found.push('Story has enough detail to analyze');
  } else {
    missing.push('Story is too short to analyze');
    suggestions.push('Write a few sentences describing what happens — plain prose is fine, no special formatting needed.');
  }

  if (hasSceneMarkers(trimmed)) {
    found.push('Scene markers detected');
  } else {
    suggestions.push('Optional: add scene headings like "Scene 1:" or INT./EXT. if you want to control pacing — the AI will split prose into scenes on its own.');
  }

  if (hasDialogueLines(trimmed)) {
    found.push('Dialogue lines detected');
  } else {
    suggestions.push('Optional: write dialogue as "Name: ..." if you want specific spoken lines.');
  }

  const characterNames = extractCharacterNames(trimmed);
  if (characterNames.length > 0) {
    found.push(`Character cues found (${characterNames.length})`);
  } else {
    suggestions.push('Optional: name a character or two for stronger consistency — the AI will still infer characters from your prose.');
  }

  if (hasSettingHints(trimmed)) {
    found.push('Setting cues detected');
  } else {
    suggestions.push('Optional: mention where or when a scene happens for richer backgrounds.');
  }

  return {
    found,
    missing,
    suggestions,
    updatedAt: Date.now()
  };
};
