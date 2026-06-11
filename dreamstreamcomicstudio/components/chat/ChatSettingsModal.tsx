import React, { useMemo, useRef, useState } from 'react';
import {
  X, Brain, Network, Wrench, Plus, Trash2, Check, Pencil, Bot, Activity,
  LayoutGrid, BookOpen, Settings2, Sun, Moon, Monitor, Upload, Loader2, Sparkles
} from 'lucide-react';
import { ModalPortal } from '../modals/ModalPortal';
import { SystemDashboard } from './SystemDashboard';
import { ComponentGallery } from './ComponentGallery';
import { RecipeStudio } from './RecipeStudio';
import { ToolsDashboard } from './ToolsDashboard';
import type { CustomAgentDef } from '../../apiTypes';
import { getChatMemory, setChatMemory } from '../../services/chatStorage';
import { importChatMemory } from '../../services/chatApi';
import {
  MEMORY_IMPORT_SOURCES, MAX_IMPORT_FILE_BYTES, prepareMemoryImportContent,
  type MemoryImportSource
} from '../../services/memoryImport';
import { useTheme, type ThemePreference } from '../../services/theme';
import {
  BUILTIN_AGENTS, AGENT_TOOLS, TOOL_LABEL,
  listCustomAgents, saveCustomAgent, deleteCustomAgent, newCustomAgent,
  parseMemoryItems, formatMemoryItems
} from '../../services/chatAgents';

type Tab = 'general' | 'memory' | 'agents' | 'recipes' | 'tools' | 'system' | 'gallery';

interface ChatSettingsModalProps {
  userId?: string;
  initialTab?: Tab;
  onMemoryChange: (memory: string) => void;
  onAgentsChange: (agents: CustomAgentDef[]) => void;
  onClose: () => void;
}

const TABS = [
  ['general', 'General', Settings2],
  ['memory', 'Memory', Brain],
  ['agents', 'Agents', Network],
  ['recipes', 'Recipes', BookOpen],
  ['tools', 'Tools', Wrench],
  ['system', 'System', Activity],
  ['gallery', 'Gallery', LayoutGrid]
] as const;

// Shared field styles: recessed wells, ≥16px font on mobile.
const FIELD =
  'rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-3 py-2 text-base sm:text-sm ' +
  'text-[var(--ds-ink)] placeholder:text-[var(--ds-muted)] outline-none focus:border-[var(--ds-accent)]';

const SectionLabel: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div className={`text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ds-muted)] ${className}`}>
    {children}
  </div>
);

/** Hairline-divided grouped card, macOS Settings style. */
const Group: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="divide-y divide-[var(--ds-hairline-soft)] overflow-hidden rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)]">
    {children}
  </div>
);

