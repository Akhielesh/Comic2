// Metadata backbone for the Widget Studio (Gallery view): which live tool / API / MCP
// produces each artifact type, plus tag derivation. Kept separate from the view so the
// mapping is easy to audit and extend as widgets are added. The producing-tool names
// are matched against TOOL_CATALOG for the rich technical spec (provider, auth, rate
// limit, data shape, docs); an unmatched name still renders, just without that detail.

import type { ToolMeta } from '../../toolCatalog';

/** Artifact `type` → the server tool that emits it (the widget's "connection point"). */
export const ARTIFACT_TOOL: Record<string, string> = {
  weather: 'get_weather',
  video_results: 'video_search',
  map: 'show_map',
  directions: 'get_directions',
  news_results: 'get_news',
  places_results: 'find_places',
  stock_quote: 'get_stock',
  stock_comparison: 'compare_stocks',
  chart: 'render_chart',
  metric_board: 'show_metrics',
  data_table: 'render_table',
  market_heatmap: 'render_heatmap',
  finance_terminal: 'build_finance_terminal',
  code_studio: 'generate_app',
  quiz: 'generate_quiz',
  document: 'generate_document',
  flashcards: 'generate_flashcards',
  sql_exercise: 'sql_exercise',
  code_exercise: 'code_exercise',
  resource_bundle: 'generate_bundle',
  generative_ui: 'render_ui',
  dashboard: 'create_dashboard',
  learning_path: 'create_learning_path',
  itinerary: 'plan_trip',
  ticker_tape: 'get_ticker_tape',
  market_sentiment: 'get_market_sentiment',
  yield_curve: 'get_yield_curve',
  portfolio: 'build_portfolio',
  currency_converter: 'convert_currency',
  whats_changed: 'render_whats_changed',
  boarding_pass: 'render_boarding_pass',
  world_clocks: 'render_world_clocks',
  packing_list: 'render_packing_list',
  trip_countdown: 'render_trip_countdown',
  goal_tracker: 'create_goal_tracker',
  code_review: 'render_code_review',
  live_monitor: 'create_monitor',
  macro_tiles: 'show_macro_tiles',
  econ_calendar: 'get_econ_calendar',
  earnings_calendar: 'get_earnings_calendar',
  central_bank_watch: 'render_central_banks',
  pnl_calendar: 'render_pnl_calendar',
  debt_clock: 'get_national_debt',
  flight_status: 'get_flight_status',
  trip_budget: 'render_trip_budget',
  local_cheatsheet: 'render_cheatsheet',
  loyalty_wallet: 'render_loyalty_wallet',
  widget_stack: 'create_widget_stack',
  clarify: 'ask_user',
  react_component: 'render_react'
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
  toolMeta?: ToolMeta;
  title: string;
}

/** Clean, relevant tags for search + categorization (source kind, liveness, density,
 *  auth, and a couple of capability keywords from the tool + the demo title). */
export const deriveTags = ({ kind, refreshable, densityAware, toolMeta, title }: TagInput): string[] => {
  const tags = new Set<string>();
  tags.add(KIND_LABEL[kind].toLowerCase());
  if (refreshable) tags.add('live data');
  if (densityAware) tags.add('compact + detailed');
  if (toolMeta?.auth === 'required') tags.add('needs key');
  else if (toolMeta?.auth === 'optional') tags.add('key optional');
  // Capability hints from the demo title (parenthetical descriptors) + tool keywords.
  const hay = `${title} ${toolMeta?.keywords?.join(' ') ?? ''}`.toLowerCase();
  for (const cap of ['chart', 'map', 'route', 'gauge', 'table', 'timeline', 'animated', 'live', 'interactive', 'finance', 'travel', 'crypto'])
    if (hay.includes(cap)) tags.add(cap);
  return [...tags].slice(0, 7);
};
