import React, { useEffect, useRef, useState } from 'react';
import {
  Key, Plus, Trash2, Check, AlertTriangle, ExternalLink, Pencil, X, ChevronDown, ChevronRight,
  Power, Loader2, ShieldCheck, ShieldX, ShieldQuestion, RefreshCw, Gauge, Server, Wallet, BookOpen, Sparkles
} from 'lucide-react';
import {
  ALL_PROVIDERS,
  PROVIDER_META,
  type ManagedApiKey,
  type ApiKeyProvider,
  type KeyValidationState,
  listKeys,
  addKey,
  updateKey,
  deleteKey,
  setActiveKey,
  setKeyValidation,
  usageFraction,
  isOverLimit,
  getAccountKeyMeta,
  API_KEYS_CHANGED
} from '../services/apiKeys';
import { getProviderDef, type ProviderId } from '../shared/providers';
import { ProviderLogo, hasProviderLogo } from './providerLogos';
import { fetchModelCatalog } from '../services/modelCatalog';
import { isProviderEnabled, setProviderEnabled, SOURCE_GOVERNANCE_CHANGED } from '../services/sourceGovernance';
import { validateApiKey, KEY_CHECK_UNAVAILABLE_COPY, type KeyValidationStatus } from '../services/keyValidation';
import { listMcpServers, addMcpServer, removeMcpServer } from '../services/mcpServers';
import type { McpServerConfig } from '../apiTypes';
import { ModelSelectionPanel } from './ModelSelectionPanel';
import { useAuth } from '../contexts/AuthContext';
import { reconcileProviderMirror } from '../services/byokSync';
import {
  USAGE_EXHAUSTED_COPY,
  fetchAllowanceStatus,
  formatPctLeft,
  getLastAllowanceStatus,
  patchBillingPrefs,
  publishAllowanceStatus,
  refreshAllowanceStatus,
  resetsLabel,
  subscribeAllowanceStatus,
  type AllowanceStatus,
  type BillingPrefsPatch,
  type ByokFallbackMode
} from '../services/usageAllowance';
import {
  HAIRLINE, INK, MUTED, TRANSITION, ACCENT_BG, ACCENT_SOFT_BG, CHIP, CHIP_VARIANT, DENSITY, FIELD, FOCUS_RING, OVERLINE,
  RADIUS_CONTROL, RADIUS_PILL, SECTION_CARD, SEGMENTED_ACTIVE_FILL, SEGMENTED_ITEM, SEGMENTED_TRACK, STATUS_CHIP,
  STATUS_CHIP_TONE, STATUS_INK, STATUS_SURFACE, TONE_FILL, TONE_TEXT, WRAP_TEXT, type StatusState
} from './chat/studioDesign';
import { cn } from '../lib/utils';
import { Button, IconButton } from './ds';

// ── Shared bits ─────────────────────────────────────────────────────────────

const SECTION_LABEL = `${OVERLINE} px-0.5`;
/** An opaque settings card: the surface, a hairline, the soft shadow, the panel radius (SECTION_CARD). */
const PANEL = SECTION_CARD;
/** A card's own title: the body face, semibold (Atlas card titles are never the display face). */
const CARD_HEAD = 'text-[length:var(--ds-text-base)] font-semibold leading-5 text-[var(--ds-ink)]';
/** A text field on the FIELD recipe: 16 px on phones (no iOS zoom), 14 px from md. */
const INPUT = `${FIELD} w-full min-w-0 px-3 py-2 text-base md:text-[length:var(--ds-text-base)] ${DENSITY.coarse}`;
/** A status chip with its words: the one status vocabulary, the hue only repeats the word. */
const statusChip = (state: StatusState) => cn(STATUS_CHIP, STATUS_CHIP_TONE[state]);

const LinkPill: React.FC<{ href: string; icon: React.ReactNode; children: React.ReactNode; accent?: boolean }> = ({ href, icon, children, accent }) => (
  <a
    href={href}
    target="_blank"
    rel="noreferrer"
    className={cn(
      'inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold hover:bg-[var(--ds-hover)]',
      HAIRLINE,
      RADIUS_PILL,
      TRANSITION,
      DENSITY.coarse,
      FOCUS_RING,
      accent ? `${ACCENT_SOFT_BG} text-[var(--ds-ink)]` : `bg-[var(--ds-surface-soft)] ${MUTED}`
    )}
  >
    {icon}{children}<ExternalLink className="w-3 h-3 opacity-60" />
  </a>
);

