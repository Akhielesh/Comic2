// QA scene `live-turn` (liveturn LT-2; the scene contract is in qa/app/index.tsx): the Director's turn survives leaving
// the comic. The real studio controller (useStudio) runs over a fake transport that streams a scripted turn:
//
//   1. The page opens on the comic and sends one message: the Director reads the brief and starts planning
//      ("Thinking…", with the steps under "Director activity").
//   2. "Settings" unmounts the studio, as App does when you open Settings, My comics or another comic. While you are
//      there the Director finishes planning and starts checking the cast: the stream keeps reading, held by
//      components/comicstudio/live/studioStreams.ts.
//   3. "Comic" mounts a new studio for the same comic: "Thinking…" and the steps are back, including the step that
//      finished while you were away.
//   4. "Let the Director finish" streams the reply in. The last line names the moments an alert would hear.
//
// `?step=away` opens on step 2 and `?step=back` on step 3 (each plays the earlier steps first), so a screenshot needs
// no clicks. Nothing reaches the network and nothing spends: the "server" lives in this page, and so do its timers.

import React, { useEffect, useRef, useState } from 'react';
import { cn } from '../../../lib/utils';
import { CANVAS_BG, HEADING, INK, MUTED, OVERLINE, RADIUS_PANEL } from '../../../components/chat/studioDesign';
import { Button, Segmented } from '../../../components/ds';
import { applyOps, type DocOp } from '../../../shared/comic/ops';
import type { ComicDoc, RenderState } from '../../../shared/comic/doc';
import type { StreamRequest, StudioEvent } from '../../../shared/comic/events';
import { ConversationPane } from '../../../components/comicstudio/conversation/ConversationPane';
import { useStudio, type StudioTransport } from '../../../components/comicstudio/useStudio';
import { StudioApiError } from '../../../components/comicstudio/studioApi';
import { subscribeStudioMoments, type StudioMoment } from '../../../components/comicstudio/live/studioStreams';
import { QA_NOW, makeQaDoc, qaImagePaths } from '../../../components/comicstudio/testing/qaFixtures';
import { qaImageUrl } from '../../../components/comicstudio/testing/qaController';
import type { QaAppScene } from '../index';

const PROJECT_ID = 'proj_qa_live_turn';
const SAMPLE_MESSAGE = 'Plan a rooftop chase in six pages, ending on the roof.';
const REPLY_ID = 'lt_reply';
const REPLY_PARTS = ['Here is the plan: ', 'six pages in the rain, ', 'the chase crosses three rooftops, ', 'and it ends with the two of them back to back on the roof.'];
const STEP_MS = 160;

type Phase = 'idle' | 'planning' | 'checking' | 'replying' | 'done';
type View = 'comic' | 'settings';
type Step = 'start' | 'away' | 'back';

/** A render the fixture left queued or drawing, as finished. */
const settled = <R extends RenderState>(r: R): R => (r.status === 'queued' || r.status === 'rendering' ? { ...r, status: 'ready' } : r);

/** A pretend backend for one page: the doc it holds, the one open message stream, and the script. */
class ScriptedServer {
  doc: ComicDoc;
  phase: Phase = 'idle';
  private stream: { emit: (e: StudioEvent) => void; end: () => void } | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private listeners = new Set<() => void>();

