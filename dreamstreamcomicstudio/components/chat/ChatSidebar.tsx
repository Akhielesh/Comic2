import React, { useEffect, useRef, useState } from 'react';
import { Plus, MoreVertical, Trash2, Pencil, MessageSquare, ArrowLeft, GitBranch, Check, X, Brain } from 'lucide-react';
import type { ChatSession } from '../../services/chatStorage';

interface ChatSidebarProps {
  sessions: ChatSession[];
  activeId: string | null;
  hasMemory: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onEditMemory: () => void;
  onBack: () => void;
}

const SessionRow: React.FC<{
  session: ChatSession;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}> = ({ session, active, onSelect, onDelete, onRename }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  const commitRename = () => {
    const next = draft.trim();
    if (next && next !== session.title) onRename(next);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className={`flex items-center gap-1 rounded-lg border-2 border-black px-2 py-1.5 ${active ? 'bg-brand-yellow/50' : 'bg-white'}`}>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="flex-1 min-w-0 text-sm outline-none bg-transparent font-semibold"
        />
        <button onClick={commitRename} className="text-green-600 hover:scale-110"><Check className="w-4 h-4" /></button>
        <button onClick={() => setEditing(false)} className="text-slate-500 hover:scale-110"><X className="w-4 h-4" /></button>
      </div>
    );
  }

  return (
    <div
      className={`group relative flex items-center gap-2 rounded-lg border-2 px-2.5 py-2 cursor-pointer transition-all ${
        active ? 'border-black bg-brand-yellow/50 shadow-comic-hover' : 'border-transparent hover:border-black hover:bg-white'
      }`}
      onClick={onSelect}
    >
      {session.parentSessionId ? <GitBranch className="w-4 h-4 shrink-0 text-slate-500" /> : <MessageSquare className="w-4 h-4 shrink-0 text-slate-500" />}
      <span className="flex-1 min-w-0 truncate text-sm font-semibold">{session.title}</span>

      <div ref={menuRef} className="relative">
        <button
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
          className={`p-1 rounded hover:bg-black/10 ${menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
          title="Options"
        >
          <MoreVertical className="w-4 h-4" />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-7 z-20 w-36 bg-white border-2 border-black rounded-lg shadow-comic py-1">
            <button
              onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setDraft(session.title); setEditing(true); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-100 text-left"
            >
              <Pencil className="w-3.5 h-3.5" /> Rename
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDelete(); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-red-50 text-brand-red text-left"
            >
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export const ChatSidebar: React.FC<ChatSidebarProps> = ({ sessions, activeId, hasMemory, onSelect, onNew, onDelete, onRename, onEditMemory, onBack }) => (
  <div className="w-72 shrink-0 h-full flex flex-col border-r-4 border-black bg-slate-100">
    <div className="p-3 border-b-2 border-black space-y-2">
      <button onClick={onBack} className="flex items-center gap-1 text-xs font-bold text-slate-600 hover:text-black hover:underline">
        <ArrowLeft className="w-3.5 h-3.5" /> Back
      </button>
      <button
        onClick={onNew}
        className="w-full flex items-center justify-center gap-2 border-2 border-black rounded-lg px-3 py-2 bg-brand-yellow font-bold text-sm shadow-comic hover:translate-y-[1px] hover:shadow-comic-hover"
      >
        <Plus className="w-4 h-4" /> New chat
      </button>
    </div>

    <div className="flex-1 overflow-y-auto p-2 space-y-1">
      {sessions.length === 0 ? (
        <p className="text-xs text-slate-500 text-center py-8">No chats yet. Start a new one.</p>
      ) : (
        sessions.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            active={s.id === activeId}
            onSelect={() => onSelect(s.id)}
            onDelete={() => onDelete(s.id)}
            onRename={(title) => onRename(s.id, title)}
          />
        ))
      )}
    </div>

    <div className="p-3 border-t-2 border-black space-y-2">
      <button
        onClick={onEditMemory}
        className={`w-full flex items-center gap-2 border-2 border-black rounded-lg px-3 py-1.5 text-sm font-bold ${hasMemory ? 'bg-indigo-100' : 'bg-white hover:bg-slate-100'}`}
        title="Durable facts the AI remembers across every chat"
      >
        <Brain className="w-4 h-4" /> Memory {hasMemory ? '· on' : ''}
      </button>
      <p className="text-[10px] text-slate-500 leading-tight">
        Chats are stored on this device. Pick any model from the catalog — reasoning, vision and web tools appear when supported.
      </p>
    </div>
  </div>
);
