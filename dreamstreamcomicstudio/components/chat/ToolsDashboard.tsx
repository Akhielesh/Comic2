import React, { useEffect, useMemo, useState } from 'react';
import {
  Search, Newspaper, CloudSun, LineChart, MapPin, BookOpen, Type, Globe, Rocket,
  UtensilsCrossed, Gamepad2, Code2, Network, Wrench, Server, ExternalLink, Activity,
  KeyRound, Unlock, Zap, RotateCcw, Boxes, CheckCircle2, Plug
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  TOOL_CATALOG, CATEGORY_META, type ToolMeta, type ToolCategory, type ToolKind, type ToolAuth
} from '../../toolCatalog';
import {
  getToolStats, summarizeToolStats, resetToolStats, onToolAnalyticsChanged,
  type ToolStats, type ToolStat
} from '../../services/toolAnalytics';
import { listMcpServers, onMcpServersChanged, addMcpServer } from '../../services/mcpServers';
import type { McpServerConfig } from '../../apiTypes';

// Curated MCP marketplace — a few vetted, keyless https servers a user can connect in one
// click (mirrors server/src/ai/tools/mcpCatalog.ts). Connecting adds the server to the
// local MCP store, which already flows into the agent's tool loop.
const MCP_MARKETPLACE: { id: string; name: string; url: string; blurb: string }[] = [
  { id: 'deepwiki', name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', blurb: 'Ask questions about any public GitHub repo — docs, architecture, code.' },
  { id: 'context7', name: 'Context7', url: 'https://mcp.context7.com/mcp', blurb: 'Up-to-date docs + code examples for thousands of libraries.' },
  { id: 'huggingface', name: 'Hugging Face', url: 'https://huggingface.co/mcp', blurb: 'Search models, datasets and Spaces on the Hugging Face Hub.' }
];

const CAT_ICONS: Record<string, LucideIcon> = {
  Search, Newspaper, CloudSun, LineChart, MapPin, BookOpen, Type, Globe, Rocket,
  UtensilsCrossed, Gamepad2, Code2, Network
};

// --- small presentational helpers ----------------------------------------------
const KindBadge: React.FC<{ kind: ToolKind }> = ({ kind }) => {
  const map: Record<ToolKind, { label: string; cls: string }> = {
    api: { label: 'API', cls: 'border-sky-400 text-sky-700 bg-sky-50' },
    mcp: { label: 'MCP', cls: 'border-violet-400 text-violet-700 bg-violet-50' },
    builtin: { label: 'BUILT-IN', cls: 'border-slate-400 text-slate-600 bg-slate-50' }
  };
  const m = map[kind];
  return <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${m.cls}`}>{m.label}</span>;
};

const AuthBadge: React.FC<{ auth: ToolAuth; env?: string }> = ({ auth, env }) => {
  if (auth === 'none')
    return (
      <span className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded border border-emerald-300 text-emerald-700 bg-emerald-50">
        <Unlock className="w-2.5 h-2.5" /> KEYLESS
      </span>
    );
  if (auth === 'optional')
    return (
      <span
        title={env ? `Runs keyless; set ${env} to raise limits` : undefined}
        className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded border border-amber-300 text-amber-700 bg-amber-50"
      >
        <KeyRound className="w-2.5 h-2.5" /> KEY OPTIONAL
      </span>
    );
  return (
    <span
      title={env ? `Requires ${env}` : undefined}
      className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded border border-rose-300 text-rose-700 bg-rose-50"
    >
      <KeyRound className="w-2.5 h-2.5" /> KEY REQUIRED
    </span>
  );
};

const relativeTime = (ts: number): string => {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

const StatCard: React.FC<{ icon: LucideIcon; label: string; value: string; sub?: string; accent?: string }> = ({
  icon: Icon, label, value, sub, accent = 'text-brand-blue'
}) => (
  <div className="border-2 border-black rounded-lg bg-white px-3 py-2 flex items-center gap-2.5">
    <Icon className={`w-5 h-5 ${accent} shrink-0`} />
    <div className="min-w-0">
      <div className="text-lg font-display leading-none">{value}</div>
      <div className="text-[10px] font-bold uppercase text-slate-500 leading-tight">{label}</div>
      {sub && <div className="text-[10px] text-slate-400 truncate">{sub}</div>}
    </div>
  </div>
);

const ToolRow: React.FC<{ tool: ToolMeta; stat?: ToolStat }> = ({ tool, stat }) => {
  const successRate = stat && stat.calls ? Math.round((stat.ok / stat.calls) * 100) : null;
  return (
    <div className="border-2 border-black rounded-lg bg-white p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-bold text-sm">{tool.label}</span>
            <KindBadge kind={tool.kind} />
            <AuthBadge auth={tool.auth} env={tool.authEnv} />
            <code className="text-[9px] text-slate-400">{tool.name}</code>
          </div>
          <div className="text-[11px] text-slate-600 mt-0.5">{tool.description}</div>
        </div>
        <a
          href={tool.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-slate-400 hover:text-black"
          title={`${tool.provider} — open docs`}
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1 mt-2 text-[10px]">
        <div><span className="font-bold text-slate-500">Provider:</span> {tool.provider}</div>
        <div><span className="font-bold text-slate-500">Limit:</span> {tool.rateLimit}</div>
        <div className="truncate" title={tool.dataShape}><span className="font-bold text-slate-500">Returns:</span> {tool.dataShape}</div>
      </div>

      {/* Usage analytics (real, from this device). */}
      <div className="flex items-center gap-3 mt-2 pt-2 border-t border-slate-100 text-[10px]">
        <span className="inline-flex items-center gap-1 font-bold text-slate-600">
          <Activity className="w-3 h-3" /> {stat?.calls || 0} call{(stat?.calls || 0) === 1 ? '' : 's'}
        </span>
        {successRate != null && (
          <span className={successRate >= 80 ? 'text-emerald-700' : successRate >= 50 ? 'text-amber-700' : 'text-rose-700'}>
            {successRate}% ok
          </span>
        )}
        <span className="text-slate-400">last: {relativeTime(stat?.lastUsedAt || 0)}</span>
        {stat?.recentQueries?.length ? (
          <span className="text-slate-400 truncate" title={stat.recentQueries.join(' · ')}>
            “{stat.recentQueries[0]}”
          </span>
        ) : null}
      </div>
    </div>
  );
};

export const ToolsDashboard: React.FC = () => {
  const [stats, setStats] = useState<ToolStats>(() => getToolStats());
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>(() => listMcpServers());
  const [query, setQuery] = useState('');
  const [activeCat, setActiveCat] = useState<ToolCategory | 'all'>('all');

  useEffect(() => onToolAnalyticsChanged(() => setStats(getToolStats())), []);
  useEffect(() => onMcpServersChanged(() => setMcpServers(listMcpServers())), []);

  const summary = useMemo(() => summarizeToolStats(stats), [stats]);
  const counts = useMemo(() => {
    const api = TOOL_CATALOG.filter((t) => t.kind === 'api').length;
    const builtin = TOOL_CATALOG.filter((t) => t.kind === 'builtin').length;
    const keyless = TOOL_CATALOG.filter((t) => t.auth === 'none').length;
    return { api, builtin, keyless, total: TOOL_CATALOG.length };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return TOOL_CATALOG.filter((t) => {
      if (activeCat !== 'all' && t.category !== activeCat) return false;
      if (!q) return true;
      return (
        t.label.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.provider.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.keywords.some((k) => k.includes(q))
      );
    });
  }, [query, activeCat]);

  const grouped = useMemo(() => {
    const map = new Map<ToolCategory, ToolMeta[]>();
    for (const t of filtered) {
      const arr = map.get(t.category) || [];
      arr.push(t);
      map.set(t.category, arr);
    }
    return CATEGORY_META.filter((c) => map.has(c.id)).map((c) => ({ cat: c, tools: map.get(c.id)! }));
  }, [filtered]);

  return (
    <div className="space-y-4">
      {/* Summary band */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatCard icon={Boxes} label="Live tools" value={String(counts.total)} sub={`${counts.api} API · ${counts.builtin} built-in`} />
        <StatCard icon={Unlock} label="Keyless" value={String(counts.keyless)} sub={`of ${counts.total} run with no key`} accent="text-emerald-600" />
        <StatCard icon={Activity} label="Total calls" value={summary.totalCalls.toLocaleString()} sub={`${summary.distinctToolsUsed} tools used`} accent="text-fuchsia-600" />
        <StatCard
          icon={CheckCircle2}
          label="Success rate"
          value={summary.totalCalls ? `${Math.round(summary.successRate * 100)}%` : '—'}
          sub={summary.totalCalls ? `${summary.totalOk}/${summary.totalCalls} ok` : 'no calls yet'}
          accent="text-emerald-600"
        />
      </div>

      <p className="text-[11px] text-slate-500 flex items-start gap-1.5">
        <Zap className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
        These are <span className="font-bold">automatic backend tools</span> — the AI always has them and picks the right
        ones for each message (it <span className="font-bold">smart-routes</span> by relevance instead of calling everything).
        You don’t need to enable anything; this view is just for transparency. Usage analytics below are recorded locally on this device.
      </p>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tools, providers, capabilities…"
            className="w-full border-2 border-black rounded-lg pl-8 pr-3 py-1.5 text-sm outline-none focus:shadow-comic-hover"
          />
        </div>
        {summary.totalCalls > 0 && (
          <button
            onClick={() => { if (confirm('Reset local tool usage analytics?')) resetToolStats(); }}
            className="flex items-center gap-1 text-[11px] font-bold border-2 border-black rounded-lg px-2.5 py-1.5 bg-white hover:bg-slate-100"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Reset stats
          </button>
        )}
      </div>

      {/* Category filter chips */}
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => setActiveCat('all')}
          className={`text-[11px] font-bold px-2.5 py-1 rounded-full border-2 ${activeCat === 'all' ? 'border-black bg-brand-yellow' : 'border-slate-300 bg-white hover:border-black'}`}
        >
          All ({TOOL_CATALOG.length})
        </button>
        {CATEGORY_META.map((c) => {
          const Icon = CAT_ICONS[c.icon] || Wrench;
          const n = TOOL_CATALOG.filter((t) => t.category === c.id).length;
          return (
            <button
              key={c.id}
              onClick={() => setActiveCat(c.id)}
              className={`flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-full border-2 ${activeCat === c.id ? 'border-black bg-brand-yellow' : 'border-slate-300 bg-white hover:border-black'}`}
            >
              <Icon className="w-3.5 h-3.5" /> {c.label} ({n})
            </button>
          );
        })}
      </div>

      {/* Grouped tool list */}
      <div className="space-y-4">
        {grouped.map(({ cat, tools }) => {
          const Icon = CAT_ICONS[cat.icon] || Wrench;
          return (
            <div key={cat.id}>
              <div className="flex items-center gap-1.5 mb-1.5">
                <Icon className="w-4 h-4 text-brand-blue" />
                <span className="font-bold text-sm">{cat.label}</span>
                <span className="text-[10px] text-slate-400">{cat.blurb}</span>
              </div>
              <div className="grid sm:grid-cols-2 gap-2">
                {tools.map((t) => <ToolRow key={t.name} tool={t} stat={stats[t.name]} />)}
              </div>
            </div>
          );
        })}
        {grouped.length === 0 && (
          <div className="text-sm text-slate-400 text-center py-8 border-2 border-dashed border-slate-200 rounded-lg">
            No tools match “{query}”.
          </div>
        )}
      </div>

      {/* Curated MCP marketplace — one-click connect (Phase 10) */}
      <div>
        <div className="flex items-center gap-1.5 mb-1.5">
          <Boxes className="w-4 h-4 text-violet-600" />
          <span className="font-bold text-sm">MCP marketplace</span>
          <span className="text-[10px] text-slate-400">Vetted servers — connect one in a click to expose its tools to the AI</span>
        </div>
        <div className="grid sm:grid-cols-2 gap-2">
          {MCP_MARKETPLACE.map((m) => {
            const connected = mcpServers.some((s) => s.url === m.url);
            return (
              <div key={m.id} className="border-2 border-black rounded-lg bg-white p-2.5 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <Server className="w-4 h-4 text-violet-600 shrink-0" />
                    <span className="font-bold text-sm truncate">{m.name}</span>
                    <KindBadge kind="mcp" />
                    <AuthBadge auth="none" />
                  </div>
                  <div className="text-[11px] text-slate-600 mt-0.5">{m.blurb}</div>
                  <div className="text-[10px] text-slate-400 mt-0.5 truncate" title={m.url}>{m.url}</div>
                </div>
                <button
                  disabled={connected}
                  onClick={() => addMcpServer({ name: m.name, url: m.url })}
                  className={`shrink-0 inline-flex items-center gap-1 text-[11px] font-bold border-2 border-black rounded-lg px-2 py-1 ${
                    connected ? 'bg-emerald-50 text-emerald-700 cursor-default' : 'bg-brand-yellow hover:shadow-comic-hover'
                  }`}
                >
                  {connected ? <><CheckCircle2 className="w-3.5 h-3.5" /> Connected</> : <><Plug className="w-3.5 h-3.5" /> Connect</>}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Custom MCP servers */}
      <div>
        <div className="flex items-center gap-1.5 mb-1.5">
          <Plug className="w-4 h-4 text-violet-600" />
          <span className="font-bold text-sm">Custom MCP servers</span>
          <span className="text-[10px] text-slate-400">Model Context Protocol endpoints you’ve connected</span>
        </div>
        {mcpServers.length === 0 ? (
          <div className="text-[11px] text-slate-400 border-2 border-dashed border-slate-200 rounded-lg px-3 py-3">
            None connected. Add an MCP server from the chat toolbar to expose its tools to the agent — they’ll be tagged
            <span className="inline-flex items-center mx-1"><KindBadge kind="mcp" /></span> and routed like any other tool.
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-2">
            {mcpServers.map((s) => (
              <div key={s.id} className="border-2 border-black rounded-lg bg-white p-2.5">
                <div className="flex items-center gap-1.5">
                  <Server className="w-4 h-4 text-violet-600" />
                  <span className="font-bold text-sm truncate">{s.name}</span>
                  <KindBadge kind="mcp" />
                  {s.headers?.Authorization && <AuthBadge auth="required" />}
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5 truncate" title={s.url}>{s.url}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
