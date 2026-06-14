import React, { useState } from 'react';
import { Bot, Mail, Sparkles, BookOpen, Compass, Palette, LayoutGrid, MessageSquare, Cpu, Code2, Menu, X, Radio, Plug } from 'lucide-react';
import { Button } from '../Button';
import { BrandLockup } from './BrandLockup';
import { NavDropdown } from './NavDropdown';
import { NotificationBell } from '../NotificationBell';
import { UserAvatar } from '../UserAvatar';
import { TokenAvailabilityPill } from '../TokenAvailabilityPill';
import { useProductAccess } from '../../services/productAccess';

interface StaticSiteHeaderProps {
  isAuthenticated: boolean;
  /** Admins are never feature-gated — they get the real Code Studio entry, not "Soon". */
  isAdmin?: boolean;
  currentView?: string;
  onGoHome: () => void;
  onViewComics: () => void;
  onEnterStudio: () => void;
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
  const [mobileOpen, setMobileOpen] = useState(false);
  // Run an action then close the mobile menu.
  const go = (fn: () => void) => () => { fn(); setMobileOpen(false); };

  // Per-account studio confinement (product_access): null = unrestricted → show all.
  // Confined accounts only see the product groups in their active set (admins are never
  // gated; marketing pages and the Models catalog stay visible to everyone).
  const allowedProducts = useProductAccess();
  const confined = !isAdmin && allowedProducts !== null;
  const showComic = !confined || allowedProducts!.has('comic_studio');
  const showChat = !confined || allowedProducts!.has('chat_studio');
  const showLive = !confined || allowedProducts!.has('stream_studio');
  // Code Studio isn't one of the standalone products — confined accounts never get it.
  const showCode = !confined;

  // Same products as the desktop nav, flattened for the mobile menu (<1024px).
  const mobileGroups: { heading: string; items: { label: string; onClick: () => void }[] }[] = [
    ...(showComic ? [{ heading: 'Comic', items: [
      { label: 'How It Works', onClick: () => onNavigate('how-it-works') },
      { label: 'Comic Studio', onClick: onEnterStudio },
      { label: 'Library', onClick: onViewComics },
    ] }] : []),
    ...(showChat ? [{ heading: 'Chat Studio', items: [
      { label: 'Open Chat Studio', onClick: () => onNavigate('chat') },
      { label: 'Model Catalog', onClick: () => onNavigate('models') },
    ] }] : []),
    ...(showCode ? [{ heading: 'Code', items: isAdmin
      ? [{ label: 'Open Code Studio', onClick: () => onNavigate('codestudio') }]
      : [{ label: 'Get notified', onClick: notify }] }] : []),
    { heading: 'Live', items: showLive
      ? [{ label: 'Open Stream Studio', onClick: () => { window.location.href = '/live.html'; } }]
      : [{ label: 'Get notified', onClick: notify }] },
    { heading: 'Models', items: [
      { label: 'Browse Models', onClick: () => onNavigate('models') },
    ] },
    ...(isAuthenticated ? [{ heading: 'Connectors', items: [
      { label: 'Browse Connectors', onClick: () => onNavigate('connectors') },
      { label: 'Your Connections', onClick: () => onNavigate('connectors') },
    ] }] : []),
  ];

