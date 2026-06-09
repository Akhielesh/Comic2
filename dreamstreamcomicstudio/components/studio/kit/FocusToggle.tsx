// FocusToggle: a compact segmented control that switches the right (70%) workspace pane between
// the live Preview and the Code editor. Lives in the right pane's header (it controls that pane)
// and, on wide screens, the top bar. Two clean views — no three-pane split. Code-Studio-only.

import React from 'react';
import { Eye, FileCode } from 'lucide-react';
import { useStudioTheme } from './themeStore';
import { useStudioFocus, STUDIO_FOCUS_ORDER, type StudioFocus } from './focusStore';

const META: Record<StudioFocus, { label: string; Icon: React.ComponentType<{ className?: string }> }> = {
  preview: { label: 'Preview', Icon: Eye },
  code: { label: 'Code', Icon: FileCode },
};

export interface FocusToggleProps {
  className?: string;
  /** Show the text label next to the icon (used in the pane header). */
  labels?: boolean;
}

export const FocusToggle: React.FC<FocusToggleProps> = ({ className, labels = false }) => {
  const focus = useStudioFocus((s) => s.focus);
  const setFocus = useStudioFocus((s) => s.setFocus);
  const t = useStudioTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Workspace view"
      className={`inline-flex items-center gap-0.5 rounded-full border ${t.edge} ${t.panelAlt} p-0.5 ${className ?? ''}`}
    >
      {STUDIO_FOCUS_ORDER.map((id) => {
        const { label, Icon } = META[id];
        const active = id === focus;
        return (
          <button
            key={id}
            role="radio"
            aria-checked={active}
            aria-label={`${label} view`}
            onClick={() => setFocus(id)}
            title={`${label} view`}
            className={`flex items-center justify-center gap-1.5 rounded-full transition-colors ${t.focusRing} ${
              labels ? 'h-6 px-2.5 text-[11px] font-semibold' : 'h-6 w-6'
            } ${active ? `${t.accentBg} ${t.accentText}` : `${t.textDim} ${t.hover}`}`}
          >
            <Icon className="h-3.5 w-3.5" />
            {labels && <span>{label}</span>}
          </button>
        );
      })}
    </div>
  );
};
