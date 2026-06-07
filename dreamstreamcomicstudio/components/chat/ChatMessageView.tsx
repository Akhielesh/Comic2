import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Copy, Check, GitBranch, AlertTriangle, Sparkles, User, Globe, Brain,
  Download, FileArchive, ChevronDown, ChevronUp, ExternalLink, Search, Cpu, Play,
  RefreshCw, Pencil, ChevronLeft, ChevronRight, X, Info
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

interface ChatMessageViewProps {
  turn: ChatTurn;
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

export const ChatMessageView: React.FC<ChatMessageViewProps> = ({ turn, busy, isLast, onBranch, onRegenerate, onEdit, onSelectVariant }) => {
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
  // Live reasoning: streaming reasoning while the answer text hasn't started yet.
  const streamingThinking = !isUser && busy && isLast && !turn.content && Boolean(turn.reasoning);

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
    <div className={`group flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      <div
        className={`shrink-0 w-9 h-9 rounded-full border-2 border-black flex items-center justify-center ${
          isUser ? 'bg-brand-blue text-white' : turn.error ? 'bg-red-100' : 'bg-brand-yellow'
        }`}
      >
        {isUser ? <User className="w-4 h-4" /> : turn.error ? <AlertTriangle className="w-4 h-4 text-brand-red" /> : <Sparkles className="w-4 h-4" />}
      </div>

      <div className={`min-w-0 max-w-[80%] flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
        <div
          className={`border-2 border-black rounded-xl px-4 py-2.5 shadow-comic w-full ${
            isUser ? 'bg-white' : turn.error ? 'bg-red-50' : 'bg-slate-50'
          }`}
        >
          {turn.attachments && turn.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {turn.attachments.map((att) =>
                att.kind === 'document' ? (
                  <button
                    key={att.id}
                    onClick={() => openPanel?.({ type: 'media', data: { kind: 'pdf', url: att.dataUrl, title: att.name } })}
                    className="w-28 h-20 rounded-lg border-2 border-black bg-white flex flex-col items-center justify-center p-1 hover:bg-slate-50"
                    title="Open document"
                  >
                    <FileText className="w-6 h-6 text-brand-red" />
                    <span className="text-[9px] font-bold text-slate-600 truncate w-full text-center mt-1">{att.name}</span>
                  </button>
                ) : (
                  <button
                    key={att.id}
                    onClick={() => openPanel?.({ type: 'media', data: { kind: 'image', url: att.dataUrl, title: att.name } })}
                    className="block"
                    title="Open image"
                  >
                    <img src={att.dataUrl} alt={att.name} className="w-20 h-20 object-cover rounded-lg border-2 border-black hover:opacity-90" />
                  </button>
                )
              )}
            </div>
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
                className="w-full text-sm border-2 border-black rounded-lg p-2 outline-none focus:ring-2 focus:ring-brand-blue/40 resize-y"
              />
              <div className="flex items-center justify-end gap-2 mt-1.5">
                <button onClick={cancelEdit} className="flex items-center gap-1 text-[11px] font-bold text-slate-500 hover:text-black"><X className="w-3.5 h-3.5" /> Cancel</button>
                <button onClick={commitEdit} className="flex items-center gap-1 text-[11px] font-bold border-2 border-black rounded-full px-2.5 py-0.5 bg-brand-yellow hover:translate-y-[1px]"><Check className="w-3.5 h-3.5" /> Save & send</button>
              </div>
            </div>
          ) : isUser ? (
            <p className="whitespace-pre-wrap break-words text-sm">{turn.content}</p>
          ) : turn.error ? (
            <MessageBody text={turn.content || '…'} className="text-sm" />
          ) : turn.content ? (
            <ChatMarkdown text={turn.content} className="text-sm" />
          ) : streamingThinking ? (
            <div className="py-1">
              <div className="flex items-center gap-1.5 text-[11px] font-bold text-indigo-600 mb-1">
                <Brain className="w-3.5 h-3.5 animate-pulse" /> Thinking…
              </div>
              <pre className="text-[11px] whitespace-pre-wrap break-words text-slate-500 max-h-32 overflow-y-auto font-sans">{turn.reasoning}</pre>
            </div>
          ) : (
            <span className="flex items-center gap-1.5 py-1">
              <span className="w-2 h-2 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-2 h-2 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-2 h-2 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '300ms' }} />
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
                    className="w-full h-24 object-cover rounded-lg border-2 border-black hover:opacity-90"
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* User message actions: copy + edit & resend. */}
        {isUser && !editing && (
          <div className="flex items-center gap-2 mt-1 px-1 text-[11px] text-slate-400 hover-reveal">
            <button onClick={handleCopy} className="flex items-center gap-0.5 hover:text-black font-bold" title="Copy message">
              {copied ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            {onEdit && (
              <button onClick={startEdit} disabled={busy} className="flex items-center gap-0.5 hover:text-black font-bold disabled:opacity-40" title="Edit & resend">
                <Pencil className="w-3 h-3" /> Edit
              </button>
            )}
          </div>
        )}

        {/* Retry for a failed assistant turn. */}
        {!isUser && turn.error && onRegenerate && (
          <div className="flex items-center gap-2 mt-1 px-1">
            <button onClick={onRegenerate} disabled={busy} className="flex items-center gap-0.5 text-[11px] font-bold text-brand-red hover:text-black disabled:opacity-40" title="Try again">
              <RefreshCw className="w-3 h-3" /> Try again
            </button>
          </div>
        )}

        {/* Capability gaps: honest flags about what the AI couldn't fully deliver. */}
        {!isUser && turn.notices && turn.notices.length > 0 && (
          <div className="w-full mt-1 space-y-1">
            {turn.notices.map((n, i) => (
              <div
                key={i}
                className={`flex items-start gap-1.5 text-[11px] rounded px-2 py-1 border ${
                  n.level === 'error' ? 'bg-red-50 border-red-300 text-red-700' : 'bg-amber-50 border-amber-300 text-amber-800'
                }`}
              >
                {n.level === 'error' ? <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" /> : <Info className="w-3 h-3 shrink-0 mt-0.5" />}
                <span>{n.message}{n.fix ? <span className="font-bold"> ({n.fix})</span> : ''}</span>
              </div>
            ))}
          </div>
        )}

        {/* Model-switch transparency: shown when the answer came from a different model. */}
        {!isUser && !turn.error && turn.requestedModel && turn.model && turn.requestedModel !== turn.model && (
          <div className="mt-1 flex items-start gap-1 text-[10px] text-amber-700 bg-amber-50 border border-amber-300 rounded px-2 py-1 max-w-full">
            <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
            <span><span className="font-bold">{turn.requestedModel}</span> was unavailable or rate-limited, so this was answered by <span className="font-bold">{turn.model}</span>.</span>
          </div>
        )}

        {/* Structured "thinking & sources" dropdown */}
        {!isUser && !turn.error && hasDetails && (
          <div className="w-full mt-1">
            <button
              onClick={() => setShowDetails((v) => !v)}
              className="flex items-center gap-1 text-[11px] font-bold text-slate-600 hover:text-black border-2 border-black rounded-full px-2.5 py-0.5 bg-white"
            >
              {showDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              How it answered
              {turn.toolEvents && turn.toolEvents.length > 0 && <Search className="w-3 h-3" />}
              {turn.reasoning && <Brain className="w-3 h-3" />}
              {turn.citations && turn.citations.length > 0 && <Globe className="w-3 h-3" />}
            </button>
            {showDetails && (
              <div className="mt-1.5 border-2 border-black rounded-lg bg-white p-3 space-y-3">
                {turn.toolEvents && turn.toolEvents.length > 0 && (
                  <div>
                    <div className="text-[11px] font-bold uppercase text-emerald-700 flex items-center gap-1 mb-1"><Search className="w-3.5 h-3.5" /> Tools used</div>
                    <ul className="space-y-1">
                      {turn.toolEvents.map((ev, i) => (
                        <li key={i} className="text-[11px] flex items-start gap-1.5">
                          <span className={`mt-0.5 w-1.5 h-1.5 rounded-full shrink-0 ${ev.ok ? 'bg-emerald-500' : 'bg-brand-red'}`} />
                          <span><span className="font-bold">{ev.tool}</span>{ev.query ? `: “${ev.query}”` : ''}{!ev.ok && ev.summary ? ` — ${ev.summary}` : ''}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {turn.reasoning && (
                  <div>
                    <div className="text-[11px] font-bold uppercase text-indigo-600 flex items-center gap-1 mb-1"><Brain className="w-3.5 h-3.5" /> Reasoning</div>
                    <pre className="text-[11px] whitespace-pre-wrap break-words bg-slate-50 border border-slate-200 rounded p-2 max-h-60 overflow-y-auto font-sans">{turn.reasoning}</pre>
                  </div>
                )}
                {turn.citations && turn.citations.length > 0 && (
                  <div>
                    <div className="text-[11px] font-bold uppercase text-sky-700 flex items-center gap-1 mb-1.5"><Globe className="w-3.5 h-3.5" /> Web sources ({turn.citations.length})</div>
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
          <div className="flex flex-wrap items-center gap-2 mt-1 px-1 text-[11px] text-slate-500">
            {turn.model && <span className="font-bold truncate max-w-[160px]">{turn.model}</span>}
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
                  className="hover:text-black disabled:opacity-30"
                  title="Previous version"
                ><ChevronLeft className="w-3.5 h-3.5" /></button>
                <span className="tabular-nums">{activeVariant + 1}/{variantCount}</span>
                <button
                  onClick={() => onSelectVariant?.(activeVariant + 1)}
                  disabled={activeVariant >= variantCount - 1}
                  className="hover:text-black disabled:opacity-30"
                  title="Next version"
                ><ChevronRight className="w-3.5 h-3.5" /></button>
              </span>
            )}
            {onRegenerate && (
              <button onClick={onRegenerate} disabled={busy} className="flex items-center gap-0.5 hover:text-black font-bold disabled:opacity-40" title="Regenerate answer">
                <RefreshCw className="w-3 h-3" /> Retry
              </button>
            )}
            <button onClick={handleCopy} className="flex items-center gap-0.5 hover:text-black font-bold" title="Copy answer">
              {copied ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button onClick={downloadMarkdown} className="flex items-center gap-0.5 hover:text-black font-bold" title="Download answer as Markdown">
              <Download className="w-3 h-3" /> .md
            </button>
            {codeBlocks.length > 1 && (
              <button onClick={downloadZip} className="flex items-center gap-0.5 hover:text-black font-bold" title={`Download ${codeBlocks.length} files as a .zip`}>
                <FileArchive className="w-3 h-3" /> .zip ({codeBlocks.length})
              </button>
            )}
            {codeBlocks.length > 1 && openPanel && (
              <button
                onClick={() => {
                  const { files, template } = buildPlaygroundFiles(codeBlocks);
                  openPanel({ type: 'playground', data: { files, template, title: 'Playground' } });
                }}
                className="flex items-center gap-0.5 hover:text-black font-bold"
                title="Open all files in a runnable playground"
              >
                <Play className="w-3 h-3" /> Playground
              </button>
            )}
            {onBranch && (
              <div ref={branchRef} className="relative">
                <button onClick={() => setBranchOpen((v) => !v)} className="flex items-center gap-0.5 hover:text-black font-bold" title="Branch a new chat from here">
                  <GitBranch className="w-3 h-3" /> Branch
                </button>
                {branchOpen && (
                  <div className="absolute left-0 bottom-6 z-20 w-44 bg-white border-2 border-black rounded-lg shadow-comic py-1">
                    <button
                      onClick={() => { setBranchOpen(false); onBranch(false); }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] hover:bg-slate-100 text-left"
                    >
                      <GitBranch className="w-3.5 h-3.5" /> Same model
                    </button>
                    <button
                      onClick={() => { setBranchOpen(false); onBranch(true); }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] hover:bg-slate-100 text-left"
                    >
                      <Cpu className="w-3.5 h-3.5" /> Pick a new model…
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
