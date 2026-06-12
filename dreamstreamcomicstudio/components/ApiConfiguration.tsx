import React, { useEffect, useState } from 'react';
import { Key, Plus, Trash2, Check, AlertTriangle, ExternalLink, Pencil, X, ChevronDown, ChevronRight, Shield, Power, Loader2, ShieldCheck, ShieldX, ShieldQuestion, RefreshCw } from 'lucide-react';
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
  isOverLimit
} from '../services/apiKeys';
import { isProviderEnabled, setProviderEnabled } from '../services/sourceGovernance';
import { validateApiKey } from '../services/keyValidation';
import { listMcpServers, addMcpServer, removeMcpServer } from '../services/mcpServers';
import { Server } from 'lucide-react';
import type { McpServerConfig } from '../apiTypes';
import { Button } from './Button';
import { ModelSelectionPanel } from './ModelSelectionPanel';
import { useAuth } from '../contexts/AuthContext';
import { reconcileProviderMirror, syncByokKeyToServer } from '../services/byokSync';

// Manage custom remote MCP servers (their tools appear as connectors in the chat).
const McpServersPanel: React.FC = () => {
  const [servers, setServers] = useState<McpServerConfig[]>(() => listMcpServers());
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [auth, setAuth] = useState('');
  const refresh = () => setServers(listMcpServers());

  const add = () => {
    if (!url.trim()) return;
    addMcpServer({ name: name.trim() || 'MCP server', url: url.trim(), authorization: auth.trim() || undefined });
    setName('');
    setUrl('');
    setAuth('');
    refresh();
  };

  const urlValid = !url.trim() || /^https:\/\//i.test(url.trim());

  return (
    <div className="bg-white border-2 border-black rounded-xl shadow-comic p-4">
      <div className="flex items-center gap-2">
        <Server className="w-4 h-4" />
        <h4 className="font-bold">Custom MCP servers</h4>
      </div>
      <p className="text-[11px] text-slate-500 mt-1 mb-3">
        Add your own remote MCP servers (https). Their tools appear as connectors in the chat composer
        and the model can call them. Stored on this device.
      </p>

      {servers.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {servers.map((s) => (
            <div key={s.id} className="flex items-center gap-2 border-2 border-black rounded-lg px-2.5 py-1.5">
              <Server className="w-3.5 h-3.5 shrink-0 text-violet-600" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold truncate">{s.name}</span>
                <span className="block text-[10px] text-slate-500 truncate">{s.url}{s.headers?.Authorization ? ' · auth' : ''}</span>
              </span>
              <button onClick={() => { removeMcpServer(s.id); refresh(); }} className="p-1.5 border-2 border-black rounded hover:bg-red-100 text-red-600" title="Remove"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. My Tools)" className="border-2 border-black rounded px-2 py-1.5 text-sm" />
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://server.example.com/mcp" className={`border-2 rounded px-2 py-1.5 text-sm font-mono ${urlValid ? 'border-black' : 'border-brand-red'}`} />
        <input value={auth} onChange={(e) => setAuth(e.target.value)} placeholder="Authorization header (optional, e.g. Bearer …)" className="border-2 border-black rounded px-2 py-1.5 text-sm font-mono sm:col-span-2" />
      </div>
      {!urlValid && <p className="text-[11px] text-brand-red font-bold mt-1">MCP server URL must start with https://</p>}
      <div className="flex justify-end mt-2">
        <Button onClick={add} size="sm" disabled={!url.trim() || !urlValid} icon={<Plus size={14} />}>Add server</Button>
      </div>
    </div>
  );
};

// Re-validate a key if we've never checked it or the last check is older than this.
const VALIDATION_STALE_MS = 10 * 60 * 1000; // 10 minutes

/** Validate one stored key against its provider and persist the verdict. */
const runValidation = async (k: ManagedApiKey): Promise<void> => {
  const r = await validateApiKey(k.provider, k.key);
  const state = r.status === 'missing' ? 'invalid' : r.status;
  setKeyValidation(k.id, state, r.message);
};

const ValidationBadge: React.FC<{ k: ManagedApiKey; checking: boolean }> = ({ k, checking }) => {
  if (checking) {
    return (
      <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border border-black bg-slate-100 text-slate-600 flex items-center gap-1">
        <Loader2 className="w-3 h-3 animate-spin" /> Checking
      </span>
    );
  }
  const state = k.validation ?? 'unknown';
  const title = k.validationMessage || '';
  if (state === 'valid') {
    return <span title={title} className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border border-black bg-green-100 text-green-800 flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> Valid</span>;
  }
  if (state === 'invalid') {
    return <span title={title} className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border border-black bg-brand-red text-white flex items-center gap-1"><ShieldX className="w-3 h-3" /> Invalid</span>;
  }
  if (state === 'unsupported') {
    return <span title={title} className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border border-black bg-slate-100 text-slate-500 flex items-center gap-1"><ShieldQuestion className="w-3 h-3" /> Not verifiable</span>;
  }
  return <span title={title} className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border border-black bg-slate-100 text-slate-500 flex items-center gap-1"><ShieldQuestion className="w-3 h-3" /> Unchecked</span>;
};

const mask = (key: string) => (key.length > 8 ? `${key.slice(0, 3)}••••${key.slice(-4)}` : '••••');

const usageColor = (frac: number) =>
  frac >= 1 ? 'bg-brand-red' : frac >= 0.8 ? 'bg-brand-yellow' : 'bg-green-500';

const UsageMeter: React.FC<{ k: ManagedApiKey }> = ({ k }) => {
  if (!k.limitUsd || k.limitUsd <= 0) {
    return <div className="text-[11px] text-slate-500">No limit · ${k.usedUsd.toFixed(2)} used this month</div>;
  }
  const frac = usageFraction(k);
  const pct = Math.min(100, Math.round(frac * 100));
  return (
    <div className="space-y-1" title={`$${k.usedUsd.toFixed(4)} of $${k.limitUsd.toFixed(2)} used this month (${Math.round(frac * 100)}%)`}>
      <div className="h-2 w-full bg-slate-200 rounded-full overflow-hidden border border-black/20">
        <div className={`h-full ${usageColor(frac)}`} style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <div className="flex items-center justify-between text-[11px] text-slate-600">
        <span>${k.usedUsd.toFixed(2)} / ${k.limitUsd.toFixed(2)}</span>
        <span className={frac >= 1 ? 'font-bold text-brand-red' : ''}>
          {Math.round(frac * 100)}%{frac >= 1 ? ' · blocked' : ''}
        </span>
      </div>
    </div>
  );
};

const KeyRow: React.FC<{ k: ManagedApiKey; onChange: () => void }> = ({ k, onChange }) => {
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

  // Validate on mount when we've never checked this key, or the last check is stale.
  useEffect(() => {
    const stale = !k.validatedAt || Date.now() - k.validatedAt > VALIDATION_STALE_MS;
    if (stale) void verify();
    // Re-run only when the key value changes (a new/edited secret needs a fresh check).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k.id, k.key]);

  const save = () => {
    updateKey(k.id, { label, limitUsd: limit.trim() ? Number(limit) : null });
    setEditing(false);
    onChange();
  };

  return (
    <div className={`border-2 rounded-lg p-3 ${k.active ? 'border-black bg-brand-yellow/10' : 'border-slate-300 bg-white'}`}>
      <div className="flex items-start gap-3">
        <button
          onClick={() => { setActiveKey(k.id); void reconcileProviderMirror(k.provider); onChange(); }}
          title={k.active ? 'Active key' : 'Set as active'}
          className={`mt-0.5 w-5 h-5 shrink-0 rounded-full border-2 border-black flex items-center justify-center ${k.active ? 'bg-brand-blue text-white' : 'bg-white'}`}
        >
          {k.active && <Check className="w-3 h-3" />}
        </button>

        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full border-2 border-black rounded px-2 py-1 text-sm font-bold mb-2"
              placeholder="Key label"
            />
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-bold text-sm truncate">{k.label}</span>
              {k.active && <span className="text-[10px] font-bold uppercase bg-brand-blue text-white px-1.5 py-0.5 rounded border border-black">Active</span>}
              <ValidationBadge k={k} checking={checking} />
              {isOverLimit(k) && <span className="text-[10px] font-bold uppercase bg-brand-red text-white px-1.5 py-0.5 rounded border border-black flex items-center gap-1"><AlertTriangle className="w-3 h-3" />Limit reached</span>}
            </div>
          )}
          <div className="text-[11px] font-mono text-slate-500 mt-0.5">{mask(k.key)}</div>
          {!editing && !checking && k.validation === 'invalid' && k.validationMessage && (
            <div className="text-[11px] text-brand-red font-semibold mt-0.5 flex items-start gap-1">
              <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />{k.validationMessage}
            </div>
          )}

          <div className="mt-2">
            {editing ? (
              <label className="text-[11px] font-bold uppercase text-slate-600 flex items-center gap-2">
                Monthly limit (USD)
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  placeholder="none"
                  className="w-24 border-2 border-black rounded px-2 py-1 text-sm font-mono"
                />
              </label>
            ) : (
              <UsageMeter k={k} />
            )}
          </div>
        </div>

        <div className="flex gap-1 shrink-0">
          {editing ? (
            <>
              <button onClick={save} title="Save" className="p-1.5 border-2 border-black rounded hover:bg-brand-yellow"><Check className="w-3.5 h-3.5" /></button>
              <button onClick={() => { setEditing(false); setLabel(k.label); setLimit(k.limitUsd != null ? String(k.limitUsd) : ''); }} title="Cancel" className="p-1.5 border-2 border-black rounded hover:bg-slate-100"><X className="w-3.5 h-3.5" /></button>
            </>
          ) : (
            <>
              <button onClick={verify} disabled={checking} title="Verify key is valid" className="p-1.5 border-2 border-black rounded hover:bg-brand-yellow disabled:opacity-40"><RefreshCw className={`w-3.5 h-3.5 ${checking ? 'animate-spin' : ''}`} /></button>
              <button onClick={() => setEditing(true)} title="Edit label / limit" className="p-1.5 border-2 border-black rounded hover:bg-brand-yellow"><Pencil className="w-3.5 h-3.5" /></button>
              <button onClick={() => { if (confirm(`Delete "${k.label}"?`)) { deleteKey(k.id); void reconcileProviderMirror(k.provider); onChange(); } }} title="Delete key" className="p-1.5 border-2 border-black rounded hover:bg-red-100 text-red-600"><Trash2 className="w-3.5 h-3.5" /></button>
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

    // Mirror to the cloud via the server, which encrypts with a server-only secret
    // (so the key survives sign-out → sign-in without the old hardcoded-secret weakness).
    if (user) await syncByokKeyToServer(provider, key.trim());

    setLabel(''); setKey(''); setLimit('');
    onChange();
  };

  return (
    <div className="border-2 border-dashed border-slate-400 rounded-lg p-3 space-y-2 bg-slate-50">
      <div className="flex flex-col sm:flex-row gap-2">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. Personal)" className="flex-1 border-2 border-black rounded px-2 py-1.5 text-sm" />
        <input type="number" min={0} step="0.01" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="Limit $/mo (optional)" className="w-full sm:w-40 border-2 border-black rounded px-2 py-1.5 text-sm font-mono" />
      </div>
      <div className="flex gap-2">
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={`Paste ${PROVIDER_META[provider].label} API key`} className="flex-1 border-2 border-black rounded px-2 py-1.5 text-sm font-mono" />
        <Button size="sm" onClick={() => void add()} icon={<Plus size={14} />} disabled={!key.trim()}>Add</Button>
      </div>
    </div>
  );
};

/** Compact usage chip shown in a collapsed provider header. */
const HeaderUsage: React.FC<{ k: ManagedApiKey }> = ({ k }) => {
  if (!k.limitUsd || k.limitUsd <= 0) return <span className="text-[11px] text-slate-500">${k.usedUsd.toFixed(2)}</span>;
  const pct = Math.round(usageFraction(k) * 100);
  const color = pct >= 100 ? 'text-brand-red' : pct >= 80 ? 'text-amber-600' : 'text-slate-600';
  return <span className={`text-[11px] font-bold ${color}`}>{pct}%</span>;
};

// Central "allowed sources" governance — turn a source off and its keys (yours AND
// the platform's) are ignored everywhere, so nothing uses it by accident.
const SourceGovernancePanel: React.FC<{ onChange: () => void }> = ({ onChange }) => {
  const enabledCount = ALL_PROVIDERS.filter(isProviderEnabled).length;
  return (
    <div className="bg-white border-2 border-black rounded-xl shadow-comic p-4">
      <div className="flex items-center gap-2">
        <Shield className="w-4 h-4" />
        <h4 className="font-bold">Allowed sources</h4>
      </div>
      <p className="text-[11px] text-slate-500 mt-1 mb-3">
        Turn a source off to be sure neither you nor the app uses it — its keys (yours and the
        platform's) are ignored across the whole app.{' '}
        {enabledCount === 0 && <span className="text-brand-red font-bold">All sources are off — AI features won't work.</span>}
      </p>
      <div className="grid sm:grid-cols-2 gap-2">
        {ALL_PROVIDERS.map((provider) => {
          const on = isProviderEnabled(provider);
          return (
            <button
              key={provider}
              onClick={() => { setProviderEnabled(provider, !on); onChange(); }}
              className={`flex items-center justify-between gap-2 border-2 border-black rounded-lg px-3 py-2 transition-colors ${on ? 'bg-green-50 hover:bg-green-100' : 'bg-slate-100 hover:bg-slate-200'}`}
            >
              <span className="flex items-center gap-2 min-w-0">
                <Power className={`w-3.5 h-3.5 shrink-0 ${on ? 'text-green-600' : 'text-slate-400'}`} />
                <span className="font-bold text-sm truncate">{PROVIDER_META[provider].label}</span>
              </span>
              <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full border-2 border-black shrink-0 ${on ? 'bg-green-300' : 'bg-white text-slate-500'}`}>
                {on ? 'On' : 'Off'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export const ApiConfiguration: React.FC = () => {
  const [keys, setKeys] = useState<ManagedApiKey[]>(() => listKeys());
  const [, setGovVersion] = useState(0);
  // Open the first provider that has no key yet, to nudge first-time setup.
  const [open, setOpen] = useState<ApiKeyProvider | null>(() => {
    const initial = listKeys();
    return ALL_PROVIDERS.find((p) => !initial.some((k) => k.provider === p)) ?? null;
  });
  const refresh = () => setKeys(listKeys());

  // Periodic re-validation while the panel is open: a key can be revoked or run out of
  // credits at any time, so we don't trust a one-time check. Each KeyRow validates itself
  // on mount; this keeps verdicts fresh on a rolling interval thereafter.
  useEffect(() => {
    const id = setInterval(async () => {
      const current = listKeys();
      await Promise.all(current.map((k) => runValidation(k)));
      setKeys(listKeys());
    }, VALIDATION_STALE_MS);
    return () => clearInterval(id);
  }, []);

  const enabledProviders = ALL_PROVIDERS.filter(isProviderEnabled).length;
  const validKeys = keys.filter((k) => k.validation === 'valid').length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-slate-600 max-w-xl">
          Bring your own keys. Click a provider to add keys, pick the{' '}
          <span className="font-bold">active</span> one, and set an optional monthly limit
          (generation is blocked on a key once it hits its limit). Keys stay on this device.
        </p>
        <div className="flex items-center gap-2 text-[11px] font-bold shrink-0" aria-label="Configuration summary">
          <span className={`px-2.5 py-1 rounded-full border-2 border-black ${enabledProviders > 0 ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-700'}`}>
            {enabledProviders}/{ALL_PROVIDERS.length} sources on
          </span>
          <span className="px-2.5 py-1 rounded-full border-2 border-black bg-slate-100 text-slate-700">
            {keys.length} key{keys.length === 1 ? '' : 's'}
          </span>
          <span className={`px-2.5 py-1 rounded-full border-2 border-black ${validKeys > 0 ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-500'}`}>
            {validKeys} valid
          </span>
        </div>
      </div>

      <SourceGovernancePanel onChange={() => setGovVersion((v) => v + 1)} />

      <div className="pt-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">Provider keys</div>

      {ALL_PROVIDERS.map((provider) => {
        const meta = PROVIDER_META[provider];
        const providerKeys = keys.filter((k) => k.provider === provider);
        const active = providerKeys.find((k) => k.active);
        const isOpen = open === provider;
        const sourceOff = !isProviderEnabled(provider);
        return (
          <div key={provider} className="bg-white border-2 border-black rounded-xl shadow-comic overflow-hidden">
            <button
              onClick={() => setOpen(isOpen ? null : provider)}
              className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-brand-yellow/10 transition-colors text-left"
            >
              <div className="flex items-center gap-2 min-w-0">
                {isOpen ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
                <Key className="w-4 h-4 shrink-0" />
                <span className="font-bold truncate">{meta.label}</span>
                <span className="text-[10px] font-bold uppercase text-slate-500 bg-slate-100 border border-slate-300 rounded px-1.5 py-0.5 shrink-0">
                  {providerKeys.length} key{providerKeys.length === 1 ? '' : 's'}
                </span>
                {sourceOff && (
                  <span className="text-[10px] font-bold uppercase text-slate-600 bg-slate-200 border border-slate-400 rounded px-1.5 py-0.5 shrink-0">
                    Source off
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {active ? (
                  <span className="hidden sm:flex items-center gap-1.5 text-[11px]">
                    <span className="text-slate-400">active:</span>
                    <span className="font-semibold max-w-[8rem] truncate">{active.label}</span>
                    <HeaderUsage k={active} />
                  </span>
                ) : (
                  <span className="text-[11px] text-slate-400">not configured</span>
                )}
              </div>
            </button>

            {isOpen && (
              <div className="border-t-2 border-black p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-slate-500">{meta.hint}</p>
                  <a href={meta.keysUrl} target="_blank" rel="noreferrer" className="text-[11px] font-bold text-brand-blue underline flex items-center gap-1 shrink-0">
                    Get a key <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
                {providerKeys.map((k) => <KeyRow key={k.id} k={k} onChange={refresh} />)}
                <AddKeyForm provider={provider} onChange={refresh} />
              </div>
            )}
          </div>
        );
      })}

      <div className="pt-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">Connectors</div>
      <McpServersPanel />

      <div className="pt-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">Default models</div>
      <ModelSelectionPanel />
    </div>
  );
};
