// ChatHome — the chat "home dash" (Pulse-style landing). Shown instead of an empty
// conversation: a time-of-day greeting, a prominent "start" affordance with curated
// starter prompts, resumable recent-session cards, skill shortcuts, and a small,
// honestly-computed insights strip derived purely from local session data.
//
// Calm-studio language only: token vars (--ds-*), hairlines, rounded-2xl, soft
// ambient shadows. No comic styles inside the chat shell.

import React, { useMemo } from 'react';
import { ArrowRight, ArrowUp, LayoutDashboard } from 'lucide-react';
import type { ChatSession } from '../../services/chatStorage';
import type { ChatSkill } from '../../services/chatSkills';

interface ChatHomeProps {
  userName?: string;
  sessions: ChatSession[];
  skills: ChatSkill[];
  onResume: (sessionId: string) => void;
  onStartChat: (seedText?: string) => void;
  onRunSkill: (skill: ChatSkill, arg: string) => void;
  onOpenDashboards: () => void;
}

// ---------------------------------------------------------------------------
// Style atoms (literal so Tailwind's scanner picks them up)
// ---------------------------------------------------------------------------

const SOFT_SHADOW = 'shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.06)]';
const CARD =
  `rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] ${SOFT_SHADOW} transition-all duration-200`;
const SECTION_LABEL = 'text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const greetingFor = (hour: number): string => {
  if (hour < 5) return 'Good night';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
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

/** Last real message in a session, for the card snippet. */
const lastSnippet = (s: ChatSession): { text: string; you: boolean } | null => {
  for (let i = (s.turns?.length || 0) - 1; i >= 0; i--) {
    const t = s.turns[i];
    const text = (t.content || '').replace(/\s+/g, ' ').trim();
    if (text && !t.error) return { text: text.slice(0, 160), you: t.role === 'user' };
  }
  return null;
};

/** Local calendar-day index (DST-safe via Math.round) for streak math. */
const localDayIndex = (ts: number): number => {
  const d = new Date(ts);
  return Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86400000);
};

/**
 * Honest, locally-derived stats. Everything here is computed from the sessions
 * prop alone — anything that can't be computed is simply omitted (no fake data).
 */
const buildInsights = (sessions: ChatSession[], skills: ChatSkill[]): string[] => {
  const nonEmpty = sessions.filter((s) => (s.turns?.length || 0) > 0);
  if (nonEmpty.length === 0) return [];
  const chips: string[] = [];

  // 1) Chats active in the last 7 days.
  const weekAgo = Date.now() - 7 * 86400000;
  const thisWeek = nonEmpty.filter((s) => (s.updatedAt || 0) >= weekAgo).length;
  if (thisWeek > 0) chips.push(`${thisWeek} chat${thisWeek === 1 ? '' : 's'} this week`);

  // 2) Longest streak of consecutive days with chat activity (turn timestamps).
  const daySet = new Set<number>();
  for (const s of nonEmpty) {
    for (const t of s.turns) if (t.createdAt) daySet.add(localDayIndex(t.createdAt));
    if (s.updatedAt) daySet.add(localDayIndex(s.updatedAt));
  }
  const days = [...daySet].sort((a, b) => a - b);
  let streak = days.length > 0 ? 1 : 0;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    run = days[i] === days[i - 1] + 1 ? run + 1 : 1;
    if (run > streak) streak = run;
  }
  if (streak >= 2) chips.push(`${streak}-day streak`);

  // 3) Most-used skill (user turns that start with a known /command or alias).
  const aliasToCommand = new Map<string, string>();
  for (const sk of skills) {
    aliasToCommand.set(sk.command, sk.command);
    for (const a of sk.aliases || []) aliasToCommand.set(a, sk.command);
  }
  const counts = new Map<string, number>();
  for (const s of nonEmpty) {
    for (const t of s.turns) {
      if (t.role !== 'user') continue;
      const m = /^\/([a-zA-Z]+)\b/.exec(t.content || '');
      const cmd = m ? aliasToCommand.get(m[1].toLowerCase()) : undefined;
      if (cmd) counts.set(cmd, (counts.get(cmd) || 0) + 1);
    }
  }
  let topCmd: string | null = null;
  let topCount = 0;
  for (const [cmd, n] of counts) {
    if (n > topCount) {
      topCmd = cmd;
      topCount = n;
    }
  }
  if (topCmd && topCount >= 2) chips.push(`most used skill: /${topCmd}`);

  return chips;
};

