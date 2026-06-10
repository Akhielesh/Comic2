import React, { useEffect, useRef, useState } from 'react';
import {
  BookOpen, Play, Plus, Trash2, Pencil, Check, X, ArrowLeft, Loader2,
  Network, Bot, Wrench, Sparkles, ChefHat, AlertTriangle
} from 'lucide-react';
import { RecipeCard } from './artifacts/RecipeCard';
import { ChatMarkdown } from './ChatMarkdown';
import { ChatArtifacts } from './artifacts/ChatArtifacts';
import { BUILTIN_AGENTS, AGENT_TOOLS } from '../../services/chatAgents';
import {
  listRecipes, saveRecipe, deleteRecipe, runRecipe,
  type StoredRecipe, type RecipeLibrary
} from '../../services/recipes';
import type { RecipeCardArtifact, RecipeParameterView, ChatArtifact } from '../../apiTypes';

// The Recipe Studio: browse the built-in + saved recipes, run any of them with a
// parameter form (live-streamed), and author new ones. Recipes are reusable,
// parameterized agent workflows — the "skills" the agents grow and reuse.

type View =
  | { kind: 'browse' }
  | { kind: 'run'; recipe: StoredRecipe }
  | { kind: 'edit'; recipe: RecipeCardArtifact };

const blankRecipe = (): RecipeCardArtifact => ({
  title: '',
  description: '',
  instructions: '',
  prompt: '',
  parameters: [],
  tools: [],
  agents: [],
  swarm: false
});

// Calm-studio form controls shared across the run panel + editor.
const INPUT_CLS =
  'w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm text-[#1a1915] outline-none transition-colors duration-200 focus:border-black/20';
const BTN_PRIMARY =
  'flex items-center gap-1 rounded-lg bg-[#D97757] px-4 py-2 text-sm font-semibold text-white transition-colors duration-200 hover:bg-[#c2643f] disabled:opacity-40';
const BTN_SECONDARY =
  'flex items-center gap-1 rounded-lg border border-black/10 bg-white/70 px-4 py-2 text-sm font-semibold text-[#1a1915] transition-colors duration-200 hover:bg-black/5';

export const RecipeStudio: React.FC<{ userId?: string }> = ({ userId }) => {
  const [lib, setLib] = useState<RecipeLibrary>({ builtins: [], custom: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: 'browse' });

  const refresh = () => {
    setLoading(true);
    listRecipes()
      .then((l) => { setLib(l); setLoadError(null); })
      .catch((e) => setLoadError(e?.message || 'Could not load recipes.'))
      .finally(() => setLoading(false));
  };
  useEffect(refresh, []);

  const onSave = async (recipe: RecipeCardArtifact) => {
    await saveRecipe(recipe);
    setView({ kind: 'browse' });
    refresh();
  };
  const onDelete = async (slug?: string) => {
    if (!slug) return;
    await deleteRecipe(slug).catch(() => {});
    refresh();
  };

  if (view.kind === 'run') {
    return <RunPanel recipe={view.recipe} onBack={() => setView({ kind: 'browse' })} />;
  }
  if (view.kind === 'edit') {
    return <RecipeEditor recipe={view.recipe} onSave={onSave} onCancel={() => setView({ kind: 'browse' })} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-[#6e6a60]">
          <span className="font-semibold text-[#1a1915]">Recipes</span> are reusable, parameterized agent workflows. Run a built-in,
          save your own, and the agents can run &amp; create them mid-chat (<code className="text-[11px]">run_recipe</code> /
          <code className="text-[11px]">save_recipe</code>) — that's how they improve themselves.
        </p>
        <button
          onClick={() => setView({ kind: 'edit', recipe: blankRecipe() })}
          className="flex shrink-0 items-center gap-1 rounded-lg bg-[#D97757] px-3 py-1.5 text-[12px] font-semibold text-white transition-colors duration-200 hover:bg-[#c2643f]"
        >
          <Plus className="h-4 w-4" /> New recipe
        </button>
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-[#6e6a60]/70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading recipes…
        </div>
      )}
      {loadError && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          {loadError} — built-ins still work in chat.
        </div>
      )}

      {!loading && (
        <>
          <Section title={`Built-in recipes (${lib.builtins.length})`}>
            {lib.builtins.map((r) => (
              <RecipeRow key={r.id} recipe={r} onRun={() => setView({ kind: 'run', recipe: r })} />
            ))}
          </Section>

          <Section
            title={`Your recipes (${lib.custom.length})`}
            empty={lib.custom.length === 0 ? 'No saved recipes yet. Create one above, or ask the AI to save a workflow it just ran.' : undefined}
          >
            {lib.custom.map((r) => (
              <RecipeRow
                key={r.slug || r.id}
                recipe={r}
                onRun={() => setView({ kind: 'run', recipe: r })}
                onEdit={() => setView({ kind: 'edit', recipe: r })}
                onDelete={() => onDelete(r.slug)}
              />
            ))}
          </Section>
        </>
      )}
    </div>
  );
};

