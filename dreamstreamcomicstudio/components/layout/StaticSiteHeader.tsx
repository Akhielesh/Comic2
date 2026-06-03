import React from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '../Button';
import { BrandLockup } from './BrandLockup';
import { NotificationBell } from '../NotificationBell';
import { UserAvatar } from '../UserAvatar';
import { TokenAvailabilityPill } from '../TokenAvailabilityPill';

interface StaticSiteHeaderProps {
  isAuthenticated: boolean;
  onGoHome: () => void;
  onViewComics: () => void;
  onEnterStudio: () => void;
  onEnterComicForge: () => void;
  onSignIn: () => void;
  onOpenProfile: () => void;
  onNavigate: (view: string, id?: string) => void;
}

export const StaticSiteHeader: React.FC<StaticSiteHeaderProps> = ({
  isAuthenticated,
  onGoHome,
  onViewComics,
  onEnterStudio,
  onEnterComicForge,
  onSignIn,
  onOpenProfile,
  onNavigate
}) => {
  return (
    <header className="sticky top-0 z-50 bg-white/90 backdrop-blur border-b-4 border-black">
      <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
        <BrandLockup onClick={onGoHome} />
        <div className="flex items-center gap-4">
          <button onClick={onViewComics} className="hidden md:block text-sm font-bold hover:underline">
            View Comics
          </button>
          <button onClick={() => onNavigate('models')} className="hidden md:block text-sm font-bold hover:underline">
            Models
          </button>
          <button onClick={() => onNavigate('chat')} className="hidden md:block text-sm font-bold hover:underline">
            AI Chat
          </button>
          {isAuthenticated ? (
            <>
              <TokenAvailabilityPill />
              <Button onClick={onEnterStudio} size="sm" icon={<ArrowRight size={16} />}>
                Studio
              </Button>
              <Button onClick={onEnterComicForge} size="sm" variant="secondary">
                ComicForge
              </Button>
              <NotificationBell onNavigate={onNavigate} />
              <UserAvatar onClick={onOpenProfile} />
            </>
          ) : (
            <Button onClick={onSignIn} size="sm" icon={<ArrowRight size={16} />}>
              Sign In
            </Button>
          )}
        </div>
      </div>
    </header>
  );
};
