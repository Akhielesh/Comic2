/**
 * The account menu (navtheme NT-1): one trigger every Comic Studio header mounts at its right end. Signed in, the
 * person's photo or initial in a 44 px round button named "Account and settings", which opens AccountPanel (who you
 * are, Appearance, the Settings rows, Help, Sign out). Signed out, the Appearance button alone (the only account
 * choice a visitor has).
 *
 * The trigger is all this module draws: the panel is its own chunk (React.lazy), fetched on the first open,
 * pointer-enter or focus, so the public landing's first load carries only this button. Nothing here reads the network:
 * the person comes from App (AccountContext), and the photo shows once the panel has read it.
 */
import React, { Suspense, useCallback, useId, useRef, useState } from 'react';
import { cn } from '../../lib/utils';
import { FOCUS_RING, INK, RADIUS_ROUND } from '../chat/studioDesign';
import { AppearanceButton } from './AppearanceControl';
import { useAccount, usePersonWithProfile, type AccountPerson } from './AccountContext';
import type { AccountResume } from './accountNav';

const loadPanel = () => import('./AccountPanel');
const AccountPanel = React.lazy(() => loadPanel().then((m) => ({ default: m.AccountPanel })));

export type AccountMenuPresentation = 'anchored' | 'sheet';

export interface AccountMenuProps {
  /** Offer Paper in Appearance (Comic Studio screens). */
  paper?: boolean;
  /** Where Back from Settings resumes: the New comic form. */
  resume?: AccountResume;
  /** 'anchored' (default): a panel under the trigger from 600 px, the bottom sheet below. 'sheet': the sheet always. */
  presentation?: AccountMenuPresentation;
  /** Placement classes from the header that hosts it (show/hide by width), on the wrapper. */
  className?: string;
  /** Told when the panel opens or closes, so the host keeps one overlay open at a time. */
  onOpenChange?: (open: boolean) => void;
}

/** The person's face: the photo when known, else the initial on the well, with a hairline ring. */
export const AccountFace: React.FC<{ person: AccountPerson; size?: 'sm' | 'md' }> = ({ person, size = 'sm' }) => (
  <span
    aria-hidden="true"
    className={cn(
      'flex shrink-0 items-center justify-center overflow-hidden border border-[var(--ds-hairline)] bg-[var(--ds-well)] font-semibold leading-none',
      RADIUS_ROUND,
      INK,
      size === 'sm' ? 'size-8 text-[length:var(--ds-text-sm)]' : 'size-10 text-[length:var(--ds-text-base)]'
    )}
  >
    {person.avatarUrl ? <img src={person.avatarUrl} alt="" className="size-full object-cover" /> : person.initial}
  </span>
);

export function AccountMenu({ paper = false, resume, presentation = 'anchored', className, onOpenChange }: AccountMenuProps): React.ReactElement {
  const { person: given } = useAccount();
  const person = usePersonWithProfile(given);
  const [open, setOpenState] = useState(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    onOpenChangeRef.current?.(next);
  }, []);
  const close = useCallback(() => setOpen(false), [setOpen]);

  if (!person) return <AppearanceButton paper={paper} wrapperClassName={className} onOpenChange={onOpenChange} />;

  // Fetch the panel's chunk ahead of the press; the module system keeps the one copy.
  const preload = () => {
    void loadPanel().catch(() => undefined);
  };

  return (
    <span className={cn('relative inline-flex', className)} data-slot="account-menu">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Account and settings"
        title="Account and settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-slot="account-trigger"
        className={cn(
          'inline-flex size-11 shrink-0 items-center justify-center hover:bg-[var(--ds-hover)] aria-expanded:bg-[var(--ds-hover)]',
          RADIUS_ROUND,
          FOCUS_RING
        )}
        onPointerEnter={preload}
        onFocus={preload}
        onClick={() => setOpen(!open)}
      >
        <AccountFace person={person} />
      </button>
      {open && (
        <Suspense fallback={null}>
          <AccountPanel id={panelId} anchorRef={triggerRef} onClose={close} paper={paper} resume={resume} presentation={presentation} />
        </Suspense>
      )}
    </span>
  );
}

export default AccountMenu;
