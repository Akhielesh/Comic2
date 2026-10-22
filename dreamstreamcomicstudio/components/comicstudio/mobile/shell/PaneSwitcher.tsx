// PaneSwitcher (mobile.md §3.3): Chat | Both | Board in the header of the split / dual-screen studio.
// "Chat" or "Board" collapses the other pane; the choice is remembered per window class
// (`cs.split.mode.<widthClass>`), so an iPad portrait and landscape can differ.

import React from 'react';
import { Columns2, LayoutGrid, MessageSquare } from 'lucide-react';
import { Segmented } from '../../board/ui';
import type { WidthClass } from '../formFactor';

export type PaneMode = 'both' | 'chat' | 'board';

export const PANE_MODE_KEY_PREFIX = 'cs.split.mode.';

export const readPaneMode = (widthClass: WidthClass): PaneMode => {
  try {
    const v = window.localStorage.getItem(`${PANE_MODE_KEY_PREFIX}${widthClass}`);
    return v === 'chat' || v === 'board' || v === 'both' ? v : 'both';
  } catch {
    return 'both';
  }
};

export const writePaneMode = (widthClass: WidthClass, mode: PaneMode): void => {
  try {
    window.localStorage.setItem(`${PANE_MODE_KEY_PREFIX}${widthClass}`, mode);
  } catch {
    /* not remembered (private mode / blocked storage) */
  }
};

export const PaneSwitcher: React.FC<{ value: PaneMode; onChange: (mode: PaneMode) => void; className?: string }> = ({ value, onChange, className }) => (
  <Segmented<PaneMode>
    label="Panes"
    value={value}
    onChange={onChange}
    className={className}
    options={[
      { value: 'chat', title: 'Chat only', label: <MessageSquare className="h-4 w-4" aria-label="Chat only" /> },
      { value: 'both', title: 'Chat and board side by side', label: <Columns2 className="h-4 w-4" aria-label="Chat and board" /> },
      { value: 'board', title: 'Board only', label: <LayoutGrid className="h-4 w-4" aria-label="Board only" /> }
    ]}
  />
);

export default PaneSwitcher;
