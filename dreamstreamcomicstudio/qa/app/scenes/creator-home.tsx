// QA scene `creator-home` (homestyles HS-2a; the scene contract is in qa/app/index.tsx): My comics in Comic Studio for a
// signed-in member, on invented comics. `&state=` picks the fixture:
//   one (default)  one studio comic, 3 of 10 pages drawn, edited two hours ago (the Continue card)
//   empty          no comics: the idea form
//   many           twelve comics (studio and classic): Continue shows the newest studio comic
//   published      the newest comic is published and fully drawn
//   classic        classic comics only: no Continue card
//   over-limit     one comic, and the member's own key is over its monthly limit (a fixture key: stored keys are never
//                  read or written)
// The brand, New comic and All comics stay inside the frame. Covers are bundled files; nothing reaches the network or spends.

import React from 'react';
import type { ComicState, Project } from '../../../types';
import type { ManagedApiKey } from '../../../services/apiKeys';
import { ProjectDashboard } from '../../../components/ProjectDashboard';
import { OwnKeySource } from '../../../components/comicstudio/home/OwnKeyLimitLine';
import { useComicThemeScope } from '../../../components/comicstudio/useComicTheme';
import type { QaAppScene } from '../index';

const CREATOR_HOME_STATES = ['one', 'empty', 'many', 'published', 'classic', 'over-limit'] as const;
type CreatorHomeState = (typeof CREATOR_HOME_STATES)[number];

const stateOf = (): CreatorHomeState => {
  if (typeof window === 'undefined') return 'one';
  const raw = new URLSearchParams(window.location.search).get('state');
  return (CREATOR_HOME_STATES as readonly string[]).includes(raw ?? '') ? (raw as CreatorHomeState) : 'one';
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SAMPLE = '/assets/comic-sample';

const baseState = (patch: Record<string, unknown>): ComicState => ({
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
  panels: [],
  ...patch
}) as ComicState;

const studio = (id: string, name: string, ageMs: number, pages: number, drawn: number, cover?: string, row: Partial<Project> = {}): Project => {
  const updatedAt = Date.now() - ageMs;
  return {
    id,
    name,
    createdAt: updatedAt - 3 * DAY,
    updatedAt,
    state: baseState({ studioVersion: 4, studioPages: pages, studioRendered: drawn, ...(cover ? { coverImageUrl: `${SAMPLE}/${cover}` } : {}) }),
    ...row
  };
};

const classic = (id: string, name: string, ageMs: number, cover?: string): Project => {
  const updatedAt = Date.now() - ageMs;
  return { id, name, createdAt: updatedAt - 5 * DAY, updatedAt, state: baseState({ pipelineMode: 'classic', ...(cover ? { coverImageUrl: `${SAMPLE}/${cover}` } : {}) }) };
};

const fixtures = (state: CreatorHomeState): Project[] => {
  const harbour = studio('qa-harbour', 'Harbour Lights', 2 * HOUR, 10, 3, 'last-tram-page-1-480.webp');
  switch (state) {
    case 'empty':
      return [];
    case 'classic':
      return [classic('qa-c1', 'The Brass Kite', 3 * DAY, 'retro-pop-thumb.webp'), classic('qa-c2', 'Moth and the Moon', 9 * DAY)];
    case 'published':
      return [
        studio('qa-garden', 'The Clockmaker’s Garden', 3 * DAY, 8, 8, 'watercolor-storybook-1.webp', { isPublic: true }),
        studio('qa-rooftop', 'Rooftop Run', 6 * DAY, 12, 5, 'manga-screentone-1.webp')
      ];
    case 'many':
      return [
        studio('qa-garden', 'The Clockmaker’s Garden', 30 * 60_000, 8, 2, 'watercolor-storybook-1.webp'),
        harbour,
        studio('qa-rooftop', 'Rooftop Run', 26 * HOUR, 12, 12, 'manga-screentone-1.webp'),
        studio('qa-signal', 'Signal from Station Nine', 2 * DAY, 6, 1, 'retro-pop-1.webp'),
        classic('qa-c1', 'The Brass Kite', 3 * DAY, 'retro-pop-thumb.webp'),
        studio('qa-ink', 'Night Ferry', 4 * DAY, 5, 5, 'noir-ink-1.webp', { isPublic: true }),
        studio('qa-map', 'A Map of Small Rivers', 5 * DAY, 0, 0),
        studio('qa-riso', 'Paper Planes Club', 8 * DAY, 4, 2, 'indie-risograph-1.webp'),
        studio('qa-ligne', 'The Lighthouse Letters', 11 * DAY, 10, 10, 'ligne-claire-1.webp'),
        classic('qa-c2', 'Moth and the Moon', 15 * DAY),
        studio('qa-long', 'An Exceptionally Long Comic Title That Has To Clip Inside Its Card Without Pushing Anything', 20 * DAY, 3, 0),
        studio('qa-old', 'Winter Market', 40 * DAY, 6, 6, 'noir-ink-2.webp')
      ];
    case 'one':
    case 'over-limit':
    default:
      return [harbour];
  }
};

/** A fixture key, never stored: the over-limit line reads it through OwnKeySource. */
const OVER_LIMIT_KEY: ManagedApiKey = {
  id: 'qa-key',
  provider: 'openrouter',
  label: 'Fixture key',
  key: 'qa-fixture-not-a-key',
  active: true,
  limitUsd: 5,
  usedUsd: 5,
  periodStart: '2026-11-01T00:00:00.000Z',
  createdAt: '2026-11-01T00:00:00.000Z'
};

const noop = () => undefined;

function CreatorHomeScene() {
  useComicThemeScope(true);
  const [state] = React.useState(stateOf);
  const [projects] = React.useState(() => fixtures(state));
  const keySource = React.useCallback(() => (state === 'over-limit' ? OVER_LIMIT_KEY : null), [state]);
  return (
    <OwnKeySource.Provider value={keySource}>
      <div data-qa-creator-home={state} className="min-w-0">
        <ProjectDashboard
          comicWorkspace
          accountId="qa-creator-home"
          projects={projects}
          projectsLoaded
          onCreateProject={() => Promise.resolve()}
          onOpenProject={noop}
          onDeleteProject={noop}
          onDuplicateProject={noop}
          onReadProject={noop}
          onUpdateProject={noop}
          onNavigate={noop}
        />
      </div>
    </OwnKeySource.Provider>
  );
}

const scene: QaAppScene = { id: 'creator-home', title: 'Comic Studio My comics: Continue card, brand stays home', Scene: CreatorHomeScene };
export default scene;