/** The card's one primary action: the ink Button, small. */
const PrimaryBtn: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ className, children, type, ...rest }) => (
  <Button {...rest} type={type ?? 'button'} size="sm" className={className}>
    {children}
  </Button>
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
        <Server className={`w-4 h-4 shrink-0 ${MUTED}`} aria-hidden="true" />
        <h4 className={CARD_HEAD}>Custom MCP servers</h4>
      </div>
      <p className={`text-[11px] ${MUTED} mt-1 mb-3`}>
        Add your own remote MCP servers (https). Their tools appear as connectors in the chat composer.
        Stored on this device. <span className="font-medium">DeepWiki is already built in</span> — just toggle it on in the composer.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className={OVERLINE}>Recommended</span>
        {RECOMMENDED_MCP.map((m) => (
          <button
            key={m.url}
            type="button"
            onClick={() => { setName(m.name); setUrl(m.url); }}
            className={cn(CHIP, CHIP_VARIANT.outline, 'px-2.5 py-1 hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]', TRANSITION, DENSITY.coarse, FOCUS_RING)}
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
            <div key={s.id} className={cn('flex items-center gap-2 bg-[var(--ds-surface-soft)] px-2.5 py-1.5', HAIRLINE, RADIUS_CONTROL)}>
              <Server className={`w-3.5 h-3.5 shrink-0 ${MUTED}`} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className={`block text-sm font-semibold truncate ${INK}`}>{s.name}</span>
                <span className={`block text-[10px] ${MUTED} truncate`}>{s.url}{s.headers?.Authorization ? ' · auth' : ''}</span>
              </span>
              <IconButton label="Remove" size="sm" onClick={() => { removeMcpServer(s.id); refresh(); }} className={TONE_TEXT.danger}><Trash2 className="w-3.5 h-3.5" /></IconButton>
            </div>
          ))}
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. My Tools)" className={INPUT} />
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://server.example.com/mcp" aria-invalid={urlValid ? undefined : true} className={`${INPUT} aria-[invalid=true]:border-[var(--ds-danger-mark)]`} />
        <input value={auth} onChange={(e) => setAuth(e.target.value)} placeholder="Authorization header (optional, e.g. Bearer …)" className={`${INPUT} sm:col-span-2`} />
      </div>
      {!urlValid && <p className={cn('mt-1 flex items-center gap-1 text-[11px] font-medium', TONE_TEXT.danger)}><AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />MCP server URL must start with https://</p>}
      <div className="flex justify-end mt-2">
        <PrimaryBtn onClick={add} disabled={!url.trim() || !urlValid}><Plus className="w-3.5 h-3.5" /> Add server</PrimaryBtn>
      </div>
    </div>
  );
};

// ── Key validation ────────────────────────────────────────────────────────────

// A stored verdict is re-checked when a key row is shown (the provider card is opened) and the
// verdict is over a day old — never on a timer: a timed /api call keeps the sleepable backend
// awake. Otherwise keys are checked on add and on the explicit "Verify" button.
const VALIDATION_STALE_MS = 24 * 60 * 60 * 1000;

// Account checks show our own status copy, never an arbitrary response message.
const ACCOUNT_CHECK_COPY: Record<KeyValidationStatus, string> = {
  valid: 'Account key authenticated. Access can vary by model.',
  invalid: 'The provider rejected this account key. Add a replacement key to update your account.',
  unsupported: 'Saved. This provider does not offer a read-only key check.',
  missing: 'No enabled account key is available to check.',
  unavailable: KEY_CHECK_UNAVAILABLE_COPY
};

// Messages that earlier versions stored as an 'invalid' verdict although no verdict was reached:
// our own route failed (expired session, rate limit, 5xx, offline) or the provider was
// unreachable or errored. Tabs still running the old code may keep writing them for a while
// after a deploy. They count as "not checked": the row shows Unchecked and re-checks on open,
// instead of a red Invalid under a good key for a day.
const NON_VERDICT_MESSAGE =
  /^(Validation failed \(HTTP \d+\)|Could not validate|Could not reach )| returned \d{3}\.$|\(or it could not be reached\)\.$/;

/** The stored verdict to show and trust — 'unknown' when there is none, or it wasn't a verdict. */
const storedVerdict = (k: ManagedApiKey): KeyValidationState => {
  const v = k.validation;
  if (v !== 'valid' && v !== 'invalid' && v !== 'unsupported') return 'unknown';
  if (v === 'invalid' && k.validationMessage && NON_VERDICT_MESSAGE.test(k.validationMessage)) return 'unknown';
  return v;
};

/**
 * Check a key. A verdict is stored with its time; a check that could not run is returned as a
 * notice for the row and NOT stored, so the previous verdict stays and the next open re-checks.
 */
