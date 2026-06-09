import React, { useEffect, useRef, useState } from 'react';
import { Send, Paperclip, X, Brain, Square, Loader2, LayoutGrid, FileText, Wand2, Undo2, Network, Server, Slash } from 'lucide-react';
import type { ChatReasoningLevel } from '../../apiTypes';
import type { ChatAttachment } from '../../services/chatStorage';
import { enhancePrompt } from '../../services/chatApi';
import { REASONING_LEVELS, type ChatModelFeatures } from '../../services/chatFeatures';
import type { ChatConnector } from '../../services/chatConnectors';
import type { McpServerConfig } from '../../apiTypes';
import { type ChatSkill, isSlashQuery, slashQuery, filterSkills, parseSkillInput } from '../../services/chatSkills';

interface ChatComposerProps {
  busy: boolean;
  features: ChatModelFeatures;
  reasoningLevel: ChatReasoningLevel;
  webSearch: boolean;
  swarm: boolean;
  swarmSupported: boolean;
  dreamstreamAccess: boolean;
  enabledTools: string[];
  toolsSupported: boolean;
  mcpServers: McpServerConfig[];
  enabledMcpServers: string[];
  onReasoningChange: (level: ChatReasoningLevel) => void;
  onWebToggle: (on: boolean) => void;
  onSwarmToggle: (on: boolean) => void;
  onDreamstreamToggle: (on: boolean) => void;
  onToggleConnector: (connector: ChatConnector, on: boolean) => void;
  onToggleMcpServer: (id: string, on: boolean) => void;
  onSend: (text: string, attachments: ChatAttachment[]) => void;
  /** Run a `/`-command skill (a recipe) instead of a plain message. */
  onRunSkill: (skill: ChatSkill, arg: string) => void;
  /** When set, prefill the composer with this text (e.g. clicking a skill suggestion). */
  seedText?: string;
  onSeedConsumed?: () => void;
  onStop: () => void;
}

const MAX_ATTACHMENTS = 6;

const fileToAttachment = (file: File): Promise<ChatAttachment> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () =>
      resolve({
        id: crypto.randomUUID(),
        name: file.name,
        mimeType: file.type,
        kind: file.type.startsWith('image/') ? 'image' : 'document',
        dataUrl: reader.result as string
      });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

