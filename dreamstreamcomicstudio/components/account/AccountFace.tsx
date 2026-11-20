/**
 * The person's face (navtheme NT-1): the photo when known, else the initial on the well, with a hairline ring. Its own
 * module so the account menu's trigger and its lazy panel share it without importing each other.
 */
import React from 'react';
import { cn } from '../../lib/utils';
import { INK, RADIUS_ROUND } from '../chat/studioDesign';
import type { AccountPerson } from './AccountContext';

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
