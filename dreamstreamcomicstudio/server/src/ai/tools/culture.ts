// Culture, food & entertainment tools — recipes, cocktails, Pokémon, trivia,
// TV shows, anime, jokes, advice and fun facts. All free & keyless.
// Structured results also emit rich artifact cards (document / metric_board)
// so they render as widgets and pin to dashboards.

import type { ChatTool } from './types.js';
import type { DocumentArtifact, MetricBoardArtifact, MetricTile } from '../../../../apiTypes.js';
import { fetchJson } from './http.js';

const decode = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;|&rsquo;/g, "'")
    .replace(/&eacute;/g, 'é')
    .replace(/&[a-z0-9#]+;/gi, ' ');
const stripHtml = (s: string): string => decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

// Collect "strIngredient1..N" + "strMeasureN" pairs from a *DB record.
const collectIngredients = (m: Record<string, unknown>, max: number): string[] => {
  const out: string[] = [];
  for (let i = 1; i <= max; i++) {
    const ing = String(m[`strIngredient${i}`] || '').trim();
    const meas = String(m[`strMeasure${i}`] || '').trim();
    if (ing) out.push(`${meas ? `${meas} ` : ''}${ing}`.trim());
  }
  return out;
};

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);

// --- TheMealDB recipe -----------------------------------------------------------

/** Map a TheMealDB record to a downloadable recipe document (photo, ingredients, steps). Pure. */
export const recipeToDocument = (meal: Record<string, unknown>): DocumentArtifact => {
  const name = String(meal.strMeal || 'Recipe');
  const ingredients = collectIngredients(meal, 20);
  const instructions = String(meal.strInstructions || '').replace(/\r\n/g, '\n').trim().slice(0, 4000);
  const thumb = meal.strMealThumb ? String(meal.strMealThumb) : '';
  return {
    title: name,
    subtitle: [meal.strArea, meal.strCategory].filter(Boolean).join(' · ') || undefined,
    content:
      `${thumb ? `![${name}](${thumb})\n\n` : ''}` +
      `## Ingredients\n\n${ingredients.map((x) => `- ${x}`).join('\n')}\n\n` +
      `## Instructions\n\n${instructions}`,
    filename: `recipe-${slug(name)}`
  };
};

export const findRecipeTool: ChatTool = {
  name: 'find_recipe',
  description:
    'Find a cooking recipe by dish name with ingredients and step-by-step instructions (via TheMealDB). Use when the user asks how to cook/make a dish, wants a recipe, or ingredients for a meal.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Dish name, e.g. "carbonara", "chicken tikka", "pancakes".' } },
    required: ['query']
  },
  execute: async (args, signal) => {
    const query = String(args?.query || '').trim();
    if (!query) return { content: 'No dish was provided.' };
    try {
      const d = await fetchJson<{ meals?: Record<string, unknown>[] }>(
        `https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(query)}`,
        { signal }
      );
      const meal = d.meals?.[0];
      if (!meal) return { content: `No recipe found for "${query}".` };
      const name = String(meal.strMeal);
      const ingredients = collectIngredients(meal, 20);
      const instructions = String(meal.strInstructions || '').replace(/\r\n/g, '\n').slice(0, 1200);
      const content =
        `Recipe: ${name}${meal.strArea ? ` (${meal.strArea} · ${meal.strCategory})` : ''}\n\n` +
        `Ingredients:\n${ingredients.map((x) => `• ${x}`).join('\n')}\n\n` +
        `Instructions:\n${instructions}\n\n(A downloadable recipe card is shown to the user — don't repeat the steps.)`;
      const thumb = meal.strMealThumb ? String(meal.strMealThumb) : undefined;
      return {
        content,
        ...(thumb ? { images: [{ url: thumb, title: name, source: 'TheMealDB' }] } : {}),
        artifacts: [{ type: 'document', data: recipeToDocument(meal) }]
      };
    } catch (err) {
      return { content: `Recipe lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

// --- TheCocktailDB --------------------------------------------------------------

/** Map a TheCocktailDB record to a downloadable drink document. Pure. */
export const cocktailToDocument = (drink: Record<string, unknown>): DocumentArtifact => {
  const name = String(drink.strDrink || 'Cocktail');
  const ingredients = collectIngredients(drink, 15);
  const thumb = drink.strDrinkThumb ? String(drink.strDrinkThumb) : '';
  const subtitle = [drink.strAlcoholic, drink.strGlass ? `served in a ${drink.strGlass}` : '']
    .filter(Boolean)
    .join(' — ');
  return {
    title: name,
    subtitle: subtitle || undefined,
    content:
      `${thumb ? `![${name}](${thumb})\n\n` : ''}` +
      `## Ingredients\n\n${ingredients.map((x) => `- ${x}`).join('\n')}\n\n` +
      `## Instructions\n\n${String(drink.strInstructions || '').trim().slice(0, 2000)}`,
    filename: `cocktail-${slug(name)}`
  };
};

export const findCocktailTool: ChatTool = {
  name: 'find_cocktail',
  description:
    'Find a cocktail/drink recipe by name with ingredients, measures and mixing instructions (via TheCocktailDB). Use for drink recipes, "how to make a X", or bartending questions.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Cocktail name, e.g. "margarita", "negroni", "mojito".' } },
    required: ['query']
  },
  execute: async (args, signal) => {
    const query = String(args?.query || '').trim();
    if (!query) return { content: 'No cocktail was provided.' };
    try {
      const d = await fetchJson<{ drinks?: Record<string, unknown>[] }>(
        `https://www.thecocktaildb.com/api/json/v1/1/search.php?s=${encodeURIComponent(query)}`,
        { signal }
      );
      const drink = d.drinks?.[0];
      if (!drink) return { content: `No cocktail found for "${query}".` };
      const name = String(drink.strDrink);
      const ingredients = collectIngredients(drink, 15);
      const content =
        `${name}${drink.strAlcoholic ? ` (${drink.strAlcoholic})` : ''}${drink.strGlass ? ` — served in a ${drink.strGlass}` : ''}\n\n` +
        `Ingredients:\n${ingredients.map((x) => `• ${x}`).join('\n')}\n\n` +
        `Instructions:\n${String(drink.strInstructions || '').slice(0, 800)}\n\n(A downloadable drink card is shown to the user — don't repeat the steps.)`;
      const thumb = drink.strDrinkThumb ? String(drink.strDrinkThumb) : undefined;
      return {
        content,
        ...(thumb ? { images: [{ url: thumb, title: name, source: 'TheCocktailDB' }] } : {}),
        artifacts: [{ type: 'document', data: cocktailToDocument(drink) }]
      };
    } catch (err) {
      return { content: `Cocktail lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

// --- PokéAPI --------------------------------------------------------------------

export interface PokemonData {
  name?: string;
  id?: number;
  height?: number;
  weight?: number;
  types?: { type: { name: string } }[];
  stats?: { base_stat: number; stat: { name: string } }[];
  sprites?: { front_default?: string; other?: { 'official-artwork'?: { front_default?: string } } };
}

const MAX_BASE_STAT = 255; // The Pokédex cap (Blissey's 255 HP).
const STAT_LABEL: Record<string, string> = {
  hp: 'HP',
  attack: 'Attack',
  defense: 'Defense',
  'special-attack': 'Sp. Atk',
  'special-defense': 'Sp. Def',
  speed: 'Speed'
};

/** Map a PokéAPI record to a stat metric board (base stats as progress rings). Pure. */
export const pokemonToMetrics = (d: PokemonData): MetricBoardArtifact => {
  const tiles: MetricTile[] = (d.stats || []).map((s) => ({
    label: STAT_LABEL[s.stat.name] || s.stat.name,
    value: s.base_stat,
    progress: { value: s.base_stat, max: MAX_BASE_STAT }
  }));
  tiles.push({ label: 'Type', value: (d.types || []).map((t) => t.type.name).join(' / ') || '—' });
  tiles.push({ label: 'Height', value: (d.height || 0) / 10, unit: 'm' });
  tiles.push({ label: 'Weight', value: (d.weight || 0) / 10, unit: 'kg' });
  const name = d.name ? d.name[0].toUpperCase() + d.name.slice(1) : 'Pokémon';
  return { title: `#${d.id ?? '?'} ${name}`, columns: 3, tiles };
};

export const pokemonInfoTool: ChatTool = {
  name: 'pokemon_info',
  description:
    'Get details about a Pokémon — types, height/weight, base stats and artwork (via PokéAPI). Use for Pokémon questions, team-building, or game references.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Pokémon name or Pokédex number, e.g. "pikachu", "charizard", "150".' } },
    required: ['name']
  },
  execute: async (args, signal) => {
    const name = String(args?.name || '').trim().toLowerCase();
    if (!name) return { content: 'No Pokémon was provided.' };
    try {
      const d = await fetchJson<PokemonData>(`https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(name)}`, { signal });
      if (!d.name) return { content: `No Pokémon found named "${name}".` };
      const types = (d.types || []).map((t) => t.type.name).join(', ');
      const stats = (d.stats || []).map((s) => `${s.stat.name} ${s.base_stat}`).join(', ');
      const content =
        `#${d.id} ${d.name[0].toUpperCase() + d.name.slice(1)}\n` +
        `• Type: ${types || '—'}\n` +
        `• Height: ${(d.height || 0) / 10} m · Weight: ${(d.weight || 0) / 10} kg\n` +
        `• Base stats: ${stats}\n` +
        `(A stat board is shown to the user — don't repeat the numbers.)`;
      const art = d.sprites?.other?.['official-artwork']?.front_default || d.sprites?.front_default;
      return {
        content,
        ...(art ? { images: [{ url: art, title: d.name, source: 'PokéAPI' }] } : {}),
        artifacts: [{ type: 'metric_board', data: pokemonToMetrics(d) }]
      };
    } catch (err) {
      const msg = (err as Error)?.message || 'unknown error';
      return { content: msg.includes('404') ? `No Pokémon found named "${name}".` : `Pokémon lookup failed: ${msg}.` };
    }
  }
};