export const ChatSettingsModal: React.FC<ChatSettingsModalProps> = ({
  userId, initialTab = 'memory', onMemoryChange, onAgentsChange, onClose
}) => {
  const [tab, setTab] = useState<Tab>(initialTab);
  const activeLabel = TABS.find(([id]) => id === tab)?.[1] ?? 'Settings';

  const closeBtn = (
    <button
      onClick={onClose}
      aria-label="Close settings"
      className="rounded-lg p-1.5 text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
    >
      <X className="h-4 w-4" />
    </button>
  );

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
        <div
          className="flex h-[min(92vh,44rem)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] text-[var(--ds-ink)] shadow-[0_24px_60px_-12px_rgba(0,0,0,0.35)] backdrop-blur"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Mobile: title bar + scrollable segmented tabs */}
          <div className="shrink-0 border-b border-[var(--ds-hairline-soft)] sm:hidden">
            <div className="flex items-center justify-between px-4 pb-1 pt-3">
              <h2 className="text-base font-semibold">Settings</h2>
              {closeBtn}
            </div>
            <div className="flex gap-1 overflow-x-auto px-3 pb-2">
              {TABS.map(([id, label, Icon]) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                    tab === id
                      ? 'bg-[#D97757]/10 text-[var(--ds-accent)]'
                      : 'text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" /> {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex min-h-0 flex-1">
            {/* Desktop: vertical tab rail */}
            <nav className="hidden w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] p-3 sm:flex">
              <SectionLabel className="px-2.5 pb-2 pt-1">Settings</SectionLabel>
              {TABS.map(([id, label, Icon]) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                    tab === id
                      ? 'bg-[#D97757]/10 font-medium text-[var(--ds-accent)]'
                      : 'text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]'
                  }`}
                >
                  <Icon className={`h-4 w-4 shrink-0 ${tab === id ? '' : 'text-[var(--ds-muted)]'}`} />
                  {label}
                </button>
              ))}
            </nav>

            <div className="flex min-w-0 flex-1 flex-col">
              <header className="hidden shrink-0 items-center justify-between border-b border-[var(--ds-hairline-soft)] px-6 py-3.5 sm:flex">
                <h2 className="text-base font-semibold">{activeLabel}</h2>
                {closeBtn}
              </header>

              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
                {tab === 'general' && <GeneralTab />}
                {tab === 'memory' && <MemoryTab userId={userId} onMemoryChange={onMemoryChange} />}
                {tab === 'agents' && <AgentsTab userId={userId} onAgentsChange={onAgentsChange} />}
                {tab === 'recipes' && <RecipeStudio userId={userId} />}
                {tab === 'tools' && <ToolsDashboard />}
                {tab === 'system' && <SystemDashboard />}
                {tab === 'gallery' && <ComponentGallery />}
              </div>
            </div>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
};

// --- General: appearance (theme) preferences ---

const THEME_OPTIONS: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor }
];

/** Fixed-palette mini mockup of each theme (intentionally not token-driven: it depicts the theme itself). */
const ThemePreviewSwatch: React.FC<{ value: ThemePreference }> = ({ value }) => {
  const pane = (dark: boolean) => (
    <div key={dark ? 'dark' : 'light'} className={`flex-1 p-2 ${dark ? 'bg-stone-800' : 'bg-stone-100'}`}>
      <div className={`h-1.5 w-8 rounded-full ${dark ? 'bg-stone-600' : 'bg-stone-300'}`} />
      <div className={`mt-1.5 h-1.5 w-12 rounded-full ${dark ? 'bg-stone-700' : 'bg-stone-200'}`} />
      <div className="mt-1.5 h-1.5 w-6 rounded-full bg-[#D97757]/70" />
    </div>
  );
  return (
    <div className="flex h-16 overflow-hidden rounded-lg border border-[var(--ds-hairline-soft)]">
      {pane(value === 'dark')}
      {value === 'system' && pane(true)}
    </div>
  );
};

const GeneralTab: React.FC = () => {
  const { preference, setPreference } = useTheme();

  return (
    <div className="space-y-6">
      <section>
        <SectionLabel className="mb-2 px-1">Appearance</SectionLabel>
        <Group>
          <div className="px-4 py-4">
            <div className="text-sm font-medium text-[var(--ds-ink)]">Theme</div>
            <div className="mt-0.5 text-xs text-[var(--ds-muted)]">
              How Chat Studio looks. System follows your device setting.
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2.5">
              {THEME_OPTIONS.map(({ value, label, Icon }) => {
                const active = preference === value;
                return (
                  <button
                    key={value}
                    onClick={() => setPreference(value)}
                    aria-pressed={active}
                    className={`rounded-xl border p-1.5 text-left transition-colors ${
                      active
                        ? 'border-[var(--ds-accent)] bg-[#D97757]/10'
                        : 'border-[var(--ds-hairline)] hover:bg-[var(--ds-hover)]'
                    }`}
                  >
                    <ThemePreviewSwatch value={value} />
                    <div className="flex items-center justify-between px-1 pb-0.5 pt-1.5">
                      <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--ds-ink)]">
                        <Icon className="h-3.5 w-3.5 text-[var(--ds-muted)]" /> {label}
                      </span>
                      {active && <Check className="h-3.5 w-3.5 text-[var(--ds-accent)]" />}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </Group>
      </section>
    </div>
  );
};

// --- Memory: the user's durable facts/preferences as an editable list of points ---
const MemoryTab: React.FC<{ userId?: string; onMemoryChange: (m: string) => void }> = ({ userId, onMemoryChange }) => {
  const [items, setItems] = useState<string[]>(() => parseMemoryItems(getChatMemory(userId)));
  const [draft, setDraft] = useState('');

  const commit = (next: string[]) => {
    setItems(next);
    const formatted = formatMemoryItems(next);
    setChatMemory(formatted, userId);
    onMemoryChange(formatted);
  };
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    commit([...items, v]);
    setDraft('');
  };
  const edit = (i: number, v: string) => commit(items.map((it, idx) => (idx === i ? v : it)));
  const remove = (i: number) => commit(items.filter((_, idx) => idx !== i));

  // ---- Import from another AI tool (ChatGPT / Claude / Gemini / other) ----
  const [importSource, setImportSource] = useState<MemoryImportSource>('chatgpt');
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const sourceMeta = MEMORY_IMPORT_SOURCES.find((s) => s.id === importSource)!;

  const onPickFile = async (file: File | null) => {
    if (!file) return;
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      setImportError('That file is too large — export files over 8 MB usually mean full chat logs; paste just the memory/instructions text instead.');
      return;
    }
    setImportError(null);
    setImportText(await file.text());
  };

  const runImport = async () => {
    const content = prepareMemoryImportContent(importText);
    if (!content || importing) return;
    setImporting(true);
    setImportError(null);
    try {
      const existing = formatMemoryItems(items);
      const res = await importChatMemory(importSource, content, existing);
      const merged = parseMemoryItems(res.memory);
      if (merged.length === 0) {
        setImportError('Nothing durable found in that content — try pasting the memory list itself.');
      } else {
        setPreview(merged);
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed — try again.');
    } finally {
      setImporting(false);
    }
  };

  const applyImport = () => {
    if (!preview) return;
    commit(preview);
    setPreview(null);
    setImportText('');
  };

  const previewNewCount = useMemo(() => {
    if (!preview) return 0;
    const existing = new Set(items.map((it) => it.trim().toLowerCase()));
    return preview.filter((p) => !existing.has(p.trim().toLowerCase())).length;
  }, [preview, items]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--ds-muted)]">
        Things the AI remembers about you across every chat — facts, preferences and context.
        These are added automatically as you chat, and you can edit them here.
      </p>
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          placeholder="Add a memory (e.g. “Prefers concise answers”)"
          className={`min-w-0 flex-1 ${FIELD}`}
        />
        <button
          onClick={add}
          disabled={!draft.trim()}
          className="flex shrink-0 items-center gap-1 rounded-lg bg-[var(--ds-accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--ds-accent-hover)] disabled:opacity-40"
        >
          <Plus className="h-4 w-4" /> Add
        </button>
      </div>

      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--ds-hairline)] py-8 text-center text-sm text-[var(--ds-muted)]">
          No memories yet. They'll build up as you chat — or add your own above.
        </div>
      ) : (
        <div>
          <div className="mb-2 flex items-center justify-between px-1">
            <SectionLabel>{items.length} {items.length === 1 ? 'memory' : 'memories'}</SectionLabel>
            <button onClick={() => commit([])} className="text-[11px] font-medium text-red-500 hover:text-red-600">
              Clear all
            </button>
          </div>
          <ul className="divide-y divide-[var(--ds-hairline-soft)] overflow-hidden rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)]">
            {items.map((it, i) => (
              <li key={i} className="group flex items-center gap-2.5 px-3 py-1.5">
                <Brain className="h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)]" />
                <input
                  value={it}
                  onChange={(e) => edit(i, e.target.value)}
                  className="min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-1 text-base text-[var(--ds-ink)] outline-none focus:bg-[var(--ds-well)] sm:text-sm"
                />
                <button
                  onClick={() => remove(i)}
                  aria-label="Remove memory"
                  className="shrink-0 rounded-md p-1 text-[var(--ds-muted)] opacity-0 hover:bg-[var(--ds-hover)] hover:text-red-500 focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Import memories the user already built up in another AI tool. */}
      <section>
        <SectionLabel className="mb-2 px-1">Import from another AI</SectionLabel>
        <Group>
          <div className="space-y-3 px-4 py-4">
            <p className="text-xs text-[var(--ds-muted)]">
              Bring what ChatGPT, Claude or Gemini already knows about you. Paste your memory
              list or custom instructions (or upload an export file) — it's distilled into
              memories here, and you review before anything is saved.
            </p>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Import source">
              {MEMORY_IMPORT_SOURCES.map((s) => (
                <button
                  key={s.id}
                  role="radio"
                  aria-checked={importSource === s.id}
                  onClick={() => setImportSource(s.id)}
                  className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    importSource === s.id
                      ? 'bg-[#D97757]/10 text-[var(--ds-accent)]'
                      : 'text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-[var(--ds-muted)]">Where to find it: {sourceMeta.hint}.</p>
            <textarea
              value={importText}
              onChange={(e) => { setImportText(e.target.value); setPreview(null); }}
              rows={4}
              placeholder={`Paste your ${sourceMeta.label === 'Other' ? '' : `${sourceMeta.label} `}memories or instructions here…`}
              className={`w-full resize-y ${FIELD}`}
            />
            <input
              ref={fileRef}
              type="file"
              accept=".json,.txt,.md,application/json,text/plain,text/markdown"
              className="hidden"
              onChange={(e) => { void onPickFile(e.target.files?.[0] ?? null); e.target.value = ''; }}
            />
            {importError && <p className="text-xs text-red-500">{importError}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => fileRef.current?.click()}
                className="flex items-center gap-1.5 rounded-lg border border-[var(--ds-hairline)] px-3 py-2 text-sm text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]"
              >
                <Upload className="h-4 w-4" /> Upload export file
              </button>
              <button
                onClick={() => void runImport()}
                disabled={!importText.trim() || importing}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--ds-accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--ds-accent-hover)] disabled:opacity-40"
              >
                {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {importing ? 'Distilling…' : 'Import'}
              </button>
            </div>

            {preview && (
              <div className="space-y-2 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] p-3">
                <div className="flex items-center justify-between">
                  <SectionLabel>
                    Preview · {preview.length} {preview.length === 1 ? 'memory' : 'memories'}
                    {previewNewCount > 0 ? ` (${previewNewCount} new)` : ' (no new facts)'}
                  </SectionLabel>
                </div>
                <ul className="max-h-44 space-y-1 overflow-y-auto">
                  {preview.map((p, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-[var(--ds-ink)]">
                      <Brain className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)]" />
                      <span className="min-w-0">{p}</span>
                    </li>
                  ))}
                </ul>
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={applyImport}
                    className="flex items-center gap-1.5 rounded-lg bg-[var(--ds-accent)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--ds-accent-hover)]"
                  >
                    <Check className="h-4 w-4" /> Save these memories
                  </button>
                  <button
                    onClick={() => setPreview(null)}
                    className="rounded-lg px-3 py-1.5 text-sm text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </Group>
      </section>
    </div>
  );
};

const ToolChip: React.FC<{ label: string }> = ({ label }) => (
  <span className="rounded-md border border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ds-muted)]">
    {label}
  </span>
);

// --- Agents: built-in specialists + user-created custom agents the swarm deploys ---
const AgentsTab: React.FC<{ userId?: string; onAgentsChange: (a: CustomAgentDef[]) => void }> = ({ userId, onAgentsChange }) => {
  const [custom, setCustom] = useState<CustomAgentDef[]>(() => listCustomAgents(userId));
  const [editing, setEditing] = useState<CustomAgentDef | null>(null);

  const save = (agent: CustomAgentDef) => {
    const next = saveCustomAgent(agent, userId);
    setCustom(next);
    onAgentsChange(next);
    setEditing(null);
  };
  const remove = (id: string) => {
    const next = deleteCustomAgent(id, userId);
    setCustom(next);
    onAgentsChange(next);
  };

  if (editing) return <AgentEditor agent={editing} onSave={save} onCancel={() => setEditing(null)} />;

  return (
    <div className="space-y-6">
      <p className="text-sm text-[var(--ds-muted)]">
        When you use <span className="font-medium text-[var(--ds-ink)]">Swarm</span>, a planner deploys these specialized agents in
        parallel and merges their findings. Built-ins are always available; your custom agents are added to the pool.
      </p>

      <div>
        <SectionLabel className="mb-2 px-1">Built-in agents</SectionLabel>
        <div className="grid gap-2 sm:grid-cols-2">
          {BUILTIN_AGENTS.map((a) => (
            <div key={a.id} className="rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] p-3">
              <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--ds-ink)]">
                <Bot className="h-4 w-4 text-[var(--ds-accent)]" /> {a.name}
              </div>
              <div className="mt-0.5 text-[11px] text-[var(--ds-muted)]">{a.description}</div>
              {a.toolNames.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {a.toolNames.map((t) => <ToolChip key={t} label={TOOL_LABEL[t] || t} />)}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between px-1">
          <SectionLabel>Your agents ({custom.length})</SectionLabel>
          <button
            onClick={() => setEditing(newCustomAgent())}
            className="flex items-center gap-1 rounded-full bg-[#D97757]/10 px-2.5 py-1 text-[11px] font-medium text-[var(--ds-accent)] hover:bg-[#D97757]/20"
          >
            <Plus className="h-3.5 w-3.5" /> New agent
          </button>
        </div>
        {custom.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--ds-hairline)] px-4 py-6 text-center text-sm text-[var(--ds-muted)]">
            No custom agents yet. Create one (e.g. an “Apple/Mac news” agent) — the swarm will deploy it when relevant.
          </div>
        ) : (
          <div className="divide-y divide-[var(--ds-hairline-soft)] overflow-hidden rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)]">
            {custom.map((a) => (
              <div key={a.id} className="flex items-start gap-2.5 px-3.5 py-3">
                <Bot className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ds-accent)]" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-[var(--ds-ink)]">{a.name}</div>
                  <div className="text-[11px] text-[var(--ds-muted)]">{a.description}</div>
                  {a.toolNames.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {a.toolNames.map((t) => <ToolChip key={t} label={TOOL_LABEL[t] || t} />)}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => setEditing(a)}
                  aria-label={`Edit ${a.name}`}
                  className="shrink-0 rounded-md p-1 text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={() => remove(a.id)}
                  aria-label={`Delete ${a.name}`}
                  className="shrink-0 rounded-md p-1 text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-red-500"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const AgentEditor: React.FC<{ agent: CustomAgentDef; onSave: (a: CustomAgentDef) => void; onCancel: () => void }> = ({ agent, onSave, onCancel }) => {
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [systemPrompt, setSystemPrompt] = useState(agent.systemPrompt);
  const [tools, setTools] = useState<string[]>(agent.toolNames);

  const toggle = (t: string) => setTools((cur) => cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]);
  const valid = name.trim() && systemPrompt.trim();

  return (
    <div className="space-y-4">
      <div className="text-sm font-semibold text-[var(--ds-ink)]">{agent.name ? 'Edit agent' : 'New agent'}</div>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name (e.g. Apple / Mac News)"
        className={`w-full font-medium ${FIELD}`}
      />
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="When should it be used? (e.g. Apple, Mac, iPhone news & rumors)"
        className={`w-full ${FIELD}`}
      />
      <div>
        <SectionLabel className="mb-1.5 px-1">Instructions (system prompt)</SectionLabel>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={5}
          placeholder="You are a specialist in… Use the tools to… Always cite sources and dates."
          className={`w-full resize-y rounded-xl leading-relaxed ${FIELD}`}
        />
      </div>
      <div>
        <SectionLabel className="mb-1.5 px-1">Tools this agent can use</SectionLabel>
        <div className="flex flex-wrap gap-1.5">
          {AGENT_TOOLS.map((t) => (
            <button
              key={t.name}
              onClick={() => toggle(t.name)}
              aria-pressed={tools.includes(t.name)}
              className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                tools.includes(t.name)
                  ? 'border-[var(--ds-accent)] bg-[#D97757]/10 text-[var(--ds-accent)]'
                  : 'border-[var(--ds-hairline)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-[var(--ds-hairline-soft)] pt-3">
        <button
          onClick={onCancel}
          className="rounded-lg border border-[var(--ds-hairline)] px-4 py-2 text-sm font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]"
        >
          Cancel
        </button>
        <button
          onClick={() => valid && onSave({ ...agent, name: name.trim(), description: description.trim(), systemPrompt: systemPrompt.trim(), toolNames: tools })}
          disabled={!valid}
          className="flex items-center gap-1 rounded-lg bg-[var(--ds-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--ds-accent-hover)] disabled:opacity-40"
        >
          <Check className="h-4 w-4" /> Save agent
        </button>
      </div>
    </div>
  );
};
