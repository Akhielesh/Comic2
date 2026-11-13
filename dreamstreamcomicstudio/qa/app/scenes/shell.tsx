// QA scene `shell` (DS-2; the scene contract is in qa/app/index.tsx): the Atlas app shell as every page outside
// the studio wears it — the real site header (signed out, so it never reaches the network), the shell
// primitives the redesign builds its places from (the AppHeader skeleton on the header's own grid, the phone
// TabBar and the landscape NavRail with its leading Back item, both with a badge, dots and an unavailable item
// that says why), the app's own screens (the product gate, the could-not-open screen and the loader) and the
// legal line. The layout smoke measures it at the M2 matrix, light and dark: the 44 px phone menu toggle, the
// 44 px nav items and no overflow from 320 px. Nothing here reaches the network or spends.

import React, { useState } from 'react';
import { BookOpen, Compass, Library, MessageSquare, Search } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { CANVAS_BG, INK, MUTED, OVERLINE, RADIUS_PANEL, SECTION_BODY, SECTION_CARD, SECTION_DESCRIPTION, SECTION_HEADER, SECTION_TITLE } from '../../../components/chat/studioDesign';
import { AppHeaderSkeleton } from '../../../components/ds/AppHeader';
import { NavRail } from '../../../components/ds/NavRail';
import { TabBar, type TabBarItem } from '../../../components/ds/TabBar';
import { LegalMicroLinks } from '../../../components/layout/LegalMicroLinks';
import { StaticSiteHeader } from '../../../components/layout/StaticSiteHeader';
import { AppLoader, ProductGateScreen, SystemErrorScreen } from '../../../App';
import type { QaAppScene } from '../index';

type Place = 'library' | 'discover' | 'search' | 'saved';
type StudioPlace = 'chat' | 'story' | 'pages' | 'read';

const noop = () => undefined;
const BODY = 'm-0 text-[length:var(--ds-text-base)] leading-6';

const Section: React.FC<{ id: string; title: string; description: string; children: React.ReactNode }> = ({ id, title, description, children }) => (
  <section aria-labelledby={`shell-${id}`} data-qa-shell={id} className={cn(SECTION_CARD, 'min-w-0')}>
    <header className={SECTION_HEADER}>
      <div className="min-w-0">
        <h2 id={`shell-${id}`} className={SECTION_TITLE}>
          {title}
        </h2>
        <p className={SECTION_DESCRIPTION}>{description}</p>
      </div>
    </header>
    <div className={cn(SECTION_BODY, 'flex min-w-0 flex-col gap-4')}>{children}</div>
  </section>
);

/** The phone's places outside the studio, signed in (redesign plan §2): Library · Discover · Search · Saved. */
const PhoneNav: React.FC = () => {
  const [current, setCurrent] = useState<Place>('library');
  const items: TabBarItem<Place>[] = [
    { id: 'library', label: 'Library', icon: <Library />, badge: '3/6', badgeLabel: '3 of 6 comics drawn' },
    { id: 'discover', label: 'Discover', icon: <Compass />, dot: 'accent' },
    { id: 'search', label: 'Search', icon: <Search /> },
    { id: 'saved', label: 'Saved', icon: <BookOpen />, disabled: true, disabledReason: 'Save a comic from Discover to keep it here' }
  ].map((item) => ({ ...item, current: item.id === current, onSelect: () => setCurrent(item.id as Place) })) as TabBarItem<Place>[];
  return (
    <div className={cn('min-w-0 overflow-hidden border border-[var(--ds-hairline)]', RADIUS_PANEL)}>
      <p className={cn(BODY, MUTED, 'px-4 py-3')} aria-live="polite">
        Showing {items.find((i) => i.current)?.label}.
      </p>
      <TabBar<Place> label="Places" items={items} />
    </div>
  );
};