// --- Open Trivia DB -------------------------------------------------------------
// Deliberately text-only: the questions feed the model's interactive generate_quiz
// flow — rendering answers in a display card would spoil the quiz.
export const triviaQuestionsTool: ChatTool = {
  name: 'trivia_questions',
  description:
    'Fetch trivia/quiz questions with answers across categories and difficulties (via Open Trivia DB). Use to create a quiz, "ask me trivia", or generate quiz content.',
  parameters: {
    type: 'object',
    properties: {
      amount: { type: 'number', description: 'How many questions (1-10, default 5).' },
      difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'], description: 'Optional difficulty.' }
    }
  },
  execute: async (args, signal) => {
    const amount = Math.min(10, Math.max(1, typeof args?.amount === 'number' ? Math.floor(args.amount) : 5));
    const diff = ['easy', 'medium', 'hard'].includes(String(args?.difficulty)) ? `&difficulty=${args.difficulty}` : '';
    try {
      const d = await fetchJson<{ response_code: number; results?: { category: string; question: string; correct_answer: string; incorrect_answers: string[]; difficulty: string }[] }>(
        `https://opentdb.com/api.php?amount=${amount}&type=multiple${diff}`,
        { signal }
      );
      if (!d.results?.length) return { content: 'No trivia questions available right now.' };
      const content = d.results
        .map((q, i) => {
          const options = [...q.incorrect_answers.map(stripHtml), stripHtml(q.correct_answer)].sort();
          return `Q${i + 1} (${q.category} · ${q.difficulty}): ${stripHtml(q.question)}\n   Options: ${options.join(' | ')}\n   ✅ Answer: ${stripHtml(q.correct_answer)}`;
        })
        .join('\n\n');
      return { content };
    } catch (err) {
      return { content: `Trivia lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

// --- TVMaze ---------------------------------------------------------------------

export interface TvShowData {
  name?: string;
  genres?: string[];
  premiered?: string;
  status?: string;
  rating?: { average?: number };
  network?: { name?: string };
  webChannel?: { name?: string };
  summary?: string;
  officialSite?: string;
  url?: string;
  image?: { medium?: string; original?: string };
}

/** Map a TVMaze show to a document card (poster, facts, summary). Pure. */
export const tvShowToDocument = (s: TvShowData): DocumentArtifact => {
  const name = s.name || 'TV show';
  const img = s.image?.original || s.image?.medium;
  const link = s.officialSite || s.url;
  const facts = [
    `- **Genres:** ${s.genres?.join(', ') || '—'}`,
    `- **Network:** ${s.network?.name || s.webChannel?.name || '—'}`,
    `- **Premiered:** ${s.premiered || '—'}`,
    `- **Status:** ${s.status || '—'}`,
    `- **Rating:** ${s.rating?.average != null ? `${s.rating.average}/10` : '—'}`
  ].join('\n');
  return {
    title: `${name}${s.premiered ? ` (${s.premiered.slice(0, 4)})` : ''}`,
    subtitle: s.genres?.length ? s.genres.join(' · ') : undefined,
    content:
      `${img ? `![${name}](${img})\n\n` : ''}${facts}\n\n` +
      `${s.summary ? `${stripHtml(s.summary)}\n\n` : ''}` +
      `${link ? `[More${s.officialSite ? ' on the official site' : ' on TVMaze'}](${link})` : ''}`.trim(),
    filename: `tv-${slug(name)}`
  };
};

export const tvShowTool: ChatTool = {
  name: 'tv_show',
  description:
    'Look up a TV show — genres, premiere date, network, rating and summary (via TVMaze). Use for TV show info, "what is X about", ratings, or where it aired.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'TV show title, e.g. "Breaking Bad", "The Office".' } },
    required: ['query']
  },
  execute: async (args, signal) => {
    const query = String(args?.query || '').trim();
    if (!query) return { content: 'No show title was provided.' };
    try {
      const s = await fetchJson<TvShowData>(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(query)}`, { signal });
      if (!s.name) return { content: `No TV show found for "${query}".` };
      const content =
        `${s.name}${s.premiered ? ` (${s.premiered.slice(0, 4)})` : ''} — ${s.status || ''}\n` +
        `• Genres: ${s.genres?.join(', ') || '—'}\n` +
        `• Network: ${s.network?.name || s.webChannel?.name || '—'}\n` +
        `• Rating: ${s.rating?.average != null ? `${s.rating.average}/10` : '—'}\n` +
        `${s.summary ? `\n${stripHtml(s.summary).slice(0, 500)}` : ''}\n(A show card is shown to the user — don't repeat the synopsis.)`;
      const img = s.image?.original || s.image?.medium;
      const link = s.officialSite || s.url;
      return {
        content,
        ...(img ? { images: [{ url: img, title: s.name, source: 'TVMaze' }] } : {}),
        ...(link ? { citations: [{ url: link, title: s.name }] } : {}),
        artifacts: [{ type: 'document', data: tvShowToDocument(s) }]
      };
    } catch (err) {
      const msg = (err as Error)?.message || 'unknown error';
      return { content: msg.includes('404') ? `No TV show found for "${query}".` : `TV show lookup failed: ${msg}.` };
    }
  }
};

