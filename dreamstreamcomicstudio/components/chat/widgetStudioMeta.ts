// Metadata backbone for the Widget Studio (Gallery view). The core idea (per the
// product vision): a VISUAL is decoupled from any single data source — a line chart can
// plot finance, polls, metrics or anything; a table can render screeners, schedules or a
// COT report. So each artifact type maps to ALL the tools / APIs that can feed it, and
// when NO tool supplies what the user wants, the agent builds the visual + sources the
// data custom (web_search / analyze_data / render_react). The producing-tool names are
// matched against TOOL_CATALOG for the rich technical spec.

import type { ToolMeta } from '../../toolCatalog';

/** Artifact `type` → every tool / API that can feed that visual (primary first). A
 *  visual with several entries is general-purpose: the same component renders data from
 *  any of them. `render_*` tools accept ANY data the agent computes or gathers. */
export const ARTIFACT_TOOLS: Record<string, string[]> = {
  // General-purpose visuals — fed by a universal render_* tool PLUS domain tools.
  chart: ['render_chart'],
  data_table: ['render_table', 'analyze_data', 'get_cot_positioning', 'get_funding_rates'],
  metric_board: ['show_metrics', 'country_info', 'npm_package', 'pypi_package', 'sun_times'],
  market_heatmap: ['render_heatmap', 'build_finance_terminal'],
  map: ['show_map', 'find_places', 'get_directions'],
  news_results: ['get_news', 'hacker_news'],
  document: ['generate_document', 'wiki_lookup', 'find_recipe', 'search_books', 'search_papers'],
  generative_ui: ['render_ui'],
  react_component: ['render_react'],
  // Domain visuals — typically one live source, occasionally a couple.
  weather: ['get_weather'],
  video_results: ['video_search'],
  directions: ['get_directions'],
  places_results: ['find_places'],
  stock_quote: ['get_stock'],
  stock_comparison: ['compare_stocks'],
  finance_terminal: ['build_finance_terminal'],
  code_studio: ['generate_app'],
  quiz: ['generate_quiz'],
  flashcards: ['generate_flashcards'],
  sql_exercise: ['sql_exercise'],
  code_exercise: ['code_exercise'],
  resource_bundle: ['generate_bundle'],
  dashboard: ['create_dashboard'],
  learning_path: ['create_learning_path'],
  itinerary: ['plan_trip'],
  ticker_tape: ['get_ticker_tape'],
  market_sentiment: ['get_market_sentiment'],
  yield_curve: ['get_yield_curve'],
  portfolio: ['build_portfolio'],
  currency_converter: ['convert_currency'],
  whats_changed: ['render_whats_changed'],
  boarding_pass: ['render_boarding_pass'],
  world_clocks: ['render_world_clocks'],
  packing_list: ['render_packing_list'],
  trip_countdown: ['render_trip_countdown'],
  goal_tracker: ['create_goal_tracker'],
  code_review: ['render_code_review'],
  live_monitor: ['create_monitor'],
  macro_tiles: ['show_macro_tiles'],
  econ_calendar: ['get_econ_calendar'],
  earnings_calendar: ['get_earnings_calendar'],
  central_bank_watch: ['render_central_banks'],
  pnl_calendar: ['render_pnl_calendar'],
  debt_clock: ['get_national_debt'],
  flight_status: ['get_flight_status'],
  trip_budget: ['render_trip_budget'],
  local_cheatsheet: ['render_cheatsheet'],
  loyalty_wallet: ['render_loyalty_wallet'],
  widget_stack: ['create_widget_stack'],
  clarify: ['ask_user']
};

/** Artifact types the MODEL composes directly (no single producing data tool). */
export const MODEL_AUTHORED = new Set(['swarm_trace', 'recipe_card', 'recipe_run', 'research_report']);

/** A widget's source kind — drives the badge + a tag. */
export type WidgetKind = 'api' | 'mcp' | 'builtin' | 'model-authored' | 'static';

export const KIND_LABEL: Record<WidgetKind, string> = {
  api: 'Live API',
  mcp: 'MCP',
  builtin: 'Built-in',
  'model-authored': 'Model-authored',
  static: 'Static'
};

export interface TagInput {
  category?: string;
  kind: WidgetKind;
  refreshable: boolean;
  densityAware: boolean;
  multiSource: boolean;
  toolMeta?: ToolMeta;
  title: string;
}

/** Clean, relevant tags for search + categorization (source kind, liveness, density,
 *  multi-source, auth, and a couple of capability keywords from the tool + title). */
export const deriveTags = ({ kind, refreshable, densityAware, multiSource, toolMeta, title }: TagInput): string[] => {
  const tags = new Set<string>();
  tags.add(KIND_LABEL[kind].toLowerCase());
  if (refreshable) tags.add('live data');
  if (multiSource) tags.add('multi-source');
  if (densityAware) tags.add('compact + detailed');
  if (toolMeta?.auth === 'required') tags.add('needs key');
  else if (toolMeta?.auth === 'optional') tags.add('key optional');
  const hay = `${title} ${toolMeta?.keywords?.join(' ') ?? ''}`.toLowerCase();
  for (const cap of ['chart', 'map', 'route', 'gauge', 'table', 'timeline', 'animated', 'live', 'interactive', 'finance', 'travel', 'crypto'])
    if (hay.includes(cap)) tags.add(cap);
  return [...tags].slice(0, 7);
};
