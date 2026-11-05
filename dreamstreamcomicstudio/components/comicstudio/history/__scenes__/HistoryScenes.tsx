// Comic History QA scenes (package H5) for the layout harness: /qa/comic-qa.html?surface=kit&kit=<scene>, measured at
// 360×740 and 1440×900, light and dark, ?skin=atlas (registered by the qa/KitScenes.tsx owner — see the wave notes).
//
//   history          the History panel inline: the filmstrip, the scrubber, moments by day; a moment's detail; the
//                    compare of "before the AI" with now (page 3, word diffs, language chips); the reader of a moment
//   history-sheets   the restore sheet, the save-version sheet and the undo-AI sheet (with a conflict), each opened
//                    through the real panel with the "Open …" buttons
//   history-states   a brand-new comic (History starts now), a v4 comic ("Earlier (images only)"), a classic import
//                    ("Classic snapshots (3)") and the history card in each view
//
// Offline and free: the fake HistoryApi on synthetic fixtures; every history action is recorded, never sent.

import React from 'react';
import type { HistoryCard as HistoryCardData } from '../../../../shared/comic/history/types';
import { recordQaOp, useQaController, type QaParams } from '../../testing/qaController';
import { HistoryApiProvider } from '../historyApi';
import { createFakeHistoryApi } from '../historyApi.fake';
import { HistoryCardView } from '../HistoryCard';
import { HistoryBrowser, HistoryPanel, type HistoryOpenRequest } from '../HistoryPanel';
import { HISTORY_NOW, HISTORY_TZ, historyFixture, type HistoryFixtureName } from './historyFixtures';

export const HISTORY_KIT_SCENES = ['history', 'history-sheets', 'history-states'] as const;
export type HistoryKitScene = (typeof HISTORY_KIT_SCENES)[number];

const Frame: React.FC<{ title: string; testid: string; children: React.ReactNode; width?: number }> = ({ title, testid, children, width }) => (
  <section aria-label={title} data-testid={testid} style={{ width: '100%', maxWidth: width ?? 520, margin: '0 auto' }}>
    <h2 style={{ font: '600 12px/1.4 system-ui, sans-serif', color: 'var(--ds-muted)', margin: '0 0 6px', letterSpacing: '0.02em' }}>{title}</h2>
    <div className="overflow-hidden rounded-[var(--ds-radius-panel)] border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)]">{children}</div>
  </section>
);

const OPEN_BTN = 'm-0 min-h-11 rounded-[var(--ds-radius-control)] border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-4 text-[13px] font-medium text-[var(--ds-ink)]';

/** A QA controller on a history fixture with Comic History on; every action is recorded, never sent. */
const useHistoryStudio = (name: HistoryFixtureName, params: QaParams) => {
  const fixture = React.useMemo(() => historyFixture(name), [name]);
  const studio = useQaController({ doc: fixture.live, mode: params.mode === 'pro' ? 'pro' : 'easy', img: params.img, caps: { history: true } });
  const api = React.useMemo(() => createFakeHistoryApi({ live: () => fixture.live, versions: fixture.versions, classic: fixture.classic }), [fixture]);
  const recording = React.useMemo(
    () => ({
      ...studio,
      act: async (action: Parameters<typeof studio.act>[0]) => {
        recordQaOp('act', action);
        return { ok: true, aborted: false, retryable: false, gated: false };
      }
    }),
    [studio]
  );
  return { fixture, studio: recording, api };
};

let seq = 0;
const req = (r: Omit<HistoryOpenRequest, 'seq'>): HistoryOpenRequest => ({ ...r, seq: ++seq });

const Inline: React.FC<{ name: HistoryFixtureName; params: QaParams; request?: Omit<HistoryOpenRequest, 'seq'> }> = ({ name, params, request }) => {
  const { studio, api } = useHistoryStudio(name, params);
  const r = React.useMemo(() => (request ? req(request) : null), [request]);
  return (
    <HistoryApiProvider api={api}>
      <HistoryBrowser studio={studio} open inline request={r} now={HISTORY_NOW} tz={HISTORY_TZ} />
    </HistoryApiProvider>
  );
};

