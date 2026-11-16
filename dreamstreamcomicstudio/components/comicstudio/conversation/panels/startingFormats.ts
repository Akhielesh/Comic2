import type { Format } from '../../../../shared/comic/doc';
import { nearestAspect, type ImageModelSpec } from '../../../../shared/comic/models';

type StartingFormat = Pick<Format, 'kind' | 'pageAspect' | 'panelsPerPage'> & Pick<Partial<Format>, 'readingDirection'> & {
  id: string;
  title: string;
  description: string;
  requiresExactShape?: boolean;
};

/** Editable starting points, not printer trim specifications or platform upload formats. */
export const STARTING_FORMATS: readonly StartingFormat[] = [
  { id: 'comic-issue', title: 'Comic book issue', description: 'A classic portrait comic with flexible panel layouts.', kind: 'comic', pageAspect: '2:3', panelsPerPage: 'auto' },
  { id: 'graphic-novel', title: 'Graphic novel chapter', description: 'A portrait paperback shape for a longer story told in chapters.', kind: 'comic', pageAspect: '2:3', panelsPerPage: 'auto' },
  { id: 'comic-album', title: 'Comic album chapter', description: 'A wider portrait page for roomier scenes and backgrounds.', kind: 'comic', pageAspect: '3:4', panelsPerPage: 'auto' },
  { id: 'manga', title: 'Right-to-left manga', description: 'Portrait pages read from right to left.', kind: 'manga', pageAspect: '2:3', panelsPerPage: 'auto', readingDirection: 'rtl' },
  { id: 'mobile-webtoon', title: 'Mobile webtoon', description: 'Tall pages with panels stacked for scrolling on a phone.', kind: 'webtoon', pageAspect: '9:16', panelsPerPage: 3 },
  { id: 'long-webtoon', title: 'Long-scroll webtoon', description: 'Extra-tall pages for bigger vertical reveals.', kind: 'webtoon', pageAspect: '1:4', panelsPerPage: 4, requiresExactShape: true },
  { id: 'daily-strip', title: 'Daily comic strip', description: 'A horizontal strip with panels paced to its punchline.', kind: 'strip', pageAspect: '4:1', panelsPerPage: 4 },
  { id: 'picture-book', title: 'Square picture book', description: 'Square pages with roomy pictures and scene-driven layouts.', kind: 'storybook', pageAspect: '1:1', panelsPerPage: 2 }
];

/** Apply only the settings the card describes. Keep custom lettering, language, and color. */
export function startingFormatPatch(format: Format, preset: StartingFormat, pageModel: ImageModelSpec): Partial<Format> {
  const pageAspect = nearestAspect(pageModel, preset.pageAspect);
  const patch: Partial<Format> = {};
  if (format.kind !== preset.kind) patch.kind = preset.kind;
  if (format.pageAspect !== pageAspect) patch.pageAspect = pageAspect;
  if (format.panelsPerPage !== preset.panelsPerPage) patch.panelsPerPage = preset.panelsPerPage;
  if (preset.readingDirection && format.readingDirection !== preset.readingDirection) patch.readingDirection = preset.readingDirection;
  return patch;
}