const Section: React.FC<{ title: string; empty?: string; children: React.ReactNode }> = ({ title, empty, children }) => (
  <div>
    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#6e6a60]">{title}</div>
    {empty ? (
      <div className="rounded-xl border border-dashed border-black/10 bg-black/[0.02] py-6 text-center text-sm text-[#6e6a60]/70">{empty}</div>
    ) : (
      <div className="space-y-2">{children}</div>
    )}
  </div>
);

const RecipeRow: React.FC<{
  recipe: StoredRecipe;
  onRun: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}> = ({ recipe, onRun, onEdit, onDelete }) => (
  <div className="overflow-hidden rounded-2xl border border-black/10 bg-white/85 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.06)]">
    <RecipeCard data={recipe} />
    <div className="flex items-center gap-2 border-t border-black/5 bg-black/[0.025] px-3 py-2">
      <button
        onClick={onRun}
        className="flex items-center gap-1 rounded-lg bg-[#D97757] px-3 py-1 text-[12px] font-semibold text-white transition-colors duration-200 hover:bg-[#c2643f]"
      >
        <Play className="h-3.5 w-3.5" /> Run
      </button>
      {onEdit && (
        <button
          onClick={onEdit}
          className="flex items-center gap-1 rounded-lg border border-black/10 bg-white/70 px-2.5 py-1 text-[12px] font-semibold text-[#1a1915] transition-colors duration-200 hover:bg-black/5"
        >
          <Pencil className="h-3.5 w-3.5" /> Edit
        </button>
      )}
      {onDelete && (
        <button onClick={onDelete} className="ml-auto text-[#6e6a60]/50 transition-colors duration-200 hover:text-red-500">
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  </div>
);

// ── Run panel: parameter form + live-streamed result ────────────────────────────
const RunPanel: React.FC<{ recipe: StoredRecipe; onBack: () => void }> = ({ recipe, onBack }) => {
  const params = recipe.parameters || [];
  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    const init: Record<string, string | boolean> = {};
    for (const p of params) init[p.key] = p.default !== undefined ? (p.input_type === 'boolean' ? Boolean(p.default) : String(p.default)) : (p.input_type === 'boolean' ? false : '');
    return init;
  });
  const [running, setRunning] = useState(false);
  const [text, setText] = useState('');
  const [artifacts, setArtifacts] = useState<ChatArtifact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const missing = params.filter((p) => p.requirement === 'required' && !String(values[p.key] ?? '').trim()).map((p) => p.key);

  const run = async () => {
    if (missing.length) return;
    setRunning(true);
    setText('');
    setArtifacts([]);
    setError(null);
    abortRef.current = new AbortController();
    try {
      const outcome = await runRecipe(
        { recipeId: recipe.slug || recipe.id, values },
        { onDelta: (chunk) => setText((t) => t + chunk) },
        abortRef.current.signal
      );
      if (outcome.error) setError(outcome.error);
      if (outcome.text) setText(outcome.text);
      if (outcome.artifacts) setArtifacts(outcome.artifacts);
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') setError((e as Error)?.message || 'The recipe failed.');
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };
  const stop = () => abortRef.current?.abort();

  return (
    <div className="space-y-3">
      <button onClick={onBack} className="flex items-center gap-1 text-[12px] font-semibold text-[#6e6a60] transition-colors duration-200 hover:text-[#1a1915]">
        <ArrowLeft className="h-4 w-4" /> All recipes
      </button>

      <div className="flex items-center gap-2">
        <span className="rounded-lg border border-black/10 bg-black/[0.03] p-1.5"><BookOpen className="h-4 w-4 text-[#6e6a60]" /></span>
        <div>
          <div className="text-lg font-semibold leading-tight tracking-tight text-[#1a1915]">{recipe.title}</div>
          <div className="text-[12px] text-[#6e6a60]">{recipe.description}</div>
        </div>
      </div>

      {params.length > 0 && (
        <div className="space-y-2 rounded-xl border border-black/10 bg-white p-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[#6e6a60]">Parameters</div>
          {params.map((p) => (
            <ParamField key={p.key} param={p} value={values[p.key]} onChange={(v) => setValues((s) => ({ ...s, [p.key]: v }))} />
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        {!running ? (
          <button
            onClick={run}
            disabled={missing.length > 0}
            title={missing.length ? `Fill: ${missing.join(', ')}` : undefined}
            className={BTN_PRIMARY}
          >
            <Play className="h-4 w-4" /> Run recipe
          </button>
        ) : (
          <button onClick={stop} className={BTN_SECONDARY}>
            <X className="h-4 w-4" /> Stop
          </button>
        )}
        {running && <span className="flex items-center gap-1 text-[12px] text-[#D97757]"><Loader2 className="h-3.5 w-3.5 animate-spin" /> running…</span>}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      {(text || artifacts.length > 0) && (
        <div className="rounded-xl border border-black/10 bg-white p-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-[#6e6a60]">
            <ChefHat className="h-3.5 w-3.5" /> Result
          </div>
          {text && <ChatMarkdown text={text} />}
          {artifacts.length > 0 && <ChatArtifacts artifacts={artifacts} />}
        </div>
      )}
    </div>
  );
};

const ParamField: React.FC<{ param: RecipeParameterView; value: string | boolean | undefined; onChange: (v: string | boolean) => void }> = ({ param, value, onChange }) => {
  const label = (
    <div className="mb-0.5 flex items-center gap-1.5">
      <code className="text-[12px] font-semibold text-[#1a1915]">{param.key}</code>
      {param.requirement === 'required' && <span className="text-[10px] font-semibold text-red-600">required</span>}
      {param.description && <span className="text-[11px] text-[#6e6a60]/80">— {param.description}</span>}
    </div>
  );
  if (param.input_type === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[#D97757]" />
        <code className="text-[12px] font-semibold text-[#1a1915]">{param.key}</code>
        {param.description && <span className="text-[11px] text-[#6e6a60]/80">— {param.description}</span>}
      </label>
    );
  }
  if (param.input_type === 'select' && param.options?.length) {
    return (
      <div>
        {label}
        <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} className={INPUT_CLS}>
          {param.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    );
  }
  const long = param.input_type === 'string' && (param.description || '').length > 40;
  return (
    <div>
      {label}
      {long ? (
        <textarea value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} rows={3} className={`resize-y ${INPUT_CLS}`} />
      ) : (
        <input
          type={param.input_type === 'number' ? 'number' : 'text'}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT_CLS}
        />
      )}
    </div>
  );
};

// ── Editor: author / edit a recipe ──────────────────────────────────────────────
const REQUIREMENTS: RecipeParameterView['requirement'][] = ['required', 'optional', 'user_prompt'];
const PARAM_TYPES: RecipeParameterView['input_type'][] = ['string', 'number', 'boolean', 'select'];

const RecipeEditor: React.FC<{ recipe: RecipeCardArtifact; onSave: (r: RecipeCardArtifact) => void; onCancel: () => void }> = ({ recipe, onSave, onCancel }) => {
  const [title, setTitle] = useState(recipe.title);
  const [description, setDescription] = useState(recipe.description);
  const [instructions, setInstructions] = useState(recipe.instructions || '');
  const [prompt, setPrompt] = useState(recipe.prompt || '');
  const [swarm, setSwarm] = useState(Boolean(recipe.swarm));
  const [tools, setTools] = useState<string[]>(recipe.tools || []);
  const [agents, setAgents] = useState<string[]>(recipe.agents || []);
  const [params, setParams] = useState<RecipeParameterView[]>(recipe.parameters || []);
  const [saving, setSaving] = useState(false);

  const valid = title.trim() && (instructions.trim() || prompt.trim());
  const toggle = (arr: string[], v: string, set: (a: string[]) => void) =>
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  const updateParam = (i: number, patch: Partial<RecipeParameterView>) =>
    setParams((ps) => ps.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  const addParam = () => setParams((ps) => [...ps, { key: '', input_type: 'string', requirement: 'optional' }]);
  const removeParam = (i: number) => setParams((ps) => ps.filter((_, idx) => idx !== i));

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    const payload: RecipeCardArtifact = {
      ...recipe,
      title: title.trim(),
      description: description.trim(),
      instructions: instructions.trim(),
      prompt: prompt.trim(),
      swarm,
      tools,
      agents,
      parameters: params.filter((p) => p.key.trim())
    };
    try {
      await onSave(payload);
    } finally {
      setSaving(false);
    }
  };

  // Small editor inputs (param rows) share a tighter control style.
  const smallInput =
    'rounded-md border border-black/10 bg-white px-2 py-1 text-[12px] text-[#1a1915] outline-none transition-colors duration-200 focus:border-black/20';
  const toggleChip = (active: boolean) =>
    `rounded-full border px-2 py-1 text-[11px] font-semibold transition-colors duration-200 ${
      active
        ? 'border-transparent bg-[#1a1915] text-white'
        : 'border-black/10 bg-white/70 text-[#6e6a60] hover:bg-black/5 hover:text-[#1a1915]'
    }`;

  return (
    <div className="space-y-3">
      <button onClick={onCancel} className="flex items-center gap-1 text-[12px] font-semibold text-[#6e6a60] transition-colors duration-200 hover:text-[#1a1915]">
        <ArrowLeft className="h-4 w-4" /> All recipes
      </button>
      <div className="text-lg font-semibold tracking-tight text-[#1a1915]">{recipe.title ? 'Edit recipe' : 'New recipe'}</div>

      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (e.g. Comic Concept Forge)" className={`font-semibold ${INPUT_CLS}`} />
      <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One-line description of what it does" className={INPUT_CLS} />

      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[#6e6a60]">Instructions (use {'{{ parameter }}'} placeholders)</div>
        <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={5} placeholder="You are a… Build {{ topic }} for {{ audience }}. Be concrete and cite sources." className={`resize-y ${INPUT_CLS}`} />
      </div>
      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[#6e6a60]">Initial prompt (optional)</div>
        <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Kickoff message, e.g. Research {{ topic }} and write the brief." className={INPUT_CLS} />
      </div>

      <label className="flex items-center gap-2 text-sm text-[#1a1915]">
        <input type="checkbox" checked={swarm} onChange={(e) => setSwarm(e.target.checked)} className="h-4 w-4 accent-[#D97757]" />
        <Network className="h-4 w-4 text-[#D97757]" /> Run through the agent <span className="font-semibold">swarm</span> (multi-agent)
      </label>

      {/* Parameters editor */}
      <div className="rounded-xl border border-black/10 bg-white p-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[#6e6a60]">Parameters</span>
          <button
            onClick={addParam}
            className="flex items-center gap-1 rounded-full border border-black/10 bg-white/70 px-2 py-0.5 text-[11px] font-semibold text-[#1a1915] transition-colors duration-200 hover:bg-black/5"
          >
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        </div>
        {params.length === 0 && <div className="py-2 text-center text-[12px] text-[#6e6a60]/70">No parameters — the recipe runs as-is.</div>}
        <div className="space-y-2">
          {params.map((p, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5 rounded-lg border border-black/10 bg-black/[0.03] p-2">
              <input value={p.key} onChange={(e) => updateParam(i, { key: e.target.value })} placeholder="key" className={`w-28 font-semibold ${smallInput}`} />
              <select value={p.input_type} onChange={(e) => updateParam(i, { input_type: e.target.value as RecipeParameterView['input_type'] })} className={smallInput}>
                {PARAM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <select value={p.requirement} onChange={(e) => updateParam(i, { requirement: e.target.value as RecipeParameterView['requirement'] })} className={smallInput}>
                {REQUIREMENTS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              <input value={p.description || ''} onChange={(e) => updateParam(i, { description: e.target.value })} placeholder="description" className={`min-w-[8rem] flex-1 ${smallInput}`} />
              <input value={p.default !== undefined ? String(p.default) : ''} onChange={(e) => updateParam(i, { default: e.target.value })} placeholder="default" className={`w-20 ${smallInput}`} />
              <button onClick={() => removeParam(i)} className="text-[#6e6a60]/50 transition-colors duration-200 hover:text-red-500"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
      </div>

      {/* Agents (for swarm recipes) */}
      {swarm && (
        <div>
          <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-[#6e6a60]"><Bot className="h-3.5 w-3.5" /> Specialist agents</div>
          <div className="flex flex-wrap gap-1.5">
            {BUILTIN_AGENTS.map((a) => (
              <button key={a.id} onClick={() => toggle(agents, a.id, setAgents)} className={toggleChip(agents.includes(a.id))}>{a.name}</button>
            ))}
          </div>
        </div>
      )}

      {/* Tools (for single-agent recipes) */}
      {!swarm && (
        <div>
          <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-[#6e6a60]"><Wrench className="h-3.5 w-3.5" /> Tools the recipe may use</div>
          <div className="flex flex-wrap gap-1.5">
            {AGENT_TOOLS.map((t) => (
              <button key={t.name} onClick={() => toggle(tools, t.name, setTools)} className={toggleChip(tools.includes(t.name))}>{t.label}</button>
            ))}
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className={BTN_SECONDARY}>Cancel</button>
        <button onClick={submit} disabled={!valid || saving} className={BTN_PRIMARY}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save recipe
        </button>
      </div>
      {!valid && <p className="text-right text-[11px] text-[#6e6a60]/70">A recipe needs a title and at least instructions or a prompt.</p>}
    </div>
  );
};
