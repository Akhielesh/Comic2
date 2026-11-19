/**
 * The account panel (navtheme NT-1), loaded only when the account menu first opens, is a press, a pointer-enter or a
 * focus away. Top to bottom:
 *   1. the person: photo or initial, display name and @handle (never the address);
 *   2. Appearance (AppearanceSegmented; Paper where Comic Studio's Paper look applies);
 *   3. Settings: Profile · Usage and API keys · Preferences · Security · Help · Admin console (staff only), each opening
 *      the DreamStream settings inside the app at that tab (requestAccountSettings), so Back returns where the
 *      person was, New comic included (`resume`);
 *   4. after a hairline, Sign out: `await signOut()` from useAuth, then App's signed-out handler, the same two calls
 *      Settings makes (nothing about sign-in, sessions or roles changes here);
 *   5. while the Director works in the open comic, one muted line: the rows open a new tab then.
 *
 * Presentation: an anchored panel under the trigger from 600 px (OVERLAY on the popover layer, portalled and kept
 * inside the viewport); the studio's bottom sheet below 600 px, on a short landscape phone, and when the host asks for
 * the sheet. Esc and a press outside close it and focus returns to the trigger; the first row takes focus on open.
 * The panel reads one thing, once per page: the person's public profile row, for the @handle and the photo (App's
 * session data has the name but not those). It never reads usage, money or admin state.
 */
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle, KeyRound, LogOut, Shield, ShieldCheck, SlidersHorizontal, User as UserIcon, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import { DENSITY, FOCUS_RING, MUTED, OVERLAY, OVERLINE, RADIUS_CONTROL, WRAP_TEXT, Z } from '../chat/studioDesign';
import { useAuth } from '../../contexts/AuthContext';
import { getUserProfile } from '../../services/db';
import { placeSheet, useSheetBehaviour } from '../comicstudio/conversation/PopSheet';
import { LEAVE_SETTLE_MS } from '../comicstudio/mobile/backStack';
import { AdaptiveSheet } from '../comicstudio/mobile/sheets/AdaptiveSheet';
import { useFormFactor } from '../comicstudio/mobile/useFormFactor';
import type { SettingsTab } from '../settingsTabs';
import { AppearanceSegmented } from './AppearanceControl';
import { AccountFace } from './AccountMenu';
import { rememberProfile, useAccount, usePersonWithProfile } from './AccountContext';
import { requestAccountSettings, useSettingsOpenInNewTab, type AccountResume } from './accountNav';

/** The panel's accessible name (also the sheet's, which keys its history layer). */
export const ACCOUNT_PANEL_LABEL = 'Account and settings';

interface Row {
  tab: SettingsTab;
  label: string;
  Icon: LucideIcon;
  staffOnly?: boolean;
}

/** The Settings rows, in order. "Usage" lives on the API & Models tab (usage left, your own keys, default models). */
export const ACCOUNT_ROWS: readonly Row[] = [
  { tab: 'profile', label: 'Profile', Icon: UserIcon },
  { tab: 'settings', label: 'Usage and API keys', Icon: KeyRound },
  { tab: 'preferences', label: 'Preferences', Icon: SlidersHorizontal },
  { tab: 'security', label: 'Security', Icon: ShieldCheck },
  { tab: 'contact', label: 'Help', Icon: HelpCircle },
  { tab: 'admin', label: 'Admin console', Icon: Shield, staffOnly: true }
];

export const BUSY_LINE = 'Opens in a new tab while the Director is working.';

/** A row: ink words, a muted icon, the overlay-row tint, 44 px under a coarse pointer, the focus ring. */
const ROW = cn(
  'flex w-full min-h-10 items-center gap-3 px-3 py-2 text-left text-[length:var(--ds-text-base)] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-overlay-hover)]',
  RADIUS_CONTROL,
  DENSITY.coarse,
  FOCUS_RING
);
const ROW_ICON = 'size-4 shrink-0 text-[var(--ds-muted)]';

const PANEL_WIDTH = 288;

