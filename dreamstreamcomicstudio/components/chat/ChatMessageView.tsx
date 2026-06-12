import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Copy, Check, GitBranch, AlertTriangle, Sparkles, User, Globe, Brain,
  Download, FileArchive, ChevronDown, ChevronUp, ExternalLink, Search, Cpu, Play,
  RefreshCw, Pencil, ChevronLeft, ChevronRight, X, Info, Clock
} from 'lucide-react';
import JSZip from 'jszip';
import { FileText } from 'lucide-react';
import { ChatMarkdown } from './ChatMarkdown';
import { MessageBody } from '../MessageBody';
import { ChatArtifacts } from './artifacts/ChatArtifacts';
import { CodeStudioCard } from './artifacts/CodeStudioCard';
import { SourceCard } from './SourceCard';
import { useChatPanel } from './panelContext';
import type { ChatTurn } from '../../services/chatStorage';
import { extractCodeBlocks, codeBlockFilename, downloadTextFile, triggerDownload, buildPlaygroundFiles, buildStudioArtifact } from '../../services/chatUtils';
import { FeedbackButtons } from '../feedback/FeedbackButtons';
import {
  GLASS, HAIRLINE, MENU, MUTED, TRANSITION, PILL,
  ACCENT_BG, ACCENT_BG_HOVER, ACCENT_TEXT
} from './studioDesign';

/** Format an elapsed duration compactly: "0.8s", "12.3s", "1m 04s". */
const formatDuration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
};

/** A live, ticking elapsed-time counter shown while the model is generating. */
const LiveDuration: React.FC<{ startedAt?: number }> = ({ startedAt }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, []);
  if (!startedAt) return null;
  return <span className="tabular-nums">{formatDuration(now - startedAt)}</span>;
};

interface ChatMessageViewProps {
  turn: ChatTurn;
  /** Chat/session id, threaded to per-response feedback so ratings correlate to the chat. */
  sessionId?: string;
  /** True while a generation is in flight (disables regenerate/edit). */
  busy?: boolean;
  /** Whether this is the last turn in the conversation. */
  isLast?: boolean;
  /** Branch a new conversation from this assistant turn. `chooseNewModel` opens the model picker. */
  onBranch?: (chooseNewModel: boolean) => void;
  /** Regenerate this assistant turn (keeps prior answers as versions). */
  onRegenerate?: () => void;
  /** Edit + resend a user message. */
  onEdit?: (newText: string) => void;
  /** Switch which regenerated version is shown. */
  onSelectVariant?: (index: number) => void;
}

