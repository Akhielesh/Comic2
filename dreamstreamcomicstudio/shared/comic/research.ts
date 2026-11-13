export interface ComicResearchResult {
  title: string;
  source: string;
  description?: string;
  thumbnail?: string;
  license?: string;
  credit?: string;
}

export interface ComicResearchResults {
  articles: ComicResearchResult[];
  images: ComicResearchResult[];
  incomplete: boolean;
}
