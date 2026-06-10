import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus, MoreVertical, MoreHorizontal, Trash2, Pencil, ArrowLeft, GitBranch, Check, X,
  FolderPlus, ChevronDown, ChevronRight, FolderInput, Loader2, Search, Sparkles,
  LayoutDashboard, LayoutGrid, Wrench, Settings, PanelLeftClose, PanelLeftOpen,
  Sun, Moon, Monitor
} from 'lucide-react';
import type { ChatSession, ChatProject } from '../../services/chatStorage';
import { iconByName, colorByKey } from '../../services/chatProjectStyle';
import { useTheme, type ThemePreference } from '../../services/theme';
import {
  SIDEBAR_BG, HAIRLINE, MENU, MENU_ITEM, MUTED, INK, LABEL, TRANSITION,
  PRIMARY_BTN, CONTROL_BTN, NAV_ROW, NAV_ROW_ACTIVE, RAIL_ROW, RAIL_ROW_ACTIVE,
  ACCENT_TEXT, ACCENT_BG
} from './studioDesign';

interface ChatSidebarProps {
  sessions: ChatSession[];
  projects: ChatProject[];
  activeId: string | null;
  /** Ids of chats currently generating an answer (shows a spinner). */
  generatingIds?: Set<string>;
  hasMemory: boolean;
  /** Which main view is showing — used to highlight Skills/Dashboards rows. */
  view?: 'chat' | 'home' | 'skills' | 'dashboards';
  userName?: string;
  userEmail?: string;
  planLabel?: string;
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
  /** Opens the command palette. */
  onOpenSearch: () => void;
  onOpenSkills: () => void;
  onOpenDashboards: () => void;
  onOpenGallery: () => void;
  onOpenTools: () => void;
}