/** The studio's places in a phone held sideways: Back first, then the places, with the live-drawing dot. */
const LandscapeRail: React.FC = () => {
  const [current, setCurrent] = useState<StudioPlace>('pages');
  const [left, setLeft] = useState(false);
  const items: TabBarItem<StudioPlace>[] = [
    { id: 'chat', label: 'Chat', icon: <MessageSquare />, dot: 'amber' },
    { id: 'story', label: 'Story', icon: <BookOpen /> },
    { id: 'pages', label: 'Pages', icon: <Library />, dot: 'pulse', badge: '2/6', badgeLabel: '2 of 6 pages drawn' },
    { id: 'read', label: 'Read', icon: <Compass />, disabled: true, disabledReason: 'Draw a page first, then read it here' }
  ].map((item) => ({ ...item, current: item.id === current, onSelect: () => setCurrent(item.id as StudioPlace) })) as TabBarItem<StudioPlace>[];
  return (
    <div className={cn('flex h-[400px] min-w-0 overflow-hidden border border-[var(--ds-hairline)]', RADIUS_PANEL)}>
      <NavRail<StudioPlace> label="Studio places" items={items} back={{ label: 'Back to your comics', onBack: () => setLeft(true) }} />
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-4">
        <p className={cn('m-0', OVERLINE)}>{items.find((i) => i.current)?.label}</p>
        <p className={cn(BODY, MUTED)} aria-live="polite">
          {left ? 'Back pressed: the studio would close here.' : 'The place shows here, beside the rail.'}
        </p>
      </div>
    </div>
  );
};

const ShellScene: React.FC = () => (
  <div className={cn('min-h-[100dvh] min-w-0', CANVAS_BG, INK)}>
    <StaticSiteHeader
      isAuthenticated={false}
      currentView="home"
      onGoHome={noop}
      onViewComics={noop}
      onEnterStudio={noop}
      onSignIn={noop}
      onRequestAccess={noop}
      onOpenProfile={noop}
      onNavigate={noop}
    />
    <main id="qa-main" className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-6 px-4 py-6 medium:px-6">
      <header className="flex min-w-0 flex-col gap-1">
        <p className={cn('m-0', OVERLINE)}>QA scene</p>
        <h1 className={cn('m-0 text-[length:var(--ds-text-xl)] font-semibold', INK)}>The app shell</h1>
        <p className={cn(BODY, MUTED)}>The header above is the real site header, signed out. Below: the shell primitives and the app’s own screens.</p>
      </header>

      <Section id="skeleton" title="Header skeleton" description="AppHeaderSkeleton paints the header’s own grid, so the real header lands where its placeholders were.">
        <div className={cn('min-w-0 overflow-hidden border border-[var(--ds-hairline)]', RADIUS_PANEL)}>
          <AppHeaderSkeleton label="Loading the header" className="static" />
        </div>
      </Section>

      <Section id="tab-bar" title="Phone tab bar" description="Generic places, flex-1 items at least 44 px tall, a badge, a dot, and an unavailable item that says why.">
        <PhoneNav />
      </Section>

      <Section id="nav-rail" title="Landscape rail" description="The same items in the rail, led by Back.">
        <LandscapeRail />
      </Section>

      <Section id="gate" title="Product gate" description="An account confined to other studios.">
        <div className="min-w-0 [&>div]:min-h-0 [&>div]:py-0">
          <ProductGateScreen productLabel="Comic Studio" canStream onGoHome={noop} />
        </div>
      </Section>

      <Section id="could-not-open" title="Could not open" description="A private or missing comic, in plain words.">
        {/* The screens are full height in the app; here they keep a section's height. */}
        <div className={cn('min-w-0 [&>div]:min-h-0', RADIUS_PANEL)}>
          <SystemErrorScreen message="Comic not found or private." onRetry={noop} onDismiss={noop} />
        </div>
      </Section>

      <Section id="loader" title="Loader" description="The calm full-screen loader on the canvas.">
        <div className={cn('min-w-0 border border-[var(--ds-hairline)] [&>div]:min-h-[12rem]', RADIUS_PANEL)}>
          <AppLoader label="Opening project…" />
        </div>
      </Section>
    </main>
    <LegalMicroLinks onOpenPrivacy={noop} onOpenTerms={noop} onOpenFaq={noop} />
  </div>
);

const scene: QaAppScene = { id: 'shell', title: 'App shell: header, nav and the app’s screens', Scene: ShellScene };
export default scene;
