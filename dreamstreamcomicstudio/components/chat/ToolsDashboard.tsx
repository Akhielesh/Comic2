import React, { useEffect, useMemo, useState } from 'react';
import {
  Search, Newspaper, CloudSun, LineChart, MapPin, BookOpen, Type, Globe, Rocket,
  UtensilsCrossed, Gamepad2, Code2, Network, Wrench, Server, ExternalLink, Activity,
  KeyRound, Unlock, Zap, RotateCcw, Boxes, CheckCircle2, Plug, Plane, Target, ShieldCheck
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  TOOL_CATALOG, CATEGORY_META, LICENSE_META, CONNECTOR_KEYS,
  type ToolMeta, type ToolCategory, type ToolKind, type ToolAuth, type ToolLicense
} from '../../toolCatalog';
import {
  getToolStats, summarizeToolStats, resetToolStats, onToolAnalyticsChanged,
  type ToolStats, type ToolStat
} from '../../services/toolAnalytics';
import { listMcpServers, onMcpServersChanged, addMcpServer } from '../../services/mcpServers';
import type { McpServerConfig } from '../../apiTypes';

// Curated MCP marketplace — vetted, keyless https servers a user can connect in one
// click (mirrors server/src/ai/tools/mcpCatalog.ts — keep the two lists in sync).
// Connecting adds the server to the local MCP store, which already flows into the
// agent's tool loop.
type McpMarketCategory = 'docs' | 'dev' | 'data' | 'travel';
interface McpMarketEntry {
  id: string;
  name: string;
  url: string;
  blurb: string;
  category: McpMarketCategory;
}
const MCP_MARKETPLACE: McpMarketEntry[] = [
  { id: 'deepwiki', name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', blurb: 'Ask questions about any public GitHub repo — docs, architecture, code.', category: 'docs' },
  { id: 'context7', name: 'Context7', url: 'https://mcp.context7.com/mcp', blurb: 'Up-to-date docs + code examples for thousands of libraries.', category: 'docs' },
  { id: 'microsoft-learn', name: 'Microsoft Learn', url: 'https://learn.microsoft.com/api/mcp', blurb: 'Q&A over official Microsoft and Azure documentation.', category: 'docs' },
  { id: 'cloudflare-docs', name: 'Cloudflare Docs', url: 'https://docs.mcp.cloudflare.com/sse', blurb: 'Cloudflare platform docs — Workers, R2, DNS and more.', category: 'docs' },
  { id: 'astro-docs', name: 'Astro Docs', url: 'https://mcp.docs.astro.build/mcp', blurb: 'Official documentation for the Astro web framework.', category: 'docs' },
  { id: 'aws-knowledge', name: 'AWS Knowledge', url: 'https://knowledge-mcp.global.api.aws', blurb: 'AWS documentation, API references and guidance.', category: 'docs' },
  { id: 'gitmcp', name: 'GitMCP', url: 'https://gitmcp.io/docs', blurb: "Explore any public GitHub repository's docs and code.", category: 'dev' },
  { id: 'semgrep', name: 'Semgrep', url: 'https://mcp.semgrep.ai/sse', blurb: 'Static code analysis — scan code for bugs and security issues.', category: 'dev' },
  { id: 'huggingface', name: 'Hugging Face', url: 'https://huggingface.co/mcp', blurb: 'Search models, datasets and Spaces on the Hugging Face Hub.', category: 'data' },
  { id: 'manifold-markets', name: 'Manifold Markets', url: 'https://api.manifold.markets/v0/mcp', blurb: 'Prediction market data — live forecast probabilities.', category: 'data' },
  { id: 'livescore', name: 'LiveScore', url: 'https://livescoremcp.com/sse', blurb: 'Live sports scores, fixtures and league standings.', category: 'data' },
  { id: 'ferryhopper', name: 'Ferryhopper', url: 'https://mcp.ferryhopper.com/mcp', blurb: 'Ferry routes, schedules and booking information.', category: 'travel' },
  { id: 'subwayinfo-nyc', name: 'SubwayInfo NYC', url: 'https://subwayinfo.nyc/mcp', blurb: 'NYC subway and transit status — lines, delays, alerts.', category: 'travel' }
];
const MCP_CATEGORY_ORDER: McpMarketCategory[] = ['docs', 'dev', 'data', 'travel'];
const MCP_CATEGORY_LABELS: Record<McpMarketCategory, string> = {
  docs: 'Docs & reference',
  dev: 'Developer',
  data: 'Data',
  travel: 'Travel & transit'
};

const CAT_ICONS: Record<string, LucideIcon> = {
  Search, Newspaper, CloudSun, LineChart, MapPin, BookOpen, Type, Globe, Rocket,
  UtensilsCrossed, Gamepad2, Code2, Network, Plane, Target
};

// --- small presentational helpers ----------------------------------------------
const KindBadge: React.FC<{ kind: ToolKind }> = ({ kind }) => {
  const map: Record<ToolKind, { label: string; cls: string }> = {
    api: { label: 'API', cls: 'border-sky-500/20 text-sky-700 bg-sky-50' },
    mcp: { label: 'MCP', cls: 'border-violet-500/20 text-violet-700 bg-violet-50' },
    builtin: { label: 'BUILT-IN', cls: 'border-[var(--ds-hairline)] text-[var(--ds-muted)] bg-[var(--ds-well)]' }
  };
  const m = map[kind];
  return <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-md border ${m.cls}`}>{m.label}</span>;
};

const AuthBadge: React.FC<{ auth: ToolAuth; env?: string }> = ({ auth, env }) => {
  if (auth === 'none')
    return (
      <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold px-1.5 py-0.5 rounded-md border border-emerald-500/20 text-emerald-700 bg-emerald-50">
        <Unlock className="w-2.5 h-2.5" /> KEYLESS
      </span>
    );
  if (auth === 'optional')
    return (
      <span
        title={env ? `Runs keyless; set ${env} to raise limits` : undefined}
        className="inline-flex items-center gap-0.5 text-[9px] font-semibold px-1.5 py-0.5 rounded-md border border-amber-500/20 text-amber-700 bg-amber-50"
      >
        <KeyRound className="w-2.5 h-2.5" /> KEY OPTIONAL
      </span>
    );
  return (
    <span
      title={env ? `Requires ${env}` : undefined}
      className="inline-flex items-center gap-0.5 text-[9px] font-semibold px-1.5 py-0.5 rounded-md border border-rose-500/20 text-rose-700 bg-rose-50"
    >
      <KeyRound className="w-2.5 h-2.5" /> KEY REQUIRED
    </span>
  );
};

// Commercial-use posture of the tool's primary data source (from the June 2026
// connector audit) — surfaced so "free tier" is never confused with "free for
// commercial use".
const LicenseBadge: React.FC<{ license: ToolLicense }> = ({ license }) => {
  const cls: Record<ToolLicense, string> = {
    'commercial-ok': 'border-emerald-500/20 text-emerald-700 bg-emerald-50',
    attribution: 'border-sky-500/20 text-sky-700 bg-sky-50',
    conditional: 'border-amber-500/20 text-amber-700 bg-amber-50',
    unofficial: 'border-rose-500/20 text-rose-700 bg-rose-50'
  };
  const m = LICENSE_META[license];
  return (
    <span title={m.blurb} className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-md border ${cls[license]}`}>
      {m.label}
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

/** Section label in the calm-studio voice. */
const SectionLabel: React.FC<{ icon?: LucideIcon; children: React.ReactNode; blurb?: string }> = ({ icon: Icon, children, blurb }) => (
  <div className="flex items-center gap-1.5 mb-1.5">
    {Icon && <Icon className="w-3.5 h-3.5 text-[var(--ds-muted)]" />}
    <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">{children}</span>
    {blurb && <span className="text-[10px] text-[var(--ds-muted)]">{blurb}</span>}
  </div>
);

const StatCard: React.FC<{ icon: LucideIcon; label: string; value: string; sub?: string; accent?: string }> = ({
  icon: Icon, label, value, sub, accent = 'text-[var(--ds-muted)]'
}) => (
  <div className="rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] shadow-[0_1px_2px_rgba(0,0,0,0.04)] px-3 py-2 flex items-center gap-2.5">
    <Icon className={`w-5 h-5 ${accent} shrink-0`} />
    <div className="min-w-0">
      <div className="text-lg font-semibold tracking-tight leading-none text-[var(--ds-ink)] tabular-nums">{value}</div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)] leading-tight">{label}</div>
      {sub && <div className="text-[10px] text-[var(--ds-muted)] truncate">{sub}</div>}
    </div>
  </div>
);

