// The page index behind "Find a page in this story" (StoryMap, in the page breakdown card) and the side panel's page
// search and chapters (SH-C2, panel/partsModel.ts): one entry per page in reading order, with its chapter, where it
// happens, its gist, and the author's own script, artwork directions and dialogue to search. Pure; older pages read as
// far as their fields go.

import type { ComicDoc, Page } from '../../../shared/comic/doc';
import { sceneIndex } from '../../../shared/comic/continuity';

const list = <T>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v : []);

/** Search folds width and case, so "ＭＡＹＡ" finds "Maya". */
export const searchable = (text: string): string => text.normalize('NFKC').toLocaleLowerCase();

/** A page's chapter title, when it starts one (trimmed), or undefined. */
export const chapterStart = (page: Page | undefined): string | undefined => {
  const title = typeof page?.chapterTitle === 'string' ? page.chapterTitle.trim() : '';
  return title || undefined;
};

/** The book's pages in reading order, each with the chapter it sits in (carried from the page that starts it). */
export const readingOrder = (doc: Pick<ComicDoc, 'pages'>): Array<{ page: Page; chapter: string }> => {
  let chapter = '';
  return [...list(doc?.pages)]
    .filter((page): page is Page => !!page && typeof page.id === 'string')
    .sort((a, b) => (a.n || 0) - (b.n || 0))
    .map((page) => {
      chapter = chapterStart(page) ?? chapter;
      return { page, chapter };
    });
};

/** What a page is about, in the author's words: its summary, else its first panel's action, else its turn hook. */
export const pageGist = (page: Page): string | undefined => page.summary || list(page.panels).find((p) => p?.action)?.action || page.turnHook || undefined;

export interface StoryPage {
  id: string;
  n: number;
  /** "Chapter · place" (either may be missing). */
  label: string;
  summary?: string;
  /** Everything searchable, folded (searchable()). */
  text: string;
}

/** The search index: built when a search opens (it reads scenes, so it is not free on a long book). */
export function storyPageIndex(doc: ComicDoc): StoryPage[] {
  const scenes = sceneIndex(doc, { derive: true });
  const cast = new Map(list(doc.cast).map((c) => [c.id, c.name]));
  return readingOrder(doc).map(({ page, chapter }) => {
    const scene = scenes.scenes.find((s) => s.id === scenes.byPage[page.id]);
    const place = scene?.placeId ? list(doc.places).find((p) => p.id === scene.placeId)?.name || scene.name : scene?.name;
    const label = [chapter, place].filter(Boolean).join(' · ');
    const panels = list(page.panels);
    const names = [...new Set(panels.flatMap((p) => list(p.castIds)).map((id) => cast.get(id)).filter(Boolean))].join(', ');
    const summary = pageGist(page);
    const dialogue = panels.flatMap((p) => [p.action, ...list(p.lines).map((line) => line.text)]).join(' ');
    const changes = page.continuity;
    const visuals = changes
      ? [
          ...Object.entries(changes.props || {}).flatMap(([name, state]) => [name, state]),
          ...Object.entries(changes.cast || {}).flatMap(([id, state]) => [cast.get(id), state?.outfit, ...(state?.holding || []), ...(state?.marks || [])])
        ].join(' ')
      : '';
    return { id: page.id, n: page.n, label, summary, text: searchable([page.n, label, names, summary, page.turnHook, dialogue, visuals].join(' ')) };
  });
}

/** The pages whose text holds every word of the query (every page for an empty one). */
export const matchStoryPages = (pages: readonly StoryPage[], query: string): StoryPage[] => {
  const words = searchable(query).trim().split(/\s+/).filter(Boolean);
  return pages.filter((page) => words.every((word) => page.text.includes(word)));
};
