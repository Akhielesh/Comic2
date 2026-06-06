// Code Studio settings — the dedicated panel for the studio's OWN coding model + build knobs,
// independent of the comics/chat model selection. Seamless by default (Auto free-first picks a
// proven coder); power users can pin any catalog model, choose the source (OpenRouter / NVIDIA),
// tune spend preference + creativity, and set the self-heal iteration budget and default scaffold.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Cpu, Sparkles, Zap, Search, Check, RotateCcw, Star, Code2, Crown, Users,
  Building2, MonitorSmartphone, Layout, Palette, Database, ShieldCheck, CheckCircle2
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useStudioTheme } from './kit';
import { useDialogA11y } from './kit/useDialogA11y';
import {
  fetchModelCatalog, loadCachedCatalog, sourceLabel, type CatalogModel
} from '../../services/modelCatalog';
import { domainStrength } from '../../services/modelDomains';
import {
  getStudioModelSelection, setStudioModel, setStudioAuto, setStudioSource,
  setStudioCostPref, setStudioCreativity, setStudioMaxIterations, setStudioDefaultTemplate,
  setStudioAgents, setStudioAgentPreferences, setStudioAutoRunAgents,
  resetStudioModelSelection, STUDIO_MODEL_CHANGED, STUDIO_MAX_ITERATIONS_CEILING,
  type StudioModelSelection, type StudioCostPref
} from '../../services/studioModelSelection';
import { STUDIO_AGENT_CATALOG, STUDIO_AGENT_ORDER, DEFAULT_STUDIO_AGENT_IDS } from '../../services/studioAgents';
import { CODING_RECOMMENDATIONS, TIER_LABEL, type CodingPick } from '../../services/codingRecommendations';
import type { ModelSourceId } from '../../services/modelSelection';

const COST_OPTIONS: { id: StudioCostPref; label: string; hint: string }[] = [
  { id: 'free', label: 'Free-first', hint: 'Best free coder; falls back to cheapest paid' },
  { id: 'cheap', label: 'Cheapest', hint: 'Lowest cost eligible coder' },
  { id: 'quality', label: 'Best quality', hint: 'Strongest coder (needs a funded key)' }
];

const SOURCE_OPTIONS: { id: ModelSourceId | 'auto'; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'nvidia', label: 'NVIDIA' }
];

const TEMPLATE_OPTIONS: { id: string; label: string }[] = [
  { id: '', label: 'Auto (let the AI choose)' },
  { id: 'react-ts', label: 'React + TypeScript' },
  { id: 'react', label: 'React (JS)' },
  { id: 'vanilla-ts', label: 'Vanilla + TypeScript' },
  { id: 'vanilla', label: 'Vanilla JS' },
  { id: 'static', label: 'Static HTML/CSS/JS' }
];

const AGENT_ICONS: Record<string, LucideIcon> = {
  Building2, Code2, MonitorSmartphone, Layout, Palette, Database, ShieldCheck, CheckCircle2
};

const isCoderText = (m: CatalogModel): boolean => !m.supportsImageOutput;

/** Map a curated recommendation to a concrete catalog model id, preferring free + the active source. */
const resolveRecommended = (pick: CodingPick, catalog: CatalogModel[], preferSource: ModelSourceId | null): { id: string; source: ModelSourceId } => {
  const hits = catalog.filter((m) => isCoderText(m) && pick.match.test(m.id.toLowerCase()));
  if (hits.length) {
    const ranked = [...hits].sort((a, b) => {
      const srcA = preferSource && a.source === preferSource ? 1 : 0;
      const srcB = preferSource && b.source === preferSource ? 1 : 0;
      if (srcA !== srcB) return srcB - srcA;
      if (a.isFree !== b.isFree) return a.isFree ? -1 : 1; // free first
      return domainStrength(b, 'coding') - domainStrength(a, 'coding');
    });
    return { id: ranked[0].id, source: ranked[0].source };
  }
  // Not in the live catalog — fall back to the curated representative id.
  if (preferSource === 'nvidia' && pick.nvidiaId) return { id: pick.nvidiaId, source: 'nvidia' };
  if (pick.openrouterId) return { id: pick.openrouterId, source: 'openrouter' };
  if (pick.nvidiaId) return { id: pick.nvidiaId, source: 'nvidia' };
  return { id: pick.key, source: 'openrouter' };
};