const runValidation = async (k: ManagedApiKey): Promise<string | null> => {
  const r = await validateApiKey(k.provider, k.key);
  if (r.status === 'unavailable') return r.message;
  const state = r.status === 'missing' ? 'invalid' : r.status;
  setKeyValidation(k.id, state, r.message, k.key);
  return null;
};

const ValidationBadge: React.FC<{ k: ManagedApiKey; checking: boolean }> = ({ k, checking }) => {
  if (checking) return <span className={statusChip('waiting')}><Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none" /> Checking</span>;
  const state = storedVerdict(k);
  const title = state === 'unknown' ? '' : k.validationMessage || '';
  if (state === 'valid') return <span title={title} className={statusChip('healthy')}><ShieldCheck className="w-3 h-3" /> Valid</span>;
  if (state === 'invalid') return <span title={title} className={statusChip('error')}><ShieldX className="w-3 h-3" /> Invalid</span>;
  if (state === 'unsupported') return <span title={title} className={statusChip('waiting')}><ShieldQuestion className="w-3 h-3" /> Not verifiable</span>;
  return <span title={title} className={statusChip('waiting')}><ShieldQuestion className="w-3 h-3" /> Unchecked</span>;
};

const mask = (key: string) => (key.length > 8 ? `${key.slice(0, 3)}••••${key.slice(-4)}` : '••••');
const usageColor = (frac: number) => (frac >= 1 ? TONE_FILL.danger : frac >= 0.8 ? TONE_FILL.warning : TONE_FILL.success);

const UsageMeter: React.FC<{ k: ManagedApiKey; fundsUrl?: string | null }> = ({ k, fundsUrl }) => {
  if (!k.limitUsd || k.limitUsd <= 0) {
    return <div className={`text-[11px] ${MUTED}`}>No limit · ${k.usedUsd.toFixed(2)} used this month</div>;
  }
  const frac = usageFraction(k);
  const pct = Math.min(100, Math.round(frac * 100));
  return (
    <div className="space-y-1" title={`$${k.usedUsd.toFixed(4)} of $${k.limitUsd.toFixed(2)} used this month (${Math.round(frac * 100)}%)`}>
      <div className="h-1.5 w-full bg-[var(--ds-well-strong)] rounded-full overflow-hidden">
        <div className={`h-full ${usageColor(frac)}`} style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <div className={`flex items-center justify-between text-[11px] ${MUTED}`}>
        <span className="tabular-nums">${k.usedUsd.toFixed(2)} / ${k.limitUsd.toFixed(2)}</span>
        <span className="flex items-center gap-1.5">
          <span className={cn('tabular-nums', frac >= 1 && `font-semibold ${TONE_TEXT.danger}`)}>{Math.round(frac * 100)}%{frac >= 1 ? ' · blocked' : ''}</span>
          {frac >= 0.8 && fundsUrl && (
            <a href={fundsUrl} target="_blank" rel="noreferrer" className={cn('inline-flex items-center gap-0.5 font-semibold text-[var(--ds-ink)] underline-offset-2 hover:underline', RADIUS_CONTROL, FOCUS_RING)}>
              <Wallet className="w-3 h-3" /> Add funds
            </a>
          )}
        </span>
      </div>
    </div>
  );
};

// ── A single key row ──────────────────────────────────────────────────────────

