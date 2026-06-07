import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus, MoreVertical, Trash2, Pencil, MessageSquare, ArrowLeft, GitBranch, Check, X,
  FolderPlus, ChevronDown, ChevronRight, FolderInput, SlidersHorizontal, Loader2
} from 'lucide-react';
import type { ChatSession, ChatProject } from '../../services/chatStorage';
import { iconByName, colorByKey } from '../../services/chatProjectStyle';

interface ChatSidebarProps {
  sessions: ChatSession[];
  projects: ChatProject[];
  activeId: string | null;
  /** Ids of chats currently generating an answer (shows a spinner). */
  generatingIds?: Set<string>;
  hasMemory: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onMoveToProject: (sessionId: string, projectId: string | null) => void;
  onNewProject: () => void;
  onEditProject: (project: ChatProject) => void;
  onDeleteProject: (projectId: string) => void;
  onEditMemory: () => void;
  onBack: () => void;
}

const SessionRow: React.FC<{
  session: ChatSession;
  projects: ChatProject[];
  active: boolean;
  generating?: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
  onMoveToProject: (projectId: string | null) => void;
}> = ({ session, projects, active, generating, onSelect, onDelete, onRename, onMoveToProject }) => {
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
          onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditing(false); }}
          className="flex-1 min-w-0 text-sm outline-none bg-transparent font-semibold"
        />
        <button onClick={commitRename} className="text-green-600 hover:scale-110"><Check className="w-4 h-4" /></button>
        <button onClick={() => setEditing(false)} className="text-slate-500 hover:scale-110"><X className="w-4 h-4" /></button>
      </div>
    );
  }

  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/session', session.id); e.dataTransfer.effectAllowed = 'move'; }}
      className={`group relative flex items-center gap-2 rounded-lg border-2 px-2.5 py-2 cursor-pointer transition-all ${
        active ? 'border-black bg-brand-yellow/50 shadow-comic-hover' : 'border-transparent hover:border-black hover:bg-white'
      }`}
      onClick={onSelect}
    >
      {generating
        ? <Loader2 className="w-4 h-4 shrink-0 text-brand-blue animate-spin" />
        : session.parentSessionId ? <GitBranch className="w-4 h-4 shrink-0 text-slate-500" /> : <MessageSquare className="w-4 h-4 shrink-0 text-slate-500" />}
      <span className="flex-1 min-w-0 truncate text-sm font-semibold">{session.title}</span>
      {generating && <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-brand-blue">···</span>}

      <div ref={menuRef} className="relative">
        <button
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
          className={`p-1 rounded hover:bg-black/10 ${menuOpen ? 'opacity-100' : 'hover-reveal'}`}
          title="Options"
        >
          <MoreVertical className="w-4 h-4" />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-7 z-30 w-44 bg-white border-2 border-black rounded-lg shadow-comic py-1 max-h-72 overflow-y-auto">
            <button onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setDraft(session.title); setEditing(true); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-100 text-left">
              <Pencil className="w-3.5 h-3.5" /> Rename
            </button>
            <button onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDelete(); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-red-50 text-brand-red text-left">
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </button>
            <div className="border-t border-slate-200 my-1" />
            <div className="px-3 py-0.5 text-[10px] font-bold uppercase text-slate-400 flex items-center gap-1"><FolderInput className="w-3 h-3" /> Move to</div>
            <button onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onMoveToProject(null); }} className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-100 text-left ${!session.projectId ? 'font-bold' : ''}`}>
              {!session.projectId && <Check className="w-3 h-3" />} Unfiled
            </button>
            {projects.map((p) => {
              const Icon = iconByName(p.icon);
              return (
                <button key={p.id} onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onMoveToProject(p.id); }} className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-100 text-left ${session.projectId === p.id ? 'font-bold' : ''}`}>
                  <Icon className="w-3.5 h-3.5" /> <span className="truncate">{p.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

const ProjectGroup: React.FC<{
  project: ChatProject;
  sessions: ChatSession[];
  activeId: string | null;
  projects: ChatProject[];
  collapsed: boolean;
  dragOver: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onDropSession: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  renderSession: (s: ChatSession) => React.ReactNode;
}> = ({ project, sessions, collapsed, dragOver, onToggle, onEdit, onDelete, onDropSession, onDragOver, onDragLeave, renderSession }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const Icon = iconByName(project.icon);
  const swatch = colorByKey(project.color);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  return (
    <div
      onDrop={onDropSession}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      className={`rounded-lg border-2 ${dragOver ? 'border-brand-blue border-dashed bg-brand-blue/5' : 'border-transparent'}`}
    >
      <div className={`group flex items-center gap-2 rounded-lg border-2 border-black px-2 py-1.5 ${swatch.soft}`}>
        <button onClick={onToggle} className="flex items-center gap-1.5 min-w-0 flex-1">
          {collapsed ? <ChevronRight className="w-3.5 h-3.5 shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 shrink-0" />}
          <Icon className="w-4 h-4 shrink-0" />
          <span className="font-bold text-sm truncate">{project.name}</span>
          <span className="text-[10px] text-slate-500 shrink-0">{sessions.length}</span>
        </button>
        <div ref={menuRef} className="relative">
          <button onClick={() => setMenuOpen((v) => !v)} className={`p-1 rounded hover:bg-black/10 ${menuOpen ? 'opacity-100' : 'hover-reveal'}`}><MoreVertical className="w-4 h-4" /></button>
          {menuOpen && (
            <div className="absolute right-0 top-7 z-30 w-36 bg-white border-2 border-black rounded-lg shadow-comic py-1">
              <button onClick={() => { setMenuOpen(false); onEdit(); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-100 text-left"><Pencil className="w-3.5 h-3.5" /> Edit</button>
              <button onClick={() => { setMenuOpen(false); onDelete(); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-red-50 text-brand-red text-left"><Trash2 className="w-3.5 h-3.5" /> Delete</button>
            </div>
          )}
        </div>
      </div>
      {!collapsed && (
        <div className="pl-3 pt-1 space-y-1">
          {sessions.length === 0 ? (
            <p className="text-[10px] text-slate-400 px-2 py-1">Drag chats here</p>
          ) : (
            sessions.map(renderSession)
          )}
        </div>
      )}
    </div>
  );
};

export const ChatSidebar: React.FC<ChatSidebarProps> = ({
  sessions, projects, activeId, generatingIds, hasMemory,
  onSelect, onNew, onDelete, onRename, onMoveToProject,
  onNewProject, onEditProject, onDeleteProject, onEditMemory, onBack
}) => {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState<string | null>(null);

  const byProject = useMemo(() => {
    const map = new Map<string, ChatSession[]>();
    const unfiled: ChatSession[] = [];
    for (const s of sessions) {
      if (s.projectId && projects.some((p) => p.id === s.projectId)) {
        const list = map.get(s.projectId) || [];
        list.push(s);
        map.set(s.projectId, list);
      } else {
        unfiled.push(s);
      }
    }
    return { map, unfiled };
  }, [sessions, projects]);

  const toggle = (id: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const dropHandler = (projectId: string | null) => (e: React.DragEvent) => {
    e.preventDefault();
    const sid = e.dataTransfer.getData('text/session');
    if (sid) onMoveToProject(sid, projectId);
    setDragOver(null);
  };
  const allowDrop = (key: string) => (e: React.DragEvent) => { e.preventDefault(); setDragOver(key); };

  const renderSession = (s: ChatSession) => (
    <SessionRow
      key={s.id}
      session={s}
      projects={projects}
      active={s.id === activeId}
      generating={generatingIds?.has(s.id)}
      onSelect={() => onSelect(s.id)}
      onDelete={() => onDelete(s.id)}
      onRename={(title) => onRename(s.id, title)}
      onMoveToProject={(projectId) => onMoveToProject(s.id, projectId)}
    />
  );

  return (
    <div className="w-72 shrink-0 h-full flex flex-col border-r-4 border-black bg-slate-100">
      <div className="p-3 border-b-2 border-black space-y-2">
        <button onClick={onBack} className="flex items-center gap-1 text-xs font-bold text-slate-600 hover:text-black hover:underline">
          <ArrowLeft className="w-3.5 h-3.5" /> Back
        </button>
        <div className="flex gap-2">
          <button onClick={onNew} className="flex-1 flex items-center justify-center gap-2 border-2 border-black rounded-lg px-3 py-2 bg-brand-yellow font-bold text-sm shadow-comic hover:translate-y-[1px] hover:shadow-comic-hover">
            <Plus className="w-4 h-4" /> New chat
          </button>
          <button onClick={onNewProject} title="New project" className="border-2 border-black rounded-lg px-2.5 py-2 bg-white font-bold shadow-comic hover:translate-y-[1px] hover:shadow-comic-hover">
            <FolderPlus className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {/* Projects */}
        {projects.map((project) => (
          <ProjectGroup
            key={project.id}
            project={project}
            projects={projects}
            sessions={byProject.map.get(project.id) || []}
            activeId={activeId}
            collapsed={collapsed.has(project.id)}
            dragOver={dragOver === project.id}
            onToggle={() => toggle(project.id)}
            onEdit={() => onEditProject(project)}
            onDelete={() => onDeleteProject(project.id)}
            onDropSession={dropHandler(project.id)}
            onDragOver={allowDrop(project.id)}
            onDragLeave={() => setDragOver(null)}
            renderSession={renderSession}
          />
        ))}

        {/* Unfiled */}
        <div
          onDrop={dropHandler(null)}
          onDragOver={allowDrop('unfiled')}
          onDragLeave={() => setDragOver(null)}
          className={`rounded-lg border-2 ${dragOver === 'unfiled' ? 'border-brand-blue border-dashed bg-brand-blue/5' : 'border-transparent'} p-1 space-y-1`}
        >
          {projects.length > 0 && (
            <div className="px-2 py-1 text-[10px] font-bold uppercase text-slate-400">Unfiled</div>
          )}
          {byProject.unfiled.length === 0 ? (
            projects.length === 0 && <p className="text-xs text-slate-500 text-center py-8">No chats yet. Start a new one.</p>
          ) : (
            byProject.unfiled.map(renderSession)
          )}
        </div>
      </div>

      <div className="p-3 border-t-2 border-black space-y-2">
        <button onClick={onEditMemory} className={`w-full flex items-center gap-2 border-2 border-black rounded-lg px-3 py-1.5 text-sm font-bold ${hasMemory ? 'bg-indigo-100' : 'bg-white hover:bg-slate-100'}`} title="Memory, agents and tools">
          <SlidersHorizontal className="w-4 h-4" /> Settings {hasMemory ? '· memory on' : ''}
        </button>
        <p className="text-[10px] text-slate-500 leading-tight">
          Drag a chat onto a project to file it, or use its ⋮ menu. Chats are stored on this device.
        </p>
      </div>
    </div>
  );
};
