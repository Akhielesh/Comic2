// QA scene `new-comic` (navtheme NT-3; the scene contract is in qa/app/index.tsx): "Start creating" as App mounts it,
// the real ComicWorkspaceFrame and ComicIdeaForm, so it can be shot beside the studio fixture
// (`?surface=studio&skin=atlas&fixture=heist-12p`): the header, the left column, the fields, the focus ring and the one
// fill per view. Three frames, one page, one <main> (the frame's own):
//   (default)     New comic: the idea form; Start is the view's one fill, New comic an outline;
//   &view=all     All comics: the frame around a stand-in listing; New comic is the view's one fill;
//   &drawer=1     below 900 px, the navigation drawer opened on load (the scrim and sheet rungs, the overlay shadow);
//   &state=error  the idea form with its create error;
//   &material=paper  Paper's materials on the frame (the drawer is portalled, so it keeps the page's).
// The frame's own New comic / All comics buttons switch the view in place. Invented comic names; nothing navigates,
// reaches the network or spends.

import React, { useEffect, useState } from 'react';
import { ComicIdeaForm, ComicWorkspaceFrame, type ComicProjectNavigationProps } from '../../../components/comicstudio/ComicCreationWorkspace';
import { useComicTheme } from '../../../components/comicstudio/useComicTheme';
import { cn } from '../../../lib/utils';
import { HEADING, MUTED, RADIUS_PANEL, TEXT_3XL } from '../../../components/chat/studioDesign';
import type { ComicState, Project } from '../../../types';
import { AccountProvider, type AccountContextValue } from '../../../components/account/AccountContext';
import { useAccountSettingsListener } from '../../../components/account/accountNav';
import type { QaAppScene } from '../index';

const noop = () => undefined;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 18, 12);

const state = (): ComicState => ({
  step: 0,
  maxStepReached: 0,
  script: '',
  scenes: [],
  styleVariants: [],
  stylePrompt: '',
  styleCategory: '',
  styleAspectRatio: '2:3',
  imageResolution: '2K',
  characters: [],
  items: [],
  locations: [],
  layoutType: 'grid',
  panels: []
});

const PROJECTS: Project[] = ['The Lantern Ferry', 'Salt Road', 'Midnight Orchard', 'Glass Harbour', 'A Kite for Ostrava'].map((name, i) => ({
  id: `qa-new-comic-${i + 1}`,
  name,
  createdAt: NOW - (i + 3) * DAY,
  updatedAt: NOW - i * DAY,
  state: state()
}));

/** The header's account menu shows this person, as App fills it (invented). */
const ACCOUNT: AccountContextValue = { person: { id: 'qa-person', name: 'Rowan Vale', initial: 'R', username: 'rowan_draws', avatarUrl: null }, staff: false, onSignedOut: noop };

const param = (key: string): string | null => (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get(key));

/** All comics as the dashboard titles it (HEADING + TEXT_3XL); the cards are plain stand-ins with no actions. */
const AllComicsStandIn: React.FC = () => (
  <div className="mx-auto max-w-7xl p-4 medium:p-8">
    <div className="mb-8 min-w-0">
      <h1 className={cn(TEXT_3XL, HEADING)}>My comics</h1>
      <p className={cn('mt-1 text-[length:var(--ds-text-base)] leading-6', MUTED)}>Where each comic stands, and what’s next</p>
    </div>
    <ul className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {PROJECTS.map((p) => (
        <li key={p.id} className={cn('min-w-0 overflow-hidden border border-[var(--ds-hairline)] bg-[var(--ds-surface)]', RADIUS_PANEL)}>
          <div aria-hidden className="aspect-[3/2] bg-[var(--ds-well)]" />
          <div className="p-5">
            <h2 className="truncate text-[length:var(--ds-text-lg)] font-semibold leading-6">{p.name}</h2>
            <p className={cn('text-[length:var(--ds-text-sm)] tabular-nums', MUTED)}>Updated {new Date(p.updatedAt).toLocaleDateString('en-GB', { timeZone: 'UTC' })}</p>
          </div>
        </li>
      ))}
    </ul>
  </div>
);

function NewComicScene() {
  const [view, setView] = useState<'new' | 'all'>(param('view') === 'all' ? 'all' : 'new');
  const [name, setName] = useState('');
  const [idea, setIdea] = useState('A ferry captain who only sails at night finds a passenger with no reflection.');
  const { theme } = useComicTheme();
  const material = param('material') === 'paper' ? 'paper' : theme;
  const error = param('state') === 'error' ? 'The comic could not be created. Try again in a moment.' : null;
  // The account menu's rows are answered here, so nothing navigates away from the scene.
  useAccountSettingsListener(noop);

  useEffect(() => {
    if (param('drawer') !== '1') return;
    document.querySelector<HTMLButtonElement>('button[aria-label="Open comic navigation"]')?.click();
  }, []);

  const navigation: ComicProjectNavigationProps = {
    projects: PROJECTS,
    activeView: view,
    onNewComic: () => setView('new'),
    onAllComics: () => setView('all'),
    onLibrary: noop,
    onOpenProject: noop
  };

  return (
    <AccountProvider value={ACCOUNT}>
    <div data-comic-theme={material} data-qa-new-comic={view} className="min-h-[100dvh] bg-[var(--ds-canvas)] text-[var(--ds-ink)]">
      <ComicWorkspaceFrame title={view === 'new' ? 'New comic' : 'All comics'} navigation={navigation} onHome={noop}>
        {view === 'new'
          ? <ComicIdeaForm name={name} idea={idea} pending={false} error={error} onName={setName} onIdea={setIdea} onStart={noop} onDraft={noop} onStartBlank={noop} onClassic={noop} onLibrary={noop} />
          : <AllComicsStandIn />}
      </ComicWorkspaceFrame>
    </div>
    </AccountProvider>
  );
}

const scene: QaAppScene = { id: 'new-comic', title: 'Start creating: New comic, All comics and the phone drawer in the studio’s look', Scene: NewComicScene };
export default scene;