const KeyRow: React.FC<{
  k: ManagedApiKey;
  fundsUrl?: string | null;
  onChange: () => void;
  onActiveKeyChange: () => void;
}> = ({ k, fundsUrl, onChange, onActiveKeyChange }) => {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(k.label);
  const [limit, setLimit] = useState(k.limitUsd != null ? String(k.limitUsd) : '');
  const [replacement, setReplacement] = useState('');
  const [checking, setChecking] = useState(false);
  // A check that could not run this time ("Couldn't check…"). Shown, never stored.
  const [notice, setNotice] = useState<string | null>(null);
  const validationRun = useRef({ id: 0, key: '' });

  const verify = async () => {
    if (checking && validationRun.current.key === k.key) return;
    const id = validationRun.current.id + 1;
    validationRun.current = { id, key: k.key };
    setChecking(true);
    setNotice(null);
    const result = await runValidation(k);
    if (validationRun.current.id !== id) return;
    setNotice(result);
    setChecking(false);
    onChange();
  };

  useEffect(() => {
    const stale =
      storedVerdict(k) === 'unknown' || !k.validatedAt || Date.now() - k.validatedAt > VALIDATION_STALE_MS;
    if (stale) void verify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k.id, k.key]);

  const save = () => {
    const changedSecret = Boolean(replacement.trim() && replacement.trim() !== k.key);
    updateKey(k.id, { label, limitUsd: limit.trim() ? Number(limit) : null, ...(changedSecret ? { key: replacement } : {}) });
    setEditing(false);
    setReplacement('');
    if (changedSecret && k.active) onActiveKeyChange();
    else onChange();
  };

  const activate = () => {
    setActiveKey(k.id);
    onActiveKeyChange();
  };

  const remove = () => {
    if (!confirm(`Delete "${k.label}"?`)) return;
    deleteKey(k.id);
    if (k.active) onActiveKeyChange();
    else onChange();
  };

  return (
    <div className={cn('p-3', HAIRLINE, RADIUS_CONTROL, k.active ? `${ACCENT_SOFT_BG} border-[color:color-mix(in_srgb,var(--ds-ink)_25%,transparent)]` : 'bg-[var(--ds-surface-soft)]')}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <button
          onClick={activate}
          title={k.active ? 'Active key' : 'Set as active'}
          className={cn('-m-0.5 grid size-6 shrink-0 place-items-center', RADIUS_CONTROL, DENSITY.coarseSquare, FOCUS_RING)}
        >
          <span className={cn('grid size-5 place-items-center rounded-full border', TRANSITION, k.active ? `${ACCENT_BG} border-transparent text-[var(--ds-on-accent)]` : 'border-[var(--ds-control-border)] bg-[var(--ds-canvas)]')}>
            {k.active && <Check className="w-3 h-3" />}
          </span>
        </button>

        <div className="min-w-0 flex-1 basis-40">
          {editing ? (
            <input value={label} onChange={(e) => setLabel(e.target.value)} className={cn(INPUT, 'mb-2 font-semibold')} placeholder="Key label" />
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`min-w-0 font-semibold text-sm truncate ${INK}`}>{k.label}</span>
              {k.active && <span className={statusChip('active')}>Active</span>}
              <ValidationBadge k={k} checking={checking} />
              {isOverLimit(k) && <span className={statusChip('error')}><AlertTriangle className="w-3 h-3" />Limit reached</span>}
            </div>
          )}
          <div className={`text-[11px] font-mono ${MUTED} mt-0.5`}>{mask(k.key)}</div>
          {editing && (
            <label className={`block text-[11px] ${MUTED} mt-2`}>
              Replace API key (optional)
              <input type="password" autoComplete="off" value={replacement} onChange={(e) => setReplacement(e.target.value)} placeholder="Leave blank to keep this key" className={`${INPUT} mt-1 font-mono`} />
            </label>
          )}
          {!editing && !checking && storedVerdict(k) === 'invalid' && k.validationMessage && (
            <div className={cn('mt-0.5 flex items-start gap-1 text-[11px] font-medium', TONE_TEXT.danger, WRAP_TEXT)}>
              <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />{k.validationMessage}
            </div>
          )}
          {!editing && !checking && notice && (
            <div role="status" className={`text-[11px] ${MUTED} mt-0.5 flex items-start gap-1`}>
              <ShieldQuestion className="w-3 h-3 shrink-0 mt-0.5" />{notice}
            </div>
          )}

          <div className="mt-2">
            {editing ? (
              <label className={`text-[11px] font-semibold ${MUTED} flex flex-wrap items-center gap-2`}>
                Monthly limit (USD)
                <input type="number" min={0} step="0.01" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="none" className={`${FIELD} w-24 px-2 py-1 font-mono text-base md:text-[length:var(--ds-text-base)] ${DENSITY.coarse}`} />
              </label>
            ) : (
              <UsageMeter k={k} fundsUrl={fundsUrl} />
            )}
          </div>
        </div>

        <div className="ml-auto flex shrink-0 gap-1">
          {editing ? (
            <>
              <IconButton label="Save" size="sm" variant="outline" onClick={save}><Check className="w-3.5 h-3.5" /></IconButton>
              <IconButton label="Cancel" size="sm" variant="outline" onClick={() => { setEditing(false); setReplacement(''); setLabel(k.label); setLimit(k.limitUsd != null ? String(k.limitUsd) : ''); }}><X className="w-3.5 h-3.5" /></IconButton>
            </>
          ) : (
            <>
              <IconButton label="Verify key is valid" size="sm" variant="outline" onClick={verify} disabled={checking}><RefreshCw className={`w-3.5 h-3.5 ${checking ? 'animate-spin motion-reduce:animate-none' : ''}`} /></IconButton>
              <IconButton label="Edit label / limit" size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil className="w-3.5 h-3.5" /></IconButton>
              <IconButton label="Delete key" size="sm" variant="outline" onClick={remove} className={TONE_TEXT.danger}><Trash2 className="w-3.5 h-3.5" /></IconButton>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const AddKeyForm: React.FC<{ provider: ApiKeyProvider; onChange: () => void; onActiveKeyChange: () => void }> = ({ provider, onChange, onActiveKeyChange }) => {
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [limit, setLimit] = useState('');

  const add = () => {
    if (!key.trim()) return;
    const added = addKey({ provider, label, key, limitUsd: limit.trim() ? Number(limit) : null });
    setLabel(''); setKey(''); setLimit('');
    if (added.active) onActiveKeyChange();
    else onChange();
  };

  // Gentle, non-blocking format hint: most providers' keys carry a known prefix.
  const prefix = getProviderDef(provider)?.keyPrefix;
  const prefixMismatch = Boolean(prefix && key.trim() && !key.trim().startsWith(prefix));

  return (
    <div className={cn('space-y-2 border border-dashed border-[var(--ds-hairline)] bg-[var(--ds-well)] p-3', RADIUS_CONTROL)}>
      <div className="flex flex-col sm:flex-row gap-2">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. Personal)" className={INPUT} />
        <input type="number" min={0} step="0.01" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="Limit $/mo (optional)" aria-label="Monthly limit in dollars (optional)" className={`${INPUT} tabular-nums sm:w-52`} />
      </div>
      <div className="flex gap-2">
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste API key" aria-label={`${PROVIDER_META[provider].label} API key`} className={cn(INPUT, prefixMismatch && 'border-[var(--ds-warning)] hover:border-[var(--ds-warning)]')} />
        <PrimaryBtn onClick={add} disabled={!key.trim()}><Plus className="w-3.5 h-3.5" /> Add</PrimaryBtn>
      </div>
      {prefix && !prefixMismatch && (
        <p className={cn('text-[11px]', MUTED, WRAP_TEXT)}>{PROVIDER_META[provider].label} keys start with <span className="font-mono">{prefix}</span></p>
      )}
      {prefixMismatch && (
        <p className={cn('flex items-start gap-1 text-[11px]', TONE_TEXT.warning, WRAP_TEXT)}><AlertTriangle className="mt-0.5 w-3 h-3 shrink-0" /> Most {PROVIDER_META[provider].label} keys start with <span className="font-mono">{prefix}</span> — double-check you pasted the right one.</p>
      )}
    </div>
  );
};

// ── DreamStream usage left (P1-LIMITS: percent + friendly units, never dollars) ──

const FALLBACK_OPTIONS: { mode: ByokFallbackMode; label: string }[] = [
  { mode: 'ask', label: 'Ask me first' },
  { mode: 'auto', label: 'Switch to my key' },
  { mode: 'never', label: 'Just stop' }
];
// Colour by usage LEFT (the status tones, beside the percentage in words): plenty → success, under 30% → warning,
// under 10% → danger.
const usageLeftColor = (pctLeft: number) => (pctLeft < 10 ? TONE_FILL.danger : pctLeft < 30 ? TONE_FILL.warning : TONE_FILL.success);

const DreamStreamAllowancePanel: React.FC = () => {
  const [status, setStatus] = useState<AllowanceStatus | null>(() => getLastAllowanceStatus());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Read on open and when the window regains focus — never on a timer (the backend sleeps).
    const unsubscribe = subscribeAllowanceStatus(setStatus);
    void refreshAllowanceStatus(0);
    const onFocus = () => void refreshAllowanceStatus(60_000);
    window.addEventListener('focus', onFocus);
    return () => { unsubscribe(); window.removeEventListener('focus', onFocus); };
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

  const pctLeft = status.exhausted ? 0 : Math.min(100, Math.max(0, status.pctLeft));
  const reset = resetsLabel(status.resetsAt);
  const crossed90 = status.governed && (status.exhausted || status.crossed.includes(90) || status.pctUsed >= 90);
  const showConsent = status.governed && status.exhausted && status.byokAvailable && status.byokFallbackMode === 'ask';

  return (
    <div className={`${PANEL} p-4`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Gauge className={`w-4 h-4 shrink-0 ${MUTED}`} aria-hidden="true" />
          <h4 className={CARD_HEAD}>DreamStream usage left</h4>
        </div>
        <button
          role="switch"
          aria-checked={status.usePlatformAllowance}
          disabled={saving}
          onClick={() => void applyPrefs({ usePlatformAllowance: !status.usePlatformAllowance })}
          className={cn('flex shrink-0 items-center gap-1.5 border px-3 py-1 text-[11px] font-semibold disabled:opacity-50', RADIUS_PILL, TRANSITION, DENSITY.coarse, FOCUS_RING, status.usePlatformAllowance ? `${STATUS_SURFACE.healthy} ${STATUS_INK.healthy}` : `border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] ${MUTED}`)}
        >
          <Power className="w-3.5 h-3.5" /> {status.usePlatformAllowance ? 'On' : 'Off'}
        </button>
      </div>
      <p className={`text-[11px] ${MUTED} mt-1`}>
        On: generation runs on DreamStream's key while you have usage left — shared across every studio. Off: only your own keys below are used. Your own keys never use your DreamStream usage.
      </p>

      {status.governed ? (
        <div className="mt-3">
          <div
            className="relative h-2 w-full overflow-hidden rounded-full bg-[var(--ds-well-strong)]"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pctLeft)}
            aria-label="DreamStream usage left"
          >
            <div className={`h-full ${usageLeftColor(pctLeft)}`} style={{ width: `${pctLeft > 0 ? Math.max(2, pctLeft) : 0}%` }} />
          </div>
          <div className={`mt-1 text-[11px] ${MUTED}`}>
            <span className={`font-semibold tabular-nums ${pctLeft < 10 ? TONE_TEXT.danger : INK}`}>{status.exhausted ? '0%' : formatPctLeft(pctLeft)}</span> of your usage left
            {status.friendlyUnits && !status.exhausted && <> · {status.friendlyUnits.label}</>}
            {reset ? <> · comes back {reset}</> : <> · doesn't reset on its own</>}
          </div>
        </div>
      ) : (
        <p className={`mt-3 text-xs ${INK}`}>Your account has no usage limit.</p>
      )}

      <div className="mt-3">
        <div className={SECTION_LABEL}>When my usage runs out</div>
        <div className={cn(SEGMENTED_TRACK, 'mt-1.5 flex-wrap')} role="radiogroup">
          {FALLBACK_OPTIONS.map((opt) => {
            const active = status.byokFallbackMode === opt.mode;
            return (
              <button
                key={opt.mode}
                role="radio"
                aria-checked={active}
                disabled={saving}
                onClick={() => void applyPrefs({ byokFallbackMode: opt.mode })}
                className={cn(SEGMENTED_ITEM, 'min-h-8 flex-none py-1 disabled:opacity-50', DENSITY.coarse, active && SEGMENTED_ACTIVE_FILL)}
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
          <div className={cn('mt-3 border p-3', RADIUS_CONTROL, STATUS_SURFACE.error)}>
            <div className="flex items-start gap-2 flex-wrap sm:flex-nowrap">
              <AlertTriangle className={cn('w-4 h-4 shrink-0 mt-0.5', STATUS_INK.error)} />
              <div className="flex-1 min-w-[12rem]">
                <div className={cn('text-sm font-semibold', STATUS_INK.error)}>You've used all of your DreamStream usage. Continue with your own key?</div>
                <p className={`text-[11px] ${MUTED} mt-0.5`}>Your key's own limits still apply.</p>
              </div>
              <PrimaryBtn onClick={() => void applyPrefs({ byokFallbackMode: 'auto' })} disabled={saving}>Continue with my key</PrimaryBtn>
            </div>
          </div>
        ) : (
          <div className={cn('mt-3 flex items-start gap-2 border p-3', RADIUS_CONTROL, status.exhausted ? STATUS_SURFACE.error : STATUS_SURFACE.attention)}>
            <AlertTriangle className={cn('w-4 h-4 shrink-0 mt-0.5', status.exhausted ? STATUS_INK.error : STATUS_INK.attention)} />
            <div className={`text-xs ${INK}`}>
              {status.exhausted ? (
                status.byokFallbackMode === 'auto' && status.byokAvailable ? (
                  <>You've used all of your DreamStream usage — generation now runs on your own key{reset && <> until it comes back {reset}</>}.</>
                ) : reset ? (
                  <>You've used all of this month's DreamStream usage. Nothing more is spent until it comes back {reset}{!status.byokAvailable && <> — or add a key below to keep going now</>}.</>
                ) : (
                  <>{USAGE_EXHAUSTED_COPY}</>
                )
              ) : (
                <>Less than <span className="font-semibold">10%</span> of your DreamStream usage is left{reset ? <> — it comes back {reset}</> : <> — ask us for a top-up or add a key below when you need more</>}.</>
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
  const { user } = useAuth();
  const [syncStatus, setSyncStatus] = useState<'syncing' | 'failed' | null>(null);
  const [accountCheck, setAccountCheck] = useState<string | null>(null);
  const [checkingAccount, setCheckingAccount] = useState(false);
  const accountValidationRun = useRef(0);
  const meta = PROVIDER_META[provider];
  const def = getProviderDef(provider);
  const accountMeta = getAccountKeyMeta();
  const enabled = isProviderEnabled(provider);
  const providerKeys = keys.filter((k) => k.provider === provider);
  const active = providerKeys.find((k) => k.active);
  const hasKey = providerKeys.length > 0 || accountMeta.some((m) => m.provider === provider);
  const overLimit = active ? isOverLimit(active) : false;
  const accountSuffix = accountMeta.find((entry) => entry.provider === provider)?.suffix;

  useEffect(() => {
    accountValidationRun.current += 1;
    setAccountCheck(null);
    setCheckingAccount(false);
  }, [user?.id, provider, accountSuffix]);

  const syncActiveKey = async () => {
    if (!user) return;
    setSyncStatus('syncing');
    const result = await reconcileProviderMirror(user.id, provider);
    setSyncStatus(result === 'failed' ? 'failed' : null);
    onChange();
  };

  const onActiveKeyChange = () => {
    onChange();
    void syncActiveKey();
  };

  // A stored secret is not a verified connection. Keep these states distinct.
  const status: { label: string; state: StatusState } = !enabled
    ? { label: 'Off', state: 'waiting' }
    : overLimit
      ? { label: 'Limit reached', state: 'error' }
      : active && storedVerdict(active) === 'invalid'
        ? { label: 'Key rejected', state: 'error' }
        : active && storedVerdict(active) === 'valid'
          ? { label: 'Verified', state: 'healthy' }
          : { label: hasKey ? 'Key saved' : 'No key', state: 'waiting' };

  return (
    <div className={`${PANEL} overflow-hidden ${!enabled ? 'opacity-70' : ''}`}>
      <div className="w-full flex items-center gap-3 px-3.5 py-3">
        <button onClick={onToggleOpen} aria-expanded={open} className={cn('-my-1 flex min-w-0 flex-1 items-center gap-2.5 py-1 text-left', RADIUS_CONTROL, DENSITY.coarse, FOCUS_RING)}>
          {open ? <ChevronDown className={`w-4 h-4 shrink-0 ${MUTED}`} /> : <ChevronRight className={`w-4 h-4 shrink-0 ${MUTED}`} />}
          <span className={cn('grid size-6 shrink-0 place-items-center bg-[var(--ds-well)]', RADIUS_CONTROL)} style={{ color: def?.accent || 'var(--ds-muted)' }}>
            {hasProviderLogo(provider)
              ? <ProviderLogo provider={provider} className="w-4 h-4" title={meta.label} />
              : <span className="w-2.5 h-2.5 rounded-full" style={{ background: def?.accent || 'var(--ds-muted)' }} />}
          </span>
          <span className="min-w-0">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className={`min-w-0 max-w-full font-semibold text-sm truncate ${INK}`}>{meta.label}</span>
              {def?.freeTier && <span className={cn(CHIP, CHIP_VARIANT.filled)}>Free tier</span>}
            </span>
            <span className={`block text-[11px] ${MUTED} truncate`}>
              {active ? `Active: ${active.label}` : meta.hint}
            </span>
          </span>
        </button>

        {typeof count === 'number' && count > 0 && (
          <span className={`text-[11px] ${MUTED} shrink-0 hidden sm:inline tabular-nums`}>{count} model{count === 1 ? '' : 's'}</span>
        )}
        {/* Below sm a quiet "Off" / "No key" / "Key saved" is left to the switch and the hint, so the name keeps the row */}
        <span className={cn(statusChip(status.state), 'shrink-0', status.state === 'waiting' && 'hidden sm:inline-flex')}>{status.label}</span>

        {/* Governance on/off toggle */}
        <button
          role="switch"
          aria-label={`Enable ${meta.label}`}
          aria-checked={enabled}
          onClick={() => { setProviderEnabled(provider, !enabled); onChange(); }}
          title={enabled ? 'Source is on — turn off to ignore its keys everywhere' : 'Source is off — turn on to use it'}
          className={cn(
            'relative h-5 w-9 shrink-0 rounded-full motion-reduce:transition-none',
            "coarse:after:absolute coarse:after:left-1/2 coarse:after:top-1/2 coarse:after:h-[var(--ds-density-touch)] coarse:after:w-[var(--ds-density-touch)] coarse:after:-translate-x-1/2 coarse:after:-translate-y-1/2 coarse:after:content-['']",
            TRANSITION,
            FOCUS_RING,
            enabled ? 'bg-[var(--ds-accent-fill)]' : 'bg-[color:color-mix(in_srgb,var(--ds-ink)_18%,var(--ds-canvas))]'
          )}
        >
          <span className={`absolute top-0.5 w-4 h-4 rounded-full shadow-[shadow:var(--ds-shadow-segment)] motion-reduce:transition-none ${enabled ? 'bg-[var(--ds-on-accent)]' : 'bg-[var(--ds-raised)] dark:bg-[var(--ds-ink)]'} ${TRANSITION} ${enabled ? 'left-[18px]' : 'left-0.5'}`} />
        </button>
      </div>

      {open && (
        <div className="border-t border-[var(--ds-hairline)] p-3 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className={`text-[11px] ${MUTED} max-w-md`}>{meta.hint}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              <LinkPill href={meta.keysUrl} icon={<Key className="w-3 h-3" />} accent>Get a key</LinkPill>
              {def?.fundsUrl && <LinkPill href={def.fundsUrl} icon={<Wallet className="w-3 h-3" />}>Add funds</LinkPill>}
              {def?.docsUrl && <LinkPill href={def.docsUrl} icon={<BookOpen className="w-3 h-3" />}>Models</LinkPill>}
            </div>
          </div>
          {!hasKey && (
            <div className={cn('flex items-center gap-2 bg-[var(--ds-well)] px-3 py-2 text-[11px]', MUTED, HAIRLINE, RADIUS_CONTROL)}>
              <Sparkles className="w-3.5 h-3.5 shrink-0 text-[var(--ds-ink)]" aria-hidden="true" />
              Add a {meta.label} key to unlock its models. {def?.freeTier ? 'This provider has a free tier.' : 'Usage is billed to your key.'}
            </div>
          )}
          {providerKeys.map((k) => <KeyRow key={k.id} k={k} fundsUrl={def?.fundsUrl} onChange={onChange} onActiveKeyChange={onActiveKeyChange} />)}
          {!active && accountSuffix && (
            <div className={`space-y-2 text-xs ${MUTED}`}>
              <p>Your account has a saved key ending in {accountSuffix}. Each studio shows the models it supports.</p>
              <Button type="button" size="sm" variant="outline" disabled={checkingAccount || !user || !enabled} onClick={async () => {
                const id = ++accountValidationRun.current;
                setCheckingAccount(true);
                const { status } = await validateApiKey(provider);
                if (accountValidationRun.current !== id) return;
                setAccountCheck(ACCOUNT_CHECK_COPY[status] || KEY_CHECK_UNAVAILABLE_COPY);
                setCheckingAccount(false);
              }}>{checkingAccount ? 'Checking account key…' : 'Verify account key'}</Button>
              {accountCheck && <p role="status">{accountCheck}</p>}
            </div>
          )}
          <AddKeyForm provider={provider} onChange={onChange} onActiveKeyChange={onActiveKeyChange} />
          {syncStatus === 'syncing' && <p role="status" className={`text-xs ${MUTED}`}>Syncing the active key to your account…</p>}
          {syncStatus === 'failed' && (
            <div className="flex flex-wrap items-center gap-2">
              <p role="status" className={`text-xs ${MUTED}`}>This device is updated. Your account key could not sync.</p>
              <button type="button" onClick={() => void syncActiveKey()} className={cn('text-xs underline underline-offset-2', INK, RADIUS_CONTROL, DENSITY.coarse, FOCUS_RING)}>Retry sync</button>
            </div>
          )}
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
    const update = () => { setKeys(listKeys()); setGovVersion((v) => v + 1); };
    window.addEventListener(API_KEYS_CHANGED, update);
    window.addEventListener(SOURCE_GOVERNANCE_CHANGED, update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(API_KEYS_CHANGED, update);
      window.removeEventListener(SOURCE_GOVERNANCE_CHANGED, update);
      window.removeEventListener('storage', update);
    };
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
    tone === 'ok' ? statusChip('healthy') : tone === 'bad' ? statusChip('error') : cn(CHIP, CHIP_VARIANT.outline);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className={`text-sm ${MUTED} max-w-xl`}>
          Connect a provider to use its models. Bring your own key — pick the <span className={`font-semibold ${INK}`}>active</span> one,
          set an optional monthly limit, and turn any source on or off. Keys stay on this device (and sync to your account, encrypted).
        </p>
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Configuration summary">
          <span className={chip(`${connected} saved`, 'muted')}>{connected} providers with keys</span>
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