export const ChatMessageView: React.FC<ChatMessageViewProps> = ({ turn, sessionId, busy, isLast, onBranch, onRegenerate, onEdit, onSelectVariant }) => {
  const [copied, setCopied] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(turn.content);
  const branchRef = useRef<HTMLDivElement>(null);
  const openPanel = useChatPanel();
  const isUser = turn.role === 'user';

  // Version navigation (regenerate history) for assistant turns.
  const variantCount = turn.variants?.length || 0;
  const activeVariant = typeof turn.activeVariant === 'number' ? turn.activeVariant : variantCount - 1;
  // Live reasoning: show the model's thinking as it streams — and KEEP it visible
  // after the answer text starts (it used to vanish the moment the first content
  // token arrived, so you could never actually watch the agent think).
  const liveReasoning = !isUser && busy && isLast && Boolean(turn.reasoning);

  useEffect(() => {
    if (!branchOpen) return;
    const onClick = (e: MouseEvent) => {
      if (branchRef.current && !branchRef.current.contains(e.target as Node)) setBranchOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [branchOpen]);

  const codeBlocks = useMemo(() => (isUser ? [] : extractCodeBlocks(turn.content)), [isUser, turn.content]);
  // Fallback Code Studio: if the model wrote an app as Markdown code blocks instead of
  // calling generate_app (the norm for NVIDIA + free, non-tool-calling models), offer
  // the SAME live Studio it would have. Skip while still streaming and when the tool
  // already produced a code_studio artifact (so we never double up).
  const inferredStudio = useMemo(() => {
    if (isUser) return null;
    if (busy && isLast) return null;
    if (turn.artifacts?.some((a) => a.type === 'code_studio')) return null;
    return buildStudioArtifact(codeBlocks);
  }, [isUser, busy, isLast, turn.artifacts, codeBlocks]);
  const hasDetails = Boolean(
    turn.reasoning ||
    (turn.citations && turn.citations.length) ||
    (turn.toolEvents && turn.toolEvents.length)
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(turn.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const startEdit = () => { setEditDraft(turn.content); setEditing(true); };
  const cancelEdit = () => { setEditing(false); setEditDraft(turn.content); };
  const commitEdit = () => {
    const next = editDraft.trim();
    setEditing(false);
    if (next && next !== turn.content) onEdit?.(next);
  };

  const downloadMarkdown = () => downloadTextFile('dreamstream-answer.md', turn.content, 'text/markdown');

  const downloadZip = async () => {
    const zip = new JSZip();
    codeBlocks.forEach((b, i) => zip.file(codeBlockFilename(b, i), b.code));
    const blob = await zip.generateAsync({ type: 'blob' });
    triggerDownload('dreamstream-files.zip', blob);
  };

  return (
    <div className={`group flex gap-2 sm:gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      <div
        className={`shrink-0 w-8 h-8 sm:w-9 sm:h-9 rounded-full flex items-center justify-center ${
          isUser ? `${ACCENT_BG} text-white` : turn.error ? 'bg-red-500/10 border border-red-500/30' : `${GLASS} ${HAIRLINE}`
        }`}
      >
        {isUser ? <User className="w-4 h-4" /> : turn.error ? <AlertTriangle className="w-4 h-4 text-red-500" /> : <Sparkles className={`w-4 h-4 ${ACCENT_TEXT}`} />}
      </div>

      {/* On phones the bubble takes nearly the full width (assistant turns especially,
          so artifacts/tables/code get room); the 80% cap only applies from sm up. */}
      <div className={`min-w-0 ${isUser ? 'max-w-[88%]' : 'max-w-[92%]'} sm:max-w-[80%] flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
        <div
          className={`w-full ${
            isUser
              ? 'bg-[var(--ds-well-strong)] rounded-2xl px-4 py-2.5'
              : turn.error
                ? 'bg-red-500/10 border border-red-500/30 rounded-2xl px-4 py-2.5'
                : 'px-0.5 py-1'
          }`}
        >
          {turn.attachments && turn.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {turn.attachments.map((att) =>
                att.kind === 'document' ? (
                  <button
                    key={att.id}
                    onClick={() => openPanel?.({ type: 'media', data: { kind: 'pdf', url: att.dataUrl, title: att.name } })}
                    className={`w-28 h-20 rounded-xl ${HAIRLINE} bg-[var(--ds-surface-soft)] flex flex-col items-center justify-center p-1 hover:bg-[var(--ds-raised)] ${TRANSITION}`}
                    title="Open document"
                  >
                    <FileText className={`w-6 h-6 ${ACCENT_TEXT}`} />
                    <span className={`text-[9px] font-medium ${MUTED} truncate w-full text-center mt-1`}>{att.name}</span>
                  </button>
                ) : (
                  <button
                    key={att.id}
                    onClick={() => openPanel?.({ type: 'media', data: { kind: 'image', url: att.dataUrl, title: att.name } })}
                    className="block"
                    title="Open image"
                  >
                    <img src={att.dataUrl} alt={att.name} className={`w-20 h-20 object-cover rounded-xl ${HAIRLINE} hover:opacity-90 ${TRANSITION}`} />
                  </button>
                )
              )}
            </div>
          )}
          {liveReasoning && (
            <details open className="mb-2">
              <summary className="flex items-center gap-1.5 text-[11px] font-bold text-indigo-500 cursor-pointer select-none">
                <Brain className="w-3.5 h-3.5 animate-pulse" /> Thinking…
              </summary>
              <pre className="mt-1 text-[11px] whitespace-pre-wrap break-words text-[var(--ds-muted)] max-h-40 overflow-y-auto font-sans border-l-2 border-indigo-400/40 pl-2">{turn.reasoning}</pre>
            </details>
          )}
          {isUser && editing ? (
            <div className="w-full">
              <textarea
                autoFocus
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitEdit(); }
                  if (e.key === 'Escape') cancelEdit();
                }}
                rows={Math.min(10, Math.max(2, editDraft.split('\n').length))}
                className={`w-full text-base sm:text-sm ${HAIRLINE} rounded-xl bg-[var(--ds-surface-soft)] p-2 outline-none focus:ring-2 focus:ring-[#D97757]/30 resize-y`}
              />
              <div className="flex items-center justify-end gap-2 mt-1.5">
                <button onClick={cancelEdit} className={`flex items-center gap-1 text-[11px] font-semibold ${MUTED} hover:text-[var(--ds-ink)]`}><X className="w-3.5 h-3.5" /> Cancel</button>
                <button onClick={commitEdit} className={`flex items-center gap-1 text-[11px] font-semibold rounded-full px-2.5 py-0.5 ${ACCENT_BG} ${ACCENT_BG_HOVER} text-white ${TRANSITION}`}><Check className="w-3.5 h-3.5" /> Save & send</button>
              </div>
            </div>
          ) : isUser ? (
            <p className="whitespace-pre-wrap break-words text-sm">{turn.content}</p>
          ) : turn.error ? (
            <MessageBody text={turn.content || '…'} className="text-sm" />
          ) : turn.content ? (
            <ChatMarkdown text={turn.content} className="text-sm" />
          ) : (
            <span className="flex items-center gap-1.5 py-1">
              <span className="w-2 h-2 rounded-full bg-[var(--ds-muted)] animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-2 h-2 rounded-full bg-[var(--ds-muted)] animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-2 h-2 rounded-full bg-[var(--ds-muted)] animate-bounce" style={{ animationDelay: '300ms' }} />
            </span>
          )}

          {!isUser && <ChatArtifacts artifacts={turn.artifacts} />}

          {!isUser && inferredStudio && (
            <div className="mt-2">
              <CodeStudioCard data={inferredStudio} />
            </div>
          )}

          {!isUser && turn.images && turn.images.length > 0 && (
            <div className="mt-2 grid grid-cols-3 gap-2">
              {turn.images.map((img, i) => (
                <button
                  key={`${img.url}-${i}`}
                  onClick={() => openPanel?.({ type: 'media', data: { kind: 'image', url: img.url, title: img.title } })}
                  title={img.title || 'Open image'}
                  className="block"
                >
                  <img
                    src={img.thumbnail || img.url}
                    alt={img.title || 'image result'}
                    loading="lazy"
                    className={`w-full h-24 object-cover rounded-xl ${HAIRLINE} hover:opacity-90 ${TRANSITION}`}
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Live response timer — counts up while the model is generating this turn. */}
        {!isUser && busy && isLast && !turn.error && (
          <div className="mt-1 px-1 text-[11px] text-[var(--ds-muted)] flex items-center gap-1" title="Time elapsed generating this answer">
            <Clock className="w-3 h-3 animate-pulse" />
            <LiveDuration startedAt={turn.startedAt} />
          </div>
        )}

        {/* User message actions: copy + edit & resend. */}
        {isUser && !editing && (
          <div className="flex items-center gap-3 sm:gap-2 mt-1 px-1 text-[11px] text-[var(--ds-muted)] hover-reveal">
            <button onClick={handleCopy} className="tap-target flex items-center gap-0.5 hover:text-[var(--ds-ink)] font-bold" title="Copy message">
              {copied ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            {onEdit && (
              <button onClick={startEdit} disabled={busy} className="tap-target flex items-center gap-0.5 hover:text-[var(--ds-ink)] font-bold disabled:opacity-40" title="Edit & resend">
                <Pencil className="w-3 h-3" /> Edit
              </button>
            )}
          </div>
        )}

        {/* Retry for a failed assistant turn. */}
        {!isUser && turn.error && onRegenerate && (
          <div className="flex items-center gap-2 mt-1 px-1">
            <button onClick={onRegenerate} disabled={busy} className="tap-target flex items-center gap-0.5 text-[11px] font-semibold text-red-500 hover:text-[var(--ds-ink)] disabled:opacity-40" title="Try again">
              <RefreshCw className="w-3 h-3" /> Try again
            </button>
          </div>
        )}

        {/* Capability gaps: honest flags about what the AI couldn't fully deliver.
            DEDUPED — a tool that fails 7 times in one turn produced 7 identical rows
            of red noise; now each distinct message renders once with a ×N count. */}
        {!isUser && turn.notices && turn.notices.length > 0 && (() => {
          const grouped = new Map<string, { n: (typeof turn.notices)[number]; count: number }>();
          for (const n of turn.notices) {
            const key = `${n.level}:${n.message}:${n.fix ?? ''}`;
            const hit = grouped.get(key);
            if (hit) hit.count += 1;
            else grouped.set(key, { n, count: 1 });
          }
          return (
            <div className="w-full mt-1 space-y-1">
              {[...grouped.values()].map(({ n, count }, i) => (
                <div
                  key={i}
                  className={`flex items-start gap-1.5 text-[11px] rounded px-2 py-1 border ${
                    n.level === 'error' ? 'bg-red-500/10 border-red-500/30 text-red-600' : 'bg-amber-500/10 border-amber-500/30 text-amber-600'
                  }`}
                >
                  {n.level === 'error' ? <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" /> : <Info className="w-3 h-3 shrink-0 mt-0.5" />}
                  <span>
                    {n.message}
                    {n.fix ? <span className="font-bold"> ({n.fix})</span> : ''}
                    {count > 1 && <span className="ml-1 opacity-70">×{count}</span>}
                  </span>
                </div>
              ))}
            </div>
          );
        })()}

        {/* Model-switch transparency: shown when the answer came from a different model. */}
        {!isUser && !turn.error && turn.requestedModel && turn.model && turn.requestedModel !== turn.model && (
          <div className="mt-1 flex items-start gap-1 text-[10px] text-amber-600 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1 max-w-full">
            <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
            <span><span className="font-bold">{turn.requestedModel}</span> was unavailable or rate-limited, so this was answered by <span className="font-bold">{turn.model}</span>.</span>
          </div>
        )}

        {/* Structured "thinking & sources" dropdown */}
        {!isUser && !turn.error && hasDetails && (
          <div className="w-full mt-1">
            <button
              onClick={() => setShowDetails((v) => !v)}
              className={`tap-target flex items-center gap-1 text-[11px] font-semibold ${MUTED} hover:text-[var(--ds-ink)] ${PILL} px-2.5 py-1 sm:py-0.5 hover:bg-[var(--ds-raised)]`}
            >
              {showDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              How it answered
              {turn.toolEvents && turn.toolEvents.length > 0 && <Search className="w-3 h-3" />}
              {turn.reasoning && <Brain className="w-3 h-3" />}
              {turn.citations && turn.citations.length > 0 && <Globe className="w-3 h-3" />}
            </button>
            {showDetails && (
              <div className={`mt-1.5 ${GLASS} ${HAIRLINE} rounded-2xl p-3 space-y-3`}>
                {turn.toolEvents && turn.toolEvents.length > 0 && (
                  <div>
                    <div className="text-[11px] font-bold uppercase text-emerald-600 flex items-center gap-1 mb-1"><Search className="w-3.5 h-3.5" /> Tools used</div>
                    <ul className="space-y-1">
                      {turn.toolEvents.map((ev, i) => (
                        <li key={i} className="text-[11px] flex items-start gap-1.5">
                          <span className={`mt-0.5 w-1.5 h-1.5 rounded-full shrink-0 ${ev.ok ? 'bg-emerald-500' : 'bg-red-500'}`} />
                          <span><span className="font-bold">{ev.tool}</span>{ev.query ? `: “${ev.query}”` : ''}{!ev.ok && ev.summary ? ` — ${ev.summary}` : ''}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {turn.reasoning && (
                  <div>
                    <div className="text-[11px] font-bold uppercase text-indigo-500 flex items-center gap-1 mb-1"><Brain className="w-3.5 h-3.5" /> Reasoning</div>
                    <pre className="text-[11px] whitespace-pre-wrap break-words bg-[var(--ds-well)] border border-[var(--ds-hairline)] rounded p-2 max-h-60 overflow-y-auto font-sans">{turn.reasoning}</pre>
                  </div>
                )}
                {turn.citations && turn.citations.length > 0 && (
                  <div>
                    <div className="text-[11px] font-bold uppercase text-sky-600 flex items-center gap-1 mb-1.5"><Globe className="w-3.5 h-3.5" /> Web sources ({turn.citations.length})</div>
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {turn.citations.map((c, i) => (
                        <SourceCard key={`${c.url}-${i}`} index={i + 1} url={c.url} title={c.title} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {!isUser && !turn.error && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 sm:gap-2 mt-1 px-1 text-[11px] text-[var(--ds-muted)]">
            {turn.model && <span className="font-bold truncate max-w-[160px]">{turn.model}</span>}
            {typeof turn.durationMs === 'number' && turn.durationMs >= 0 && (
              <span className="flex items-center gap-0.5" title="Response time"><Clock className="w-3 h-3" /> {formatDuration(turn.durationMs)}</span>
            )}
            {turn.reasoningLevel && turn.reasoningLevel !== 'none' && (
              <span className="flex items-center gap-0.5"><Brain className="w-3 h-3" /> {turn.reasoningLevel}</span>
            )}
            {turn.webSearch && <span className="flex items-center gap-0.5"><Globe className="w-3 h-3" /> web</span>}
            {/* Version navigation across regenerated answers. */}
            {variantCount > 1 && (
              <span className="flex items-center gap-0.5 font-bold">
                <button
                  onClick={() => onSelectVariant?.(activeVariant - 1)}
                  disabled={activeVariant <= 0}
                  className="tap-target hover:text-[var(--ds-ink)] disabled:opacity-30"
                  title="Previous version"
                ><ChevronLeft className="w-3.5 h-3.5" /></button>
                <span className="tabular-nums">{activeVariant + 1}/{variantCount}</span>
                <button
                  onClick={() => onSelectVariant?.(activeVariant + 1)}
                  disabled={activeVariant >= variantCount - 1}
                  className="tap-target hover:text-[var(--ds-ink)] disabled:opacity-30"
                  title="Next version"
                ><ChevronRight className="w-3.5 h-3.5" /></button>
              </span>
            )}
            {onRegenerate && (
              <button onClick={onRegenerate} disabled={busy} className="tap-target flex items-center gap-0.5 hover:text-[var(--ds-ink)] font-bold disabled:opacity-40" title="Regenerate answer">
                <RefreshCw className="w-3 h-3" /> Retry
              </button>
            )}
            <button onClick={handleCopy} className="tap-target flex items-center gap-0.5 hover:text-[var(--ds-ink)] font-bold" title="Copy answer">
              {copied ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button onClick={downloadMarkdown} className="tap-target flex items-center gap-0.5 hover:text-[var(--ds-ink)] font-bold" title="Download answer as Markdown">
              <Download className="w-3 h-3" /> .md
            </button>
            {codeBlocks.length > 1 && (
              <button onClick={downloadZip} className="tap-target flex items-center gap-0.5 hover:text-[var(--ds-ink)] font-bold" title={`Download ${codeBlocks.length} files as a .zip`}>
                <FileArchive className="w-3 h-3" /> .zip ({codeBlocks.length})
              </button>
            )}
            {codeBlocks.length > 1 && openPanel && (
              <button
                onClick={() => {
                  const { files, template } = buildPlaygroundFiles(codeBlocks);
                  openPanel({ type: 'playground', data: { files, template, title: 'Playground' } });
                }}
                className="tap-target flex items-center gap-0.5 hover:text-[var(--ds-ink)] font-bold"
                title="Open all files in a runnable playground"
              >
                <Play className="w-3 h-3" /> Playground
              </button>
            )}
            {onBranch && (
              <div ref={branchRef} className="relative">
                <button onClick={() => setBranchOpen((v) => !v)} className="tap-target flex items-center gap-0.5 hover:text-[var(--ds-ink)] font-bold" title="Branch a new chat from here">
                  <GitBranch className="w-3 h-3" /> Branch
                </button>
                {branchOpen && (
                  <div className={`absolute left-0 bottom-6 z-20 w-44 ${MENU} py-1`}>
                    <button
                      onClick={() => { setBranchOpen(false); onBranch(false); }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] hover:bg-[var(--ds-hover)] text-left"
                    >
                      <GitBranch className="w-3.5 h-3.5" /> Same model
                    </button>
                    <button
                      onClick={() => { setBranchOpen(false); onBranch(true); }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] hover:bg-[var(--ds-hover)] text-left"
                    >
                      <Cpu className="w-3.5 h-3.5" /> Pick a new model…
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Per-response feedback. Shown on every finished assistant turn — including
            failed ones — so a like/dislike signal is captured no matter the outcome. */}
        {!isUser && !(busy && isLast) && (turn.content || turn.error) && (
          <FeedbackButtons
            targetType="chat_response"
            targetId={turn.id}
            sessionId={sessionId}
            source="ai_chat"
            compact
            className="mt-1 px-1"
            metadata={{ model: turn.model, hadError: Boolean(turn.error) }}
          />
        )}
      </div>
    </div>
  );
};
