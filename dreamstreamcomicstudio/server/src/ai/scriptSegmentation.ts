export type ScriptSegmentSource = 'scene_marker' | 'paragraph' | 'full_script';

export type ScriptSegment = {
  id: number;
  order: number;
  rawText: string;
  source: ScriptSegmentSource;
};

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

export const segmentScript = (script: string): ScriptSegment[] => {
  const normalized = (script || '').trim();
  if (!normalized) return [];

  const bySceneMarkers = splitBySceneMarkers(normalized);
  if (bySceneMarkers.length > 1) {
    return bySceneMarkers.map((rawText, index) => ({
      id: index + 1,
      order: index,
      rawText,
      source: 'scene_marker'
    }));
  }

  const byParagraphs = splitByParagraphs(normalized);
  if (byParagraphs.length > 0) {
    return byParagraphs.map((rawText, index) => ({
      id: index + 1,
      order: index,
      rawText,
      source: 'paragraph'
    }));
  }

  return [{
    id: 1,
    order: 0,
    rawText: normalized,
    source: 'full_script'
  }];
};
