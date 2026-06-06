import React from 'react';
import { Bot, Mail, Sparkles, BookOpen, Compass, Palette, LayoutGrid, MessageSquare, Cpu, Code2 } from 'lucide-react';
import { Button } from '../Button';
import { BrandLockup } from './BrandLockup';
import { NavDropdown } from './NavDropdown';
import { NotificationBell } from '../NotificationBell';
import { UserAvatar } from '../UserAvatar';
import { TokenAvailabilityPill } from '../TokenAvailabilityPill';

interface StaticSiteHeaderProps {
  isAuthenticated: boolean;
  /** Admins are never feature-gated — they get the real Code Studio entry, not "Soon". */
  isAdmin?: boolean;
  currentView?: string;
  onGoHome: () => void;
  onViewComics: () => void;
  onEnterStudio: () => void;
  onEnterComicForge?: () => void;
  onSignIn: () => void;
  onRequestAccess?: () => void;
  /** Jump to the "stay updated" capture (used by the Code "coming soon" product). */
  onNotify?: () => void;
  onOpenProfile: () => void;
  onNavigate: (view: string, id?: string) => void;
}

export const StaticSiteHeader: React.FC<StaticSiteHeaderProps> = ({
  isAuthenticated,
  isAdmin = false,
  currentView,
  onGoHome,
  onViewComics,
  onEnterStudio,
  onSignIn,
  onRequestAccess,
  onNotify,
  onOpenProfile,
  onNavigate,
}) => {
  const isHome = currentView === 'home';
  const notify = onNotify ?? (() => onNavigate('home'));

  return (
    <header className="sticky top-0 z-50 bg-white border-b-4 border-black">
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

          {/* Centre nav — desktop only. The four products, each with its own hover menu. */}
          <nav className="hidden lg:flex items-center gap-1 bg-slate-100 border-2 border-black rounded-full px-2 py-1">
            <NavDropdown
              label="Comic"
              icon={<BookOpen size={14} />}
              items={[
                { label: 'How It Works', description: 'The 8-step studio workflow', icon: <Compass size={16} />, onClick: () => onNavigate('how-it-works') },
                { label: 'Studio', description: 'Turn your script into a comic', icon: <Palette size={16} />, onClick: onEnterStudio },
                { label: 'Library', description: 'Browse the public comic gallery', icon: <LayoutGrid size={16} />, onClick: onViewComics },
              ]}
            />
            <NavDropdown
              label="AI Chat"
              icon={<Bot size={14} />}
              variant="blue"
              items={[
                { label: 'Open AI Chat', description: 'Chat with Claude, Gemini & 100+ models', icon: <MessageSquare size={16} />, onClick: () => onNavigate('chat') },
                { label: 'Model Catalog', description: 'Compare every available model', icon: <Cpu size={16} />, onClick: () => onNavigate('models') },
              ]}
            />
            {/* Admins are never gated: they get the real Code Studio entry; everyone else
                sees the "Soon" coming-soon capture until Code launches publicly. */}
            {isAdmin ? (
              <NavDropdown
                label="Code"
                icon={<Code2 size={14} />}
                variant="blue"
                badge="Admin"
                caption="⚡ Admin preview"
                items={[
                  { label: 'Open Code Studio', description: 'Build & run apps live (agentic builder)', icon: <Code2 size={16} />, onClick: () => onNavigate('codestudio') },
                ]}
              />
            ) : (
              <NavDropdown
                label="Code"
                icon={<Code2 size={14} />}
                variant="muted"
                badge="Soon"
                caption="🚧 In the workshop"
                items={[
                  { label: 'Get notified', description: 'Be first to know when Code launches', icon: <Mail size={16} />, onClick: notify },
                ]}
              />
            )}
            <NavDropdown
              label="Models"
              icon={<Cpu size={14} />}
              items={[
                { label: 'Browse Models', description: 'Specs, pricing & benchmarks', icon: <Cpu size={16} />, onClick: () => onNavigate('models') },
                { label: 'Use in AI Chat', description: 'Start a conversation with any model', icon: <MessageSquare size={16} />, onClick: () => onNavigate('chat') },
              ]}
            />
          </nav>

          {/* Auth controls */}
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            {isAuthenticated ? (
              <>
                <div className="hidden sm:block">
                  <TokenAvailabilityPill />
                </div>
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
