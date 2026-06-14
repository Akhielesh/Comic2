// CommandPalette — the global ⌘K search for Chat Studio. One box that finds
// chat sessions and navigation targets, with full keyboard navigation
// (↑↓ / Enter / Esc) and mouse-hover sync.
//
// Selection semantics:
//   session  → onResume(id) + close
//   nav      → onNavigate(view) + close
//
// Calm-studio language only: token vars (--ds-*), hairline, rounded-2xl,
// soft ambient shadow. Works in light and dark (.dark on <html>).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Home, LayoutDashboard, Library, MessageSquare, Search } from 'lucide-react';
import type { ChatSession } from '../../services/chatStorage';

type NavView = 'home' | 'library' | 'dashboards';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  sessions: ChatSession[];
  onResume: (id: string) => void;
  onNavigate: (view: NavView) => void;
}

type PaletteItem =
  | { kind: 'session'; session: ChatSession }
  | { kind: 'nav'; view: NavView; label: string };

interface PaletteGroup {
  label: string;
  items: PaletteItem[];
}

const NAV_ACTIONS: { view: NavView; label: string; keywords: string }[] = [
  { view: 'home', label: 'Go to Home', keywords: 'home start landing greeting' },
  { view: 'library', label: 'Open Library', keywords: 'library files images uploads media assets gallery' },
  { view: 'dashboards', label: 'Open Dashboards', keywords: 'dashboards boards charts analytics pulse' }
];

const SOFT_SHADOW = 'shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.06)]';

// Fuzzy-ish ranking: startsWith on a primary string beats substring on a
// primary, which beats substring on the secondary haystack. 0 = no match.
const rank = (q: string, primaries: string[], secondary: string): number => {
  if (!q) return 1;
  for (const p of primaries) if (p.toLowerCase().startsWith(q)) return 3;
  for (const p of primaries) if (p.toLowerCase().includes(q)) return 2;
  if (secondary.toLowerCase().includes(q)) return 1;
  return 0;
};

