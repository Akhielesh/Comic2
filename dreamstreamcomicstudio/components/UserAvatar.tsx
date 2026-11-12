// A person's round avatar: their picture, or the first letter of their name on the well. On the Atlas tokens
// (DS-2 #6): a hairline ring instead of the comic black border and offset shadow, the chrome face instead of the
// comic face, and the signed-in dot on the success mark ringed with the canvas. With `onClick` it is a real
// button (named by the person) so a comment's avatar opens their profile from the keyboard too; without one it
// is a plain picture, as in the app header, which wraps it in its own "Your profile and settings" button.

import React, { useState, useEffect } from 'react';
import { getUserProfile } from '../services/db';
import { useAuth } from '../contexts/AuthContext';
import { cn } from '../lib/utils';
import { FOCUS_RING, MUTED } from './chat/studioDesign';

interface UserAvatarProps {
  className?: string;
  onClick?: () => void;
  url?: string | null;
  name?: string;
  size?: 'sm' | 'md' | 'lg';
}

const SIZE: Record<NonNullable<UserAvatarProps['size']>, string> = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-16 w-16 text-lg'
};

export const UserAvatar: React.FC<UserAvatarProps> = ({ className, onClick, url, name, size = 'md' }) => {
  const { user } = useAuth();
  const [fetchedUrl, setFetchedUrl] = useState<string | null>(null);

  // If url is undefined, we assume we should show the current logged-in user's avatar
  const isExplicit = url !== undefined;

  useEffect(() => {
    if (!isExplicit && user) {
      getUserProfile(user.id).then((p) => {
        if (p?.avatar_url) setFetchedUrl(p.avatar_url);
      });
    }
  }, [user, isExplicit]);

  const finalUrl = isExplicit ? url : fetchedUrl;
  const finalName = isExplicit ? name : user?.email || 'User';
  const initial = finalName ? finalName[0].toUpperCase() : 'U';

  const face = (
    <span className={cn(SIZE[size], 'flex items-center justify-center overflow-hidden rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-well)]')}>
      {finalUrl ? (
        <img src={finalUrl} alt={finalName} className="h-full w-full object-cover" />
      ) : (
        <span className={cn('font-semibold', MUTED)}>{initial}</span>
      )}
    </span>
  );
  // The signed-in dot only on the current user's own avatar (implicit mode). A mark, not a status word.
  const dot = !isExplicit && user ? <span aria-hidden className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-[var(--ds-canvas)] bg-[var(--ds-success)]" /> : null;

  if (onClick) {
    return (
      <button type="button" onClick={onClick} aria-label={finalName || 'User'} className={cn('relative block rounded-full', FOCUS_RING, className)}>
        {face}
        {dot}
      </button>
    );
  }
  return (
    <div className={cn('relative', className)}>
      {face}
      {dot}
    </div>
  );
};
