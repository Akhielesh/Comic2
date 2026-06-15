import React from 'react';
import {
  Sparkles,
  Loader2,
  Check,
  AlertTriangle,
  Circle,
  Globe,
  FileText,
  Newspaper,
  CloudSun,
  LineChart,
  MapPin,
  Navigation,
  Film,
  Coins,
  Code2,
  LayoutGrid,
  Network,
  Wrench
} from 'lucide-react';
import type { AgentActivityArtifact, AgentActivityStatus, AgentActivityStep } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, useCompact } from './kit';

// Status → leading icon for a step row.
const statusIcon = (status: AgentActivityStatus) => {
  switch (status) {
    case 'running':
      return <Loader2 className="w-3.5 h-3.5 text-[#D97757] animate-spin" />;
    case 'done':
      return <Check className="w-3.5 h-3.5 text-emerald-600" />;
    case 'error':
      return <AlertTriangle className="w-3.5 h-3.5 text-red-500" />;
    default:
      return <Circle className="w-3.5 h-3.5 text-[var(--ds-faint)]" />;
  }
};

// Human-friendly labels for the tools the default agent loop can run. Anything not
// listed falls back to a title-cased version of the raw tool name, so new tools (and
// MCP tools like `mcp_*`) still read cleanly without a registry edit here.
const TOOL_LABELS: Record<string, string> = {
  web_search: 'Searching the web',
  search: 'Searching the web',
  read_url: 'Reading the page',
  fetch_url: 'Fetching the page',
  get_news: 'Gathering news',
  news_search: 'Gathering news',
  get_weather: 'Checking the weather',
  get_stock: 'Pulling market data',
  compare_stocks: 'Comparing stocks',
  crypto_price: 'Checking crypto',
  exchange_rate: 'Converting currency',
  convert_currency: 'Converting currency',
  find_places: 'Finding places',
  show_map: 'Building a map',
  get_directions: 'Routing directions',
  video_search: 'Finding videos',
  run_python: 'Running code',
  render_chart: 'Drawing a chart',
  render_ui: 'Composing a layout',
  render_react: 'Building a component',
  run_agent_swarm: 'Coordinating agents'
};

// Per-tool icon (falls back to a generic wrench). Purely decorative.
const TOOL_ICON: Record<string, React.ReactNode> = {
  web_search: <Globe className="w-3.5 h-3.5" />,
  search: <Globe className="w-3.5 h-3.5" />,
  read_url: <FileText className="w-3.5 h-3.5" />,
  fetch_url: <FileText className="w-3.5 h-3.5" />,
  get_news: <Newspaper className="w-3.5 h-3.5" />,
  news_search: <Newspaper className="w-3.5 h-3.5" />,
  get_weather: <CloudSun className="w-3.5 h-3.5" />,
  get_stock: <LineChart className="w-3.5 h-3.5" />,
  compare_stocks: <LineChart className="w-3.5 h-3.5" />,
  crypto_price: <Coins className="w-3.5 h-3.5" />,
  exchange_rate: <Coins className="w-3.5 h-3.5" />,
  convert_currency: <Coins className="w-3.5 h-3.5" />,
  find_places: <MapPin className="w-3.5 h-3.5" />,
  show_map: <MapPin className="w-3.5 h-3.5" />,
  get_directions: <Navigation className="w-3.5 h-3.5" />,
  video_search: <Film className="w-3.5 h-3.5" />,
  run_python: <Code2 className="w-3.5 h-3.5" />,
  render_chart: <LineChart className="w-3.5 h-3.5" />,
  render_ui: <LayoutGrid className="w-3.5 h-3.5" />,
  render_react: <Code2 className="w-3.5 h-3.5" />,
  run_agent_swarm: <Network className="w-3.5 h-3.5" />
};

const labelFor = (tool: string): string =>
  TOOL_LABELS[tool] || tool.replace(/^mcp_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const iconFor = (tool: string): React.ReactNode => TOOL_ICON[tool] || <Wrench className="w-3.5 h-3.5" />;

// Live trace of the DEFAULT chat agent's tool loop: each tool the agent runs to answer
// (search → read → fetch → synthesize), streamed step-by-step so the user watches it
// work during the long pre-answer window instead of staring at a bare spinner.
//
// TWO VERSIONS: compact (a row of status dots + done/total) and detailed (the labelled
// step list with the query and a short result summary), via the WidgetFrame density
// context — same pattern as SwarmTraceCard.
export const AgentActivityCard: React.FC<{ data: AgentActivityArtifact }> = ({ data }) => {
  const compact = useCompact();
  const steps = data?.steps || [];
  if (!steps.length) return null;
  const settled = steps.filter((s) => s.status === 'done' || s.status === 'error').length;
  const working = !data.done && steps.some((s) => s.status === 'running');

  const header = (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0 rounded-lg bg-[var(--ds-well-strong)] p-1.5 text-[#D97757]">
        <Sparkles className="w-4 h-4" />
      </span>
      <div className="min-w-0">
        <SurfaceTitle>{working ? 'Working…' : 'Agent activity'}</SurfaceTitle>
        <SurfaceSubtitle>
          {working
            ? `Running tools to answer · ${settled}/${steps.length} done`
            : `${steps.length} tool${steps.length === 1 ? '' : 's'} run to answer`}
        </SurfaceSubtitle>
      </div>
    </div>
  );

  // ── Compact: one tight row — status icon, label, and a done/total count. Small and
  // calm (the chunky header/dots are gone); the labelled step list lives in the expanded
  // view. While working it currently shows the latest running tool for a little context.
  if (compact) {
    const current = working ? steps.find((s) => s.status === 'running') : undefined;
    return (
      <Surface accent="#D97757">
        <div className="flex items-center gap-2 px-3 py-2">
          {working ? (
            <Loader2 className="w-3.5 h-3.5 shrink-0 text-[#D97757] animate-spin" />
          ) : (
            <Sparkles className="w-3.5 h-3.5 shrink-0 text-[#D97757]" />
          )}
          <span className="shrink-0 text-[12px] font-semibold text-[var(--ds-ink)]">{working ? 'Working…' : 'Agent activity'}</span>
          {current && <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--ds-muted)]">{labelFor(current.tool)}</span>}
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[var(--ds-muted)]">
            {working ? `${settled}/${steps.length}` : `${steps.length} tool${steps.length === 1 ? '' : 's'}`}
          </span>
        </div>
      </Surface>
    );
  }

  return (
    <Surface
      accent="#D97757"
      header={header}
      right={
        <span className="text-[11px] text-[var(--ds-muted)] tabular-nums">
          {working ? `${settled}/${steps.length} done` : `${steps.length} step${steps.length === 1 ? '' : 's'}`}
        </span>
      }
    >
      <ul className="divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
        {steps.map((s: AgentActivityStep, i) => (
          <li key={(s.id || s.tool) + i} className="flex items-start gap-2 px-3 py-2">
            <span className="mt-0.5 shrink-0">{statusIcon(s.status)}</span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="shrink-0 text-[var(--ds-muted)]">{iconFor(s.tool)}</span>
                <span className="text-[12px] font-semibold text-[var(--ds-ink)]">{labelFor(s.tool)}</span>
              </span>
              {s.query && <span className="block truncate text-[11px] text-[var(--ds-muted)]">{s.query}</span>}
              {s.status !== 'running' && s.summary && (
                <span className="block truncate text-[11px] text-[var(--ds-faint)]">{s.summary}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Surface>
  );
};