export const StudioSettingsPanel: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const t = useStudioTheme();
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(open, onClose);
  useEffect(() => { if (open) dialogRef.current?.focus(); }, [open]);

  const [sel, setSel] = useState<StudioModelSelection>(() => getStudioModelSelection());
  const [models, setModels] = useState<CatalogModel[]>(() => loadCachedCatalog()?.models ?? []);
  const [query, setQuery] = useState('');

  // Keep in sync with the store (changes can come from the leaderboard "Use in Studio" too).
  useEffect(() => {
    const onChange = () => setSel(getStudioModelSelection());
    window.addEventListener(STUDIO_MODEL_CHANGED, onChange);
    return () => window.removeEventListener(STUDIO_MODEL_CHANGED, onChange);
  }, []);

  // Refresh the live catalog when the panel opens (paint instantly from cache meanwhile).
  useEffect(() => {
    if (!open) return;
    let active = true;
    fetchModelCatalog().then((res) => { if (active) setModels(res.models); }).catch(() => {});
    return () => { active = false; };
  }, [open]);

  const coders = useMemo(() => {
    const list = models.filter(isCoderText);
    const q = query.trim().toLowerCase();
    const filtered = q ? list.filter((m) => `${m.name} ${m.id}`.toLowerCase().includes(q)) : list;
    return [...filtered].sort((a, b) => {
      const ca = domainStrength(a, 'coding');
      const cb = domainStrength(b, 'coding');
      if (cb !== ca) return cb - ca;
      if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
      return a.name.localeCompare(b.name);
    }).slice(0, 60);
  }, [models, query]);

  const activeSource: ModelSourceId | null = sel.source;
  const pickRecommended = (pick: CodingPick) => {
    const { id, source } = resolveRecommended(pick, models, activeSource);
    setStudioModel(id, source);
  };

  // Enabled refinement agents (stored explicitly, else the default team).
  const enabledAgents = useMemo(() => new Set(sel.agents ?? DEFAULT_STUDIO_AGENT_IDS), [sel.agents]);
  const toggleAgent = (id: string) => {
    const next = new Set(sel.agents ?? DEFAULT_STUDIO_AGENT_IDS);
    if (next.has(id)) next.delete(id); else next.add(id);
    setStudioAgents(STUDIO_AGENT_ORDER.filter((x) => next.has(x)));
  };

  if (!open || typeof document === 'undefined') return null;

  const card = `rounded-lg border ${t.edge} ${t.panelAlt} p-3`;
  const chip = (activeCond: boolean) =>
    `rounded-full border px-3 py-1.5 text-xs font-bold transition-colors ${t.focusRing} ${
      activeCond ? `${t.edgeStrong} ${t.accentSoft} ${t.accent}` : `${t.edge} ${t.textDim} ${t.hover}`
    }`;

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Code Studio settings"
        aria-modal="true"
        className={`studio-pop w-full max-w-2xl max-h-[88vh] overflow-auto rounded-xl border ${t.edgeStrong} ${t.panel} ${t.text} shadow-2xl focus:outline-none`}
      >
        {/* Header */}
        <div className={`sticky top-0 z-10 flex items-center gap-2 px-4 py-3 border-b ${t.edge} ${t.panel} font-bold`}>
          <Cpu className={`w-4 h-4 ${t.accent}`} /> Code Studio settings
          <button
            onClick={onClose}
            className={`ml-auto text-xs font-semibold rounded-full border ${t.edge} px-2.5 py-1 ${t.textDim} ${t.hover} ${t.focusRing}`}
          >
            Done
          </button>
        </div>

        <div className="p-4 space-y-4">
          <p className={`text-xs ${t.textDim}`}>
            Code Studio uses its <span className="font-bold">own</span> coding model — separate from the model your
            comics &amp; chat use. Leave it on <span className="font-bold">Auto</span> for a seamless, free-first build, or pin a
            specific model below.
          </p>

          {/* Coding model: Auto vs Specific */}
          <section className={card}>
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className={`w-4 h-4 ${t.accent}`} />
              <span className="text-sm font-bold">Coding model</span>
            </div>
            <div className="flex gap-2 mb-3">
              <button onClick={() => setStudioAuto()} className={chip(sel.mode === 'auto')}>
                <Zap className="inline w-3 h-3 mr-1" /> Auto (free-first)
              </button>
              <button
                onClick={() => { if (sel.mode !== 'specific') { /* keep current model if any */ setSel(getStudioModelSelection()); } }}
                className={chip(sel.mode === 'specific')}
                title="Pick a specific model below"
              >
                <Code2 className="inline w-3 h-3 mr-1" /> Specific model
              </button>
            </div>

            {sel.mode === 'specific' && sel.model && (
              <div className={`mb-3 flex items-center gap-2 rounded-lg border ${t.edgeStrong} ${t.accentSoft} px-3 py-2 text-xs`}>
                <Check className={`w-4 h-4 ${t.accent}`} />
                <span className="font-bold truncate">{sel.model}</span>
                {sel.source && <span className={`ml-auto ${t.textDim}`}>via {sourceLabel(sel.source)}</span>}
              </div>
            )}

            {/* Recommended coders (curated) */}
            <div className={`text-[11px] font-bold uppercase ${t.textFaint} mb-1.5`}>Recommended coders</div>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {CODING_RECOMMENDATIONS.slice(0, 8).map((p) => (
                <button
                  key={p.key}
                  onClick={() => pickRecommended(p)}
                  title={`${p.blurb}${p.swebench ? ` · ~${p.swebench}% SWE-bench` : ''} · ${TIER_LABEL[p.tier]}`}
                  className={`inline-flex items-center gap-1 rounded-full border ${t.edge} px-2.5 py-1 text-[11px] font-semibold ${t.textDim} ${t.hover} ${t.focusRing}`}
                >
                  {p.tier === 'flagship' && <Crown className="w-3 h-3 text-amber-400" />}
                  {p.label}
                  {p.hasFreeVariant && <span className="text-emerald-400 font-bold">·free</span>}
                </button>
              ))}
            </div>

            {/* Full catalog picker */}
            <div className={`flex items-center gap-2 rounded-lg border ${t.edge} ${t.panel} px-2.5 py-1.5 mb-2`}>
              <Search className={`w-3.5 h-3.5 ${t.textFaint}`} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search all models (e.g. qwen3-coder, deepseek, glm)…"
                className={`flex-1 bg-transparent text-xs outline-none ${t.text} placeholder:${t.textFaint}`}
              />
            </div>
            <div className={`max-h-56 overflow-auto rounded-lg border ${t.edge} divide-y divide-white/5`}>
              {coders.length === 0 && (
                <div className={`px-3 py-4 text-xs ${t.textDim}`}>No models loaded yet — they’ll appear once the catalog loads.</div>
              )}
              {coders.map((m) => {
                const score = domainStrength(m, 'coding');
                const active = sel.mode === 'specific' && sel.model === m.id;
                return (
                  <button
                    key={`${m.source}:${m.id}`}
                    onClick={() => setStudioModel(m.id, m.source)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-left ${active ? t.accentSoft : t.hover} ${t.focusRing}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-bold truncate">{m.name}</span>
                      <span className={`block text-[10px] truncate ${t.textFaint}`}>{m.id}</span>
                    </span>
                    {m.isFree && <span className="text-[10px] font-bold text-emerald-400">FREE</span>}
                    <span className={`text-[10px] ${t.textDim}`}>{sourceLabel(m.source)}</span>
                    {score > 0 && (
                      <span className={`text-[10px] font-bold ${t.accent}`} title="Coding strength (HumanEval + SWE-bench)">
                        {score}
                      </span>
                    )}
                    {active && <Check className={`w-4 h-4 ${t.accent}`} />}
                  </button>
                );
              })}
            </div>
          </section>

          {/* Source */}
          <section className={card}>
            <div className="text-sm font-bold mb-2">Source</div>
            <div className="flex gap-2">
              {SOURCE_OPTIONS.map((o) => {
                const active = o.id === 'auto' ? !sel.source : sel.source === o.id;
                return (
                  <button
                    key={o.id}
                    onClick={() => setStudioSource(o.id === 'auto' ? null : (o.id as ModelSourceId))}
                    className={chip(active)}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
            <p className={`mt-2 text-[11px] ${t.textFaint}`}>Where to route the coding model. Auto prefers your OpenRouter key, then NVIDIA.</p>
          </section>

          {/* Spend preference */}
          <section className={card}>
            <div className="text-sm font-bold mb-2">Spend preference (Auto)</div>
            <div className="flex flex-wrap gap-2">
              {COST_OPTIONS.map((o) => (
                <button key={o.id} onClick={() => setStudioCostPref(o.id)} title={o.hint} className={chip(sel.costPref === o.id)}>
                  {o.label}
                </button>
              ))}
            </div>
          </section>

          {/* Creativity + iterations */}
          <section className={`${card} grid sm:grid-cols-2 gap-4`}>
            <div>
              <div className="flex items-center justify-between text-sm font-bold mb-1">
                <span>Creativity</span><span className={`text-xs font-mono ${t.accent}`}>{sel.creativity.toFixed(2)}</span>
              </div>
              <input
                type="range" min={0} max={1} step={0.05} value={sel.creativity}
                onChange={(e) => setStudioCreativity(parseFloat(e.target.value))}
                className="w-full accent-violet-500"
              />
              <p className={`text-[11px] ${t.textFaint}`}>Lower = precise &amp; deterministic. Higher = more inventive.</p>
            </div>
            <div>
              <div className="flex items-center justify-between text-sm font-bold mb-1">
                <span>Self-heal iterations</span><span className={`text-xs font-mono ${t.accent}`}>{sel.maxIterations}</span>
              </div>
              <input
                type="range" min={1} max={STUDIO_MAX_ITERATIONS_CEILING} step={1} value={sel.maxIterations}
                onChange={(e) => setStudioMaxIterations(parseInt(e.target.value, 10))}
                className="w-full accent-violet-500"
              />
              <p className={`text-[11px] ${t.textFaint}`}>How many times the build loop may fix its own errors.</p>
            </div>
          </section>

          {/* Default template */}
          <section className={card}>
            <div className="text-sm font-bold mb-2">Default scaffold for new apps</div>
            <select
              value={sel.defaultTemplate ?? ''}
              onChange={(e) => setStudioDefaultTemplate(e.target.value || null)}
              className={`w-full rounded-lg border ${t.edge} ${t.panel} ${t.text} text-xs px-2.5 py-2 ${t.focusRing}`}
            >
              {TEMPLATE_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </section>

          {/* AI agent team — which specialists run on "Refine with agent team". */}
          <section className={card}>
            <div className="flex items-center gap-2 mb-1">
              <Users className={`w-4 h-4 ${t.accent}`} />
              <span className="text-sm font-bold">AI agent team</span>
              <span className={`ml-auto text-[11px] ${t.textFaint}`}>{enabledAgents.size} selected</span>
            </div>
            <p className={`text-[11px] ${t.textFaint} mb-2`}>
              Pick which specialists run (in order) when you click <span className="font-semibold">Refine with agent team</span>. The
              Data agent uses live web tools to wire real data into your app.
            </p>
            <div className="grid sm:grid-cols-2 gap-1.5">
              {STUDIO_AGENT_CATALOG.map((a) => {
                const Icon = AGENT_ICONS[a.icon] ?? Code2;
                const on = enabledAgents.has(a.id);
                return (
                  <button
                    key={a.id}
                    onClick={() => toggleAgent(a.id)}
                    title={a.description}
                    className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${t.focusRing} ${
                      on ? `${t.edgeStrong} ${t.accentSoft}` : `${t.edge} ${t.hover}`
                    }`}
                  >
                    <span className={`mt-0.5 shrink-0 h-4 w-4 rounded border flex items-center justify-center ${on ? `${t.accentBg} ${t.accentText}` : t.edge}`}>
                      {on && <Check className="w-3 h-3" />}
                    </span>
                    <Icon className={`w-4 h-4 shrink-0 ${on ? t.accent : t.textFaint}`} />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1 text-xs font-bold">
                        {a.name}
                        {a.hasTools && <span className="text-[9px] font-bold uppercase text-emerald-400">live</span>}
                      </span>
                      <span className={`block text-[10px] leading-tight ${t.textFaint}`}>{a.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex gap-2">
              <button onClick={() => setStudioAgents(STUDIO_AGENT_ORDER)} className={chip(false)}>Select all</button>
              <button onClick={() => setStudioAgents(DEFAULT_STUDIO_AGENT_IDS)} className={chip(false)}>Default team</button>
            </div>
            <textarea
              value={sel.agentPreferences ?? ''}
              onChange={(e) => setStudioAgentPreferences(e.target.value)}
              placeholder="Optional preferences for the agents — e.g. 'use Tailwind, keep it minimal, target mobile, prefer free APIs'."
              rows={2}
              className={`mt-2 w-full rounded-lg border ${t.edge} ${t.panel} ${t.text} text-xs px-2.5 py-2 ${t.focusRing} resize-y`}
            />
            <label className="mt-2 flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={sel.autoRunAgents === true}
                onChange={(e) => setStudioAutoRunAgents(e.target.checked)}
                className="mt-0.5 accent-violet-500"
              />
              <span className="min-w-0">
                <span className="text-xs font-bold">Auto-run the team after each new build</span>
                <span className={`block text-[10px] ${t.textFaint}`}>Seamless mode: every brand-new app is immediately refined by your selected agents. Off = run on demand.</span>
              </span>
            </label>
          </section>

          {/* Footer */}
          <div className="flex items-center justify-between pt-1">
            <button
              onClick={() => resetStudioModelSelection()}
              className={`inline-flex items-center gap-1.5 text-xs font-semibold rounded-full border ${t.edge} px-3 py-1.5 ${t.textDim} ${t.hover} ${t.focusRing}`}
            >
              <RotateCcw className="w-3.5 h-3.5" /> Reset to defaults
            </button>
            <span className={`text-[11px] ${t.textFaint} inline-flex items-center gap-1`}>
              <Star className="w-3 h-3" /> Independent of comics &amp; chat
            </span>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