// --- Jikan (MyAnimeList) --------------------------------------------------------

export interface AnimeData {
  title?: string;
  title_english?: string;
  score?: number;
  episodes?: number;
  year?: number;
  status?: string;
  synopsis?: string;
  url?: string;
  images?: { jpg?: { image_url?: string } };
  genres?: { name: string }[];
}

/** Map a Jikan anime record to a document card (poster, facts, synopsis). Pure. */
export const animeToDocument = (a: AnimeData): DocumentArtifact => {
  const name = a.title_english || a.title || 'Anime';
  const img = a.images?.jpg?.image_url;
  const facts = [
    `- **Score:** ${a.score != null ? `${a.score}/10` : '—'}`,
    `- **Episodes:** ${a.episodes ?? '—'}`,
    `- **Year:** ${a.year ?? '—'}`,
    `- **Status:** ${a.status || '—'}`,
    `- **Genres:** ${a.genres?.map((g) => g.name).join(', ') || '—'}`
  ].join('\n');
  return {
    title: `${name}${a.year ? ` (${a.year})` : ''}`,
    subtitle: a.genres?.length ? a.genres.map((g) => g.name).join(' · ') : undefined,
    content:
      `${img ? `![${name}](${img})\n\n` : ''}${facts}\n\n` +
      `${a.synopsis ? `${a.synopsis.slice(0, 2000)}\n\n` : ''}` +
      `${a.url ? `[More on MyAnimeList](${a.url})` : ''}`.trim(),
    filename: `anime-${slug(name)}`
  };
};

