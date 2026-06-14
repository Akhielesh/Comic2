import React, { useEffect, useState } from 'react';
import {
  Key, Plus, Trash2, Check, AlertTriangle, ExternalLink, Pencil, X, ChevronDown, ChevronRight,
  Power, Loader2, ShieldCheck, ShieldX, ShieldQuestion, RefreshCw, Gauge, Server, Wallet, BookOpen, Sparkles
} from 'lucide-react';
import {
  ALL_PROVIDERS,
  PROVIDER_META,
  type ManagedApiKey,
  type ApiKeyProvider,
  listKeys,
  addKey,
  updateKey,
  deleteKey,
  setActiveKey,
  setKeyValidation,
  usageFraction,
  isOverLimit,
  getAccountKeyMeta
} from '../services/apiKeys';
import { getProviderDef, type ProviderId } from '../shared/providers';
import { ProviderLogo, hasProviderLogo } from './providerLogos';
import { fetchModelCatalog } from '../services/modelCatalog';
import { isProviderEnabled, setProviderEnabled } from '../services/sourceGovernance';
import { validateApiKey } from '../services/keyValidation';
import { listMcpServers, addMcpServer, removeMcpServer } from '../services/mcpServers';
import type { McpServerConfig } from '../apiTypes';
import { ModelSelectionPanel } from './ModelSelectionPanel';
import { useAuth } from '../contexts/AuthContext';
import { reconcileProviderMirror, syncByokKeyToServer } from '../services/byokSync';
import {
  fetchAllowanceStatus,
  getLastAllowanceStatus,
  patchBillingPrefs,
  publishAllowanceStatus,
  resetsLabel,
  subscribeAllowanceStatus,
  type AllowanceStatus,
  type BillingPrefsPatch,
  type ByokFallbackMode
} from '../services/usageAllowance';
import {
  GLASS, HAIRLINE, SHADOW_SOFT, INK, MUTED, HEADING, LABEL, TRANSITION,
  ACCENT_BG, ACCENT_BG_HOVER, ACCENT_TEXT, ACCENT_SOFT_BG, CONTROL_BTN
} from './chat/studioDesign';

// ── Shared bits ─────────────────────────────────────────────────────────────

const SECTION_LABEL = `${LABEL} px-0.5`;
const PANEL = `${GLASS} ${HAIRLINE} ${SHADOW_SOFT} rounded-2xl`;
const INPUT = `w-full ${HAIRLINE} rounded-xl px-3 py-2 text-sm bg-[var(--ds-surface-soft)] outline-none focus:border-[var(--ds-accent)] ${TRANSITION} text-[var(--ds-ink)] placeholder:text-[var(--ds-muted)]`;

const LinkPill: React.FC<{ href: string; icon: React.ReactNode; children: React.ReactNode; accent?: boolean }> = ({ href, icon, children, accent }) => (
  <a
    href={href}
    target="_blank"
    rel="noreferrer"
    className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-full ${HAIRLINE} ${TRANSITION} ${
      accent ? `${ACCENT_SOFT_BG} ${ACCENT_TEXT} hover:bg-[#D97757]/20` : `bg-[var(--ds-surface-soft)] ${MUTED} hover:bg-[var(--ds-hover)]`
    }`}
  >
    {icon}{children}<ExternalLink className="w-3 h-3 opacity-60" />
  </a>
);

const PrimaryBtn: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ className = '', children, ...rest }) => (
  <button
    {...rest}
    className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-xl ${ACCENT_BG} ${ACCENT_BG_HOVER} text-white ${TRANSITION} disabled:opacity-40 ${className}`}
  >
    {children}
  </button>
);

// ── MCP servers (custom connectors) ──────────────────────────────────────────

// One-tap presets for popular remote MCPs. DeepWiki ships as a built-in composer toggle
// already (no key); these two prefill the form but need the user's API token.
const RECOMMENDED_MCP: { name: string; url: string }[] = [
  { name: 'Hugging Face', url: 'https://huggingface.co/mcp' },
  { name: 'Context7', url: 'https://mcp.context7.com/mcp' }
];

