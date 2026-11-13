// Stage identity and registry order shared by the board and workspace navigation.
import React from 'react';
import { BookOpen, FileText, LayoutGrid, Palette, Users } from 'lucide-react';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { StudioCaps } from '../../../shared/comic/capabilities';
import type { BoardTab, StudioTab } from '../types';
import { BUILTIN_TAB_ORDER, registeredTabs, type BoardTabRegistration } from '../features';

/** The built-in tabs (always present, in this order). */
export const BOARD_TABS: { id: BoardTab; label: string; icon: React.ReactNode }[] = [
  { id: 'story', label: 'Story', icon: <FileText className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'cast', label: 'Cast', icon: <Users className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'style', label: 'Style', icon: <Palette className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'pages', label: 'Pages', icon: <LayoutGrid className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'read', label: 'Read', icon: <BookOpen className="h-3.5 w-3.5" aria-hidden /> }
];

export interface ShownTab {
  id: StudioTab;
  label: string;
  icon: React.ReactNode;
  /** Set for registry tabs; built-ins render their own panel below. */
  registration?: BoardTabRegistration;
}

const isVisible = (reg: BoardTabRegistration, doc: ComicDoc, caps: StudioCaps): boolean => {
  if (!reg.visible) return true;
  try {
    return !!reg.visible(doc, caps);
  } catch {
    return false; // a feature's visibility check must never break the board
  }
};

/**
 * Built-in tabs plus the registered tabs visible for this doc, sorted by `order` (stable). The
 * `active` registered tab is always included, so the strip never loses the tab whose panel is shown.
 */
export const boardTabsFor = (doc: ComicDoc, caps: StudioCaps, active?: StudioTab): ShownTab[] => {
  const builtIns = BOARD_TABS.map((t, i) => ({ tab: t as ShownTab, order: BUILTIN_TAB_ORDER[t.id] ?? (i + 1) * 100, i }));
  const extra = registeredTabs()
    .filter((reg) => reg.id === active || isVisible(reg, doc, caps))
    .map((reg, i) => ({ tab: { id: reg.id, label: reg.label, icon: reg.icon, registration: reg }, order: reg.order, i: BOARD_TABS.length + i }));
  return [...builtIns, ...extra].sort((a, b) => a.order - b.order || a.i - b.i).map((x) => x.tab);
};
