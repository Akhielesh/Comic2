import React from 'react';
import { ArrowRight, Bot, Mail, Sparkles } from 'lucide-react';
import { Button } from '../Button';
import { BrandLockup } from './BrandLockup';
import { ComingSoonTab } from './ComingSoonTab';
import { NotificationBell } from '../NotificationBell';
import { UserAvatar } from '../UserAvatar';
import { TokenAvailabilityPill } from '../TokenAvailabilityPill';

interface StaticSiteHeaderProps {
  isAuthenticated: boolean;
  currentView?: string;
  onGoHome: () => void;
  onViewComics: () => void;
  onEnterStudio: () => void;
  onEnterComicForge: () => void;
  onSignIn: () => void;
  onRequestAccess?: () => void;
  onOpenProfile: () => void;
  onNavigate: (view: string, id?: string) => void;
}

export const StaticSiteHeader: React.FC<StaticSiteHeaderProps> = ({
  isAuthenticated,
  currentView,
  onGoHome,
  onViewComics,
  onEnterStudio,
  onEnterComicForge,
  onSignIn,
  onRequestAccess,
  onOpenProfile,
  onNavigate,
}) => {
  const isHome = currentView === 'home';

  return (
    <header className="sticky top-0 z-50 bg-white/95 backdrop-blur-md border-b-4 border-black">
      {/* Announcement banner — home page only */}
      {isHome && (
        <div className="bg-brand-yellow border-b-2 border-black py-1.5 px-4 text-center text-xs font-bold text-black tracking-wide">
          <span className="inline-flex items-center gap-2">
            <Sparkles size={11} />
            AI Chat is live — converse with Claude, Gemini &amp; 100+ models
            <button
              onClick={() => onNavigate('chat')}
              className="underline hover:no-underline ml-1"
            >
              Try it free →
            </button>
          </span>
        </div>
      )}

      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between h-16">

          {/* Logo */}
          <BrandLockup onClick={onGoHome} />

          {/* Centre nav — desktop only */}
          <nav className="hidden lg:flex items-center gap-1 bg-slate-100 border-2 border-black rounded-full px-2 py-1">
            <button
              onClick={() => onNavigate('how-it-works')}
              className="px-3 py-1.5 text-sm font-bold text-slate-600 hover:bg-white hover:text-black rounded-full transition-all"
            >
              How It Works
            </button>
            <button
              onClick={onViewComics}
              className="px-3 py-1.5 text-sm font-bold text-slate-600 hover:bg-white hover:text-black rounded-full transition-all"
            >
              Gallery
            </button>
            <button
              onClick={() => onNavigate('models')}
              className="px-3 py-1.5 text-sm font-bold text-slate-600 hover:bg-white hover:text-black rounded-full transition-all"
            >
              Models
            </button>
            <button
              onClick={() => onNavigate('chat')}
              className="px-3 py-1.5 text-sm font-bold text-brand-blue hover:bg-brand-blue hover:text-white rounded-full transition-all flex items-center gap-1.5"
            >
              <Bot size={13} /> AI Chat
            </button>
            {/* Third product — not shippable yet; shows a "coming soon" tooltip instead of navigating. */}
            <ComingSoonTab label="Code" tooltip="Code Studio is coming soon" />
          </nav>

          {/* Auth controls */}
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            {isAuthenticated ? (
              <>
                <div className="hidden sm:block">
                  <TokenAvailabilityPill />
                </div>
                <Button onClick={onEnterStudio} size="sm" icon={<ArrowRight size={14} />}>
                  Studio
                </Button>
                <Button onClick={onEnterComicForge} size="sm" variant="secondary" className="hidden md:flex">
                  ComicForge
                </Button>
                <NotificationBell onNavigate={onNavigate} />
                <UserAvatar onClick={onOpenProfile} />
              </>
            ) : (
              <>
                <button
                  onClick={onSignIn}
                  className="hidden sm:block px-3 py-1.5 text-sm font-bold text-slate-600 hover:text-black transition-colors"
                >
                  Sign In
                </button>
                {/* New signups are invite-only — collect interest instead of opening registration. */}
                <Button onClick={onRequestAccess ?? onSignIn} size="sm" icon={<Mail size={14} />}>
                  Request Access
                </Button>
              </>
            )}
          </div>

        </div>
      </div>
    </header>
  );
};