const McpServersPanel: React.FC = () => {
  const [servers, setServers] = useState<McpServerConfig[]>(() => listMcpServers());
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [auth, setAuth] = useState('');
  const refresh = () => setServers(listMcpServers());

  const add = () => {
    if (!url.trim()) return;
    addMcpServer({ name: name.trim() || 'MCP server', url: url.trim(), authorization: auth.trim() || undefined });
    setName(''); setUrl(''); setAuth('');
    refresh();
  };

  const urlValid = !url.trim() || /^https:\/\//i.test(url.trim());

  return (
    <div className={`${PANEL} p-4`}>
      <div className="flex items-center gap-2">
        <Server className={`w-4 h-4 ${ACCENT_TEXT}`} />
        <h4 className={`${HEADING} text-sm`}>Custom MCP servers</h4>
      </div>
      <p className={`text-[11px] ${MUTED} mt-1 mb-3`}>
        Add your own remote MCP servers (https). Their tools appear as connectors in the chat composer.
        Stored on this device. <span className="font-medium">DeepWiki is already built in</span> — just toggle it on in the composer.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--ds-muted)]">Recommended</span>
        {RECOMMENDED_MCP.map((m) => (
          <button
            key={m.url}
            type="button"
            onClick={() => { setName(m.name); setUrl(m.url); }}
            className={`inline-flex items-center gap-1 ${HAIRLINE} rounded-full px-2.5 py-1 text-[11px] font-medium bg-[var(--ds-surface-soft)] ${MUTED} hover:text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]`}
            title={`Prefill ${m.name} — then paste your API token below`}
          >
            <Plus className="w-3 h-3" /> {m.name}
          </button>
        ))}
        <span className={`text-[10px] ${MUTED}`}>needs an API token</span>
      </div>

      {servers.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {servers.map((s) => (
            <div key={s.id} className={`flex items-center gap-2 ${HAIRLINE} rounded-xl px-2.5 py-1.5 bg-[var(--ds-surface-soft)]`}>
              <Server className="w-3.5 h-3.5 shrink-0 text-violet-500" />
              <span className="min-w-0 flex-1">
                <span className={`block text-sm font-semibold truncate ${INK}`}>{s.name}</span>
                <span className={`block text-[10px] ${MUTED} truncate`}>{s.url}{s.headers?.Authorization ? ' · auth' : ''}</span>
              </span>
              <button onClick={() => { removeMcpServer(s.id); refresh(); }} className={`${CONTROL_BTN} p-1.5 text-red-500 hover:text-red-600`} title="Remove"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. My Tools)" className={INPUT} />
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://server.example.com/mcp" className={`${INPUT} font-mono ${urlValid ? '' : 'border-red-500'}`} />
        <input value={auth} onChange={(e) => setAuth(e.target.value)} placeholder="Authorization header (optional, e.g. Bearer …)" className={`${INPUT} font-mono sm:col-span-2`} />
      </div>
      {!urlValid && <p className="text-[11px] text-red-500 font-semibold mt-1">MCP server URL must start with https://</p>}
      <div className="flex justify-end mt-2">
        <PrimaryBtn onClick={add} disabled={!url.trim() || !urlValid}><Plus className="w-3.5 h-3.5" /> Add server</PrimaryBtn>
      </div>
    </div>
  );
};

// ── Key validation ────────────────────────────────────────────────────────────

const VALIDATION_STALE_MS = 10 * 60 * 1000;

const runValidation = async (k: ManagedApiKey): Promise<void> => {
  const r = await validateApiKey(k.provider, k.key);
  const state = r.status === 'missing' ? 'invalid' : r.status;
  setKeyValidation(k.id, state, r.message);
};

const BADGE_BASE = `text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded-full ${HAIRLINE} flex items-center gap-1`;

const ValidationBadge: React.FC<{ k: ManagedApiKey; checking: boolean }> = ({ k, checking }) => {
  if (checking) return <span className={`${BADGE_BASE} bg-[var(--ds-well)] ${MUTED}`}><Loader2 className="w-3 h-3 animate-spin" /> Checking</span>;
  const state = k.validation ?? 'unknown';
  const title = k.validationMessage || '';
  if (state === 'valid') return <span title={title} className={`${BADGE_BASE} bg-green-500/10 text-green-600`}><ShieldCheck className="w-3 h-3" /> Valid</span>;
  if (state === 'invalid') return <span title={title} className={`${BADGE_BASE} bg-red-500/10 text-red-600`}><ShieldX className="w-3 h-3" /> Invalid</span>;
  if (state === 'unsupported') return <span title={title} className={`${BADGE_BASE} bg-[var(--ds-well)] ${MUTED}`}><ShieldQuestion className="w-3 h-3" /> Not verifiable</span>;
  return <span title={title} className={`${BADGE_BASE} bg-[var(--ds-well)] ${MUTED}`}><ShieldQuestion className="w-3 h-3" /> Unchecked</span>;
};

const mask = (key: string) => (key.length > 8 ? `${key.slice(0, 3)}••••${key.slice(-4)}` : '••••');
const usageColor = (frac: number) => (frac >= 1 ? 'bg-red-500' : frac >= 0.8 ? 'bg-amber-500' : 'bg-green-500');

const UsageMeter: React.FC<{ k: ManagedApiKey; fundsUrl?: string | null }> = ({ k, fundsUrl }) => {
  if (!k.limitUsd || k.limitUsd <= 0) {
    return <div className={`text-[11px] ${MUTED}`}>No limit · ${k.usedUsd.toFixed(2)} used this month</div>;
  }
  const frac = usageFraction(k);
  const pct = Math.min(100, Math.round(frac * 100));
  return (
    <div className="space-y-1" title={`$${k.usedUsd.toFixed(4)} of $${k.limitUsd.toFixed(2)} used this month (${Math.round(frac * 100)}%)`}>
      <div className="h-1.5 w-full bg-[var(--ds-well)] rounded-full overflow-hidden">
        <div className={`h-full ${usageColor(frac)}`} style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <div className={`flex items-center justify-between text-[11px] ${MUTED}`}>
        <span>${k.usedUsd.toFixed(2)} / ${k.limitUsd.toFixed(2)}</span>
        <span className="flex items-center gap-1.5">
          <span className={frac >= 1 ? 'font-semibold text-red-600' : ''}>{Math.round(frac * 100)}%{frac >= 1 ? ' · blocked' : ''}</span>
          {frac >= 0.8 && fundsUrl && (
            <a href={fundsUrl} target="_blank" rel="noreferrer" className={`${ACCENT_TEXT} font-semibold inline-flex items-center gap-0.5 hover:underline`}>
              <Wallet className="w-3 h-3" /> Add funds
            </a>
          )}
        </span>
      </div>
    </div>
  );
};

// ── A single key row ──────────────────────────────────────────────────────────

const KeyRow: React.FC<{ k: ManagedApiKey; fundsUrl?: string | null; onChange: () => void }> = ({ k, fundsUrl, onChange }) => {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(k.label);
  const [limit, setLimit] = useState(k.limitUsd != null ? String(k.limitUsd) : '');
  const [checking, setChecking] = useState(false);

  const verify = async () => {
    if (checking) return;
    setChecking(true);
    await runValidation(k);
    setChecking(false);
    onChange();
  };

  useEffect(() => {
    const stale = !k.validatedAt || Date.now() - k.validatedAt > VALIDATION_STALE_MS;
    if (stale) void verify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k.id, k.key]);

  const save = () => {
    updateKey(k.id, { label, limitUsd: limit.trim() ? Number(limit) : null });
    setEditing(false);
    onChange();
  };

  return (
    <div className={`${HAIRLINE} rounded-xl p-3 ${k.active ? `${ACCENT_SOFT_BG} border-[#D97757]/30` : 'bg-[var(--ds-surface-soft)]'}`}>
      <div className="flex items-start gap-3">
        <button
          onClick={() => { setActiveKey(k.id); void reconcileProviderMirror(k.provider); onChange(); }}
          title={k.active ? 'Active key' : 'Set as active'}
          className={`mt-0.5 w-5 h-5 shrink-0 rounded-full border flex items-center justify-center ${TRANSITION} ${k.active ? `${ACCENT_BG} border-transparent text-white` : 'border-[var(--ds-hairline)] bg-[var(--ds-surface)]'}`}
        >
          {k.active && <Check className="w-3 h-3" />}
        </button>

        <div className="min-w-0 flex-1">
          {editing ? (
            <input value={label} onChange={(e) => setLabel(e.target.value)} className={`${INPUT} text-sm font-semibold mb-2`} placeholder="Key label" />
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`font-semibold text-sm truncate ${INK}`}>{k.label}</span>
              {k.active && <span className={`${BADGE_BASE} ${ACCENT_SOFT_BG} ${ACCENT_TEXT}`}>Active</span>}
              <ValidationBadge k={k} checking={checking} />
              {isOverLimit(k) && <span className={`${BADGE_BASE} bg-red-500/10 text-red-600`}><AlertTriangle className="w-3 h-3" />Limit reached</span>}
            </div>
          )}
          <div className={`text-[11px] font-mono ${MUTED} mt-0.5`}>{mask(k.key)}</div>
          {!editing && !checking && k.validation === 'invalid' && k.validationMessage && (
            <div className="text-[11px] text-red-600 font-medium mt-0.5 flex items-start gap-1">
              <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />{k.validationMessage}
            </div>
          )}

          <div className="mt-2">
            {editing ? (
              <label className={`text-[11px] font-semibold ${MUTED} flex items-center gap-2`}>
                Monthly limit (USD)
                <input type="number" min={0} step="0.01" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="none" className={`w-24 ${HAIRLINE} rounded-lg px-2 py-1 text-sm font-mono bg-[var(--ds-surface-soft)] outline-none`} />
              </label>
            ) : (
              <UsageMeter k={k} fundsUrl={fundsUrl} />
            )}
          </div>
        </div>

        <div className="flex gap-1 shrink-0">
          {editing ? (
            <>
              <button onClick={save} title="Save" className={`${CONTROL_BTN} p-1.5`}><Check className="w-3.5 h-3.5" /></button>
              <button onClick={() => { setEditing(false); setLabel(k.label); setLimit(k.limitUsd != null ? String(k.limitUsd) : ''); }} title="Cancel" className={`${CONTROL_BTN} p-1.5`}><X className="w-3.5 h-3.5" /></button>
            </>
          ) : (
            <>
              <button onClick={verify} disabled={checking} title="Verify key is valid" className={`${CONTROL_BTN} p-1.5 disabled:opacity-40`}><RefreshCw className={`w-3.5 h-3.5 ${checking ? 'animate-spin' : ''}`} /></button>
              <button onClick={() => setEditing(true)} title="Edit label / limit" className={`${CONTROL_BTN} p-1.5`}><Pencil className="w-3.5 h-3.5" /></button>
              <button onClick={() => { if (confirm(`Delete "${k.label}"?`)) { deleteKey(k.id); void reconcileProviderMirror(k.provider); onChange(); } }} title="Delete key" className={`${CONTROL_BTN} p-1.5 text-red-500 hover:text-red-600`}><Trash2 className="w-3.5 h-3.5" /></button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const AddKeyForm: React.FC<{ provider: ApiKeyProvider; onChange: () => void }> = ({ provider, onChange }) => {
  const { user } = useAuth();
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [limit, setLimit] = useState('');

  const add = async () => {
    if (!key.trim()) return;
    addKey({ provider, label, key, limitUsd: limit.trim() ? Number(limit) : null });
    if (user) await syncByokKeyToServer(provider, key.trim());
    setLabel(''); setKey(''); setLimit('');
    onChange();
  };

  // Gentle, non-blocking format hint: most providers' keys carry a known prefix.
  const prefix = getProviderDef(provider)?.keyPrefix;
  const prefixMismatch = Boolean(prefix && key.trim() && !key.trim().startsWith(prefix));

  return (
    <div className={`border border-dashed border-[var(--ds-hairline)] rounded-xl p-3 space-y-2 bg-[var(--ds-well)]`}>
      <div className="flex flex-col sm:flex-row gap-2">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. Personal)" className={INPUT} />
        <input type="number" min={0} step="0.01" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="Limit $/mo (optional)" className={`${INPUT} sm:w-44 font-mono`} />
      </div>
      <div className="flex gap-2">
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={`Paste ${PROVIDER_META[provider].label} API key${prefix ? ` (${prefix}…)` : ''}`} className={`${INPUT} font-mono ${prefixMismatch ? 'border-amber-500' : ''}`} />
        <PrimaryBtn onClick={() => void add()} disabled={!key.trim()}><Plus className="w-3.5 h-3.5" /> Add</PrimaryBtn>
      </div>
      {prefixMismatch && (
        <p className="text-[11px] text-amber-600 flex items-center gap-1"><AlertTriangle className="w-3 h-3 shrink-0" /> Most {PROVIDER_META[provider].label} keys start with <span className="font-mono">{prefix}</span> — double-check you pasted the right one.</p>
      )}
    </div>
  );
};

// ── DreamStream allowance ────────────────────────────────────────────────────

const ALLOWANCE_POLL_MS = 60_000;
const FALLBACK_OPTIONS: { mode: ByokFallbackMode; label: string }[] = [
  { mode: 'ask', label: 'Ask me first' },
  { mode: 'auto', label: 'Switch to my key' },
  { mode: 'never', label: 'Stop until reset' }
];
const allowanceMeterColor = (pct: number) => (pct >= 90 ? 'bg-red-500' : pct >= 30 ? 'bg-amber-500' : 'bg-emerald-500');

const DreamStreamAllowancePanel: React.FC = () => {
  const [status, setStatus] = useState<AllowanceStatus | null>(() => getLastAllowanceStatus());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeAllowanceStatus(setStatus);
    void fetchAllowanceStatus();
    const id = setInterval(() => void fetchAllowanceStatus(), ALLOWANCE_POLL_MS);
    return () => { unsubscribe(); clearInterval(id); };
  }, []);

  if (!status || !status.enabled) return null;

  const applyPrefs = async (prefs: BillingPrefsPatch) => {
    if (saving) return;
    setSaving(true);
    const before = status;
    publishAllowanceStatus({ ...status, ...prefs });
    const next = await patchBillingPrefs(prefs);
    if (!next) {
      const re = await fetchAllowanceStatus();
      if (!re) publishAllowanceStatus(before);
    }
    setSaving(false);
  };

  const pct = Math.min(100, Math.max(0, Math.round(status.pctUsed)));
  const reset = resetsLabel(status.resetsAt);
  const crossed90 = status.exhausted || status.crossed.includes(90) || status.pctUsed >= 90;
  const showConsent = status.exhausted && status.byokAvailable && status.byokFallbackMode === 'ask';

  return (
    <div className={`${PANEL} p-4`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Gauge className={`w-4 h-4 ${ACCENT_TEXT}`} />
          <h4 className={`${HEADING} text-sm`}>DreamStream monthly allowance</h4>
        </div>
        <button
          role="switch"
          aria-checked={status.usePlatformAllowance}
          disabled={saving}
          onClick={() => void applyPrefs({ usePlatformAllowance: !status.usePlatformAllowance })}
          className={`flex items-center gap-1.5 ${HAIRLINE} rounded-full px-3 py-1 text-[11px] font-semibold shrink-0 ${TRANSITION} disabled:opacity-50 ${status.usePlatformAllowance ? 'bg-emerald-500/10 text-emerald-600' : `bg-[var(--ds-surface-soft)] ${MUTED}`}`}
        >
          <Power className="w-3.5 h-3.5" /> {status.usePlatformAllowance ? 'On' : 'Off'}
        </button>
      </div>
      <p className={`text-[11px] ${MUTED} mt-1`}>
        On: generation runs on the platform key until your monthly allowance is used. Off: only your own keys below are used.
      </p>

      <div className="mt-3">
        <div className="relative h-2 w-full bg-[var(--ds-well)] rounded-full overflow-hidden">
          <div className={`h-full ${allowanceMeterColor(status.pctUsed)}`} style={{ width: `${Math.max(2, pct)}%` }} />
          {[30, 70, 90].map((t) => (
            <span key={t} className="absolute top-0 bottom-0 w-px bg-[var(--ds-hairline)]" style={{ left: `${t}%` }} title={`${t}%`} />
          ))}
        </div>
        <div className={`mt-1 text-[11px] ${MUTED}`}>
          <span className={`font-semibold ${pct >= 90 ? 'text-red-600' : INK}`}>{pct}%</span> of your monthly allowance used
          {reset && <> · resets {reset}</>}
        </div>
      </div>

      <div className="mt-3">
        <div className={SECTION_LABEL}>When my allowance runs out</div>
        <div className={`mt-1.5 inline-flex flex-wrap rounded-xl ${HAIRLINE} overflow-hidden`} role="radiogroup">
          {FALLBACK_OPTIONS.map((opt, i) => {
            const active = status.byokFallbackMode === opt.mode;
            return (
              <button
                key={opt.mode}
                role="radio"
                aria-checked={active}
                disabled={saving}
                onClick={() => void applyPrefs({ byokFallbackMode: opt.mode })}
                className={`px-3 py-1.5 text-xs font-semibold ${TRANSITION} disabled:opacity-50 ${i > 0 ? 'border-l border-[var(--ds-hairline)]' : ''} ${active ? `${ACCENT_BG} text-white` : `bg-[var(--ds-surface-soft)] ${MUTED} hover:bg-[var(--ds-hover)]`}`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        {!status.byokAvailable && (
          <p className={`text-[11px] ${MUTED} mt-1`}>No personal key on file — add a key below to enable fallback.</p>
        )}
      </div>

      {(crossed90 || status.exhausted) && (
        showConsent ? (
          <div className={`mt-3 ${HAIRLINE} rounded-xl bg-red-500/5 p-3`}>
            <div className="flex items-start gap-2 flex-wrap sm:flex-nowrap">
              <AlertTriangle className="w-4 h-4 shrink-0 text-red-500 mt-0.5" />
              <div className="flex-1 min-w-[12rem]">
                <div className="text-sm font-semibold text-red-600">You've used 100% of this month's allowance. Continue with your own key?</div>
                <p className={`text-[11px] ${MUTED} mt-0.5`}>Your key's own limits still apply.</p>
              </div>
              <PrimaryBtn onClick={() => void applyPrefs({ byokFallbackMode: 'auto' })} disabled={saving}>Continue with my key</PrimaryBtn>
            </div>
          </div>
        ) : (
          <div className={`mt-3 ${HAIRLINE} rounded-xl p-3 flex items-start gap-2 ${status.exhausted ? 'bg-red-500/5' : 'bg-amber-500/5'}`}>
            <AlertTriangle className={`w-4 h-4 shrink-0 mt-0.5 ${status.exhausted ? 'text-red-500' : 'text-amber-500'}`} />
            <div className={`text-xs ${INK}`}>
              {status.exhausted ? (
                status.byokFallbackMode === 'auto' && status.byokAvailable ? (
                  <>You've used <span className="font-semibold">100%</span> of this month's allowance — generation now runs on your own key{reset && <> until it resets {reset}</>}.</>
                ) : (
                  <>You've used <span className="font-semibold">100%</span> of this month's allowance. Platform generation is paused{reset && <> until it resets {reset}</>}{!status.byokAvailable && <> — add a key below to keep going</>}.</>
                )
              ) : (
                <>You've used over <span className="font-semibold">90%</span> of this month's allowance{reset && <> — it resets {reset}</>}.</>
              )}
            </div>
          </div>
        )
      )}
    </div>
  );
};

// ── Provider card (key management + governance + links, unified) ───────────────

const ProviderCard: React.FC<{
  provider: ApiKeyProvider;
  keys: ManagedApiKey[];
  count?: number;
  open: boolean;
  onToggleOpen: () => void;
  onChange: () => void;
}> = ({ provider, keys, count, open, onToggleOpen, onChange }) => {
  const meta = PROVIDER_META[provider];
  const def = getProviderDef(provider);
  const accountMeta = getAccountKeyMeta();
  const enabled = isProviderEnabled(provider);
  const providerKeys = keys.filter((k) => k.provider === provider);
  const active = providerKeys.find((k) => k.active);
  const hasKey = providerKeys.length > 0 || accountMeta.some((m) => m.provider === provider);
  const overLimit = active ? isOverLimit(active) : false;

  // Status pill: Off (governance) | No key (greyed) | Limit reached | Connected.
  const status: { label: string; cls: string } = !enabled
    ? { label: 'Off', cls: `bg-[var(--ds-well)] ${MUTED}` }
    : overLimit
      ? { label: 'Limit reached', cls: 'bg-red-500/10 text-red-600' }
      : hasKey
        ? { label: 'Connected', cls: 'bg-green-500/10 text-green-600' }
        : { label: 'No key', cls: `bg-[var(--ds-well)] ${MUTED}` };

  return (
    <div className={`${PANEL} overflow-hidden ${!enabled ? 'opacity-70' : ''}`}>
      <div className="w-full flex items-center gap-3 px-3.5 py-3">
        <button onClick={onToggleOpen} className="flex items-center gap-2.5 min-w-0 flex-1 text-left">
          {open ? <ChevronDown className={`w-4 h-4 shrink-0 ${MUTED}`} /> : <ChevronRight className={`w-4 h-4 shrink-0 ${MUTED}`} />}
          <span className="shrink-0 grid place-items-center w-6 h-6 rounded-lg bg-[var(--ds-well)]" style={{ color: def?.accent || 'var(--ds-muted)' }}>
            {hasProviderLogo(provider)
              ? <ProviderLogo provider={provider} className="w-4 h-4" title={meta.label} />
              : <span className="w-2.5 h-2.5 rounded-full" style={{ background: def?.accent || 'var(--ds-muted)' }} />}
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className={`font-semibold text-sm truncate ${INK}`}>{meta.label}</span>
              {def?.freeTier && <span className={`${BADGE_BASE} bg-green-500/10 text-green-600`}>Free tier</span>}
            </span>
            <span className={`block text-[11px] ${MUTED} truncate`}>
              {active ? `Active: ${active.label}` : meta.hint}
            </span>
          </span>
        </button>

        {typeof count === 'number' && count > 0 && (
          <span className={`text-[11px] ${MUTED} shrink-0 hidden sm:inline tabular-nums`}>{count} model{count === 1 ? '' : 's'}</span>
        )}
        <span className={`${BADGE_BASE} ${status.cls} shrink-0`}>{status.label}</span>

        {/* Governance on/off toggle */}
        <button
          role="switch"
          aria-checked={enabled}
          onClick={() => { setProviderEnabled(provider, !enabled); onChange(); }}
          title={enabled ? 'Source is on — turn off to ignore its keys everywhere' : 'Source is off — turn on to use it'}
          className={`shrink-0 w-9 h-5 rounded-full ${TRANSITION} relative ${enabled ? ACCENT_BG : 'bg-[var(--ds-well)]'}`}
        >
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm ${TRANSITION} ${enabled ? 'left-[18px]' : 'left-0.5'}`} />
        </button>
      </div>

      {open && (
        <div className="border-t border-[var(--ds-hairline)] p-3 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className={`text-[11px] ${MUTED} max-w-md`}>{meta.hint}</p>
            <div className="flex items-center gap-1.5 shrink-0">
              <LinkPill href={meta.keysUrl} icon={<Key className="w-3 h-3" />} accent>Get a key</LinkPill>
              {def?.fundsUrl && <LinkPill href={def.fundsUrl} icon={<Wallet className="w-3 h-3" />}>Add funds</LinkPill>}
              {def?.docsUrl && <LinkPill href={def.docsUrl} icon={<BookOpen className="w-3 h-3" />}>Models</LinkPill>}
            </div>
          </div>
          {!hasKey && (
            <div className={`flex items-center gap-2 text-[11px] ${MUTED} ${HAIRLINE} rounded-xl px-3 py-2 bg-[var(--ds-well)]`}>
              <Sparkles className={`w-3.5 h-3.5 ${ACCENT_TEXT}`} />
              Add a {meta.label} key to unlock its models. {def?.freeTier ? 'This provider has a free tier.' : 'Usage is billed to your key.'}
            </div>
          )}
          {providerKeys.map((k) => <KeyRow key={k.id} k={k} fundsUrl={def?.fundsUrl} onChange={onChange} />)}
          <AddKeyForm provider={provider} onChange={onChange} />
        </div>
      )}
    </div>
  );
};

// ── Root ──────────────────────────────────────────────────────────────────────

export const ApiConfiguration: React.FC = () => {
  const [keys, setKeys] = useState<ManagedApiKey[]>(() => listKeys());
  const [, setGovVersion] = useState(0);
  const [open, setOpen] = useState<ApiKeyProvider | null>(() => {
    const initial = listKeys();
    return ALL_PROVIDERS.find((p) => !initial.some((k) => k.provider === p)) ?? null;
  });
  const [counts, setCounts] = useState<Record<string, number>>({});
  const refresh = () => { setKeys(listKeys()); setGovVersion((v) => v + 1); };

  useEffect(() => {
    const id = setInterval(async () => {
      const current = listKeys();
      await Promise.all(current.map((k) => runValidation(k)));
      setKeys(listKeys());
    }, VALIDATION_STALE_MS);
    return () => clearInterval(id);
  }, []);

  // Live per-provider model counts, so each provider row shows what it actually offers.
  useEffect(() => {
    let active = true;
    fetchModelCatalog()
      .then((res) => {
        if (!active) return;
        const c: Record<string, number> = {};
        for (const m of res.models) c[m.source] = (c[m.source] || 0) + 1;
        setCounts(c);
      })
      .catch(() => { /* counts are a nicety; never block the panel */ });
    return () => { active = false; };
  }, []);

  const enabledProviders = ALL_PROVIDERS.filter(isProviderEnabled).length;
  const connected = ALL_PROVIDERS.filter((p) => keys.some((k) => k.provider === p) || getAccountKeyMeta().some((m) => m.provider === p)).length;
  const validKeys = keys.filter((k) => k.validation === 'valid').length;

  const chip = (label: string, tone: 'ok' | 'muted' | 'bad') =>
    `text-[11px] font-semibold px-2.5 py-1 rounded-full ${HAIRLINE} ${
      tone === 'ok' ? 'bg-green-500/10 text-green-600' : tone === 'bad' ? 'bg-red-500/10 text-red-600' : `bg-[var(--ds-surface-soft)] ${MUTED}`
    }`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className={`text-sm ${MUTED} max-w-xl`}>
          Connect a provider to use its models. Bring your own key — pick the <span className={`font-semibold ${INK}`}>active</span> one,
          set an optional monthly limit, and turn any source on or off. Keys stay on this device (and sync to your account, encrypted).
        </p>
        <div className="flex items-center gap-1.5 shrink-0" aria-label="Configuration summary">
          <span className={chip(`${connected} connected`, connected > 0 ? 'ok' : 'muted')}>{connected} connected</span>
          <span className={chip(`${enabledProviders} on`, 'muted')}>{enabledProviders} on</span>
          <span className={chip(`${validKeys} valid`, validKeys > 0 ? 'ok' : 'muted')}>{validKeys} valid</span>
        </div>
      </div>

      <DreamStreamAllowancePanel />

      <div className={SECTION_LABEL}>Providers</div>
      <div className="space-y-2">
        {ALL_PROVIDERS.map((provider) => (
          <ProviderCard
            key={provider}
            provider={provider}
            keys={keys}
            count={counts[provider]}
            open={open === provider}
            onToggleOpen={() => setOpen(open === provider ? null : provider)}
            onChange={refresh}
          />
        ))}
      </div>

      <div className={SECTION_LABEL}>Connectors</div>
      <McpServersPanel />

      <div className={SECTION_LABEL}>Default models</div>
      <ModelSelectionPanel />
    </div>
  );
};
