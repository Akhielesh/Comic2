// Single source of truth for the Settings tabs. App.tsx (deep-link restore, navigation)
// and AccountSettings.tsx (nav, content switch, URL continuity) must agree on this set —
// two hand-maintained copies previously meant a new tab could work in-app but silently
// bounce to Profile on the reload/deep-link path.

export type SettingsTab =
    | 'profile'
    | 'settings'
    | 'legal'
    | 'contact'
    | 'admin'
    | 'preferences'
    | 'security';

export const SETTINGS_TAB_IDS: readonly SettingsTab[] = [
    'profile',
    'settings',
    'preferences',
    'security',
    'legal',
    'contact',
    'admin'
];

export const isSettingsTab = (value: unknown): value is SettingsTab =>
    typeof value === 'string' && (SETTINGS_TAB_IDS as readonly string[]).includes(value);
