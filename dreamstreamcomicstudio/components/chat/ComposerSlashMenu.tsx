import React from 'react';
import {
  Inbox,
  Mail,
  PenSquare,
  Search,
  HardDrive,
  Calendar,
  Globe,
  Newspaper,
  CloudSun,
  LineChart,
  type LucideIcon
} from 'lucide-react';

// The composer "/" launcher — type "/" to call your connectors (Gmail/Drive/Calendar)
// and the top tool groups without remembering the exact phrasing. Picking a command
// either fires a ready prompt (send=true) or seeds the box for you to finish typing,
// and enables the matching tool group so the model can act on it.
//
// Natural language still works on its own (e.g. "show my unread email") — this is the
// discoverable shortcut, not a replacement.

export interface SlashCommand {
  id: string;
  label: string;
  hint: string;
  Icon: LucideIcon;
  /** Ready-to-run prompt (when send) or seed text (when not). */
  prompt: string;
  /** Fire immediately vs. drop into the box for the user to finish. */
  send?: boolean;
  /** Tool group (toolCatalog category) to enable on pick, so the model can act. */
  toolCategory?: string;
  /** Match terms in addition to the label. */
  keywords?: string[];
}

// Connector actions first (the focus), then the highest-traffic tool groups.
export const SLASH_COMMANDS: SlashCommand[] = [
  { id: 'gmail-inbox', label: 'Gmail · Inbox', hint: 'Open your inbox as an email terminal', Icon: Inbox, prompt: 'Open my Gmail inbox', send: true, toolCategory: 'productivity', keywords: ['email', 'mail', 'gmail', 'inbox'] },
  { id: 'gmail-unread', label: 'Gmail · Unread', hint: 'Just the unread messages', Icon: Mail, prompt: 'Show my unread emails', send: true, toolCategory: 'productivity', keywords: ['email', 'unread', 'new mail', 'gmail'] },
  { id: 'gmail-compose', label: 'Gmail · Compose', hint: 'Draft an email to send from Gmail', Icon: PenSquare, prompt: 'Compose an email to ', toolCategory: 'productivity', keywords: ['email', 'write', 'compose', 'draft', 'reply', 'gmail'] },
  { id: 'gmail-search', label: 'Gmail · Search', hint: 'Find messages (from:, subject:, …)', Icon: Search, prompt: 'Search my email for ', toolCategory: 'productivity', keywords: ['email', 'find', 'search', 'gmail'] },
  { id: 'drive-search', label: 'Drive · Search', hint: 'Find your files & docs', Icon: HardDrive, prompt: 'Search my Google Drive for ', toolCategory: 'productivity', keywords: ['drive', 'files', 'docs', 'google drive'] },
  { id: 'calendar', label: 'Calendar · Agenda', hint: "What's on your schedule", Icon: Calendar, prompt: "What's on my calendar this week?", send: true, toolCategory: 'productivity', keywords: ['calendar', 'schedule', 'meetings', 'agenda'] },
  { id: 'web', label: 'Web search', hint: 'Search the web', Icon: Globe, prompt: 'Search the web for ', toolCategory: 'search', keywords: ['web', 'google', 'search', 'look up'] },
  { id: 'news', label: 'News', hint: 'Latest headlines on a topic', Icon: Newspaper, prompt: 'Latest news on ', toolCategory: 'news', keywords: ['news', 'headlines', 'latest'] },
  { id: 'weather', label: 'Weather', hint: 'Forecast for a place', Icon: CloudSun, prompt: 'Weather in ', toolCategory: 'weather', keywords: ['weather', 'forecast', 'temperature'] },
  { id: 'finance', label: 'Stocks & crypto', hint: 'A quote or chart', Icon: LineChart, prompt: 'Stock price of ', toolCategory: 'finance', keywords: ['stock', 'crypto', 'price', 'ticker', 'market'] }
];

/** Rank commands by a leading "/" query (label start > label include > keyword include). */
export const filterSlashCommands = (query: string): SlashCommand[] => {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_COMMANDS;
  const score = (c: SlashCommand): number => {
    const label = c.label.toLowerCase();
    if (label.startsWith(q)) return 3;
    if (label.includes(q)) return 2;
    if ((c.keywords || []).some((k) => k.includes(q))) return 1;
    return 0;
  };
  return SLASH_COMMANDS.map((c) => ({ c, s: score(c) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);
};

export const ComposerSlashMenu: React.FC<{
  items: SlashCommand[];
  activeIndex: number;
  onPick: (cmd: SlashCommand) => void;
  onHover: (index: number) => void;
}> = ({ items, activeIndex, onPick, onHover }) => {
  if (!items.length) return null;
  return (
    <div
      role="listbox"
      aria-label="Slash commands"
      className="absolute bottom-full left-0 z-40 mb-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] shadow-xl backdrop-blur-md"
    >
      <div className="border-b border-[var(--ds-hairline-soft)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--ds-faint)]">
        Connectors &amp; tools
      </div>
      <ul className="max-h-72 overflow-y-auto py-1 [scrollbar-width:thin]">
        {items.map((cmd, i) => {
          const active = i === activeIndex;
          const Icon = cmd.Icon;
          return (
            <li key={cmd.id} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={active}
                onMouseEnter={() => onHover(i)}
                onMouseDown={(e) => {
                  // mousedown (not click) so the textarea doesn't blur first.
                  e.preventDefault();
                  onPick(cmd);
                }}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                  active ? 'bg-[var(--ds-hover)]' : 'hover:bg-[var(--ds-hover)]'
                }`}
              >
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--ds-hairline)] ${active ? 'bg-[#D97757]/10 text-[var(--ds-accent)]' : 'bg-[var(--ds-surface-soft)] text-[var(--ds-muted)]'}`}>
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-[var(--ds-ink)]">{cmd.label}</span>
                  <span className="block truncate text-[11px] text-[var(--ds-muted)]">{cmd.hint}</span>
                </span>
                {cmd.send && <span className="shrink-0 rounded-full bg-[var(--ds-well)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--ds-muted)]">↵ run</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