  constructor() {
    const base = makeQaDoc('lake-1p');
    // Nothing drawing: the only live work on this page is the Director's turn.
    this.doc = {
      ...base,
      id: PROJECT_ID,
      conversation: [],
      pages: base.pages.map((p) => ({ ...p, render: settled(p.render) })),
      cast: base.cast.map((c) => ({ ...c, sheet: settled(c.sheet) })),
      places: base.places.map((p) => ({ ...p, sheet: settled(p.sheet) })),
      style: { ...base.style, options: base.style.options.map((o) => ({ ...o, render: settled(o.render) })) },
      cover: { ...base.cover, render: settled(base.cover.render) }
    };
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  dispose(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.listeners.forEach((fn) => fn());
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private commit(ops: DocOp[]): number {
    const rev = this.doc.rev + 1;
    this.doc = { ...applyOps(this.doc, ops, QA_NOW + rev), rev };
    this.stream?.emit({ type: 'ops', rev, ops });
    return rev;
  }

  private step(id: string, label: string, phase: 'start' | 'end'): void {
    this.stream?.emit({ type: 'activity', id, label, phase, ...(phase === 'end' ? { ok: true } : {}) });
  }

  /** The person left the comic: the Director finishes planning and starts checking the cast meanwhile. */
  away(): void {
    if (this.phase !== 'planning') return;
    this.later(STEP_MS * 2, () => {
      this.step('lt_plan', 'Planning six pages', 'end');
      this.step('lt_cast', 'Checking the cast', 'start');
      this.setPhase('checking');
    });
  }

  /** "Let the Director finish": the reply streams in, lands, and the turn closes. */
  finish(): void {
    if (this.phase !== 'planning' && this.phase !== 'checking') return;
    const wasChecking = this.phase === 'checking';
    this.setPhase('replying');
    if (wasChecking) this.step('lt_cast', 'Checking the cast', 'end');
    else this.step('lt_plan', 'Planning six pages', 'end');
    REPLY_PARTS.forEach((text, i) => this.later(STEP_MS * (i + 1), () => this.stream?.emit({ type: 'delta', msgId: REPLY_ID, text })));
    this.later(STEP_MS * (REPLY_PARTS.length + 2), () => {
      this.commit([{ op: 'message', msg: { id: REPLY_ID, role: 'assistant', text: REPLY_PARTS.join(''), at: QA_NOW + 50 } }]);
      this.stream?.emit({ type: 'done', rev: this.doc.rev, spentUsd: 0 });
      this.stream?.end();
      this.stream = null;
      this.setPhase('done');
    });
  }

  readonly transport: StudioTransport = {
    loadStudioProject: async () => ({ doc: this.doc, urls: this.sign(qaImagePaths(this.doc)) }),
    signStudioUrls: async (_id: string, paths: string[]) => this.sign(paths),
    cancelStudio: async () => {
      this.dispose();
      // As the server does: a stopped turn ends with an ordinary `done`, never an error.
      this.stream?.emit({ type: 'done', rev: this.doc.rev, spentUsd: 0 });
      this.stream?.end();
      this.stream = null;
      this.setPhase('done');
    },
    streamStudio: (_id: string, req: StreamRequest, onEvent: (e: StudioEvent) => void, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new StudioApiError('aborted', 'Cancelled.')), { once: true });
        if (req.kind !== 'message') {
          // Edits save at once; any other action has nothing to do in this scene.
          onEvent({ type: 'hello', rev: this.doc.rev, turnId: 'qa_action' });
          if (req.action.type === 'patch' && Array.isArray(req.action.ops)) {
            const rev = this.doc.rev + 1;
            this.doc = { ...applyOps(this.doc, req.action.ops, QA_NOW + rev), rev };
            onEvent({ type: 'ops', rev, ops: req.action.ops, origin: 'user' });
          }
          onEvent({ type: 'done', rev: this.doc.rev, spentUsd: 0 });
          resolve();
          return;
        }
        this.stream = { emit: onEvent, end: resolve };
        this.later(STEP_MS, () => onEvent({ type: 'hello', rev: this.doc.rev, turnId: 'qa_turn_1' }));
        this.later(STEP_MS * 2, () => this.commit([{ op: 'message', msg: { id: 'lt_user', role: 'user', text: req.text, at: QA_NOW + 10 } }]));
        this.later(STEP_MS * 3, () => this.step('lt_read', 'Reading your brief', 'start'));
        this.later(STEP_MS * 6, () => {
          this.step('lt_read', 'Reading your brief', 'end');
          this.step('lt_plan', 'Planning six pages', 'start');
          this.setPhase('planning');
        });
      })
  };

  private sign(paths: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of paths) {
      const url = qaImageUrl(p, 'svg');
      if (url) out[p] = url;
    }
    return out;
  }
}

/** The studio, mounted only while the comic is the view (as in App): leaving unmounts it. */
const StudioView: React.FC<{ server: ScriptedServer; sent: React.MutableRefObject<boolean> }> = ({ server, sent }) => {
  const studio = useStudio(PROJECT_ID, { transport: server.transport });
  const sendRef = useRef(studio.send);
  sendRef.current = studio.send;
  const loaded = !!studio.doc;
  // The sample message goes once per page, on the first load (a remount after Settings never sends it again).
  useEffect(() => {
    if (!loaded || sent.current) return;
    sent.current = true;
    void sendRef.current(SAMPLE_MESSAGE);
  }, [loaded, sent]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ConversationPane studio={studio} />
    </div>
  );
};

