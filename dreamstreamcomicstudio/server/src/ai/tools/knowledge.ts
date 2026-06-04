// Knowledge & reference tools — all free, keyless public APIs.
//
// Wikipedia, Free Dictionary, Datamuse, Numbers API, Open Library, arXiv and
// Hacker News. Each returns clean structured text (plus citations/images where
// available) the model synthesizes; every network failure degrades to a message.

import type { ChatTool } from './types.js';
import { fetchJson, fetchText } from './http.js';

// --- Wikipedia: search → summary (extract + thumbnail + canonical URL) ----------
interface WikiSearch {
  pages?: { key: string; title: string; description?: string; excerpt?: string }[];
}
interface WikiSummary {
  title?: string;
  description?: string;
  extract?: string;
  content_urls?: { desktop?: { page?: string } };
  thumbnail?: { source?: string };
}

export const wikiLookupTool: ChatTool = {
  name: 'wiki_lookup',
  description:
    'Look up an encyclopedic summary of a topic, person, place, event or concept from Wikipedia. Returns a concise factual extract with a source link and (when available) a thumbnail. Use for "who/what is…", background, definitions of named entities, and reference facts.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'The topic/term to look up, e.g. "Marie Curie" or "black hole".' } },
    required: ['query']
  },
  execute: async (args, signal) => {
    const query = String(args?.query || '').trim();
    if (!query) return { content: 'No topic was provided to look up.' };
    try {
      const search = await fetchJson<WikiSearch>(
        `https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=1`,
        { signal }
      );
      const top = search.pages?.[0];
      if (!top) return { content: `No Wikipedia article found for "${query}".` };
      const summary = await fetchJson<WikiSummary>(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(top.key)}`,
        { signal }
      );
      const url = summary.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(top.key)}`;
      const extract = summary.extract || top.excerpt?.replace(/<[^>]+>/g, '') || top.description || '';
      const content = `Wikipedia — ${summary.title || top.title}${summary.description ? ` (${summary.description})` : ''}:\n${extract}\nSource: ${url}`;
      const thumb = summary.thumbnail?.source;
      return {
        content,
        citations: [{ url, title: summary.title || top.title }],
        ...(thumb ? { images: [{ url: thumb, title: summary.title || top.title, source: 'Wikipedia' }] } : {})
      };
    } catch (err) {
      return { content: `Wikipedia lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

// --- Free Dictionary: definitions, part of speech, phonetics ---------------------
interface DictEntry {
  word?: string;
  phonetic?: string;
  meanings?: { partOfSpeech?: string; definitions?: { definition?: string; example?: string }[]; synonyms?: string[] }[];
}

export const defineWordTool: ChatTool = {
  name: 'define_word',
  description:
    'Get the dictionary definition(s) of an English word — part of speech, meanings, example usage, phonetics and synonyms. Use when the user asks "what does X mean", "define X", or wants usage/synonyms of a specific word.',
  parameters: {
    type: 'object',
    properties: { word: { type: 'string', description: 'A single English word to define.' } },
    required: ['word']
  },
  execute: async (args, signal) => {
    const word = String(args?.word || '').trim().split(/\s+/)[0];
    if (!word) return { content: 'No word was provided to define.' };
    try {
      const entries = await fetchJson<DictEntry[]>(
        `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`,
        { signal }
      );
      const entry = Array.isArray(entries) ? entries[0] : undefined;
      if (!entry?.meanings?.length) return { content: `No definition found for "${word}".` };
      const lines = entry.meanings
        .slice(0, 4)
        .map((m) => {
          const defs = (m.definitions || [])
            .slice(0, 2)
            .map((d) => `  • ${d.definition}${d.example ? ` — e.g. "${d.example}"` : ''}`)
            .join('\n');
          const syn = m.synonyms?.length ? `\n  synonyms: ${m.synonyms.slice(0, 6).join(', ')}` : '';
          return `(${m.partOfSpeech || 'word'})\n${defs}${syn}`;
        })
        .join('\n');
      return { content: `Definition of "${entry.word || word}"${entry.phonetic ? ` ${entry.phonetic}` : ''}:\n${lines}` };
    } catch (err) {
      const msg = (err as Error)?.message || 'unknown error';
      return { content: msg.includes('404') ? `No dictionary entry found for "${word}".` : `Dictionary lookup failed: ${msg}.` };
    }
  }
};

// --- Datamuse: synonyms / rhymes / related / "means like" -----------------------
type WordRel = 'synonyms' | 'rhymes' | 'related' | 'antonyms' | 'sounds_like' | 'spelled_like';
const DATAMUSE_PARAM: Record<WordRel, string> = {
  synonyms: 'rel_syn',
  antonyms: 'rel_ant',
  rhymes: 'rel_rhy',
  related: 'ml',
  sounds_like: 'sl',
  spelled_like: 'sp'
};

export const wordAssocTool: ChatTool = {
  name: 'word_assoc',
  description:
    'Find words associated with a given word via Datamuse: synonyms, antonyms, rhymes, related words, words that sound like it, or words spelled like it. Use for brainstorming, naming, poetry/rhyming, vocabulary and word games.',
  parameters: {
    type: 'object',
    properties: {
      word: { type: 'string', description: 'The seed word.' },
      relation: {
        type: 'string',
        enum: ['synonyms', 'antonyms', 'rhymes', 'related', 'sounds_like', 'spelled_like'],
        description: 'Which kind of association to return (default "related").'
      }
    },
    required: ['word']
  },
  execute: async (args, signal) => {
    const word = String(args?.word || '').trim();
    const relation = (DATAMUSE_PARAM[(args?.relation as WordRel) || 'related'] ? (args?.relation as WordRel) : 'related') || 'related';
    if (!word) return { content: 'No seed word was provided.' };
    try {
      const data = await fetchJson<{ word: string; score?: number }[]>(
        `https://api.datamuse.com/words?${DATAMUSE_PARAM[relation]}=${encodeURIComponent(word)}&max=20`,
        { signal }
      );
      if (!Array.isArray(data) || !data.length) return { content: `No ${relation.replace('_', ' ')} found for "${word}".` };
      return { content: `${relation.replace('_', ' ')} of "${word}": ${data.map((d) => d.word).join(', ')}` };
    } catch (err) {
      return { content: `Word association failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

// --- Numbers API: a fact about a number, math property, date or year ------------
export const numberFactTool: ChatTool = {
  name: 'number_fact',
  description:
    'Get an interesting fact about a number — trivia, a math property, a year in history, or a calendar date (month/day). Use for fun facts, "tell me about the number N", "what happened in year Y", or "fact about today\'s date".',
  parameters: {
    type: 'object',
    properties: {
      number: { type: 'string', description: 'A number, a year, or "month/day" (e.g. "42", "1969", "7/4"). Omit for a random trivia fact.' },
      type: { type: 'string', enum: ['trivia', 'math', 'year', 'date'], description: 'Kind of fact (default "trivia").' }
    }
  },
  execute: async (args, signal) => {
    const type = ['trivia', 'math', 'year', 'date'].includes(String(args?.type)) ? String(args?.type) : 'trivia';
    const number = String(args?.number || '').trim() || 'random';
    try {
      const data = await fetchJson<{ text?: string; number?: number; found?: boolean }>(
        `http://numbersapi.com/${encodeURIComponent(number)}/${type}?json`,
        { signal }
      );
      if (!data?.text) return { content: `No ${type} fact found for "${number}".` };
      return { content: data.text };
    } catch (err) {
      return { content: `Number fact lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

// --- Open Library: search books -------------------------------------------------
interface OLDoc {
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  key?: string;
  cover_i?: number;
  edition_count?: number;
}

export const searchBooksTool: ChatTool = {
  name: 'search_books',
  description:
    'Search for books by title, author or subject via Open Library. Returns titles, authors, first-published year and a cover image with a link. Use when the user asks about books, authors, "books about X", or for reading recommendations.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Title, author or subject, e.g. "dune frank herbert" or "machine learning".' } },
    required: ['query']
  },
  execute: async (args, signal) => {
    const query = String(args?.query || '').trim();
    if (!query) return { content: 'No book search query was provided.' };
    try {
      const data = await fetchJson<{ docs?: OLDoc[] }>(
        `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=6&fields=title,author_name,first_publish_year,key,cover_i,edition_count`,
        { signal }
      );
      const docs = (data.docs || []).filter((d) => d.title).slice(0, 6);
      if (!docs.length) return { content: `No books found for "${query}".` };
      const content = `Books for "${query}":\n${docs
        .map(
          (d, i) =>
            `[${i + 1}] ${d.title}${d.author_name?.length ? ` — ${d.author_name.slice(0, 2).join(', ')}` : ''}${
              d.first_publish_year ? ` (${d.first_publish_year})` : ''
            } · https://openlibrary.org${d.key}`
        )
        .join('\n')}`;
      const images = docs
        .filter((d) => d.cover_i)
        .slice(0, 4)
        .map((d) => ({ url: `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg`, title: d.title, source: 'Open Library' }));
      const citations = docs.map((d) => ({ url: `https://openlibrary.org${d.key}`, title: d.title }));
      return { content, citations, ...(images.length ? { images } : {}) };
    } catch (err) {
      return { content: `Book search failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

// --- arXiv: search research papers (Atom XML) -----------------------------------
const atomTag = (block: string, tag: string): string | undefined => {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].replace(/\s+/g, ' ').trim() : undefined;
};

export const searchPapersTool: ChatTool = {
  name: 'search_papers',
  description:
    'Search arXiv for academic / research papers (CS, physics, math, biology, economics, etc.). Returns titles, authors, abstracts and links. Use when the user asks about research, scientific papers, "latest work on X", or wants citations on a technical topic.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Research topic or keywords, e.g. "diffusion models" or "CRISPR gene editing".' } },
    required: ['query']
  },
  execute: async (args, signal) => {
    const query = String(args?.query || '').trim();
    if (!query) return { content: 'No research query was provided.' };
    try {
      const xml = await fetchText(
        `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=5&sortBy=relevance`,
        { signal, accept: 'application/atom+xml, application/xml, text/xml' }
      );
      const entries = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
      if (!entries.length) return { content: `No arXiv papers found for "${query}".` };
      const papers = entries.slice(0, 5).map((block) => {
        const title = atomTag(block, 'title') || 'Untitled';
        const id = atomTag(block, 'id') || '';
        const summary = (atomTag(block, 'summary') || '').slice(0, 320);
        const authors = (block.match(/<name>([\s\S]*?)<\/name>/gi) || [])
          .map((a) => a.replace(/<\/?name>/gi, '').trim())
          .slice(0, 3);
        const published = (atomTag(block, 'published') || '').slice(0, 10);
        return { title, id, summary, authors, published };
      });
      const content = `arXiv papers for "${query}":\n${papers
        .map(
          (p, i) =>
            `[${i + 1}] ${p.title}${p.authors.length ? ` — ${p.authors.join(', ')}` : ''}${p.published ? ` (${p.published})` : ''}\n${p.summary}…\n${p.id}`
        )
        .join('\n\n')}`;
      return { content, citations: papers.filter((p) => p.id).map((p) => ({ url: p.id, title: p.title })) };
    } catch (err) {
      return { content: `arXiv search failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

// --- Hacker News (Algolia): top tech/startup stories ----------------------------
interface HNHit {
  title?: string;
  url?: string;
  points?: number;
  author?: string;
  num_comments?: number;
  objectID?: string;
  created_at?: string;
}

export const hackerNewsTool: ChatTool = {
  name: 'hacker_news',
  description:
    'Search Hacker News for tech, startup, programming and science stories the developer community is discussing, ranked by points. Use for "what is HN talking about", trending tech/dev topics, or community sentiment on a technology.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Topic/keywords, e.g. "rust", "openai", "self-hosting". Omit for current front-page stories.' }
    }
  },
  execute: async (args, signal) => {
    const query = String(args?.query || '').trim();
    try {
      const endpoint = query
        ? `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=8`
        : 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=8';
      const data = await fetchJson<{ hits?: HNHit[] }>(endpoint, { signal });
      const hits = (data.hits || []).filter((h) => h.title).slice(0, 8);
      if (!hits.length) return { content: `No Hacker News stories found for "${query}".` };
      const content = `Hacker News${query ? ` — "${query}"` : ' front page'}:\n${hits
        .map(
          (h, i) =>
            `[${i + 1}] ${h.title} — ${h.points ?? 0} pts, ${h.num_comments ?? 0} comments\n${
              h.url || `https://news.ycombinator.com/item?id=${h.objectID}`
            }`
        )
        .join('\n')}`;
      const citations = hits.map((h) => ({
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        title: h.title
      }));
      return { content, citations };
    } catch (err) {
      return { content: `Hacker News lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

export const KNOWLEDGE_TOOLS: ChatTool[] = [
  wikiLookupTool,
  defineWordTool,
  wordAssocTool,
  numberFactTool,
  searchBooksTool,
  searchPapersTool,
  hackerNewsTool
];