const ToolRow: React.FC<{ tool: ToolMeta; stat?: ToolStat }> = ({ tool, stat }) => {
  const successRate = stat && stat.calls ? Math.round((stat.ok / stat.calls) * 100) : null;
  return (
    <div className="rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-raised)] p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-semibold text-sm text-[var(--ds-ink)]">{tool.label}</span>
            <KindBadge kind={tool.kind} />
            <AuthBadge auth={tool.auth} env={tool.authEnv} />
            {tool.license && <LicenseBadge license={tool.license} />}
            <code className="text-[9px] text-[var(--ds-muted)]">{tool.name}</code>
          </div>
          <div className="text-[11px] text-[var(--ds-muted)] mt-0.5">{tool.description}</div>
          {tool.licenseNote && (
            <div className="flex items-start gap-1 text-[10px] text-[var(--ds-muted)] mt-1">
              <ShieldCheck className="w-3 h-3 shrink-0 mt-px" />
              <span>{tool.licenseNote}</span>
            </div>
          )}
        </div>
        <a
          href={tool.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-[var(--ds-muted)] opacity-80 hover:text-[var(--ds-ink)] transition-colors duration-200"
          title={`${tool.provider} — open docs`}
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1 mt-2 text-[10px] text-[var(--ds-ink)]">
        <div><span className="font-semibold text-[var(--ds-muted)]">Provider:</span> {tool.provider}</div>
        <div><span className="font-semibold text-[var(--ds-muted)]">Limit:</span> {tool.rateLimit}</div>
        <div className="truncate" title={tool.dataShape}><span className="font-semibold text-[var(--ds-muted)]">Returns:</span> {tool.dataShape}</div>
      </div>

      {/* Usage analytics (real, from this device). */}
      <div className="flex items-center gap-3 mt-2 pt-2 border-t border-[var(--ds-hairline-soft)] text-[10px]">
        <span className="inline-flex items-center gap-1 font-semibold text-[var(--ds-muted)]">
          <Activity className="w-3 h-3" /> {stat?.calls || 0} call{(stat?.calls || 0) === 1 ? '' : 's'}
        </span>
        {successRate != null && (
          <span className={successRate >= 80 ? 'text-emerald-700' : successRate >= 50 ? 'text-amber-700' : 'text-rose-700'}>
            {successRate}% ok
          </span>
        )}
        <span className="text-[var(--ds-muted)]">last: {relativeTime(stat?.lastUsedAt || 0)}</span>
        {stat?.recentQueries?.length ? (
          <span className="text-[var(--ds-muted)] truncate" title={stat.recentQueries.join(' · ')}>
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

  const marketplaceGroups = useMemo(
    () =>
      MCP_CATEGORY_ORDER.map((cat) => ({
        cat,
        entries: MCP_MARKETPLACE.filter((m) => m.category === cat)
      })).filter((g) => g.entries.length > 0),
    []
  );

  return (
    <div className="space-y-4">
      {/* Summary band */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatCard icon={Boxes} label="Live tools" value={String(counts.total)} sub={`${counts.api} API · ${counts.builtin} built-in`} />
        <StatCard icon={Unlock} label="Keyless" value={String(counts.keyless)} sub={`of ${counts.total} run with no key`} accent="text-emerald-600" />
        <StatCard icon={Activity} label="Total calls" value={summary.totalCalls.toLocaleString()} sub={`${summary.distinctToolsUsed} tools used`} accent="text-[var(--ds-accent)]" />
        <StatCard
          icon={CheckCircle2}
          label="Success rate"
          value={summary.totalCalls ? `${Math.round(summary.successRate * 100)}%` : '—'}
          sub={summary.totalCalls ? `${summary.totalOk}/${summary.totalCalls} ok` : 'no calls yet'}
          accent="text-emerald-600"
        />
      </div>

      <p className="text-[11px] text-[var(--ds-muted)] flex items-start gap-1.5">
        <Zap className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
        These are <span className="font-semibold text-[var(--ds-ink)]">automatic backend tools</span> — the AI always has them and picks the right
        ones for each message (it <span className="font-semibold text-[var(--ds-ink)]">smart-routes</span> by relevance instead of calling everything).
        You don’t need to enable anything; this view is just for transparency. Usage analytics below are recorded locally on this device.
      </p>

      {/* Connector upgrades — the audited "set these keys" checklist. Informational:
          the env vars live on the server (Railway), not in the browser. */}
      <div className="rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] p-3 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_var(--ds-hairline)]">
        <div className="flex items-center gap-1.5 mb-1">
          <ShieldCheck className="w-4 h-4 text-emerald-600" />
          <span className="font-semibold text-sm text-[var(--ds-ink)]">Connector upgrades</span>
          <span className="text-[10px] text-[var(--ds-muted)]">
            Free keys that raise reliability and keep commercial use compliant — set them in the server environment
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {(Object.keys(LICENSE_META) as ToolLicense[]).map((l) => (
            <span key={l} className="inline-flex items-center gap-1 text-[10px] text-[var(--ds-muted)]">
              <LicenseBadge license={l} /> {LICENSE_META[l].blurb}
            </span>
          ))}
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {CONNECTOR_KEYS.map((k) => (
            <div key={k.env} className="rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-raised)] p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <KeyRound className="w-3.5 h-3.5 text-[var(--ds-muted)] shrink-0" />
                  <span className="font-semibold text-sm text-[var(--ds-ink)] truncate">{k.provider}</span>
                </div>
                <a
                  href={k.signupUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-[var(--ds-muted)] opacity-80 hover:text-[var(--ds-ink)] transition-colors duration-200"
                  title={`${k.provider} — get a key`}
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
              <code className="text-[9px] text-[var(--ds-muted)]">{k.env}</code>
              <div className="text-[11px] text-[var(--ds-ink)] mt-1">{k.unlocks}</div>
              <div className="text-[10px] text-[var(--ds-muted)] mt-1">{k.cost}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="w-4 h-4 text-[var(--ds-muted)] opacity-80 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tools, providers, capabilities…"
            className="w-full rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] pl-8 pr-3 py-1.5 text-sm text-[var(--ds-ink)] outline-none transition-colors duration-200 focus:border-[var(--ds-accent)] focus:bg-[var(--ds-raised)]"
          />
        </div>
        {summary.totalCalls > 0 && (
          <button
            onClick={() => { if (confirm('Reset local tool usage analytics?')) resetToolStats(); }}
            className="flex items-center gap-1 text-[11px] font-semibold text-[var(--ds-ink)] rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2.5 py-1.5 transition-colors duration-200 hover:bg-[var(--ds-hover)]"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Reset stats
          </button>
        )}
      </div>

      {/* Category filter chips */}
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => setActiveCat('all')}
          className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-colors duration-200 ${
            activeCat === 'all'
              ? 'border-transparent bg-[var(--ds-ink)] text-[var(--ds-canvas)]'
              : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'
          }`}
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
              className={`flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-colors duration-200 ${
                activeCat === c.id
                  ? 'border-transparent bg-[var(--ds-ink)] text-[var(--ds-canvas)]'
                  : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'
              }`}
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
              <SectionLabel icon={Icon} blurb={cat.blurb}>{cat.label}</SectionLabel>
              <div className="grid sm:grid-cols-2 gap-2">
                {tools.map((t) => <ToolRow key={t.name} tool={t} stat={stats[t.name]} />)}
              </div>
            </div>
          );
        })}
        {grouped.length === 0 && (
          <div className="text-sm text-[var(--ds-muted)] text-center py-8 border border-dashed border-[var(--ds-hairline)] rounded-xl bg-[var(--ds-well)]">
            No tools match “{query}”.
          </div>
        )}
      </div>

      {/* Curated MCP marketplace — one-click connect (Phase 10), grouped by category */}
      <div className="rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] p-3 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_var(--ds-hairline)]">
        <div className="flex items-center gap-1.5 mb-2">
          <Boxes className="w-4 h-4 text-violet-600" />
          <span className="font-semibold text-sm text-[var(--ds-ink)]">MCP marketplace</span>
          <span className="text-[10px] text-[var(--ds-muted)]">Vetted free servers — connect one in a click to expose its tools to the AI</span>
        </div>
        <div className="space-y-3">
          {marketplaceGroups.map(({ cat, entries }) => (
            <div key={cat}>
              <SectionLabel>{MCP_CATEGORY_LABELS[cat]}</SectionLabel>
              <div className="grid sm:grid-cols-2 gap-2">
                {entries.map((m) => {
                  const connected = mcpServers.some((s) => s.url === m.url);
                  return (
                    <div key={m.id} className="rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-raised)] p-2.5 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <Server className="w-4 h-4 text-violet-600 shrink-0" />
                          <span className="font-semibold text-sm text-[var(--ds-ink)] truncate">{m.name}</span>
                          <KindBadge kind="mcp" />
                          <AuthBadge auth="none" />
                        </div>
                        <div className="text-[11px] text-[var(--ds-muted)] mt-0.5">{m.blurb}</div>
                        <div className="text-[10px] text-[var(--ds-muted)] mt-0.5 truncate" title={m.url}>{m.url}</div>
                      </div>
                      <button
                        disabled={connected}
                        onClick={() => addMcpServer({ name: m.name, url: m.url })}
                        className={`shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold rounded-lg px-2 py-1 transition-colors duration-200 ${
                          connected
                            ? 'border border-emerald-500/20 bg-emerald-50 text-emerald-700 cursor-default'
                            : 'bg-[var(--ds-accent)] hover:bg-[var(--ds-accent-hover)] text-white'
                        }`}
                      >
                        {connected ? <><CheckCircle2 className="w-3.5 h-3.5" /> Connected</> : <><Plug className="w-3.5 h-3.5" /> Connect</>}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Custom MCP servers */}
      <div>
        <SectionLabel icon={Plug} blurb="Model Context Protocol endpoints you’ve connected">Custom MCP servers</SectionLabel>
        {mcpServers.length === 0 ? (
          <div className="text-[11px] text-[var(--ds-muted)] border border-dashed border-[var(--ds-hairline)] rounded-xl bg-[var(--ds-well)] px-3 py-3">
            None connected. Add an MCP server from the chat toolbar to expose its tools to the agent — they’ll be tagged
            <span className="inline-flex items-center mx-1"><KindBadge kind="mcp" /></span> and routed like any other tool.
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-2">
            {mcpServers.map((s) => (
              <div key={s.id} className="rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-raised)] p-2.5">
                <div className="flex items-center gap-1.5">
                  <Server className="w-4 h-4 text-violet-600" />
                  <span className="font-semibold text-sm text-[var(--ds-ink)] truncate">{s.name}</span>
                  <KindBadge kind="mcp" />
                  {s.headers?.Authorization && <AuthBadge auth="required" />}
                </div>
                <div className="text-[10px] text-[var(--ds-muted)] mt-0.5 truncate" title={s.url}>{s.url}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