export interface AccountPanelProps {
  id?: string;
  /** The trigger: the panel sits under it and focus returns to it. */
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Offer Paper in Appearance. */
  paper?: boolean;
  /** Where Back from Settings resumes (New comic). */
  resume?: AccountResume;
  /** 'sheet' asks for the bottom sheet at every width. */
  presentation?: 'anchored' | 'sheet';
}

/** Read the @handle and photo once per page (person-initiated: the panel only mounts on open). */
const useProfileRead = (id: string | undefined, known: boolean): void => {
  useEffect(() => {
    if (!id || known) return undefined;
    let live = true;
    void getUserProfile(id)
      .then((row) => {
        if (!live || !row) return;
        const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
        rememberProfile(id, { username: clean(row.username), avatarUrl: clean(row.avatar_url) });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // Once per person: `known` turns true when the row lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
};

function PanelBody({ paper, resume, leave, onClose, firstRowRef }: {
  paper: boolean;
  resume?: AccountResume;
  /** Close the panel, then act (a sheet first lets its history entry go). */
  leave: (action: () => void) => void;
  onClose: () => void;
  firstRowRef: React.RefObject<HTMLButtonElement>;
}) {
  const { person: given, staff, onSignedOut } = useAccount();
  const person = usePersonWithProfile(given);
  const { signOut } = useAuth();
  const newTab = useSettingsOpenInNewTab();
  const settingsId = useId();
  useProfileRead(given?.id, given?.username !== undefined || person?.username !== undefined);

  const open = (tab: SettingsTab) => {
    if (newTab) {
      // Inside the press, so the browser lets the new tab open; the comic stays as it is.
      requestAccountSettings(tab);
      onClose();
      return;
    }
    leave(() => requestAccountSettings(tab, resume ? { resume } : {}));
  };
  const signOutNow = () =>
    leave(() => {
      void (async () => {
        await signOut();
        onSignedOut();
      })();
    });

  const rows = ACCOUNT_ROWS.filter((row) => !row.staffOnly || staff);
  return (
    <div className="flex flex-col gap-1" data-slot="account-panel-body">
      {person && (
        <div className="flex min-w-0 items-center gap-3 px-3 pb-2 pt-1">
          <AccountFace person={person} size="md" />
          <div className="min-w-0">
            <p className="truncate text-[length:var(--ds-text-base)] font-semibold text-[var(--ds-ink)]">{person.name || 'Your account'}</p>
            {person.username && <p className={cn('truncate text-[length:var(--ds-text-sm)]', MUTED)}>@{person.username}</p>}
          </div>
        </div>
      )}
      <div className="border-t border-[var(--ds-hairline)] px-3 pb-3 pt-3">
        <p aria-hidden="true" className="mb-2 text-[length:var(--ds-text-sm)] font-medium text-[var(--ds-ink)]">
          Appearance
        </p>
        <AppearanceSegmented paper={paper} fullWidth />
      </div>
      <div className="border-t border-[var(--ds-hairline)] pt-2">
        <p className={cn('px-3 pb-1', OVERLINE)} id={settingsId}>
          Settings
        </p>
        <ul aria-labelledby={settingsId} className="flex flex-col">
          {rows.map(({ tab, label, Icon }, i) => (
            <li key={tab}>
              <button type="button" ref={i === 0 ? firstRowRef : undefined} className={ROW} onClick={() => open(tab)}>
                <Icon aria-hidden className={ROW_ICON} />
                {label}
              </button>
            </li>
          ))}
        </ul>
        {newTab && <p className={cn('px-3 pb-1 pt-1 text-[length:var(--ds-text-xs)]', MUTED, WRAP_TEXT)}>{BUSY_LINE}</p>}
      </div>
      <div className="mt-1 border-t border-[var(--ds-hairline)] pt-1">
        <button type="button" className={ROW} onClick={signOutNow}>
          <LogOut aria-hidden className={ROW_ICON} />
          Sign out
        </button>
      </div>
    </div>
  );
}

/** Focus the first row once the panel is in place (after the sheet or the anchored panel took its opener). */
const useFocusFirstRow = (ref: React.RefObject<HTMLButtonElement>): void => {
  useEffect(() => {
    const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 0) as unknown as number;
    const cancel = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : (h: number) => clearTimeout(h);
    const handle = frame(() => ref.current?.focus({ preventScroll: true }));
    return () => cancel(handle);
  }, [ref]);
};

/**
 * Give focus back to the trigger when the panel goes and focus went with it (Esc, Close, a row). The sheet primitives
 * hand it back to whatever had it on open, which is nothing where a press does not focus the button it lands on
 * (Safari), so the trigger is named here.
 */
const useReturnFocus = (anchorRef: React.RefObject<HTMLElement | null>): void => {
  useEffect(
    () => () => {
      const active = document.activeElement;
      if (!active || active === document.body) anchorRef.current?.focus({ preventScroll: true });
    },
    [anchorRef]
  );
};

function AnchoredPanel({ id, anchorRef, onClose, children }: { id?: string; anchorRef: React.RefObject<HTMLElement | null>; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  // Esc (topmost first), a press outside the panel and its trigger, Tab kept inside, focus back to the trigger.
  useSheetBehaviour(true, onClose, ref, anchorRef, { autoFocus: false });
  useLayoutEffect(() => {
    const measure = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const height = ref.current?.scrollHeight || 480;
      setPlace(placeSheet(anchor, { width: PANEL_WIDTH, height }, { width: window.innerWidth, height: window.innerHeight }, 'below', 'end'));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [anchorRef]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={ref}
      id={id}
      role="dialog"
      aria-label={ACCOUNT_PANEL_LABEL}
      data-slot="account-panel"
      tabIndex={-1}
      style={place ? { left: place.left, top: place.top, maxHeight: place.maxHeight, width: PANEL_WIDTH } : { width: PANEL_WIDTH, visibility: 'hidden' }}
      className={cn(OVERLAY, Z.popover, 'ds-scale-in fixed origin-top-right overflow-y-auto overscroll-contain p-1 outline-none')}
    >
      {children}
    </div>,
    document.body
  );
}

export function AccountPanel({ id, anchorRef, onClose, paper = false, resume, presentation = 'anchored' }: AccountPanelProps): React.ReactElement | null {
  const ff = useFormFactor();
  const sheet = presentation === 'sheet' || ff.widthClass === 'compact' || ff.heightClass === 'compact';
  const firstRowRef = useRef<HTMLButtonElement>(null);
  useFocusFirstRow(firstRowRef);
  useReturnFocus(anchorRef);

  const leave = useCallback(
    (action: () => void) => {
      onClose();
      if (!sheet || typeof window === 'undefined') {
        action();
        return;
      }
      // The sheet's history entry goes once it has closed (mobile/backStack.ts); act when that traversal lands, so
      // the view Settings opens writes its own address on its own entry. A browser that never reports back still
      // gets there after the back stack's own settle time.
      let done = false;
      const go = () => {
        if (done) return;
        done = true;
        window.removeEventListener('popstate', go);
        clearTimeout(timer);
        action();
      };
      const timer = setTimeout(go, LEAVE_SETTLE_MS);
      window.addEventListener('popstate', go);
    },
    [onClose, sheet]
  );

  const body = <PanelBody paper={paper} resume={resume} leave={leave} onClose={onClose} firstRowRef={firstRowRef} />;
  if (sheet) {
    return (
      <AdaptiveSheet open presentation="bottom" onClose={onClose} label={ACCOUNT_PANEL_LABEL} title="Account" anchorRef={anchorRef}>
        <div id={id} className="px-2 pb-3">
          {body}
        </div>
      </AdaptiveSheet>
    );
  }
  return (
    <AnchoredPanel id={id} anchorRef={anchorRef} onClose={onClose}>
      {body}
    </AnchoredPanel>
  );
}

export default AccountPanel;