export const HistoryKitScene: React.FC<{ params: QaParams; scene: HistoryKitScene }> = ({ params, scene }) => {
  if (scene === 'history-sheets') return <SheetsScene params={params} />;
  if (scene === 'history-states') return <StatesScene params={params} />;
  return (
    <>
      <Frame title="History — moments (v5 comic)" testid="kit-history-list" width={440}>
        <Inline name="v5" params={params} />
      </Frame>
      <Frame title="A moment — what changed" testid="kit-history-moment" width={440}>
        <Inline name="v5" params={params} request={{ view: 'moment', versionId: 'ver_ai' }} />
      </Frame>
      <Frame title="Compare — before the AI vs now, page 3" testid="kit-history-compare" width={1100}>
        <Inline name="v5" params={params} request={{ view: 'compare', versionId: 'ver_before', pageId: 'pg_3' }} />
      </Frame>
    </>
  );
};

const SheetsScene: React.FC<{ params: QaParams }> = ({ params }) => {
  const { studio, api } = useHistoryStudio('v5-conflict', params);
  const [open, setOpen] = React.useState(false);
  const [request, setRequest] = React.useState<HistoryOpenRequest | null>(null);
  const show = (r: Omit<HistoryOpenRequest, 'seq'>) => {
    setRequest(req(r));
    setOpen(true);
  };
  return (
    <HistoryApiProvider api={api}>
      <Frame title="Open a History sheet" testid="kit-history-sheets">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 12 }}>
          <button type="button" className={OPEN_BTN} onClick={() => show({ view: 'confirm', versionId: 'ver_before' })}>
            Open the restore sheet
          </button>
          <button type="button" className={OPEN_BTN} onClick={() => show({ view: 'undo_ai' })}>
            Open undo the last AI change
          </button>
          <button type="button" className={OPEN_BTN} onClick={() => show({ view: 'list' })}>
            Open the History panel
          </button>
        </div>
      </Frame>
      <HistoryPanel studio={studio} open={open} onClose={() => setOpen(false)} request={request} now={HISTORY_NOW} tz={HISTORY_TZ} />
    </HistoryApiProvider>
  );
};

const MSG = { id: 'm_history', role: 'assistant' as const, text: '', at: HISTORY_NOW };
const CARDS: HistoryCardData[] = [
  { type: 'history', id: 'hc1', view: 'list' },
  { type: 'history', id: 'hc2', view: 'moment', versionId: 'ver_ai' },
  { type: 'history', id: 'hc3', view: 'compare', a: 'ver_before', b: 'now' },
  { type: 'history', id: 'hc4', view: 'confirm', versionId: 'ver_before', scope: { kind: 'page', pageId: 'pg_3', mode: 'replace', part: 'all' } },
  { type: 'history', id: 'hc5', view: 'undo_ai' }
];

const Cards: React.FC<{ params: QaParams }> = ({ params }) => {
  const { studio, api } = useHistoryStudio('v5', params);
  return (
    <HistoryApiProvider api={api}>
      <div style={{ display: 'grid', gap: 12, padding: 12 }}>
        {CARDS.map((c) => (
          <HistoryCardView key={c.id} card={c} message={MSG} studio={studio} now={HISTORY_NOW} tz={HISTORY_TZ} />
        ))}
      </div>
    </HistoryApiProvider>
  );
};

const StatesScene: React.FC<{ params: QaParams }> = ({ params }) => (
  <>
    <Frame title="A brand-new comic — History starts now" testid="kit-history-empty" width={440}>
      <Inline name="empty" params={params} />
    </Frame>
    <Frame title="A v4 comic — Earlier (images only)" testid="kit-history-v4" width={440}>
      <Inline name="v4" params={params} />
    </Frame>
    <Frame title="A classic import — Classic snapshots" testid="kit-history-classic" width={440}>
      <Inline name="classic" params={params} />
    </Frame>
    <Frame title="The history card (list · moment · compare · confirm · undo the AI)" testid="kit-history-cards" width={560}>
      <Cards params={params} />
    </Frame>
  </>
);

export default HistoryKitScene;
