import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus, MoreVertical, Trash2, Pencil, MessageSquare, ArrowLeft, GitBranch, Check, X,
  FolderPlus, ChevronDown, ChevronRight, FolderInput, SlidersHorizontal, Loader2,
  PanelLeftClose, PanelLeftOpen
} from 'lucide-react';
import type { ChatSession, ChatProject } from '../../services/chatStorage';
import { iconByName, colorByKey } from '../../services/chatProjectStyle';
import {
  SIDEBAR_BG, HAIRLINE, MENU, MUTED, INK, LABEL, TRANSITION,
  PRIMARY_BTN, CONTROL_BTN, HOVER_ROW, ACTIVE_ROW, ACCENT_TEXT, ACCENT_BG
} from './studioDesign';

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
      <div className={`flex items-center gap-1 rounded-xl ${HAIRLINE} px-2 py-1.5 ${active ? 'bg-[#D97757]/10' : 'bg-white/70'}`}>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditing(false); }}
          className="flex-1 min-w-0 text-base sm:text-sm outline-none bg-transparent font-medium"
        />
        <button onClick={commitRename} className="tap-target p-1 text-green-600 hover:scale-110"><Check className="w-4 h-4" /></button>
        <button onClick={() => setEditing(false)} className="tap-target p-1 text-slate-500 hover:scale-110"><X className="w-4 h-4" /></button>
      </div>
    );
  }

  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/session', session.id); e.dataTransfer.effectAllowed = 'move'; }}
      className={`group relative flex items-center gap-2 px-2.5 py-2 cursor-pointer ${TRANSITION} ${
        active ? ACTIVE_ROW : HOVER_ROW
      }`}
      onClick={onSelect}
    >
      {active && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ACCENT_BG}`} aria-hidden />}
      {generating
        ? <Loader2 className={`w-4 h-4 shrink-0 ${ACCENT_TEXT} animate-spin`} />
        : session.parentSessionId ? <GitBranch className="w-4 h-4 shrink-0 text-[#6e6a60]" /> : <MessageSquare className="w-4 h-4 shrink-0 text-[#6e6a60]" />}
      <span className={`flex-1 min-w-0 truncate text-sm font-medium ${active ? INK : 'text-[#3f3c35]'}`}>{session.title}</span>
      {generating && <span className={`shrink-0 text-[9px] font-semibold uppercase tracking-wide ${ACCENT_TEXT}`}>···</span>}

      <div ref={menuRef} className="relative">
        <button
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
          className={`tap-target p-1.5 sm:p-1 rounded-lg hover:bg-black/5 ${TRANSITION} ${menuOpen ? 'opacity-100' : 'hover-reveal'}`}
          title="Options"
        >
          <MoreVertical className="w-4 h-4" />
        </button>
        {menuOpen && (
          <div className={`absolute right-0 top-7 z-30 w-44 ${MENU} py-1 max-h-72 overflow-y-auto`}>
            <button onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setDraft(session.title); setEditing(true); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-black/5 text-left">
              <Pencil className="w-3.5 h-3.5" /> Rename
            </button>
            <button onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDelete(); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-red-50 text-red-600 text-left">
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </button>
            <div className="border-t border-black/10 my-1" />
            <div className={`px-3 py-0.5 ${LABEL} flex items-center gap-1`}><FolderInput className="w-3 h-3" /> Move to</div>
            <button onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onMoveToProject(null); }} className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-black/5 text-left ${!session.projectId ? 'font-semibold' : ''}`}>
              {!session.projectId && <Check className="w-3 h-3" />} Unfiled
            </button>
            {projects.map((p) => {
              const Icon = iconByName(p.icon);
              return (
                <button key={p.id} onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onMoveToProject(p.id); }} className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-black/5 text-left ${session.projectId === p.id ? 'font-semibold' : ''}`}>
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
  // Swatch kept for project identity, rendered as a quiet dot instead of a filled comic row.
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
      className={`rounded-xl border ${dragOver ? 'border-[#D97757] border-dashed bg-[#D97757]/5' : 'border-transparent'} ${TRANSITION}`}
    >
      <div className={`group flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-black/5 ${TRANSITION}`}>
        <button onClick={onToggle} className="flex items-center gap-1.5 min-w-0 flex-1">
          {collapsed ? <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[#6e6a60]" /> : <ChevronDown className="w-3.5 h-3.5 shrink-0 text-[#6e6a60]" />}
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${swatch.dot}`} aria-hidden />
          <Icon className="w-3.5 h-3.5 shrink-0 text-[#6e6a60]" />
          <span className={`${LABEL} truncate`}>{project.name}</span>
          <span className="text-[10px] text-[#6e6a60]/70 shrink-0">{sessions.length}</span>
        </button>
        <div ref={menuRef} className="relative">
          <button onClick={() => setMenuOpen((v) => !v)} className={`tap-target p-1.5 sm:p-1 rounded-lg hover:bg-black/5 ${TRANSITION} ${menuOpen ? 'opacity-100' : 'hover-reveal'}`}><MoreVertical className="w-4 h-4" /></button>
          {menuOpen && (
            <div className={`absolute right-0 top-7 z-30 w-36 ${MENU} py-1`}>
              <button onClick={() => { setMenuOpen(false); onEdit(); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-black/5 text-left"><Pencil className="w-3.5 h-3.5" /> Edit</button>
              <button onClick={() => { setMenuOpen(false); onDelete(); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-red-50 text-red-600 text-left"><Trash2 className="w-3.5 h-3.5" /> Delete</button>
            </div>
          )}
        </div>
      </div>
      {!collapsed && (
        <div className="pl-3 pt-1 space-y-1">
          {sessions.length === 0 ? (
            <p className="text-[10px] text-[#6e6a60]/70 px-2 py-1">Drag chats here</p>
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
  // Slim mode: the whole sidebar folds to an icon rail (persisted) so the conversation
  // gets the width — the #1 "wasted space" complaint about the chat layout.
  const [slim, setSlim] = useState<boolean>(() => {
    try { return window.localStorage.getItem('ds_chat_sidebar_slim') === '1'; } catch { return false; }
  });
  const setSlimPersist = (v: boolean) => {
    setSlim(v);
    try { window.localStorage.setItem('ds_chat_sidebar_slim', v ? '1' : '0'); } catch { /* private mode */ }
  };

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

  // Folded: a slim icon rail with the essentials; one click re-opens.
  if (slim) {
    return (
      <div className={`w-12 shrink-0 h-full flex flex-col items-center border-r border-black/10 ${SIDEBAR_BG} py-3 gap-2 transition-all duration-200`}>
        <button onClick={() => setSlimPersist(false)} title="Expand sidebar" className={`${CONTROL_BTN} p-1.5`}>
          <PanelLeftOpen className="w-4 h-4" />
        </button>
        <button onClick={onNew} title="New chat" className={`rounded-xl p-1.5 ${PRIMARY_BTN}`}>
          <Plus className="w-4 h-4" />
        </button>
        <button onClick={onNewProject} title="New project" className={`${CONTROL_BTN} p-1.5`}>
          <FolderPlus className="w-4 h-4" />
        </button>
        <div className="flex-1" />
        <button onClick={onEditMemory} title="Settings, memory, agents & tools" className={`${CONTROL_BTN} p-1.5 ${hasMemory ? 'bg-[#D97757]/10' : ''}`}>
          <SlidersHorizontal className="w-4 h-4" />
        </button>
        <button onClick={onBack} title="Back" className={`${CONTROL_BTN} p-1.5`}>
          <ArrowLeft className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className={`w-72 max-w-[85vw] shrink-0 h-full flex flex-col border-r border-black/10 ${SIDEBAR_BG} transition-all duration-200`}>
      <div className="p-3 border-b border-black/10 space-y-2">
        <div className="flex items-center justify-between">
          <button onClick={onBack} className={`flex items-center gap-1 text-xs font-medium ${MUTED} hover:text-[#1a1915] ${TRANSITION}`}>
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </button>
          <button onClick={() => setSlimPersist(true)} title="Collapse sidebar" className={`${MUTED} hover:text-[#1a1915] p-1 rounded-lg hover:bg-black/5 ${TRANSITION}`}>
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>
        <div className="flex gap-2">
          <button onClick={onNew} className={`flex-1 flex items-center justify-center gap-2 rounded-full px-3 py-2 font-semibold text-sm ${PRIMARY_BTN}`}>
            <Plus className="w-4 h-4" /> New chat
          </button>
          <button onClick={onNewProject} title="New project" className={`${CONTROL_BTN} px-2.5 py-2`}>
            <FolderPlus className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* The drawer panel scrolls here (not the page); overscroll-contain stops the
          rubber-band from bleeding into the conversation behind it on phones. */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch] p-2 space-y-2">
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
          className={`rounded-xl border ${dragOver === 'unfiled' ? 'border-[#D97757] border-dashed bg-[#D97757]/5' : 'border-transparent'} p-1 space-y-1`}
        >
          {projects.length > 0 && (
            <div className={`px-2 py-1 ${LABEL}`}>Unfiled</div>
          )}
          {byProject.unfiled.length === 0 ? (
            projects.length === 0 && <p className={`text-xs ${MUTED} text-center py-8`}>No chats yet. Start a new one.</p>
          ) : (
            byProject.unfiled.map(renderSession)
          )}
        </div>
      </div>

      {/* Footer respects the home-indicator safe area when shown as a mobile drawer. */}
      <div className="p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] border-t border-black/10 space-y-2">
        <button onClick={onEditMemory} className={`w-full flex items-center gap-2 ${CONTROL_BTN} px-3 py-1.5 text-sm font-medium ${hasMemory ? 'bg-[#D97757]/10' : ''}`} title="Memory, agents and tools">
          <SlidersHorizontal className="w-4 h-4" /> Settings {hasMemory ? '· memory on' : ''}
        </button>
        <p className={`text-[10px] ${MUTED} leading-tight`} title="Drag a chat onto a project to file it, or use its ⋮ menu.">
          Chats are stored on this device.
        </p>
      </div>
    </div>
  );
};