// ---------------------------------------------------------------------------
// Curated starters
// ---------------------------------------------------------------------------

const STARTERS: { emoji: string; text: string }[] = [
  { emoji: '🗓️', text: 'Plan my week' },
  { emoji: '🗞️', text: "Brief me on today's news" },
  { emoji: '🎓', text: 'Teach me something new in 15 minutes' },
  { emoji: '📈', text: 'Build me a market pulse' }
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ChatHome: React.FC<ChatHomeProps> = ({
  userName,
  sessions,
  skills,
  onResume,
  onStartChat,
  onRunSkill,
  onOpenDashboards
}) => {
  const recent = useMemo(
    () =>
      sessions
        .filter((s) => (s.turns?.length || 0) > 0)
        .slice()
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 6),
    [sessions]
  );
  const insights = useMemo(() => buildInsights(sessions, skills), [sessions, skills]);
  const greeting = greetingFor(new Date().getHours());
  const hasRecent = recent.length > 0;
  const featuredSkills = skills.slice(0, 5);

  const handleSkill = (skill: ChatSkill) => {
    // Skills that need an argument pre-fill the composer (`/command `) so the
    // user types the argument; no-arg skills run immediately.
    if (skill.argRequired) onStartChat(`/${skill.command} `);
    else onRunSkill(skill, '');
  };

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-10 sm:px-6 sm:pt-16">
        {/* 1 — Greeting */}
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--ds-ink)] sm:text-3xl">
            {greeting}
            {userName ? `, ${userName}` : ''}
          </h1>
          <p className="mt-1.5 text-sm text-[var(--ds-muted)]">
            {hasRecent
              ? 'Pick up a conversation, run a skill, or start something new.'
              : 'Start a conversation, run a skill, or explore your dashboards.'}
          </p>
        </header>

        {/* 2 — Start affordance (composer look-alike, not a real input) */}
        <button
          type="button"
          onClick={() => onStartChat()}
          className={`${CARD} group flex w-full items-center gap-3 px-5 py-4 text-left hover:-translate-y-px hover:bg-[var(--ds-surface-strong)]`}
        >
          <span className="flex-1 truncate text-[15px] text-[var(--ds-muted)]">
            Ask anything — or pick up where you left off…
          </span>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--ds-accent)] text-white transition-colors duration-200 group-hover:bg-[var(--ds-accent-hover)]">
            <ArrowUp className="h-4 w-4" />
          </span>
        </button>

        {/* Starter prompts — quiet pills normally; bigger cards when there's no history */}
        {hasRecent ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {STARTERS.map((s) => (
              <button
                key={s.text}
                type="button"
                onClick={() => onStartChat(s.text)}
                className="flex items-center gap-1.5 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-3.5 py-1.5 text-[13px] font-medium text-[var(--ds-ink)] transition-all duration-200 hover:-translate-y-px hover:bg-[var(--ds-hover)]"
              >
                <span aria-hidden="true">{s.emoji}</span>
                {s.text}
              </button>
            ))}
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {STARTERS.map((s) => (
              <button
                key={s.text}
                type="button"
                onClick={() => onStartChat(s.text)}
                className={`${CARD} group flex items-center gap-3 px-4 py-4 text-left hover:-translate-y-px hover:bg-[var(--ds-surface-strong)]`}
              >
                <span className="text-xl" aria-hidden="true">
                  {s.emoji}
                </span>
                <span className="flex-1 text-sm font-medium text-[var(--ds-ink)]">{s.text}</span>
                <ArrowRight className="h-4 w-4 shrink-0 text-[var(--ds-muted)] opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
              </button>
            ))}
          </div>
        )}

        {/* 3 — Pick up where you left off */}
        {hasRecent && (
          <section className="mt-10">
            <h2 className={SECTION_LABEL}>Pick up where you left off</h2>
            <div className="-mx-4 mt-3 flex snap-x gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 lg:grid-cols-3">
              {recent.map((s) => {
                const snippet = lastSnippet(s);
                const turnCount = s.turns?.length || 0;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => onResume(s.id)}
                    className={`${CARD} group w-[260px] shrink-0 snap-start p-4 text-left hover:-translate-y-px hover:bg-[var(--ds-surface-strong)] sm:w-auto`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-semibold text-[var(--ds-ink)]">{s.title}</span>
                      <span className="shrink-0 text-[11px] text-[var(--ds-muted)]">{relativeTime(s.updatedAt)}</span>
                    </div>
                    {snippet && (
                      <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-[var(--ds-muted)]">
                        {snippet.you ? 'You: ' : ''}
                        {snippet.text}
                      </p>
                    )}
                    <div className="mt-3 flex items-center justify-between">
                      {turnCount >= 4 ? (
                        <span className="rounded-full bg-[var(--ds-well)] px-2 py-0.5 text-[10px] font-medium tabular-nums text-[var(--ds-muted)]">
                          {turnCount} turns
                        </span>
                      ) : (
                        <span />
                      )}
                      <span className="flex items-center gap-1 text-[11px] font-semibold text-[var(--ds-accent)] opacity-70 transition-opacity duration-200 group-hover:opacity-100">
                        Continue <ArrowRight className="h-3 w-3" />
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* 4 — Skills (the Dashboards promo always renders, so the section always shows) */}
        <section className="mt-10">
            <h2 className={SECTION_LABEL}>Do more with skills</h2>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {featuredSkills.map((sk) => (
                <button
                  key={sk.command}
                  type="button"
                  onClick={() => handleSkill(sk)}
                  className={`${CARD} group flex flex-col items-start p-4 text-left hover:-translate-y-px hover:bg-[var(--ds-surface-strong)]`}
                >
                  <div className="flex w-full items-center gap-2">
                    <span className="text-lg" aria-hidden="true">
                      {sk.emoji}
                    </span>
                    <span className="flex-1 truncate text-sm font-semibold text-[var(--ds-ink)]">{sk.label}</span>
                    <span className="rounded-md bg-[var(--ds-well)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--ds-muted)]">
                      /{sk.command}
                    </span>
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-[var(--ds-muted)]">{sk.description}</p>
                </button>
              ))}
              {/* Quiet Dashboards promo */}
              <button
                type="button"
                onClick={onOpenDashboards}
                className="group flex flex-col items-start rounded-2xl border border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] p-4 text-left transition-all duration-200 hover:-translate-y-px hover:bg-[var(--ds-hover)]"
              >
                <div className="flex w-full items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#D97757]/10 text-[var(--ds-accent)]">
                    <LayoutDashboard className="h-4 w-4" />
                  </span>
                  <span className="flex-1 text-sm font-semibold text-[var(--ds-ink)]">Dashboards</span>
                  <ArrowRight className="h-3.5 w-3.5 text-[var(--ds-muted)] opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-[var(--ds-muted)]">
                  Live boards built from your chats — markets, weather, research and more.
                </p>
              </button>
            </div>
          </section>

        {/* 5 — Insights strip (only what can honestly be computed) */}
        {insights.length > 0 && (
          <footer className="mt-10 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-[var(--ds-hairline-soft)] pt-4 text-xs text-[var(--ds-muted)]">
            {insights.map((chip, i) => (
              <React.Fragment key={chip}>
                {i > 0 && <span aria-hidden="true">·</span>}
                <span className="tabular-nums">{chip}</span>
              </React.Fragment>
            ))}
          </footer>
        )}
      </div>
    </div>
  );
};
