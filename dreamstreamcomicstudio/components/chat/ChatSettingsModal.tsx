import React, { useState } from 'react';
import { X, Brain, Network, Wrench, Plus, Trash2, Check, Pencil, Bot, Sparkles } from 'lucide-react';
import { ModalPortal } from '../modals/ModalPortal';
import type { CustomAgentDef } from '../../apiTypes';
import { getChatMemory, setChatMemory } from '../../services/chatStorage';
import {
  BUILTIN_AGENTS, AGENT_TOOLS, TOOL_LABEL,
  listCustomAgents, saveCustomAgent, deleteCustomAgent, newCustomAgent,
  parseMemoryItems, formatMemoryItems
} from '../../services/chatAgents';

type Tab = 'memory' | 'agents' | 'tools';

interface ChatSettingsModalProps {
  userId?: string;
  initialTab?: Tab;
  onMemoryChange: (memory: string) => void;
  onAgentsChange: (agents: CustomAgentDef[]) => void;
  onClose: () => void;
}

export const ChatSettingsModal: React.FC<ChatSettingsModalProps> = ({
  userId, initialTab = 'memory', onMemoryChange, onAgentsChange, onClose
}) => {
  const [tab, setTab] = useState<Tab>(initialTab);

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
        <div className="bg-white border-4 border-black rounded-2xl shadow-comic w-full max-w-2xl max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between px-5 py-3 border-b-4 border-black bg-brand-blue text-white rounded-t-xl shrink-0">
            <h2 className="font-display text-xl flex items-center gap-2"><Sparkles className="w-5 h-5" /> Chat settings</h2>
            <button onClick={onClose} className="border-2 border-black rounded p-1 bg-white text-black hover:bg-brand-yellow"><X className="w-4 h-4" /></button>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 px-3 pt-3 border-b-2 border-black shrink-0">
            {([
              ['memory', 'Memory', Brain],
              ['agents', 'Agents', Network],
              ['tools', 'Tools', Wrench]
            ] as const).map(([id, label, Icon]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-bold rounded-t-lg border-2 border-b-0 ${tab === id ? 'border-black bg-brand-yellow' : 'border-transparent text-slate-500 hover:text-black'}`}
              >
                <Icon className="w-4 h-4" /> {label}
              </button>
            ))}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto p-5">
            {tab === 'memory' && <MemoryTab userId={userId} onMemoryChange={onMemoryChange} />}
            {tab === 'agents' && <AgentsTab userId={userId} onAgentsChange={onAgentsChange} />}
            {tab === 'tools' && <ToolsTab />}
          </div>
        </div>
      </div>
    </ModalPortal>
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

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Things the AI remembers about you across every chat — facts, preferences and context.
        These are added automatically as you chat, and you can edit them here.
      </p>
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          placeholder="Add a memory (e.g. “Prefers concise answers”)"
          className="flex-1 border-2 border-black rounded-lg px-3 py-2 text-sm outline-none focus:shadow-comic-hover"
        />
        <button onClick={add} disabled={!draft.trim()} className="flex items-center gap-1 px-3 py-2 text-sm font-bold border-2 border-black rounded-lg bg-brand-yellow disabled:opacity-40"><Plus className="w-4 h-4" /> Add</button>
      </div>

      {items.length === 0 ? (
        <div className="text-sm text-slate-400 text-center py-8 border-2 border-dashed border-slate-200 rounded-lg">
          No memories yet. They'll build up as you chat — or add your own above.
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase text-slate-500">{items.length} {items.length === 1 ? 'memory' : 'memories'}</span>
            <button onClick={() => commit([])} className="text-[11px] font-bold text-brand-red hover:underline">Clear all</button>
          </div>
          <ul className="space-y-1.5">
            {items.map((it, i) => (
              <li key={i} className="flex items-center gap-2 group">
                <Brain className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                <input
                  value={it}
                  onChange={(e) => edit(i, e.target.value)}
                  className="flex-1 border-2 border-transparent hover:border-slate-200 focus:border-black rounded px-2 py-1 text-sm outline-none bg-transparent"
                />
                <button onClick={() => remove(i)} className="text-slate-300 hover:text-brand-red shrink-0 opacity-0 group-hover:opacity-100"><Trash2 className="w-4 h-4" /></button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
};

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
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        When you use <span className="font-bold">Swarm</span>, a planner deploys these specialized agents in
        parallel and merges their findings. Built-ins are always available; your custom agents are added to the pool.
      </p>

      <div>
        <div className="text-[11px] font-bold uppercase text-slate-500 mb-1.5">Built-in agents</div>
        <div className="grid sm:grid-cols-2 gap-2">
          {BUILTIN_AGENTS.map((a) => (
            <div key={a.id} className="border-2 border-black rounded-lg p-2.5 bg-slate-50">
              <div className="flex items-center gap-1.5 font-bold text-sm"><Bot className="w-4 h-4 text-brand-blue" /> {a.name}</div>
              <div className="text-[11px] text-slate-500 mt-0.5">{a.description}</div>
              {a.toolNames.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {a.toolNames.map((t) => <span key={t} className="text-[9px] font-bold px-1.5 py-0.5 rounded border border-slate-300 text-slate-600">{TOOL_LABEL[t] || t}</span>)}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] font-bold uppercase text-slate-500">Your agents ({custom.length})</span>
          <button onClick={() => setEditing(newCustomAgent())} className="flex items-center gap-1 text-[11px] font-bold border-2 border-black rounded-full px-2 py-0.5 bg-brand-yellow hover:translate-y-[1px]"><Plus className="w-3.5 h-3.5" /> New agent</button>
        </div>
        {custom.length === 0 ? (
          <div className="text-sm text-slate-400 text-center py-6 border-2 border-dashed border-slate-200 rounded-lg">
            No custom agents yet. Create one (e.g. an “Apple/Mac news” agent) — the swarm will deploy it when relevant.
          </div>
        ) : (
          <div className="space-y-2">
            {custom.map((a) => (
              <div key={a.id} className="border-2 border-black rounded-lg p-2.5 bg-white flex items-start gap-2">
                <Bot className="w-4 h-4 text-fuchsia-600 shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-sm">{a.name}</div>
                  <div className="text-[11px] text-slate-500">{a.description}</div>
                  {a.toolNames.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {a.toolNames.map((t) => <span key={t} className="text-[9px] font-bold px-1.5 py-0.5 rounded border border-slate-300 text-slate-600">{TOOL_LABEL[t] || t}</span>)}
                    </div>
                  )}
                </div>
                <button onClick={() => setEditing(a)} className="text-slate-400 hover:text-black shrink-0"><Pencil className="w-4 h-4" /></button>
                <button onClick={() => remove(a.id)} className="text-slate-300 hover:text-brand-red shrink-0"><Trash2 className="w-4 h-4" /></button>
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
    <div className="space-y-3">
      <div className="text-sm font-bold">{agent.name ? 'Edit agent' : 'New agent'}</div>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. Apple / Mac News)" className="w-full border-2 border-black rounded-lg px-3 py-2 text-sm font-bold outline-none" />
      <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="When should it be used? (e.g. Apple, Mac, iPhone news & rumors)" className="w-full border-2 border-black rounded-lg px-3 py-2 text-sm outline-none" />
      <div>
        <div className="text-[11px] font-bold uppercase text-slate-500 mb-1">Instructions (system prompt)</div>
        <textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={5} placeholder="You are a specialist in… Use the tools to… Always cite sources and dates." className="w-full border-2 border-black rounded-lg px-3 py-2 text-sm outline-none resize-y" />
      </div>
      <div>
        <div className="text-[11px] font-bold uppercase text-slate-500 mb-1">Tools this agent can use</div>
        <div className="flex flex-wrap gap-1.5">
          {AGENT_TOOLS.map((t) => (
            <button key={t.name} onClick={() => toggle(t.name)} className={`text-[11px] font-bold px-2 py-1 rounded-full border-2 ${tools.includes(t.name) ? 'border-black bg-emerald-300' : 'border-slate-300 bg-white hover:border-black'}`}>{t.label}</button>
          ))}
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="px-4 py-2 text-sm font-bold border-2 border-black rounded-lg bg-white hover:bg-slate-100">Cancel</button>
        <button onClick={() => valid && onSave({ ...agent, name: name.trim(), description: description.trim(), systemPrompt: systemPrompt.trim(), toolNames: tools })} disabled={!valid} className="flex items-center gap-1 px-4 py-2 text-sm font-bold border-2 border-black rounded-lg bg-brand-yellow shadow-comic hover:translate-y-[1px] disabled:opacity-40"><Check className="w-4 h-4" /> Save agent</button>
      </div>
    </div>
  );
};

// --- Tools: the honest inventory of what every agent/model can access ---
const ToolsTab: React.FC = () => (
  <div className="space-y-3">
    <p className="text-sm text-slate-600">
      The live tools available to the chat models and every agent. All are free and keyless except where noted.
    </p>
    <ul className="space-y-1.5">
      {[
        ['Web search', 'DuckDuckGo — current/factual lookups', 'free'],
        ['News', 'Google News RSS — headlines by topic/region', 'free'],
        ['Weather', 'Open-Meteo — current, hourly, UV, air quality', 'free'],
        ['Stocks', 'Stooq — quotes + price history charts', 'free'],
        ['Places / local', 'OpenStreetMap, or Foursquare for ratings/photos', 'key optional'],
        ['Maps', 'OpenStreetMap (Leaflet) — markers & routes', 'free'],
        ['Video search', 'DuckDuckGo — plays inline in the panel', 'free'],
        ['Image search', 'DuckDuckGo — image results', 'free'],
        ['Agent swarm', 'Delegate complex tasks to specialized agents', 'free']
      ].map(([label, desc, tag]) => (
        <li key={label as string} className="flex items-center gap-2 border-2 border-black rounded-lg px-3 py-2 bg-white">
          <Wrench className="w-4 h-4 text-slate-500 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-bold text-sm">{label}</div>
            <div className="text-[11px] text-slate-500">{desc}</div>
          </div>
          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${tag === 'free' ? 'border-emerald-300 text-emerald-700' : 'border-amber-300 text-amber-700'}`}>{tag}</span>
        </li>
      ))}
    </ul>
  </div>
);