const SettingsView: React.FC = () => (
  <section aria-labelledby="lt-settings-title" className={cn('mx-auto mt-6 w-full max-w-3xl min-w-0 border border-[var(--ds-hairline-soft)] p-6', RADIUS_PANEL)}>
    <h2 id="lt-settings-title" className={cn('m-0 text-[length:var(--ds-text-base)]', HEADING)}>
      Settings
    </h2>
    <p className={cn('m-0 mt-2 text-[length:var(--ds-text-sm)]', MUTED)}>The comic is closed here. Its Director keeps working; go back to see where it got to.</p>
  </section>
);

const MOMENT_WORDS: Record<StudioMoment['phase'], string> = { replied: 'The Director replied', settled: 'The work settled' };

const momentLine = (m: StudioMoment): string => (m.phase === 'settled' ? `${MOMENT_WORDS.settled} (${m.outcome ?? 'done'})` : MOMENT_WORDS.replied);

const wantedStep = (): Step => {
  if (typeof window === 'undefined') return 'start';
  const v = new URLSearchParams(window.location.search).get('step');
  return v === 'away' || v === 'back' ? v : 'start';
};

function LiveTurnScene() {
  const [server] = useState(() => new ScriptedServer());
  const [view, setView] = useState<View>('comic');
  const [phase, setPhase] = useState<Phase>(server.phase);
  const [heard, setHeard] = useState<string[]>([]);
  const sentRef = useRef(false);
  const [step] = useState(wantedStep);

  useEffect(() => server.onChange(() => setPhase(server.phase)), [server]);
  useEffect(() => () => server.dispose(), [server]);
  useEffect(() => subscribeStudioMoments((m) => m.projectId === PROJECT_ID && setHeard((list) => [...list, momentLine(m)].slice(-4))), []);

  // ?step=away / ?step=back: play the earlier steps without clicks.
  useEffect(() => {
    if (step === 'start') return;
    if (phase === 'planning' && view === 'comic') {
      setView('settings');
      server.away();
    } else if (step === 'back' && phase === 'checking' && view === 'settings') {
      setView('comic');
    }
  }, [step, phase, view, server]);

  const go = (next: View) => {
    setView(next);
    if (next === 'settings') server.away();
  };
  const canFinish = phase === 'planning' || phase === 'checking';

  return (
    <main aria-labelledby="live-turn-title" className={cn('flex h-[100dvh] min-h-0 min-w-0 flex-col', CANVAS_BG, INK)}>
      <header className="mx-auto flex w-full min-w-0 max-w-3xl shrink-0 flex-col gap-3 px-4 pb-3 pt-4 sm:px-6">
        <div className="flex min-w-0 flex-col gap-1">
          <p className={cn('m-0', OVERLINE)}>Director chat</p>
          <h1 id="live-turn-title" className={cn('m-0 text-[length:var(--ds-text-lg)]', HEADING)}>
            Leave mid-turn and come back
          </h1>
          <p className={cn('m-0 text-[length:var(--ds-text-sm)]', MUTED)}>
            Open Settings while the Director is planning, then go back to the comic: the steps and the thinking line are still there, and the reply streams in.
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Segmented<View>
            label="Where you are"
            className="w-52 shrink-0"
            value={view}
            onChange={go}
            options={[
              { value: 'comic', label: 'Comic' },
              { value: 'settings', label: 'Settings' }
            ]}
          />
          <Button variant="outline" size="sm" disabled={!canFinish} onClick={() => server.finish()}>
            Let the Director finish
          </Button>
        </div>
        <p aria-live="polite" data-qa-live-moments="" className={cn('m-0 min-w-0 text-[length:var(--ds-text-xs)] [overflow-wrap:anywhere]', MUTED)}>
          {heard.length ? `What an alert would hear: ${heard.join(' · ')}` : 'What an alert would hear: nothing yet'}
        </p>
      </header>
      {view === 'comic' ? <StudioView server={server} sent={sentRef} /> : <SettingsView />}
    </main>
  );
}

const scene: QaAppScene = { id: 'live-turn', title: 'Director turn: leave mid-turn and come back', Scene: LiveTurnScene };
export default scene;
