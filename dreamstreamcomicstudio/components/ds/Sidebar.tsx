/**
 * Sidebar — the 240 px column the wide studio (≥ 1440 px) navigates from (redesign plan §4, §5.2; Atlas WorkspaceNav's
 * sidebar): the places, then the current place's sub-views, so the PageHeader's Segmented can hide. Its width is the
 * `--sidebar-w` token (index.css, M1a). It is a container: the screen passes NavTrack (vertical) groups; the sidebar
 * gives each group its OVERLINE title, scrolls on its own under a sticky header slot, and keeps a footer slot pinned
 * to the bottom (Versions, Share). Ink only, never the spark.
 */
import React, { useId } from 'react';
import { cn } from '../../lib/utils';
import { OVERLINE } from './recipes';

export interface SidebarGroup {
  id: string;
  /** Small uppercase title over the group ("Pages"); omit for the first group (the places). */
  title?: string;
  content: React.ReactNode;
}

export interface SidebarProps {
  /** The landmark's name ("Studio navigation"). */
  label: string;
  /** Over the groups (the comic's cover and title). */
  header?: React.ReactNode;
  groups: readonly SidebarGroup[];
  footer?: React.ReactNode;
  className?: string;
}

export const SIDEBAR = 'flex h-full min-h-0 w-[var(--sidebar-w)] shrink-0 flex-col border-r border-[var(--ds-hairline)] bg-[var(--ds-sidebar)] text-[var(--ds-ink)]';

export function Sidebar({ label, header, groups, footer, className }: SidebarProps) {
  const id = useId();
  return (
    <aside aria-label={label} data-slot="sidebar" className={cn(SIDEBAR, className)}>
      {header ? <div className="shrink-0 border-b border-[var(--ds-hairline)] p-3">{header}</div> : null}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-2">
        {groups.map((g) => (
          <div key={g.id} role="group" aria-labelledby={g.title ? `${id}-${g.id}` : undefined} className="flex min-w-0 flex-col gap-1">
            {g.title ? (
              <p id={`${id}-${g.id}`} className={`m-0 px-3 pt-1 ${OVERLINE}`}>
                {g.title}
              </p>
            ) : null}
            {g.content}
          </div>
        ))}
      </div>
      {footer ? <div className="shrink-0 border-t border-[var(--ds-hairline)] p-2">{footer}</div> : null}
    </aside>
  );
}