export const animeInfoTool: ChatTool = {
  name: 'anime_info',
  description:
    'Look up an anime — score, episodes, year, genres and synopsis (via Jikan / MyAnimeList). Use for anime questions, recommendations, or "what is X anime about".',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Anime title, e.g. "Attack on Titan", "Spirited Away".' } },
    required: ['query']
  },
  execute: async (args, signal) => {
    const query = String(args?.query || '').trim();
    if (!query) return { content: 'No anime title was provided.' };
    try {
      const d = await fetchJson<{ data?: AnimeData[] }>(
        `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=1&sfw=true`,
        { signal }
      );
      const a = d.data?.[0];
      if (!a?.title) return { content: `No anime found for "${query}".` };
      const content =
        `${a.title_english || a.title}${a.year ? ` (${a.year})` : ''} — ${a.status || ''}\n` +
        `• Score: ${a.score != null ? `${a.score}/10` : '—'} · Episodes: ${a.episodes ?? '—'}\n` +
        `• Genres: ${a.genres?.map((g) => g.name).join(', ') || '—'}\n` +
        `${a.synopsis ? `\n${a.synopsis.slice(0, 500)}` : ''}\n(An anime card is shown to the user — don't repeat the synopsis.)`;
      const img = a.images?.jpg?.image_url;
      return {
        content,
        ...(img ? { images: [{ url: img, title: a.title, source: 'MyAnimeList' }] } : {}),
        ...(a.url ? { citations: [{ url: a.url, title: a.title }] } : {}),
        artifacts: [{ type: 'document', data: animeToDocument(a) }]
      };
    } catch (err) {
      return { content: `Anime lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

// --- Dad joke -------------------------------------------------------------------
// Deliberately text-only: a one-line joke needs delivery, not a widget.
export const randomJokeTool: ChatTool = {
  name: 'random_joke',
  description: 'Get a random clean joke (via icanhazdadjoke). Use when the user asks for a joke or wants to lighten the mood.',
  parameters: { type: 'object', properties: {} },
  execute: async (_args, signal) => {
    try {
      const d = await fetchJson<{ joke?: string }>('https://icanhazdadjoke.com/', { signal, accept: 'application/json' });
      return { content: d.joke || 'Could not fetch a joke right now.' };
    } catch (err) {
      return { content: `Joke lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

// --- Advice slip ----------------------------------------------------------------
// Deliberately text-only: a single sentence of advice reads best as prose.
export const randomAdviceTool: ChatTool = {
  name: 'random_advice',
  description: 'Get a random piece of advice (via Advice Slip). Use when the user asks for advice, a tip, or some wisdom.',
  parameters: { type: 'object', properties: {} },
  execute: async (_args, signal) => {
    try {
      const d = await fetchJson<{ slip?: { advice?: string } }>(`https://api.adviceslip.com/advice?t=${Date.now()}`, { signal });
      return { content: d.slip?.advice || 'Could not fetch advice right now.' };
    } catch (err) {
      return { content: `Advice lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

// --- Useless / random fact ------------------------------------------------------
// Deliberately text-only: the payload is one sentence — a card would outweigh the fact.
export const uselessFactTool: ChatTool = {
  name: 'useless_fact',
  description: 'Get a random interesting (often useless) trivia fact. Use for "tell me a random fact" or fun filler content.',
  parameters: { type: 'object', properties: {} },
  execute: async (_args, signal) => {
    try {
      const d = await fetchJson<{ text?: string; source_url?: string }>('https://uselessfacts.jsph.pl/api/v2/facts/random?language=en', { signal });
      if (!d.text) return { content: 'Could not fetch a fact right now.' };
      return { content: d.text, ...(d.source_url ? { citations: [{ url: d.source_url, title: 'Source' }] } : {}) };
    } catch (err) {
      return { content: `Fact lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

export const CULTURE_TOOLS: ChatTool[] = [
  findRecipeTool,
  findCocktailTool,
  pokemonInfoTool,
  triviaQuestionsTool,
  tvShowTool,
  animeInfoTool,
  randomJokeTool,
  randomAdviceTool,
  uselessFactTool
];