// ---------------------------------------------------------------------------
// Session row — single truncated line, quiet hover, kebab on hover/touch.
// ---------------------------------------------------------------------------

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
      <div className={`flex items-center gap-1 rounded-lg ${HAIRLINE} px-2 py-1 ${active ? 'bg-[#D97757]/10' : 'bg-[var(--ds-surface-soft)]'}`}>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditing(false); }}
          className={`flex-1 min-w-0 text-base sm:text-[13px] outline-none bg-transparent font-medium ${INK}`}
        />
        <button onClick={commitRename} className="tap-target p-1 text-green-600 hover:scale-110"><Check className="w-3.5 h-3.5" /></button>
        <button onClick={() => setEditing(false)} className={`tap-target p-1 ${MUTED} hover:scale-110`}><X className="w-3.5 h-3.5" /></button>
      </div>
    );
  }

  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/session', session.id); e.dataTransfer.effectAllowed = 'move'; }}
      className={`group relative flex items-center gap-1.5 cursor-pointer ${active ? RAIL_ROW_ACTIVE : RAIL_ROW}`}
      onClick={onSelect}
    >
      {generating && <Loader2 className={`w-3.5 h-3.5 shrink-0 ${ACCENT_TEXT} animate-spin`} />}
      {!generating && session.parentSessionId && <GitBranch className="w-3.5 h-3.5 shrink-0 text-[var(--ds-muted)]" />}
      <span className={`flex-1 min-w-0 truncate ${active ? `font-medium ${INK}` : 'text-[var(--ds-ink)]'}`}>{session.title}</span>

      <div ref={menuRef} className="relative shrink-0">
        <button
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
          className={`tap-target p-1 rounded-md ${MUTED} hover:text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] ${TRANSITION} ${menuOpen ? 'opacity-100' : 'hover-reveal'}`}
          title="Options"
        >
          <MoreVertical className="w-3.5 h-3.5" />
        </button>
        {menuOpen && (
          <div className={`absolute right-0 top-7 z-30 w-44 ${MENU} py-1 max-h-72 overflow-y-auto`}>
            <button onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setDraft(session.title); setEditing(true); }} className={MENU_ITEM}>
              <Pencil className="w-3.5 h-3.5" /> Rename
            </button>
            <button onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDelete(); }} className={`${MENU_ITEM} text-red-600 hover:bg-red-500/10`}>
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </button>
            <div className="border-t border-[var(--ds-hairline)] my-1" />
            <div className={`px-3 py-0.5 ${LABEL} flex items-center gap-1`}><FolderInput className="w-3 h-3" /> Move to</div>
            <button onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onMoveToProject(null); }} className={`${MENU_ITEM} ${!session.projectId ? 'font-semibold' : ''}`}>
              {!session.projectId && <Check className="w-3 h-3" />} Unfiled
            </button>
            {projects.map((p) => {
              const Icon = iconByName(p.icon);
              return (
                <button key={p.id} onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onMoveToProject(p.id); }} className={`${MENU_ITEM} ${session.projectId === p.id ? 'font-semibold' : ''}`}>
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

// ---------------------------------------------------------------------------
// Project group — small-caps label with a tiny options affordance; drop target.
// ---------------------------------------------------------------------------

const ProjectGroup: React.FC<{
  project: ChatProject;
  sessions: ChatSession[];
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
  // Swatch kept for project identity, rendered as a quiet dot.
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
      className={`rounded-lg border ${dragOver ? 'border-[#D97757] border-dashed bg-[#D97757]/5' : 'border-transparent'} ${TRANSITION}`}
    >
      <div className={`group flex items-center gap-1 rounded-lg px-1.5 py-1 hover:bg-[var(--ds-hover)] ${TRANSITION}`}>
        <button onClick={onToggle} className="flex items-center gap-1.5 min-w-0 flex-1">
          {collapsed ? <ChevronRight className="w-3 h-3 shrink-0 text-[var(--ds-muted)]" /> : <ChevronDown className="w-3 h-3 shrink-0 text-[var(--ds-muted)]" />}
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${swatch.dot}`} aria-hidden />
          <Icon className="w-3 h-3 shrink-0 text-[var(--ds-muted)]" />
          <span className={`${LABEL} truncate`}>{project.name}</span>
          <span className="text-[10px] text-[var(--ds-muted)] shrink-0">{sessions.length}</span>
        </button>
        <div ref={menuRef} className="relative">
          <button onClick={() => setMenuOpen((v) => !v)} title="Project options" className={`tap-target p-1 rounded-md ${MUTED} hover:text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] ${TRANSITION} ${menuOpen ? 'opacity-100' : 'hover-reveal'}`}>
            <MoreHorizontal className="w-3.5 h-3.5" />
          </button>
          {menuOpen && (
            <div className={`absolute right-0 top-7 z-30 w-36 ${MENU} py-1`}>
              <button onClick={() => { setMenuOpen(false); onEdit(); }} className={MENU_ITEM}><Pencil className="w-3.5 h-3.5" /> Edit</button>
              <button onClick={() => { setMenuOpen(false); onDelete(); }} className={`${MENU_ITEM} text-red-600 hover:bg-red-500/10`}><Trash2 className="w-3.5 h-3.5" /> Delete</button>
            </div>
          )}
        </div>
      </div>
      {!collapsed && (
        <div className="pl-3 pt-0.5 space-y-px">
          {sessions.length === 0 ? (
            <p className="text-[10px] text-[var(--ds-muted)] px-2 py-1">Drag chats here</p>
          ) : (
            sessions.map(renderSession)
          )}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Recents bucketing — Today / Yesterday / Previous 7 days / Older.
// ---------------------------------------------------------------------------

const RECENT_BUCKETS = ['Today', 'Yesterday', 'Previous 7 days', 'Older'] as const;
type RecentBucket = (typeof RECENT_BUCKETS)[number];

const DAY_MS = 86_400_000;

const bucketOf = (ts: number, startOfToday: number): RecentBucket => {
  if (ts >= startOfToday) return 'Today';
  if (ts >= startOfToday - DAY_MS) return 'Yesterday';
  if (ts >= startOfToday - 7 * DAY_MS) return 'Previous 7 days';
  return 'Older';
};

// ---------------------------------------------------------------------------
// Footer account menu — avatar dot + identity + theme & exit actions.
// ---------------------------------------------------------------------------

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: React.FC<{ className?: string }> }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor }
];

const FooterAccount: React.FC<{
  userName: string;
  subLine: string;
  onEditMemory: () => void;
  onBack: () => void;
}> = ({ userName, subLine, onEditMemory, onBack }) => {
  const { preference, setPreference } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const initial = (userName.trim()[0] || '?').toUpperCase();

  return (
    <div ref={ref} className="relative">
      {open && (
        <div className={`absolute bottom-full left-0 right-0 mb-1.5 z-40 ${MENU} py-1`}>
          <div className={`px-3 pt-1 pb-0.5 ${LABEL}`}>Theme</div>
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
            <button key={value} onClick={() => setPreference(value)} className={MENU_ITEM}>
              <Icon className="w-3.5 h-3.5" />
              <span className="flex-1">{label}</span>
              {preference === value && <Check className={`w-3.5 h-3.5 ${ACCENT_TEXT}`} />}
            </button>
          ))}
          <div className="border-t border-[var(--ds-hairline)] my-1" />
          <button onClick={() => { setOpen(false); onEditMemory(); }} className={MENU_ITEM}>
            <Settings className="w-3.5 h-3.5" /> Settings
          </button>
          <button onClick={() => { setOpen(false); onBack(); }} className={MENU_ITEM}>
            <ArrowLeft className="w-3.5 h-3.5" /> Back to app
          </button>
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        className={`w-full flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-[var(--ds-hover)] ${TRANSITION} text-left`}
        title="Account, theme & exit"
      >
        <span className={`w-7 h-7 rounded-full ${ACCENT_BG} text-white flex items-center justify-center text-[11px] font-semibold shrink-0`} aria-hidden>
          {initial}
        </span>
        <span className="flex-1 min-w-0">
          <span className={`block truncate text-[13px] font-medium ${INK}`}>{userName}</span>
          <span className={`block truncate text-[11px] ${MUTED}`}>{subLine}</span>
        </span>
        <ChevronDown className={`w-3.5 h-3.5 shrink-0 ${MUTED} ${TRANSITION} ${open ? '' : 'rotate-180'}`} />
      </button>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export const ChatSidebar: React.FC<ChatSidebarProps> = ({
  sessions, projects, activeId, generatingIds, hasMemory, view = 'chat',
  userName, userEmail, planLabel,
  onSelect, onNew, onDelete, onRename, onMoveToProject,
  onNewProject, onEditProject, onDeleteProject, onEditMemory, onBack,
  onOpenSearch, onOpenSkills, onOpenDashboards, onOpenGallery, onOpenTools
}) => {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
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

  // Recents, time-bucketed and newest-first inside each bucket.
  const recents = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const buckets = new Map<RecentBucket, ChatSession[]>();
    const sorted = [...byProject.unfiled].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    for (const s of sorted) {
      const key = bucketOf(s.updatedAt || 0, startOfToday);
      const list = buckets.get(key) || [];
      list.push(s);
      buckets.set(key, list);
    }
    return buckets;
  }, [byProject.unfiled]);

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

  const displayName = userName?.trim() || userEmail?.split('@')[0] || 'Guest';
  const subLine = planLabel || userEmail || 'Chats stored on this device';

  // Folded: a slim icon rail with the essentials; one click re-opens.
  if (slim) {
    return (
      <div className={`w-12 shrink-0 h-full flex flex-col items-center border-r border-[var(--ds-hairline)] ${SIDEBAR_BG} py-3 gap-1.5 transition-all duration-200`}>
        <button onClick={() => setSlimPersist(false)} title="Expand sidebar" className={`${CONTROL_BTN} p-1.5`}>
          <PanelLeftOpen className="w-4 h-4" />
        </button>
        <button onClick={onNew} title="New chat" className={`rounded-xl p-1.5 ${PRIMARY_BTN}`}>
          <Plus className="w-4 h-4" />
        </button>
        <button onClick={onOpenSearch} title="Search" className={`${CONTROL_BTN} p-1.5`}>
          <Search className="w-4 h-4" />
        </button>
        <button onClick={onOpenSkills} title="Skills" className={`${CONTROL_BTN} p-1.5 ${view === 'skills' ? 'bg-[#D97757]/10' : ''}`}>
          <Sparkles className="w-4 h-4" />
        </button>
        <button onClick={onOpenDashboards} title="Dashboards" className={`${CONTROL_BTN} p-1.5 ${view === 'dashboards' ? 'bg-[#D97757]/10' : ''}`}>
          <LayoutDashboard className="w-4 h-4" />
        </button>
        <div className="flex-1" />
        <button onClick={onEditMemory} title="Settings, memory, agents & tools" className={`${CONTROL_BTN} p-1.5 ${hasMemory ? 'bg-[#D97757]/10' : ''}`}>
          <Settings className="w-4 h-4" />
        </button>
        <button onClick={onBack} title="Back to app" className={`${CONTROL_BTN} p-1.5`}>
          <ArrowLeft className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className={`w-64 max-w-[85vw] shrink-0 h-full flex flex-col border-r border-[var(--ds-hairline)] ${SIDEBAR_BG} transition-all duration-200`}>
      {/* Brand row */}
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className={`text-[13px] font-semibold tracking-tight ${INK}`}>Chat Studio</span>
        <button onClick={() => setSlimPersist(true)} title="Collapse sidebar" className={`${MUTED} hover:text-[var(--ds-ink)] p-1 rounded-lg hover:bg-[var(--ds-hover)] ${TRANSITION}`}>
          <PanelLeftClose className="w-4 h-4" />
        </button>
      </div>

      {/* Top action rows — quiet icon + label rows, Claude-style. */}
      <div className="px-2 pb-2 pt-1 space-y-px">
        <button onClick={onNew} className={NAV_ROW}>
          <span className={`w-5 h-5 rounded-full ${ACCENT_BG} text-white flex items-center justify-center shrink-0`}>
            <Plus className="w-3.5 h-3.5" />
          </span>
          <span className={ACCENT_TEXT}>New chat</span>
        </button>
        <button onClick={onOpenSearch} className={NAV_ROW}>
          <Search className={`w-4 h-4 shrink-0 ${MUTED}`} /> Search
          <kbd className={`ml-auto text-[10px] font-medium ${MUTED} border border-[var(--ds-hairline-soft)] rounded px-1`}>⌘K</kbd>
        </button>
        <button onClick={onOpenSkills} className={view === 'skills' ? NAV_ROW_ACTIVE : NAV_ROW}>
          <Sparkles className={`w-4 h-4 shrink-0 ${view === 'skills' ? ACCENT_TEXT : MUTED}`} /> Skills
        </button>
        <button onClick={onOpenDashboards} className={view === 'dashboards' ? NAV_ROW_ACTIVE : NAV_ROW}>
          <LayoutDashboard className={`w-4 h-4 shrink-0 ${view === 'dashboards' ? ACCENT_TEXT : MUTED}`} /> Dashboards
        </button>
        <button onClick={() => setMoreOpen((v) => !v)} className={NAV_ROW} aria-expanded={moreOpen}>
          <ChevronDown className={`w-4 h-4 shrink-0 ${MUTED} ${TRANSITION} ${moreOpen ? '' : '-rotate-90'}`} /> More
        </button>
        {moreOpen && (
          <div className="pl-4 space-y-px">
            <button onClick={onOpenGallery} className={NAV_ROW}>
              <LayoutGrid className={`w-4 h-4 shrink-0 ${MUTED}`} /> Gallery
            </button>
            <button onClick={onOpenTools} className={NAV_ROW}>
              <Wrench className={`w-4 h-4 shrink-0 ${MUTED}`} /> Tools
            </button>
            <button onClick={onNewProject} className={NAV_ROW}>
              <FolderPlus className={`w-4 h-4 shrink-0 ${MUTED}`} /> Projects
            </button>
            <button onClick={onEditMemory} className={NAV_ROW}>
              <Settings className={`w-4 h-4 shrink-0 ${MUTED}`} /> Settings
              {hasMemory && <span className={`ml-auto w-1.5 h-1.5 rounded-full ${ACCENT_BG}`} title="Memory on" aria-hidden />}
            </button>
          </div>
        )}
      </div>

      {/* The drawer panel scrolls here (not the page); overscroll-contain stops the
          rubber-band from bleeding into the conversation behind it on phones. */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch] px-2 pb-2 space-y-2 border-t border-[var(--ds-hairline-soft)] pt-2">
        {/* Project groups first */}
        {projects.map((project) => (
          <ProjectGroup
            key={project.id}
            project={project}
            sessions={byProject.map.get(project.id) || []}
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

        {/* Recents — time-bucketed; also the drop target for unfiling a chat. */}
        <div
          onDrop={dropHandler(null)}
          onDragOver={allowDrop('unfiled')}
          onDragLeave={() => setDragOver(null)}
          className={`rounded-lg border ${dragOver === 'unfiled' ? 'border-[#D97757] border-dashed bg-[#D97757]/5' : 'border-transparent'} space-y-2 ${TRANSITION}`}
        >
          {byProject.unfiled.length === 0 ? (
            projects.length === 0 && <p className={`text-xs ${MUTED} text-center py-8`}>No chats yet. Start a new one.</p>
          ) : (
            <>
              <div className={`px-2 pt-1 ${LABEL}`}>Recents</div>
              {RECENT_BUCKETS.map((bucket) => {
                const list = recents.get(bucket);
                if (!list || list.length === 0) return null;
                return (
                  <div key={bucket}>
                    <div className={`px-2 py-1 text-[10px] font-medium tracking-wide text-[var(--ds-muted)]`}>{bucket}</div>
                    <div className="space-y-px">{list.map(renderSession)}</div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>

      {/* Footer respects the home-indicator safe area when shown as a mobile drawer. */}
      <div className="px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] border-t border-[var(--ds-hairline)]">
        <FooterAccount
          userName={displayName}
          subLine={subLine}
          onEditMemory={onEditMemory}
          onBack={onBack}
        />
      </div>
    </div>
  );
};
