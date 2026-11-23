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
import { buildApiUrl } from '../../services/clientConfig';
import { useAuth } from '../../contexts/AuthContext';
import { ownerBearer } from '../../services/accountProviderUsage';
import { useIsAdmin } from '../../hooks/useIsAdmin';
import { platformDocsVisible } from '../../services/platformFlags';
import { FOCUS_RING, MUTED, RADIUS_CONTROL, SECTION_CARD, TWO_LINE_TEXT, WRAP_TEXT } from './studioDesign';

// Server-side provider usage row (mirrors server/src/lib/providerUsage.ts snapshot).
interface ProviderUsageRow {
  provider: string;
  todayCalls: number;
  todayErrors: number;
  blockedToday: number;
  lastMinute: number;
  perMin: number;
  perDay: number;
  dayUsedPct: number;
  health: 'ok' | 'hot' | 'failing' | 'near-cap' | 'capped';
}

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
    api: { label: 'API', cls: 'border-[var(--ds-hairline)] text-[var(--ds-ink)] bg-[var(--ds-well)]' },
    mcp: { label: 'MCP', cls: 'border-[var(--ds-hairline)] text-[var(--ds-ink)] bg-[var(--ds-well)]' },
    builtin: { label: 'BUILT-IN', cls: 'border-[var(--ds-hairline)] text-[var(--ds-muted)] bg-[var(--ds-well)]' }
  };
  const m = map[kind];
  return <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-md border ${m.cls}`}>{m.label}</span>;
};

const AuthBadge: React.FC<{ auth: ToolAuth; env?: string }> = ({ auth, env }) => {
  if (auth === 'none')
    return (
      <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold px-1.5 py-0.5 rounded-md border border-[color:color-mix(in_srgb,var(--ds-success)_30%,transparent)] text-[var(--ds-success-text)] bg-[color:color-mix(in_srgb,var(--ds-success)_10%,transparent)]">
        <Unlock className="w-2.5 h-2.5" /> KEYLESS
      </span>
    );
  if (auth === 'optional')
    return (
      <span
        title={env ? `Runs keyless; set ${env} to raise limits` : undefined}
        className="inline-flex items-center gap-0.5 text-[9px] font-semibold px-1.5 py-0.5 rounded-md border border-[color:color-mix(in_srgb,var(--ds-warning)_40%,transparent)] text-[var(--ds-warning-text)] bg-[color:color-mix(in_srgb,var(--ds-warning)_10%,transparent)]"
      >
        <KeyRound className="w-2.5 h-2.5" /> KEY OPTIONAL
      </span>
    );
  return (
    <span
      title={env ? `Requires ${env}` : undefined}
      className="inline-flex items-center gap-0.5 text-[9px] font-semibold px-1.5 py-0.5 rounded-md border border-[color:color-mix(in_srgb,var(--ds-danger-mark)_30%,transparent)] text-[var(--ds-danger-text)] bg-[color:color-mix(in_srgb,var(--ds-danger-mark)_10%,transparent)]"
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
    'commercial-ok': 'border-[color:color-mix(in_srgb,var(--ds-success)_30%,transparent)] text-[var(--ds-success-text)] bg-[color:color-mix(in_srgb,var(--ds-success)_10%,transparent)]',
    attribution: 'border-[color:color-mix(in_srgb,var(--ds-info)_30%,transparent)] text-[var(--ds-info-text)] bg-[color:color-mix(in_srgb,var(--ds-info)_10%,transparent)]',
    conditional: 'border-[color:color-mix(in_srgb,var(--ds-warning)_40%,transparent)] text-[var(--ds-warning-text)] bg-[color:color-mix(in_srgb,var(--ds-warning)_10%,transparent)]',
    unofficial: 'border-[color:color-mix(in_srgb,var(--ds-danger-mark)_30%,transparent)] text-[var(--ds-danger-text)] bg-[color:color-mix(in_srgb,var(--ds-danger-mark)_10%,transparent)]'
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
          <span className={successRate >= 80 ? 'text-[var(--ds-success-text)]' : successRate >= 50 ? 'text-[var(--ds-warning-text)]' : 'text-[var(--ds-danger-text)]'}>
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
  const [snapshot, setSnapshot] = useState<{ owner: string; rows: ProviderUsageRow[] } | null>(null);
  const owner = useAuth().user?.id;
  // Tools behind the shared-platform rollout (email_draft, deck_create) are listed only for a person the
  // rollout admits (VITE_PLATFORM_DOCS exactly 'on' and the stage), the same rule the server routes them by.
  const isAdmin = useIsAdmin();
  const usage = isAdmin && snapshot?.owner === owner ? snapshot?.rows : null;
  const showPlatformDocs = platformDocsVisible(isAdmin);
  const catalog = useMemo(
    () => TOOL_CATALOG.filter((t) => t.rollout !== 'platform-docs' || showPlatformDocs),
    [showPlatformDocs]
  );

  // Platform counters are operator-only. Reads carry the same signed-in account
  // throughout, with no personal provider keys attached.
  useEffect(() => {
    if (!isAdmin || !owner) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const authorization = await ownerBearer(owner, controller.signal);
        const response = await fetch(buildApiUrl('/api/usage/providers'), {
          headers: { Authorization: authorization }, cache: 'no-store', redirect: 'error', signal: controller.signal
        });
        const data = response.ok ? await response.json() : null;
        if (!controller.signal.aborted) setSnapshot(Array.isArray(data?.providers) ? { owner, rows: data.providers } : null);
      } catch { if (!controller.signal.aborted) setSnapshot(null); }
    };
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [isAdmin, owner]);

  useEffect(() => onToolAnalyticsChanged(() => setStats(getToolStats())), []);
  useEffect(() => onMcpServersChanged(() => setMcpServers(listMcpServers())), []);

  const summary = useMemo(() => summarizeToolStats(stats), [stats]);
  const counts = useMemo(() => {
    const api = catalog.filter((t) => t.kind === 'api').length;
    const builtin = catalog.filter((t) => t.kind === 'builtin').length;
    const keyless = catalog.filter((t) => t.auth === 'none').length;
    return { api, builtin, keyless, total: catalog.length };
  }, [catalog]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog.filter((t) => {
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
  }, [catalog, query, activeCat]);

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
        <StatCard icon={Unlock} label="Keyless" value={String(counts.keyless)} sub={`of ${counts.total} run with no key`} accent="text-[var(--ds-success-text)]" />
        <StatCard icon={Activity} label="Total calls" value={summary.totalCalls.toLocaleString()} sub={`${summary.distinctToolsUsed} tools used`} accent="text-[var(--ds-accent)]" />
        <StatCard
          icon={CheckCircle2}
          label="Success rate"
          value={summary.totalCalls ? `${Math.round(summary.successRate * 100)}%` : '—'}
          sub={summary.totalCalls ? `${summary.totalOk}/${summary.totalCalls} ok` : 'no calls yet'}
          accent="text-[var(--ds-success-text)]"
        />
      </div>

      {/* The icon is the only flex child beside one span, so the sentence wraps as one paragraph */}
      <p className={`text-[11px] ${MUTED} flex items-start gap-1.5`}>
        <Zap className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${MUTED}`} aria-hidden="true" />
        <span className={WRAP_TEXT}>
          These are <span className="font-semibold text-[var(--ds-ink)]">automatic backend tools</span> — the AI always has them and picks the right
          ones for each message (it <span className="font-semibold text-[var(--ds-ink)]">smart-routes</span> by relevance instead of calling everything).
          You don’t need to enable anything; this view is just for transparency. Usage analytics below are recorded locally on this device.
        </span>
      </p>

      {/* Connector upgrades — the audited "set these keys" checklist. Informational:
          the env vars live on the server, not in the browser. */}
      <div className={`${SECTION_CARD} p-3`}>
        <div className="mb-2">
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4 shrink-0 text-[var(--ds-success-text)]" aria-hidden="true" />
            <span className="font-semibold text-sm text-[var(--ds-ink)]">Connector upgrades</span>
          </div>
          <p className={`mt-0.5 text-[11px] ${MUTED} ${WRAP_TEXT}`}>
            Free keys that raise reliability and keep commercial use compliant — set them in the server environment
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {(Object.keys(LICENSE_META) as ToolLicense[]).map((l) => (
            <span key={l} className="inline-flex items-center gap-1 text-[10px] text-[var(--ds-muted)]">
              <LicenseBadge license={l} /> {LICENSE_META[l].blurb}
            </span>
          ))}
        </div>
        {/* The grid follows its own width (the settings column), not the viewport */}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2">
          {CONNECTOR_KEYS.map((k) => (
            <div key={k.env} className={`min-w-0 ${RADIUS_CONTROL} border border-[var(--ds-hairline)] bg-[var(--ds-raised)] p-2.5`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-1.5 min-w-0">
                  <KeyRound className="mt-0.5 w-3.5 h-3.5 text-[var(--ds-muted)] shrink-0" aria-hidden="true" />
                  <span className={`font-semibold text-sm text-[var(--ds-ink)] ${TWO_LINE_TEXT}`} title={k.provider}>{k.provider}</span>
                </div>
                <a
                  href={k.signupUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`shrink-0 text-[var(--ds-muted)] opacity-80 hover:text-[var(--ds-ink)] transition-colors duration-[var(--ds-motion-medium)] ${RADIUS_CONTROL} ${FOCUS_RING}`}
                  title={`${k.provider} — get a key`}
                  aria-label={`${k.provider}: get a key`}
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
              <code className={`block text-[9px] text-[var(--ds-muted)] ${WRAP_TEXT}`}>{k.env}</code>
              <div className="text-[11px] text-[var(--ds-ink)] mt-1">{k.unlocks}</div>
              <div className="text-[10px] text-[var(--ds-muted)] mt-1">{k.cost}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Server-side provider usage & budgets — the guardrail view. Counts come from
          the backend meter (every upstream call, all users), unlike the local
          per-device tool analytics below. */}
      {usage && usage.length > 0 && (
        <div className={`${SECTION_CARD} p-3`}>
          <div className="flex items-center gap-1.5 mb-2">
            <Activity className="w-4 h-4 text-[var(--ds-accent)]" />
            <span className="font-semibold text-sm text-[var(--ds-ink)]">Provider usage today (server)</span>
            <span className="text-[10px] text-[var(--ds-muted)]">
              Live counts vs. the free-tier budgets the backend enforces — spikes here mean the agent is over-calling a source
            </span>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {usage.map((u) => {
              const health: Record<ProviderUsageRow['health'], { label: string; cls: string }> = {
                ok: { label: 'OK', cls: 'border-[color:color-mix(in_srgb,var(--ds-success)_30%,transparent)] text-[var(--ds-success-text)] bg-[color:color-mix(in_srgb,var(--ds-success)_10%,transparent)]' },
                hot: { label: 'HOT', cls: 'border-[color:color-mix(in_srgb,var(--ds-warning)_40%,transparent)] text-[var(--ds-warning-text)] bg-[color:color-mix(in_srgb,var(--ds-warning)_10%,transparent)]' },
                'near-cap': { label: 'NEAR CAP', cls: 'border-[color:color-mix(in_srgb,var(--ds-warning)_40%,transparent)] text-[var(--ds-warning-text)] bg-[color:color-mix(in_srgb,var(--ds-warning)_10%,transparent)]' },
                failing: { label: 'FAILING', cls: 'border-[color:color-mix(in_srgb,var(--ds-danger-mark)_30%,transparent)] text-[var(--ds-danger-text)] bg-[color:color-mix(in_srgb,var(--ds-danger-mark)_10%,transparent)]' },
                capped: { label: 'CAPPED', cls: 'border-[color:color-mix(in_srgb,var(--ds-danger-mark)_30%,transparent)] text-[var(--ds-danger-text)] bg-[color:color-mix(in_srgb,var(--ds-danger-mark)_10%,transparent)]' }
              };
              const h = health[u.health];
              return (
                <div key={u.provider} className="rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-raised)] p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-sm text-[var(--ds-ink)] truncate">{u.provider}</span>
                    <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-md border ${h.cls}`}>{h.label}</span>
                  </div>
                  <div className="text-[10px] text-[var(--ds-muted)] mt-1 tabular-nums">
                    {u.todayCalls.toLocaleString()} / {u.perDay.toLocaleString()} today · {u.lastMinute}/{u.perMin} last min
                    {u.todayErrors > 0 && <span className="text-[var(--ds-danger-text)]"> · {u.todayErrors} errors</span>}
                    {u.blockedToday > 0 && <span className="text-[var(--ds-warning-text)]"> · {u.blockedToday} blocked</span>}
                  </div>
                  <div className="h-1.5 rounded-full bg-[var(--ds-well)] mt-1.5 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${u.dayUsedPct >= 80 ? 'bg-[var(--ds-danger-mark)]' : u.dayUsedPct >= 50 ? 'bg-[var(--ds-warning)]' : 'bg-[var(--ds-success)]'}`}
                      style={{ width: `${Math.max(2, u.dayUsedPct)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

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
          All ({catalog.length})
        </button>
        {CATEGORY_META.map((c) => {
          const Icon = CAT_ICONS[c.icon] || Wrench;
          const n = catalog.filter((t) => t.category === c.id).length;
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
      <div className={`${SECTION_CARD} p-3`}>
        <div className="flex items-center gap-1.5 mb-2">
          <Boxes className="w-4 h-4 text-[var(--ds-muted)]" />
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
                          <Server className="w-4 h-4 text-[var(--ds-muted)] shrink-0" />
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
                            ? 'border border-[color:color-mix(in_srgb,var(--ds-success)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--ds-success)_10%,transparent)] text-[var(--ds-success-text)] cursor-default'
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
                  <Server className="w-4 h-4 text-[var(--ds-muted)]" />
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
