import React from 'react';
import { Moon, Sun } from 'lucide-react';
import { cn } from '../../lib/utils';
import { IconButton, Segmented } from '../ds';
import { useTheme, type ThemePreference } from '../../services/theme';

/**
 * Light / dark in one press (the header bar, sm and up). The icon shows the theme the press switches to and
 * turns a little on the spring while hovered (still under reduced motion). The choice is saved and applied
 * through services/theme.ts: one cross-fade of the page under the skin.
 */
export const ThemeToggle: React.FC<{ className?: string }> = ({ className }) => {
  const { isDark, setPreference } = useTheme();
  const next = isDark ? 'light' : 'dark';
  const Icon = isDark ? Sun : Moon;
  return (
    <IconButton
      label={`Switch to ${next} theme`}
      onClick={() => setPreference(next)}
      className={cn('group/theme rounded-full', className)}
    >
      <Icon className="size-4 transition-transform duration-[var(--ds-motion-panel)] ease-[var(--ds-ease-spring)] motion-reduce:transition-none can-hover:group-hover/theme:-rotate-[24deg]" />
    </IconButton>
  );
};

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Auto' }
];

/** The three-way choice (light, dark, follow the device), for the phone menu. */
export const ThemeChoice: React.FC<{ className?: string }> = ({ className }) => {
  const { preference, setPreference } = useTheme();
  return <Segmented label="Theme" value={preference} onChange={setPreference} options={THEME_OPTIONS} fullWidth className={className} />;
};
