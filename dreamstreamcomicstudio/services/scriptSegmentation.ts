const cleanSegment = (value: string) => value.trim().replace(/\s+$/g, '');

const SCENE_DELIMITER_REGEX = /\n(?=\s*(?:(?:scene|act)\s+\d+[:.-]?|(?:int|ext|int\/ext|i\/e)\.?\s))/gi;

const splitBySceneMarkers = (script: string): string[] => {
  return script
    .split(SCENE_DELIMITER_REGEX)
    .map(cleanSegment)
    .filter(Boolean);
};

const splitByParagraphs = (script: string): string[] => {
  return script
    .split(/\n{2,}/g)
    .map(cleanSegment)
    .filter(Boolean);
};

const splitBySingleNewlines = (script: string): string[] => {
  return script
    .split(/\n/g)
    .map(cleanSegment)
    .filter(Boolean);
};

export const segmentScriptForReview = (script: string): string[] => {
  const normalized = (script || '').trim();
  if (!normalized) return [];

  const bySceneMarkers = splitBySceneMarkers(normalized);
  if (bySceneMarkers.length > 1) return bySceneMarkers;

  const byParagraphs = splitByParagraphs(normalized);
  if (byParagraphs.length > 0) return byParagraphs;

  const bySingleNewline = splitBySingleNewlines(normalized);
  if (bySingleNewline.length > 0) return bySingleNewline;

  return [normalized];
};
