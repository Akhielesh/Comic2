// FocusToggle (Sprint 2): a compact segmented control for the studio top bar that switches the
// layout focus — Code · Split · Preview — so the user can maximize the real estate for reviewing
// code or the running app. Mirrors ThemeSwitcher's style. Code-Studio-only.

import React from 'react';
import { FileCode, Columns, Eye } from 'lucide-react';
import { useStudioTheme } from './themeStore';
import { useStudioFocus, STUDIO_FOCUS_ORDER, type StudioFocus } from './focusStore';

const META: Record<StudioFocus, { label: string; Icon: React.ComponentType<{ className?: string }> }> = {
  code: { label: 'Code', Icon: FileCode },
  split: { label: 'Split', Icon: Columns },
  preview: { label: 'Preview', Icon: Eye },
};

export const FocusToggle: React.FC<{ className?: string }> = ({ className }) => {
  const focus = useStudioFocus((s) => s.focus);
  const setFocus = useStudioFocus((s) => s.setFocus);
  const t = useStudioTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Studio layout focus"
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
            className={`flex items-center justify-center rounded-full h-6 w-6 transition-colors ${t.focusRing} ${
              active ? `${t.accentBg} ${t.accentText}` : `${t.textDim} hover:bg-white/10`
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
};
