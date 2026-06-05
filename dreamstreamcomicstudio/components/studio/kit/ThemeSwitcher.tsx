// Code Studio theme switcher (Black / White / DreamStream). A compact segmented control for
// the workspace top bar; flips the active studio theme (workspace only — never the app).

import React from 'react';
import { Moon, Sun, Palette } from 'lucide-react';
import { useStudioThemeStore } from './themeStore';
import { useStudioTheme } from './themeStore';
import { STUDIO_THEME_ORDER, STUDIO_THEMES, type StudioThemeId } from './theme';

const ICONS: Record<StudioThemeId, React.ComponentType<{ className?: string }>> = {
  black: Moon,
  light: Sun,
  brand: Palette,
};

export const ThemeSwitcher: React.FC<{ className?: string }> = ({ className }) => {
  const activeId = useStudioThemeStore((s) => s.id);
  const setTheme = useStudioThemeStore((s) => s.setTheme);
  const t = useStudioTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Code Studio theme"
      className={`inline-flex items-center gap-0.5 rounded-full border ${t.edge} ${t.panelAlt} p-0.5 ${className ?? ''}`}
    >
      {STUDIO_THEME_ORDER.map((id) => {
        const Icon = ICONS[id];
        const active = id === activeId;
        return (
          <button
            key={id}
            role="radio"
            aria-checked={active}
            onClick={() => setTheme(id)}
            title={`${STUDIO_THEMES[id].label} theme`}
            className={`flex items-center justify-center rounded-full h-6 w-6 transition-colors ${t.focusRing} ${
              active ? `${t.accentBg} ${t.accentText}` : `${t.textDim} hover:bg-white/10`
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            <span className="sr-only">{STUDIO_THEMES[id].label}</span>
          </button>
        );
      })}
    </div>
  );
};