const relativeTime = (ts: number): string => {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const NAV_ICONS: Record<NavView, React.ComponentType<{ className?: string }>> = {
  home: Home,
  library: Library,
  dashboards: LayoutDashboard
};

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onClose,
  sessions,
  onResume,
  onNavigate
}) => {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Cheap per-session search haystack: first + last turn snippets (no full scan).
  const sessionSearch = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sessions) {
      const turns = s.turns || [];
      const bits = [(turns[0]?.content || '').slice(0, 200), (turns[turns.length - 1]?.content || '').slice(0, 200)];
      map.set(s.id, bits.join(' ').toLowerCase());
    }
    return map;
  }, [sessions]);

  const groups = useMemo<PaletteGroup[]>(() => {
    const raw = query.trim().toLowerCase();
    // A leading "/" means "I'm typing a command" — match against the bare name.
    const q = raw.startsWith('/') ? raw.slice(1) : raw;

    const pick = <T,>(arr: T[], primaries: (t: T) => string[], secondary: (t: T) => string, limit: number): T[] =>
      arr
        .map((t) => ({ t, r: rank(q, primaries(t), secondary(t)) }))
        .filter((x) => x.r > 0)
        .sort((a, b) => b.r - a.r)
        .slice(0, limit)
        .map((x) => x.t);

    const sessionHits: PaletteItem[] = (
      q
        ? pick(sessions, (s) => [s.title], (s) => sessionSearch.get(s.id) || '', 6)
        : sessions.filter((s) => (s.turns?.length || 0) > 0).slice(0, 5)
    ).map((session) => ({ kind: 'session' as const, session }));

    const navHits: PaletteItem[] = pick(NAV_ACTIONS, (n) => [n.label, n.view], (n) => n.keywords, 3).map((n) => ({
      kind: 'nav' as const,
      view: n.view,
      label: n.label
    }));

    const out: PaletteGroup[] = [];
    if (sessionHits.length) out.push({ label: q ? 'Chats' : 'Recent chats', items: sessionHits });
    if (navHits.length) out.push({ label: 'Go to', items: navHits });
    return out;
  }, [query, sessions, sessionSearch]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const select = useCallback(
    (item: PaletteItem) => {
      if (item.kind === 'session') {
        onResume(item.session.id);
        onClose();
      } else {
        onNavigate(item.view);
        onClose();
      }
    },
    [onResume, onNavigate, onClose]
  );

  // Reset state each time the palette opens; focus the input.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  // Keep the highlight in range when results change.
  useEffect(() => {
    setActive((i) => (flat.length === 0 ? 0 : Math.min(i, flat.length - 1)));
  }, [flat.length]);

  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Global keyboard handling while open: Esc / ↑↓ / Enter.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (flat.length === 0 ? 0 : (i + 1) % flat.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (flat.length === 0 ? 0 : (i - 1 + flat.length) % flat.length));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = flat[active];
        if (item) select(item);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, flat, active, select, onClose]);

  // Keep the active row visible while arrowing through results.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  if (!open) return null;

  // Running index across groups so keyboard + hover share one flat list.
  let flatIndex = -1;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center px-3 pb-6 pt-[max(4rem,env(safe-area-inset-top))] sm:pt-[16vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      {/* Backdrop: click to close */}
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />

      <div
        className={`relative flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] backdrop-blur-md ${SOFT_SHADOW} transition-shadow duration-300 focus-within:border-[#D97757]/40 focus-within:shadow-[0_0_0_1px_rgba(217,119,87,0.30),0_2px_10px_rgba(217,119,87,0.12),0_22px_60px_rgba(217,119,87,0.12)]`}
      >
        {/* Search input */}
        <div className="flex items-center gap-2.5 border-b border-[var(--ds-hairline-soft)] px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-[var(--ds-muted)]" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="Search chats and pages…"
            // 16px on mobile so iOS doesn't zoom the page on focus.
            className="w-full bg-transparent text-base text-[var(--ds-ink)] outline-none placeholder:text-[var(--ds-muted)] sm:text-sm"
            autoFocus
            spellCheck={false}
            autoComplete="off"
            aria-label="Search chats and pages"
          />
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[min(60vh,22rem)] overflow-y-auto overscroll-contain py-1.5" role="listbox">
          {flat.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-[var(--ds-muted)]">
              No matches for “{query.trim()}”
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.label} className="px-1.5 pb-1">
                <div className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">
                  {group.label}
                </div>
                {group.items.map((item) => {
                  flatIndex += 1;
                  const i = flatIndex;
                  const isActive = i === active;
                  const key = item.kind === 'session' ? `s:${item.session.id}` : `n:${item.view}`;
                  const rowClass = `flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors duration-100 ${
                    isActive ? 'bg-[#D97757]/10 text-[var(--ds-ink)]' : 'text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]'
                  }`;
                  if (item.kind === 'session') {
                    return (
                      <button
                        key={key}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        data-active={isActive}
                        onClick={() => select(item)}
                        onMouseMove={() => setActive(i)}
                        className={rowClass}
                      >
                        <MessageSquare className="h-4 w-4 shrink-0 text-[var(--ds-muted)]" />
                        <span className="flex-1 truncate text-sm">{item.session.title}</span>
                        <span className="shrink-0 text-[11px] text-[var(--ds-muted)]">
                          {relativeTime(item.session.updatedAt)}
                        </span>
                      </button>
                    );
                  }
                  const NavIcon = NAV_ICONS[item.view];
                  return (
                    <button
                      key={key}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      data-active={isActive}
                      onClick={() => select(item)}
                      onMouseMove={() => setActive(i)}
                      className={rowClass}
                    >
                      <NavIcon className="h-4 w-4 shrink-0 text-[var(--ds-muted)]" />
                      <span className="flex-1 truncate text-sm">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer hints */}
        <div className="flex items-center gap-1.5 border-t border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] px-4 py-2 text-[11px] text-[var(--ds-muted)]">
          <kbd className="rounded border border-[var(--ds-hairline-soft)] bg-[var(--ds-raised)] px-1 font-sans">↑↓</kbd>
          navigate
          <span aria-hidden="true">·</span>
          <kbd className="rounded border border-[var(--ds-hairline-soft)] bg-[var(--ds-raised)] px-1 font-sans">↵</kbd>
          open
          <span aria-hidden="true">·</span>
          <kbd className="rounded border border-[var(--ds-hairline-soft)] bg-[var(--ds-raised)] px-1 font-sans">esc</kbd>
          close
        </div>
      </div>
    </div>
  );
};