  return (
    <header className="sticky top-0 z-50 bg-white border-b-4 border-black">
      {/* Announcement banner — home page only */}
      {isHome && (
        <div className="bg-brand-yellow border-b-2 border-black py-1.5 px-4 text-center text-xs font-bold text-black tracking-wide">
          <span className="inline-flex items-center gap-2">
            <Sparkles size={11} />
            Chat Studio is live — converse with Claude, Gemini &amp; 100+ models
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

          {/* Centre nav — desktop only (≥1024px). The four products, each with its own hover menu. */}
          <nav className="hidden lg:flex items-center gap-1 bg-slate-100 border-2 border-black rounded-full px-2 py-1">
            {showComic && (
              <NavDropdown
                label="Comic"
                icon={<BookOpen size={14} />}
                items={[
                  { label: 'How It Works', description: 'The 8-step studio workflow', icon: <Compass size={16} />, onClick: () => onNavigate('how-it-works') },
                  { label: 'Studio', description: 'Turn your script into a comic', icon: <Palette size={16} />, onClick: onEnterStudio },
                  { label: 'Library', description: 'Browse the public comic gallery', icon: <LayoutGrid size={16} />, onClick: onViewComics },
                ]}
              />
            )}
            {showChat && (
              <NavDropdown
                label="Chat Studio"
                icon={<Bot size={14} />}
                variant="blue"
                items={[
                  { label: 'Open Chat Studio', description: 'Chat with Claude, Gemini & 100+ models', icon: <MessageSquare size={16} />, onClick: () => onNavigate('chat') },
                  { label: 'Model Catalog', description: 'Compare every available model', icon: <Cpu size={16} />, onClick: () => onNavigate('models') },
                ]}
              />
            )}
            {/* Admins are never gated: they get the real Code Studio entry; everyone else
                sees the "Coming soon" capture until Code launches publicly. */}
            {showCode && (isAdmin ? (
              <NavDropdown
                label="Code"
                icon={<Code2 size={14} />}
                variant="blue"
                items={[
                  { label: 'Open Code Studio', description: 'Build & run apps live (agentic builder)', icon: <Code2 size={16} />, onClick: () => onNavigate('codestudio') },
                ]}
              />
            ) : (
              <NavDropdown
                label="Code"
                icon={<Code2 size={14} />}
                variant="muted"
                badge="Coming soon"
                caption="🚧 In the workshop"
                items={[
                  { label: 'Get notified', description: 'Be first to know when Code launches', icon: <Mail size={16} />, onClick: notify },
                ]}
              />
            ))}
            {showLive ? (
              <NavDropdown
                label="Live"
                icon={<Radio size={14} />}
                variant="blue"
                items={[
                  { label: 'Open Stream Studio', description: 'Go live from your camera — chat, lobby & recording', icon: <Radio size={16} />, onClick: () => { window.location.href = '/live.html'; } },
                ]}
              />
            ) : (
              <NavDropdown
                label="Live"
                icon={<Radio size={14} />}
                variant="muted"
                badge="Coming soon"
                caption="🚧 In the workshop"
                items={[
                  { label: 'Get notified', description: 'Be first to know when Live launches', icon: <Mail size={16} />, onClick: notify },
                ]}
              />
            )}
            <NavDropdown
              label="Models"
              icon={<Cpu size={14} />}
              items={[
                { label: 'Browse Models', description: 'Specs, pricing & benchmarks', icon: <Cpu size={16} />, onClick: () => onNavigate('models') },
                { label: 'Use in Chat Studio', description: 'Start a conversation with any model', icon: <MessageSquare size={16} />, onClick: () => onNavigate('chat') },
              ]}
            />
            {/* Connectors — a top-level category (NOT nested under Settings/Tools). */}
            {isAuthenticated && (
              <NavDropdown
                label="Connectors"
                icon={<Plug size={14} />}
                items={[
                  { label: 'Browse Connectors', description: 'Connect Gmail, Maps & more', icon: <Plug size={16} />, onClick: () => onNavigate('connectors') },
                  { label: 'Your Connections', description: 'Manage your synced accounts', icon: <LayoutGrid size={16} />, onClick: () => onNavigate('connectors') },
                ]}
              />
            )}
          </nav>

          {/* Auth controls */}
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            {/* Hamburger — shows the product nav below the desktop breakpoint (<1024px). */}
            <button
              onClick={() => setMobileOpen((o) => !o)}
              className="lg:hidden inline-flex items-center justify-center h-9 w-9 rounded-lg border-2 border-black bg-white hover:bg-slate-100 transition-colors"
              aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={mobileOpen}
            >
              {mobileOpen ? <X size={18} /> : <Menu size={18} />}
            </button>

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
                {/* New signups are invite-only — collect interest instead of opening registration.
                    Compact label on phones so the header never overflows a ~360px viewport. */}
                <Button onClick={onRequestAccess ?? onSignIn} size="sm" icon={<Mail size={14} />}>
                  <span className="hidden sm:inline">Request Access</span>
                  <span className="sm:hidden">Join</span>
                </Button>
              </>
            )}
          </div>

        </div>
      </div>

      {/* Mobile product menu (<1024px) — restores the nav that the desktop bar hides. */}
      {mobileOpen && (
        <div className="lg:hidden border-t-2 border-black bg-white max-h-[75vh] overflow-auto">
          <nav className="max-w-7xl mx-auto px-4 sm:px-6 py-3 space-y-3">
            {mobileGroups.map((g) => (
              <div key={g.heading}>
                <p className="px-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">{g.heading}</p>
                <div className="mt-1 grid">
                  {g.items.map((it) => (
                    <button
                      key={it.label}
                      onClick={go(it.onClick)}
                      className="text-left px-3 py-2 rounded-lg font-semibold text-slate-800 hover:bg-slate-100 transition-colors"
                    >
                      {it.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {!isAuthenticated && (
              <button
                onClick={go(onSignIn)}
                className="w-full text-left px-3 py-2 rounded-lg font-semibold text-slate-800 hover:bg-slate-100 transition-colors"
              >
                Sign In
              </button>
            )}
          </nav>
        </div>
      )}
    </header>
  );
};
