// Client feature module: Comic History (versions plan §8; package H5 — replaces the H0 stub in place, keeping every
// export name and signature). The alternatives sheet under history/alternatives/** belongs to H7.
//
// Registers, through features.ts (listed last, lowest precedence):
//   - the header History slot (order 240: after the usage meter, before Read) — the button and the History panel,
//     which answers OPEN_HISTORY_EVENT (typed intents, the card, the page and timeline links, "See changes");
//   - the History board tab (order 510, after Media);
//   - the `history` conversation card (ids only; renders by fetching from the owner API).
// Every registration renders nothing while Comic History is off (caps.history false, the default): the tab's
// `visible` is false, the slot and the card render null, so with COMIC_HISTORY unset nothing in the studio changes.
//
// The registered components are wrapped here and resolved only when they render, so an import cycle through
// features.ts (a hotspot file a History component reaches) can never see a half-initialized binding.

import React from 'react';
import { History as HistoryIcon } from 'lucide-react';
import type { StudioTab } from '../../../shared/comic/doc';
import { historyEnabled } from '../../../shared/comic/capabilities';
import type { CardProps, FeatureModule } from '../extensions';
import type { StudioController } from '../types';
import { HistoryButton } from './HistoryButton';
import { HistoryCardView } from './HistoryCard';
import { HistoryTab } from './HistoryTab';

/** Header order: after the usage meter (220), before Read (300). */
export const HISTORY_HEADER_ORDER = 240;
/** Board tab order (versions plan §8): after Media (500). */
export const HISTORY_TAB_ORDER = 510;
/** The History tab id (a StudioTab since shared/comic/doc.ts gained 'history'; visible only while caps.history is on). */
export const HISTORY_TAB_ID: StudioTab = 'history';

const HistoryHeaderSlot: React.FC<{ studio: StudioController; compact: boolean }> = (props) => React.createElement(HistoryButton, props);
const HistoryTabPanel: React.FC<{ studio: StudioController }> = (props) => React.createElement(HistoryTab, props);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const HistoryCardSlot: React.FC<CardProps<any>> = (props) => React.createElement(HistoryCardView, props);

export const feature: FeatureModule = {
  cards: [{ type: 'history', Component: HistoryCardSlot }],
  tabs: [
    {
      id: HISTORY_TAB_ID,
      label: 'History',
      icon: React.createElement(HistoryIcon, { className: 'h-4 w-4', 'aria-hidden': true }),
      order: HISTORY_TAB_ORDER,
      Component: HistoryTabPanel,
      visible: (_doc, caps) => historyEnabled(caps)
    }
  ],
  headerSlots: [{ id: 'history', order: HISTORY_HEADER_ORDER, Component: HistoryHeaderSlot }]
};

export { OPEN_HISTORY_EVENT, requestOpenHistory } from './openHistory';
export type { OpenHistoryRequest } from './openHistory';

export { matchHistoryIntent, handleHistoryIntent, historyUndoFallback } from './intents';
export type { HistoryIntent, HistoryIntentHost } from './intents';

export { HistoryPanel, HistoryBrowser } from './HistoryPanel';
export { HistoryButton, HISTORY_HEADER_ICON_MIN_WIDTH } from './HistoryButton';
export { HistoryCardView } from './HistoryCard';
export { HistoryTab } from './HistoryTab';
export { ChangesSincePublishLink } from './ChangesSincePublishLink';
export { PageHistoryLink, TimelineHistoryLink } from './EntryLinks';
export { HistoryApiProvider, HistoryApiContext, httpHistoryApi, HISTORY_ROUTES, type HistoryApi } from './historyApi';