export const ChatComposer: React.FC<ChatComposerProps> = ({
  busy,
  features,
  reasoningLevel,
  webSearch,
  swarm,
  swarmSupported,
  dreamstreamAccess,
  enabledTools,
  toolsSupported,
  mcpServers,
  enabledMcpServers,
  onReasoningChange,
  onWebToggle,
  onSwarmToggle,
  onDreamstreamToggle,
  onToggleConnector,
  onToggleMcpServer,
  onSend,
  onRunSkill,
  seedText,
  onSeedConsumed,
  onStop
}) => {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [enhancing, setEnhancing] = useState(false);
  // Holds the pre-enhancement draft so the user can undo a suggestion they dislike.
  const [beforeEnhance, setBeforeEnhance] = useState<string | null>(null);
  // Slash-command ("skills") menu: open while typing `/cmd` with no space yet.
  const [skillIndex, setSkillIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Prefill from a clicked suggestion (e.g. a skill chip), then focus the box.
  useEffect(() => {
    if (!seedText) return;
    setText(seedText);
    setMenuDismissed(true);
    onSeedConsumed?.();
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        autoGrow(el);
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedText]);

  const skillMatches = isSlashQuery(text) && !menuDismissed ? filterSkills(slashQuery(text)) : [];
  const menuOpen = skillMatches.length > 0;
  const activeSkill = menuOpen ? skillMatches[Math.min(skillIndex, skillMatches.length - 1)] : null;

  // Pick a skill from the menu: drop its command into the input so the user can type the
  // argument (or run immediately if the skill takes no argument).
  const acceptSkill = (skill: ChatSkill) => {
    if (!skill.argRequired) {
      onRunSkill(skill, '');
      setText('');
      setMenuDismissed(false);
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
      return;
    }
    setText(`/${skill.command} `);
    setMenuDismissed(true);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !busy;
  const canEnhance = text.trim().length > 2 && !busy && !enhancing;

  // Improve the draft prompt in place (intent preserved); keeps the original for undo.
  const handleEnhance = async () => {
    if (!canEnhance) return;
    const prev = text;
    setEnhancing(true);
    try {
      const { enhanced } = await enhancePrompt(prev);
      if (enhanced && enhanced.trim() && enhanced.trim() !== prev.trim()) {
        setText(enhanced.trim());
        setBeforeEnhance(prev);
        requestAnimationFrame(() => textareaRef.current && autoGrow(textareaRef.current));
      }
    } catch {
      /* leave the draft untouched on failure */
    } finally {
      setEnhancing(false);
    }
  };

  const undoEnhance = () => {
    if (beforeEnhance === null) return;
    setText(beforeEnhance);
    setBeforeEnhance(null);
    requestAnimationFrame(() => textareaRef.current && autoGrow(textareaRef.current));
  };

  const resetInput = () => {
    setText('');
    setAttachments([]);
    setBeforeEnhance(null);
    setMenuDismissed(false);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const submit = () => {
    if (busy) return;
    // A complete `/command arg` runs the matching skill (recipe) instead of sending text.
    const parsed = parseSkillInput(text.trim());
    if (parsed) {
      if (parsed.arg || !parsed.skill.argRequired) {
        onRunSkill(parsed.skill, parsed.arg);
        resetInput();
      }
      // `/research` with no argument yet: keep it in the box, wait for the topic.
      return;
    }
    if (!canSend) return;
    onSend(text.trim(), attachments);
    resetInput();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSkillIndex((i) => (i + 1) % skillMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSkillIndex((i) => (i - 1 + skillMatches.length) % skillMatches.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        if (activeSkill) acceptSkill(activeSkill);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    // Images need a vision model; PDFs are always accepted (viewer-only); CSV/JSON/text
    // data files are accepted so tools like run_python can read/convert/process them.
    const DATA_TYPES = ['text/csv', 'application/json', 'text/plain'];
    const DATA_EXTS = /\.(csv|tsv|json|txt)$/i;
    const isDataFile = (f: File) => DATA_TYPES.includes(f.type) || DATA_EXTS.test(f.name);
    const accepted = Array.from(files).filter(
      (f) => (features.vision && f.type.startsWith('image/')) || f.type === 'application/pdf' || isDataFile(f)
    );
    const next: ChatAttachment[] = [];
    for (const file of accepted.slice(0, MAX_ATTACHMENTS - attachments.length)) {
      try {
        next.push(await fileToAttachment(file));
      } catch {
        /* skip unreadable file */
      }
    }
    setAttachments((prev) => [...prev, ...next].slice(0, MAX_ATTACHMENTS));
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  return (
    <div className="border-t-4 border-black bg-white p-3">
      {/* Feature toggles */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        {features.reasoning && (
          <label className="flex items-center gap-1.5 text-[11px] font-bold border-2 border-black rounded-full px-2.5 py-1 bg-indigo-50">
            <Brain className="w-3.5 h-3.5" /> Reasoning
            <select
              value={reasoningLevel}
              onChange={(e) => onReasoningChange(e.target.value as ChatReasoningLevel)}
              className="bg-transparent outline-none font-bold cursor-pointer"
            >
              {REASONING_LEVELS.map((lvl) => (
                <option key={lvl.value} value={lvl.value}>{lvl.label}</option>
              ))}
            </select>
          </label>
        )}
        {swarmSupported && (
          <button
            onClick={() => onSwarmToggle(!swarm)}
            className={`flex items-center gap-1.5 text-[11px] font-bold border-2 border-black rounded-full px-2.5 py-1 ${swarm ? 'bg-fuchsia-300' : 'bg-white hover:bg-slate-100'}`}
            title="Agent swarm: a planner splits your goal across specialized agents (news, finance, weather, research…) that work in parallel, then a lead agent synthesizes the answer."
          >
            <Network className="w-3.5 h-3.5" /> Swarm {swarm ? 'on' : 'off'}
          </button>
        )}
        <button
          onClick={() => onDreamstreamToggle(!dreamstreamAccess)}
          className={`flex items-center gap-1.5 text-[11px] font-bold border-2 border-black rounded-full px-2.5 py-1 ${dreamstreamAccess ? 'bg-brand-yellow' : 'bg-white hover:bg-slate-100'}`}
          title="DreamStream connector: let this chat see your own projects, account and usage (read-only, sanitized). Off by default."
        >
          <LayoutGrid className="w-3.5 h-3.5" /> DreamStream {dreamstreamAccess ? 'on' : 'off'}
        </button>

        {toolsSupported &&
          mcpServers.map((server) => {
            const on = enabledMcpServers.includes(server.id);
            return (
              <button
                key={server.id}
                onClick={() => onToggleMcpServer(server.id, !on)}
                className={`flex items-center gap-1.5 text-[11px] font-bold border-2 border-black rounded-full px-2.5 py-1 ${on ? 'bg-violet-300' : 'bg-white hover:bg-slate-100'}`}
                title={`Custom MCP server: ${server.url}`}
              >
                <Server className="w-3.5 h-3.5" /> {server.name} {on ? 'on' : 'off'}
              </button>
            );
          })}
      </div>

      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {attachments.map((att) => (
            <div key={att.id} className="relative">
              {att.kind === 'document' ? (
                <div className="w-14 h-14 rounded-lg border-2 border-black bg-slate-100 flex flex-col items-center justify-center p-1">
                  <FileText className="w-5 h-5 text-brand-red" />
                  <span className="text-[8px] font-bold text-slate-500 truncate w-full text-center mt-0.5">{att.name}</span>
                </div>
              ) : (
                <img src={att.dataUrl} alt={att.name} className="w-14 h-14 object-cover rounded-lg border-2 border-black" />
              )}
              <button
                onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                className="absolute -top-1.5 -right-1.5 bg-brand-red text-white rounded-full border-2 border-black w-5 h-5 flex items-center justify-center"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {beforeEnhance !== null && (
        <div className="flex items-center gap-1.5 mb-1.5 text-[11px] text-violet-700">
          <Wand2 className="w-3.5 h-3.5" />
          <span className="font-bold">Prompt enhanced.</span>
          <span className="text-slate-500">Review it, then send — or</span>
          <button onClick={undoEnhance} className="flex items-center gap-0.5 font-bold hover:text-black underline">
            <Undo2 className="w-3 h-3" /> undo
          </button>
        </div>
      )}

      <div className="relative flex items-end gap-2">
        {/* Slash-command (skills) menu */}
        {menuOpen && (
          <div className="absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-xl border-2 border-black bg-white shadow-comic animate-fade-in">
            <div className="flex items-center gap-1 border-b-2 border-black bg-brand-yellow px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-wide">
              <Slash className="h-3 w-3" /> Skills — ↑↓ choose · Enter to pick · Esc to dismiss
            </div>
            <ul className="max-h-64 overflow-y-auto">
              {skillMatches.map((s, i) => {
                const active = i === Math.min(skillIndex, skillMatches.length - 1);
                return (
                  <li key={s.command}>
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        acceptSkill(s);
                      }}
                      onMouseEnter={() => setSkillIndex(i)}
                      className={`flex w-full items-start gap-2 px-3 py-2 text-left ${active ? 'bg-fuchsia-50' : 'hover:bg-slate-50'}`}
                    >
                      <span className="mt-0.5 text-base leading-none">{s.emoji}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <code className="text-[12px] font-extrabold">/{s.command}</code>
                          <span className="text-[11px] text-slate-400">{s.argRequired ? `<${s.argName}>` : `[${s.argName}]`}</span>
                        </span>
                        <span className="block text-[11px] text-slate-500">{s.description}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {(
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept={`${features.vision ? 'image/*,' : ''}application/pdf,text/csv,application/json,text/plain,.csv,.tsv,.json,.txt`}
              multiple
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={attachments.length >= MAX_ATTACHMENTS}
              className="shrink-0 border-2 border-black rounded-lg p-2.5 bg-white hover:bg-brand-yellow disabled:opacity-40"
              title={features.vision ? 'Attach images or PDFs' : 'Attach a PDF'}
            >
              <Paperclip className="w-4 h-4" />
            </button>
            <button
              onClick={handleEnhance}
              disabled={!canEnhance}
              className="shrink-0 border-2 border-black rounded-lg p-2.5 bg-white hover:bg-violet-200 disabled:opacity-40"
              title="Improve my prompt (keeps your intent — review before sending)"
            >
              {enhancing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
            </button>
          </>
        )}

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            setSkillIndex(0);
            if (!v.startsWith('/')) setMenuDismissed(false);
            if (beforeEnhance !== null) setBeforeEnhance(null);
            autoGrow(e.target);
          }}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder="Message the model…  (type / for skills · Enter to send)"
          className="flex-1 resize-none border-2 border-black rounded-lg px-3 py-2.5 text-sm outline-none focus:shadow-comic-hover max-h-[200px]"
        />

        {busy ? (
          <button onClick={onStop} className="shrink-0 border-2 border-black rounded-lg p-2.5 bg-brand-red text-white" title="Stop">
            <Square className="w-4 h-4" />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!canSend}
            className="shrink-0 border-2 border-black rounded-lg p-2.5 bg-brand-yellow disabled:opacity-40 hover:translate-y-[1px]"
            title="Send"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        )}
      </div>
    </div>
  );
};
