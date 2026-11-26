// QA scene `alerts` (notify NF-4, NF-5; the scene contract is in qa/app/index.tsx): every alert the core can raise, as
// the static toast card the person sees (fixed phrases around invented titles), the summary toast, the Alerts settings
// card on in-memory prefs (this browser's are never touched, nothing is counted), and the two chimes on Play buttons
// (at the scene's prefs, so the card's Volume applies to them too).
// Nothing here reaches the network; the chimes play only from a press (that press unlocks the audio).
import React from 'react';
import { BellRing, Volume2 } from 'lucide-react';
import { Button } from '../../../components/ds/Button';
import { PageHeader } from '../../../components/ds/PageHeader';
import { SectionCard } from '../../../components/ds/SectionCard';
import { ToastCard } from '../../../components/ds/Toast';
import { alertCopy, summaryCopy } from '../../../services/alerts/copy';
import { toneOf, type AlertDraft } from '../../../services/alerts/types';
import { playChimeNow } from '../../../services/alerts/bus';
import { AlertSettingsCard } from '../../../components/alerts/AlertSettingsCard';
import { createMemoryPrefsStore } from '../../../services/alerts/prefs';

const STACK = 'flex min-w-0 flex-col gap-3';
const ROW = 'flex min-w-0 flex-wrap items-center gap-2';
const NOTE = 'm-0 text-[length:var(--ds-text-sm)] text-[var(--ds-muted)]';

const comic = { app: 'comic' as const, id: 'qa_comic' };
const chat = { app: 'chat' as const, id: 'qa_chat' };
const TITLE = 'Spice Market';

/** One draft per kind (invented titles and counts). */
const ALERT_SAMPLES: readonly AlertDraft[] = [
  { kind: 'reply', key: 's1', target: comic, title: TITLE },
  { kind: 'question', key: 's2', target: comic, title: TITLE },
  { kind: 'credit', key: 's2b', target: comic, title: TITLE },
  { kind: 'plan', key: 's3', target: comic, title: TITLE },
  { kind: 'approval', key: 's4', target: comic, title: TITLE, imageCount: 6 },
  { kind: 'style', key: 's5', target: comic, title: TITLE },
  { kind: 'drawn', key: 's6', target: comic, title: TITLE, count: 6 },
  { kind: 'drawn', key: 's6b', target: comic, title: 'The Extraordinary and Slightly Unbelievable Adventures of Captain Paprika', count: 2, pictures: true },
  { kind: 'drawn_issues', key: 's7', target: comic, title: TITLE, count: 5, failedCount: 1 },
  { kind: 'translated', key: 's8', target: comic, title: TITLE, languages: ['es', 'fr', 'de', 'ja'] },
  { kind: 'translate_issues', key: 's9', target: comic, title: TITLE, languages: ['hi'] },
  { kind: 'published', key: 's10', target: comic, title: TITLE },
  { kind: 'publish_failed', key: 's11', target: comic, title: TITLE },
  { kind: 'failed', key: 's12', target: comic, title: '' },
  { kind: 'chat_reply', key: 's13', target: chat, title: 'Weekend plans' },
  { kind: 'chat_question', key: 's14', target: chat, title: 'Weekend plans' },
  { kind: 'chat_confirm', key: 's15', target: chat, title: 'Weekend plans' },
  { kind: 'chat_failed', key: 's16', target: chat, title: '' }
];

const SUMMARY: readonly AlertDraft[] = [ALERT_SAMPLES[0], ALERT_SAMPLES[13], { ...ALERT_SAMPLES[1], title: 'Night Shift' }];

const noop = () => undefined;
/** The card's prefs in this scene: memory only. */
const scenePrefs = createMemoryPrefsStore();

function AlertCards() {
  return (
    <SectionCard title="Alert toasts" description="What each moment says. Ready kinds are calm, a question waits on you, a failure asks for a look. The only action is Open." icon={<BellRing />}>
      <div className={STACK} data-qa-alert-samples="">
        {ALERT_SAMPLES.map((d) => {
          const copy = alertCopy(d);
          return <ToastCard key={d.key} tone={toneOf(d.kind)} title={copy.title} message={copy.message} action={{ label: 'Open', onClick: noop }} />;
        })}
      </div>
    </SectionCard>
  );
}

function SummaryCard() {
  const copy = summaryCopy(SUMMARY);
  return (
    <SectionCard title="Summary" description="Several alerts close together, or what waited while the tab was hidden, come back as one toast." icon={<BellRing />}>
      <div className={STACK} data-qa-alert-summary="">
        <ToastCard tone="waiting" title={copy.title} message={copy.message} action={{ label: 'Open', onClick: noop }} />
      </div>
    </SectionCard>
  );
}

function Chimes() {
  return (
    <SectionCard title="Chimes" description="Two short synthesised chimes, quiet by default. They play only after you press something on the page." icon={<Volume2 />}>
      <div className={STACK} data-qa-alert-chimes="">
        <div className={ROW}>
          <Button variant="outline" onClick={() => void playChimeNow('ready', { gesture: true, prefs: scenePrefs.get() })}>
            Play Ready
          </Button>
          <Button variant="outline" onClick={() => void playChimeNow('needsYou', { gesture: true, prefs: scenePrefs.get() })}>
            Play Needs you
          </Button>
        </div>
        <p className={NOTE}>Ready is a rising fifth; Needs you is a lower rising third.</p>
      </div>
    </SectionCard>
  );
}

function AlertsScene() {
  return (
    // The page's one <main> (the scene contract, qa/app/index.tsx).
    <main data-qa-scene="alerts" aria-label="Alerts" className="min-h-[100dvh] min-w-0 bg-[var(--ds-canvas)] px-4 py-6 text-[var(--ds-ink)] sm:px-6">
      <div className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-8">
        <PageHeader eyebrow="Alerts" title="Chimes and toasts" description="A comic or a chat that finishes, or waits on you, while you are elsewhere." />
        <div className="grid min-w-0 gap-6 lg:grid-cols-2">
          <AlertCards />
          <div className="flex min-w-0 flex-col gap-6">
            <AlertSettingsCard store={scenePrefs} onChanged={noop} />
            <SummaryCard />
            <Chimes />
          </div>
        </div>
      </div>
    </main>
  );
}

export default { id: 'alerts', title: 'Alerts: chimes and toasts', Scene: AlertsScene };
