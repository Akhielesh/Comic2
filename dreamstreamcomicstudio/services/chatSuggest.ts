// Lightweight, client-side model recommender for the "I don't know which model" flow.
//
// Maps a free-text goal to capability needs, then scores the text-capable catalog
// models so we can suggest a few with human reasons. No backend call.

import type { CatalogModel } from './modelCatalog';
import { getCapabilities } from './modelCapabilities';

export interface GoalNeeds {
  code: boolean;
  reasoning: boolean;
  vision: boolean;
  web: boolean;
  longContext: boolean;
  free: boolean;
}

export interface ModelSuggestion {
  model: CatalogModel;
  reasons: string[];
  score: number;
}

const KW = {
  code: /\b(code|coding|program|function|debug|refactor|api|script|sql|regex|algorithm|typescript|javascript|python|react|html|css)\b/i,
  reasoning: /\b(reason|logic|math|prove|solve|step.?by.?step|plan|strategy|analy|complex|puzzle|think)\b/i,
  vision: /\b(image|photo|picture|screenshot|diagram|chart|ocr|read (this|the|my) (image|photo|screenshot))\b/i,
  web: /\b(latest|today|current|news|recent|202[4-9]|search|look up|find out|who is|price of|weather|trending)\b/i,
  longContext: /\b(document|long|book|paper|transcript|entire|whole|large (doc|file)|summari[sz]e (a |the )?(doc|book|paper|article))\b/i,
  free: /\b(free|no cost|cheap|budget|without paying)\b/i
};

export const analyzeGoal = (text: string): GoalNeeds => ({
  code: KW.code.test(text),
  reasoning: KW.reasoning.test(text),
  vision: KW.vision.test(text),
  web: KW.web.test(text),
  longContext: KW.longContext.test(text),
  free: KW.free.test(text)
});

const TOOL_KW = {
  get_weather: /\b(weather|temperature|forecast|how (hot|cold)|will it rain|humidity|wind|uv|air quality|pollen)\b/i,
  // Discovering places (restaurants, coffee, hotels…) → the rich local-search tool.
  find_places: /\b(restaurant|food|eat|dinner|lunch|breakfast|cafe|coffee|bar|pub|hotel|motel|hostel|pharmacy|atm|bank|gym|museum|park|grocery|supermarket|gas station|near me|nearby|near my|around me|places? to|where (can|should) i)\b/i,
  // Asking to see a known place/route on a map → the map tool.
  show_map: /\b(map|where is|directions?|route|navigate|how (far|to get)|located|location of)\b/i,
  get_news: /\b(news|headline|breaking|happening|latest on|updates? on)\b/i,
  get_stock: /\b(stock|share price|ticker|stock market|nasdaq|s&p|dow|crypto|bitcoin|ethereum|price of [A-Z]{1,5}\b)\b/i,
  video_search: /\b(video|youtube|watch|tutorial|how to|show me how|clip)\b/i,
  image_search: /\b(image|photo|picture|show me (a |an )?(pic|image|photo)|what does .* look like)\b/i,
  render_chart: /\b(chart|graph|plot|visuali[sz]e|bar chart|line chart|pie chart|donut|scatter|trend (over|line)|breakdown of)\b/i,
  show_metrics: /\b(dashboard|kpis?|metrics?|scorecard|stat ?board|at a glance|summary of (the )?(stats|numbers|metrics))\b/i
};

/**
 * Auto mode: which tools a message likely needs. Web search is the default backstop
 * for anything current/factual; specialized tools are added when clearly relevant.
 */
export const detectTools = (text: string): string[] => {
  const tools = new Set<string>();
  if (TOOL_KW.get_weather.test(text)) tools.add('get_weather');
  // Places (discovery) takes precedence over a bare map for "near me"/"restaurants".
  if (TOOL_KW.find_places.test(text)) tools.add('find_places');
  if (TOOL_KW.show_map.test(text)) tools.add('show_map');
  if (TOOL_KW.get_news.test(text)) tools.add('get_news');
  if (TOOL_KW.get_stock.test(text)) tools.add('get_stock');
  if (TOOL_KW.video_search.test(text)) tools.add('video_search');
  if (TOOL_KW.image_search.test(text)) tools.add('image_search');
  // Web search backstop when the message looks like it needs current/factual info.
  if (tools.size > 0 || KW.web.test(text) || /\b(who|what|when|where|latest|how much|price|news)\b/i.test(text)) {
    tools.add('web_search');
  }
  return Array.from(tools);
};

export const recommendModels = (
  text: string,
  models: CatalogModel[],
  limit = 3
): ModelSuggestion[] => {
  const needs = analyzeGoal(text);
  // Chat = text-capable models only (exclude pure image generators).
  const candidates = models.filter((m) => !m.supportsImageOutput);

  const scored: ModelSuggestion[] = candidates.map((model) => {
    const caps = getCapabilities(model);
    const reasons: string[] = [];
    let score = 0;

    if (needs.reasoning && caps.reasoning) { score += 4; reasons.push('strong step-by-step reasoning'); }
    if (needs.code && caps.reasoning) { score += 2; reasons.push('reliable for code'); }
    if (needs.vision && caps.imageInput) { score += 4; reasons.push('can read images you attach'); }
    if (needs.vision && !caps.imageInput) { score -= 6; }
    if (needs.web && model.source === 'openrouter') { score += 2; reasons.push('works with web search + DuckDuckGo'); }
    if (needs.longContext && caps.longContext) { score += 3; reasons.push(`${Math.round(caps.contextLength / 1000)}K context window`); }
    if (caps.isFree) { score += needs.free ? 3 : 1; if (needs.free) reasons.push('free to use'); }

    // Gentle baseline: prefer larger context + a touch of recency-agnostic quality.
    score += Math.min(2, caps.contextLength / 200_000);
    if (caps.longContext && !reasons.length) reasons.push('large context window');
    if (!reasons.length) reasons.push('solid general-purpose model');

    return { model, reasons, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
};
