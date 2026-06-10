import React, { useEffect, useRef, useState } from 'react';
import { Send, Paperclip, X, Brain, Square, Loader2, LayoutGrid, FileText, Wand2, Undo2, Network, Server, Slash } from 'lucide-react';
import type { ChatReasoningLevel } from '../../apiTypes';
import type { ChatAttachment } from '../../services/chatStorage';
import { enhancePrompt } from '../../services/chatApi';
import { REASONING_LEVELS, type ChatModelFeatures } from '../../services/chatFeatures';
import type { ChatConnector } from '../../services/chatConnectors';
import type { McpServerConfig } from '../../apiTypes';
import { type ChatSkill, isSlashQuery, slashQuery, filterSkills, parseSkillInput } from '../../services/chatSkills';
import { DictationButton } from './DictationButton';
import {
  CANVAS_BG, GLASS_STRONG, HAIRLINE, MENU, MUTED, LABEL, TRANSITION, SHADOW_SOFT,
  RADIUS_PANEL, PILL, CONTROL_BTN, ACCENT_BG, ACCENT_BG_HOVER, ACCENT_TEXT, ACCENT_SOFT_BG
} from './studioDesign';

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
  // Draft snapshot taken when a dictation take starts, so streamed partials replace
  // only the dictated segment instead of clobbering typed text.
  const dictationBaseRef = useRef('');

  const applyDictation = (spoken: string) => {
    if (!spoken) return;
    const base = dictationBaseRef.current;
    const joined = base ? `${base.replace(/\s+$/, '')} ${spoken}` : spoken;
    setText(joined);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        autoGrow(el);
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  };

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

  // Widgets deep in the artifact tree (learning steps, follow-up actions) can hand the
  // composer a ready-to-send draft without prop drilling: they dispatch
  // `dreamstream:compose` with { detail: { text } } and the box fills + focuses.
  useEffect(() => {
    const onCompose = (e: Event) => {
      const draft = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (!draft) return;
      setText(draft);
      setMenuDismissed(true);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          autoGrow(el);
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    };
    window.addEventListener('dreamstream:compose', onCompose);
    return () => window.removeEventListener('dreamstream:compose', onCompose);
  }, []);

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
    <div className={`${CANVAS_BG} px-3 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]`}>
      <div className={`${GLASS_STRONG} ${HAIRLINE} ${SHADOW_SOFT} ${RADIUS_PANEL} p-3`}>
      {/* Feature toggles */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        {features.reasoning && (
          <label className={`flex items-center gap-1.5 text-[11px] font-medium ${PILL} px-2.5 py-1 ${MUTED}`}>
            <Brain className="w-3.5 h-3.5" /> Reasoning
            <select
              value={reasoningLevel}
              onChange={(e) => onReasoningChange(e.target.value as ChatReasoningLevel)}
              className="bg-transparent outline-none font-medium cursor-pointer"
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
            className={`flex items-center gap-1.5 text-[11px] font-medium ${PILL} px-2.5 py-1 ${swarm ? `${ACCENT_SOFT_BG} ${ACCENT_TEXT} border-[#D97757]/30` : `${MUTED} hover:bg-[var(--ds-hover)]`}`}
            title="Agent swarm: a planner splits your goal across specialized agents (news, finance, weather, research…) that work in parallel, then a lead agent synthesizes the answer."
          >
            <Network className="w-3.5 h-3.5" /> Swarm {swarm ? 'on' : 'off'}
          </button>
        )}
        <button
          onClick={() => onDreamstreamToggle(!dreamstreamAccess)}
          className={`flex items-center gap-1.5 text-[11px] font-medium ${PILL} px-2.5 py-1 ${dreamstreamAccess ? `${ACCENT_SOFT_BG} ${ACCENT_TEXT} border-[#D97757]/30` : `${MUTED} hover:bg-[var(--ds-hover)]`}`}
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
                className={`flex items-center gap-1.5 text-[11px] font-medium ${PILL} px-2.5 py-1 ${on ? `${ACCENT_SOFT_BG} ${ACCENT_TEXT} border-[#D97757]/30` : `${MUTED} hover:bg-[var(--ds-hover)]`}`}
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
                <div className={`w-14 h-14 rounded-xl ${HAIRLINE} bg-[var(--ds-surface-soft)] flex flex-col items-center justify-center p-1`}>
                  <FileText className={`w-5 h-5 ${ACCENT_TEXT}`} />
                  <span className={`text-[8px] font-medium ${MUTED} truncate w-full text-center mt-0.5`}>{att.name}</span>
                </div>
              ) : (
                <img src={att.dataUrl} alt={att.name} className={`w-14 h-14 object-cover rounded-xl ${HAIRLINE}`} />
              )}
              <button
                onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                className={`absolute -top-1.5 -right-1.5 ${ACCENT_BG} ${ACCENT_BG_HOVER} text-white rounded-full ${SHADOW_SOFT} w-5 h-5 flex items-center justify-center ${TRANSITION}`}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {beforeEnhance !== null && (
        <div className={`flex items-center gap-1.5 mb-1.5 text-[11px] ${ACCENT_TEXT}`}>
          <Wand2 className="w-3.5 h-3.5" />
          <span className="font-semibold">Prompt enhanced.</span>
          <span className={MUTED}>Review it, then send — or</span>
          <button onClick={undoEnhance} className="flex items-center gap-0.5 font-semibold hover:text-[var(--ds-ink)] underline">
            <Undo2 className="w-3 h-3" /> undo
          </button>
        </div>
      )}

      <div className="relative flex items-end gap-2">
        {/* Slash-command (skills) menu */}
        {menuOpen && (
          <div className={`absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden ${MENU} animate-fade-in`}>
            <div className={`flex items-center gap-1 border-b border-[var(--ds-hairline)] bg-[var(--ds-well)] px-3 py-1.5 ${LABEL}`}>
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
                      className={`flex w-full items-start gap-2 px-3 py-2 text-left ${TRANSITION} ${active ? 'bg-[#D97757]/10' : 'hover:bg-[var(--ds-hover)]'}`}
                    >
                      <span className="mt-0.5 text-base leading-none">{s.emoji}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <code className="text-[12px] font-semibold">/{s.command}</code>
                          <span className={`text-[11px] ${MUTED}`}>{s.argRequired ? `<${s.argName}>` : `[${s.argName}]`}</span>
                        </span>
                        <span className={`block text-[11px] ${MUTED}`}>{s.description}</span>
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
              className={`shrink-0 ${CONTROL_BTN} p-2.5 ${MUTED} hover:text-[var(--ds-ink)] disabled:opacity-40`}
              title={features.vision ? 'Attach images or PDFs' : 'Attach a PDF'}
            >
              <Paperclip className="w-4 h-4" />
            </button>
            <button
              onClick={handleEnhance}
              disabled={!canEnhance}
              className={`hidden sm:block shrink-0 ${CONTROL_BTN} p-2.5 ${MUTED} hover:text-[var(--ds-ink)] disabled:opacity-40`}
              title="Improve my prompt (keeps your intent — review before sending)"
            >
              {enhancing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
            </button>
            <DictationButton
              disabled={busy}
              onStart={() => {
                dictationBaseRef.current = text;
              }}
              onPartial={applyDictation}
              onFinal={(spoken) => {
                applyDictation(spoken);
                textareaRef.current?.focus();
              }}
            />
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
          className="flex-1 resize-none bg-transparent rounded-xl px-3 py-2.5 text-base sm:text-sm text-[var(--ds-ink)] placeholder:text-[var(--ds-muted)] outline-none max-h-[200px]"
        />

        {busy ? (
          <button onClick={onStop} className={`shrink-0 rounded-full p-2.5 bg-red-500 hover:bg-red-600 text-white ${TRANSITION}`} title="Stop">
            <Square className="w-4 h-4" />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!canSend}
            className={`shrink-0 rounded-full p-2.5 ${ACCENT_BG} ${ACCENT_BG_HOVER} text-white disabled:opacity-40 ${TRANSITION} hover:-translate-y-px`}
            title="Send"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        )}
      </div>
      </div>
    </div>
  );
};
