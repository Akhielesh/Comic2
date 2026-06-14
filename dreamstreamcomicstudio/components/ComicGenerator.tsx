import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertTriangle, Check, Clock, Loader2, RefreshCw, Square, Terminal } from 'lucide-react';
import { AgentOutputTarget, ComicPanel, ComicState } from '../types';
import { AgentStageShell } from './AgentStageShell';
import { outputTargetLabel } from '../services/comicAgentSettings';

interface ComicGeneratorProps {
  state: ComicState;
  onStart: () => void;
  onCancel: () => void;
  onGenerationComplete: (panels: ComicPanel[]) => void;
}

const PHASES = [
  { id: 'setup', label: 'Set up run', match: /initial|style|reference|continuity/i },
  { id: 'plan', label: 'Plan pages', match: /plan|breakdown/i },
  { id: 'render', label: 'Render panels', match: /scene|panel|batch|render|generat/i },
  { id: 'finish', label: 'Finish outputs', match: /complete|finish|wrapping/i }
] as const;

const TIPS = [
  'Locking story, style, cast and page plan.',
  'Rendering panels against the continuity references.',
  'Saving completed images as soon as they land.',
  'Keeping the finished panels available if the run stops.'
];

const formatDuration = (totalSeconds: number): string => {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
};

const playCompletionSound = () => {
  try {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(987.77, audioContext.currentTime);
    gainNode.gain.setValueAtTime(0.18, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.45);

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.45);
  } catch {
    // Audio is optional; blocked autoplay or unavailable APIs should not affect builds.
  }
};

type PhaseState = 'waiting' | 'active' | 'done' | 'warning';

const phaseBadgeClass = (state: PhaseState) => {
  switch (state) {
    case 'active':
      return 'border-2 border-black bg-brand-blue text-white';
    case 'done':
      return 'border-2 border-black bg-green-100 text-green-700';
    case 'warning':
      return 'border-2 border-black bg-amber-100 text-amber-700';
    default:
      return 'border-2 border-black bg-white text-slate-600';
  }
};

const summarizeFailure = (message: string) => {
  if (/token limit|billing limit/i.test(message)) return 'Billing or token limit';
  if (/timeout/i.test(message)) return 'Timed out';
  if (/reference/i.test(message)) return 'Reference issue';
  if (/continuity/i.test(message)) return 'Continuity issue';
  return 'Needs attention';
};

export const ComicGenerator: React.FC<ComicGeneratorProps> = ({
  state,
  onStart,
  onCancel,
  onGenerationComplete
}) => {
  const hasTriggeredStart = useRef(false);
  const hasAutoAdvanced = useRef(false);
  const status = state.generationStatus;
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [tipIndex, setTipIndex] = useState(0);

  useEffect(() => {
    const hasRenderedImages = state.panels.some((panel) => panel.imageUrl);
    const failedOrStopped = /^(failed|stopped)/i.test(status?.currentStepDescription || '');
    if (!status?.isActive && !hasRenderedImages && !failedOrStopped && !hasTriggeredStart.current) {
      hasTriggeredStart.current = true;
      onStart();
    }
  }, [status, state.panels, onStart]);

  useEffect(() => {
    if (status?.isActive && !hasTriggeredStart.current) {
      hasTriggeredStart.current = true;
    }
  }, [status?.isActive]);

  useEffect(() => {
    if (!status?.isActive) return;
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const tips = window.setInterval(() => setTipIndex((index) => (index + 1) % TIPS.length), 3500);
    return () => {
      window.clearInterval(clock);
      window.clearInterval(tips);
    };
  }, [status?.isActive]);

  useEffect(() => {
    const isComplete = status && !status.isActive && (
      status.progress >= 99 ||
      (typeof status.completedPanels === 'number' &&
        typeof status.totalPanels === 'number' &&
        status.completedPanels >= status.totalPanels) ||
      status.currentStepDescription === 'Complete'
    );
    if (isComplete && hasTriggeredStart.current && !hasAutoAdvanced.current) {
      playCompletionSound();
      hasAutoAdvanced.current = true;
      onGenerationComplete(state.panels);
    }
  }, [status, state.panels, onGenerationComplete]);

  useEffect(() => {
    if (!status || status.isActive) return;
    if (!state.panels.some((panel) => panel.imageUrl)) return;
    if (hasAutoAdvanced.current) return;
    const timer = window.setTimeout(() => {
      if (!status.isActive && state.panels.some((panel) => panel.imageUrl) && !hasAutoAdvanced.current) {
        hasAutoAdvanced.current = true;
        onGenerationComplete(state.panels);
      }
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [status?.isActive, state.panels, onGenerationComplete]);

  const description = status?.currentStepDescription || 'Starting build';
  const isFailed = /^(failed|stopped)/i.test(description);
  const isDone = !!status && !status.isActive && (status.progress >= 99 || description === 'Complete');
  const percent = Math.round(Math.min(Math.max(status?.progress || 0, 0), 100));
  const elapsedSec = status ? Math.max(0, (now - status.startTime) / 1000) : 0;
  const total = Math.max(status?.totalPanels || 0, state.panels.length, 1);
  const doneCount = state.panels.filter((panel) => panel.imageUrl).length;
  const failedCount = state.panels.filter((panel) => !panel.imageUrl && panel.failureReason).length;
  const processedCount = doneCount + failedCount;
  const nextIndex = processedCount;
  const streamLogs = status?.logs?.length
    ? status.logs
    : (state.agentRun?.events || []).map((event) => ({
        timestamp: event.timestamp,
        message: event.message
      }));
  const fallbackCount = streamLogs.filter((log) => /fallback/i.test(log.message)).length || 0;
  const billingHit = streamLogs.some((log) => /token limit|billing limit/i.test(log.message)) || false;
  const currentPhaseIndex = useMemo(() => {
    if (isDone) return PHASES.length - 1;
    const matchedIndex = PHASES.findIndex((phase) => phase.match.test(description));
    if (matchedIndex >= 0) return matchedIndex;
    if (doneCount > 0 || percent > 0) return 2;
    return 0;
  }, [description, doneCount, isDone, percent]);

  const remainingDisplay = !status?.isActive
    ? (isDone ? 'Done' : '-')
    : (!status.estimatedTimeRemaining || /calculating/i.test(status.estimatedTimeRemaining) || percent === 0
        ? 'Estimating'
        : status.estimatedTimeRemaining);

  const headline = isDone
    ? 'Pages ready'
    : isFailed
      ? description
      : status?.isActive
        ? 'Build agent running'
        : 'Build agent preparing';

  const outputTargets: AgentOutputTarget[] = state.agentSettings?.outputTargets?.length
    ? state.agentSettings.outputTargets
    : ['comic', 'book', 'html'];

  const recentLogs = [...streamLogs].slice(-9).reverse();
  const latestProblem = recentLogs.find((log) => /failed|error|timeout|limit|reference|continuity/i.test(log.message));

  const sidebar = (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="text-xs font-display uppercase text-slate-600">Run Status</div>
        <div className="rounded-xl border-2 border-black bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-2xl font-display text-black">{percent}%</div>
              <div className="mt-1 text-xs text-slate-600 font-comic">{description}</div>
            </div>
            {status?.isActive ? (
              <Loader2 className="h-5 w-5 animate-spin text-black" />
            ) : isDone ? (
              <Check className="h-5 w-5 text-green-600" />
            ) : (
              <Activity className="h-5 w-5 text-slate-600" />
            )}
          </div>
          <div className="mt-4 h-2 overflow-hidden rounded-full border-2 border-black bg-white">
            <div
              className={`h-full transition-all duration-700 ${isFailed ? 'bg-amber-400' : 'bg-brand-blue'}`}
              style={{ width: `${Math.max(percent, status?.isActive ? 3 : 0)}%` }}
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl border-2 border-black bg-white p-3">
          <div className="flex items-center gap-1.5 text-[11px] uppercase text-slate-600 font-bold">
            <Clock className="h-3 w-3" /> Elapsed
          </div>
          <div className="mt-1 text-sm font-bold text-black">{formatDuration(elapsedSec)}</div>
        </div>
        <div className="rounded-xl border-2 border-black bg-white p-3">
          <div className="text-[11px] uppercase text-slate-600 font-bold">Left</div>
          <div className="mt-1 text-sm font-bold text-black">{remainingDisplay}</div>
        </div>
        <div className="rounded-xl border-2 border-black bg-white p-3">
          <div className="text-[11px] uppercase text-slate-600 font-bold">Panels</div>
          <div className="mt-1 text-sm font-bold text-black">{doneCount} / {total}</div>
        </div>
        <div className="rounded-xl border-2 border-black bg-white p-3">
          <div className="text-[11px] uppercase text-slate-600 font-bold">Retries</div>
          <div className="mt-1 text-sm font-bold text-black">{failedCount}</div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-display uppercase text-slate-600">Outputs</div>
        <div className="flex flex-wrap gap-2">
          {outputTargets.map((target) => (
            <span key={target} className="rounded-full border-2 border-black px-2.5 py-1 text-xs font-bold text-black">
              {outputTargetLabel(target)}
            </span>
          ))}
        </div>
      </div>

      {(failedCount > 0 || fallbackCount > 0 || billingHit || latestProblem) && (
        <div className="rounded-xl border-2 border-black bg-amber-100 p-3 text-xs leading-5 text-amber-800 font-comic">
          <div className="mb-1 flex items-center gap-2 font-bold">
            <AlertTriangle className="h-4 w-4" />
            {latestProblem ? summarizeFailure(latestProblem.message) : 'Build notice'}
          </div>
          {billingHit && <div>Limit reached; completed panels remain saved.</div>}
          {fallbackCount > 0 && <div>Backup model used on {fallbackCount} panel{fallbackCount === 1 ? '' : 's'}.</div>}
          {failedCount > 0 && <div>{failedCount} panel{failedCount === 1 ? '' : 's'} can be retried in review.</div>}
        </div>
      )}

      {!showStopConfirm ? (
        <button
          type="button"
          onClick={() => setShowStopConfirm(true)}
          disabled={!status?.isActive}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl border-2 border-black bg-white px-4 py-2.5 text-sm font-bold text-black transition-colors hover:bg-brand-yellow disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Square className="h-4 w-4" /> Stop
        </button>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => {
              onCancel();
              setShowStopConfirm(false);
            }}
            className="rounded-xl border-2 border-black bg-red-100 px-3 py-2 text-sm font-bold text-red-700"
          >
            Confirm
          </button>
          <button
            type="button"
            onClick={() => setShowStopConfirm(false)}
            className="rounded-xl border-2 border-black bg-white px-3 py-2 text-sm font-bold text-black"
          >
            Cancel
          </button>
        </div>
      )}

      {isFailed && (
        <button
          type="button"
          onClick={() => {
            hasAutoAdvanced.current = false;
            hasTriggeredStart.current = true;
            onStart();
          }}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl border-2 border-black bg-brand-yellow px-4 py-2.5 text-sm font-bold text-black transition-colors hover:bg-brand-yellow/80"
        >
          <RefreshCw className="h-4 w-4" /> Retry
        </button>
      )}
    </div>
  );

  const actions = (
    <div className="flex items-center gap-2">
      {status?.isActive && !isFailed && (
        <span className="hidden rounded-full border-2 border-black px-3 py-1 text-xs font-bold text-slate-600 sm:inline-flex">
          {TIPS[tipIndex]}
        </span>
      )}
      {isDone && (
        <span className="inline-flex items-center gap-1.5 rounded-full border-2 border-black bg-green-100 px-3 py-1 text-xs font-bold text-green-700">
          <Check className="h-3.5 w-3.5" /> Ready
        </span>
      )}
    </div>
  );

  return (
    <AgentStageShell
      eyebrow="Build agent"
      title={headline}
      description="The agent is planning pages, rendering panels, and preparing the requested outputs from the locked story context."
      icon={<Activity className="h-5 w-5" />}
      actions={actions}
      sidebar={sidebar}
      minHeightClassName="min-h-[700px]"
    >
      <div className="space-y-6 p-5">
        <section className="grid gap-3 md:grid-cols-4">
          {PHASES.map((phase, index) => {
            const stateForPhase: PhaseState = isFailed && index === currentPhaseIndex
              ? 'warning'
              : index < currentPhaseIndex || isDone
                ? 'done'
                : index === currentPhaseIndex && status?.isActive
                  ? 'active'
                  : 'waiting';
            return (
              <div key={phase.id} className={`rounded-lg border p-4 transition-colors ${phaseBadgeClass(stateForPhase)}`}>
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold">{phase.label}</div>
                  {stateForPhase === 'done' ? <Check className="h-4 w-4" />
                    : stateForPhase === 'active' ? <Loader2 className="h-4 w-4 animate-spin" />
                    : stateForPhase === 'warning' ? <AlertTriangle className="h-4 w-4" />
                    : <span className="h-2 w-2 rounded-full bg-current opacity-40" />}
                </div>
                <div className="mt-5 h-1 rounded-full bg-current/20">
                  <div
                    className="h-full rounded-full bg-current transition-all duration-500"
                    style={{
                      width: stateForPhase === 'done'
                        ? '100%'
                        : stateForPhase === 'active'
                          ? `${Math.max(12, percent)}%`
                          : '0%'
                    }}
                  />
                </div>
              </div>
            );
          })}
        </section>

        <section className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="text-xs font-display uppercase text-slate-600">Panel Wall</div>
              <h3 className="mt-1 text-lg font-display text-black">{doneCount} of {total} rendered</h3>
            </div>
            <div className="text-xs text-slate-600 font-comic">{description}</div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-5 xl:grid-cols-6">
            {Array.from({ length: total }).map((_, index) => {
              const panel = state.panels[index];
              if (panel?.imageUrl) {
                return (
                  <div key={panel.id || `done-${index}`} className="group relative aspect-square overflow-hidden rounded-md border-2 border-black bg-white">
                    <img src={panel.imageUrl} alt={panel.description || `Panel ${index + 1}`} className="h-full w-full object-cover" />
                    <div className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-black bg-green-400 text-black">
                      <Check className="h-3 w-3" strokeWidth={3} />
                    </div>
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2 pb-1.5 pt-6 text-[10px] font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100">
                      Panel {index + 1}
                    </div>
                  </div>
                );
              }

              if (panel?.failureReason) {
                return (
                  <div
                    key={panel.id || `failed-${index}`}
                    title={panel.failureReason}
                    className="flex aspect-square flex-col items-center justify-center rounded-md border-2 border-black bg-amber-100 text-amber-700"
                  >
                    <AlertTriangle className="h-4 w-4" />
                    <span className="mt-1 text-[10px] font-bold">Panel {index + 1}</span>
                  </div>
                );
              }

              const isNext = status?.isActive && index === nextIndex;
              return (
                <div
                  key={panel?.id || `pending-${index}`}
                  className={`relative aspect-square overflow-hidden rounded-md border-2 ${isNext ? 'border-brand-blue' : 'border-black'} bg-slate-50`}
                >
                  <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(0,0,0,.04),rgba(0,0,0,.01))]" />
                  {isNext && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Loader2 className="h-5 w-5 animate-spin text-black" />
                    </div>
                  )}
                  <span className="absolute bottom-1.5 left-2 text-[10px] font-bold text-slate-400">Panel {index + 1}</span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="rounded-xl border-2 border-black bg-white">
          <div className="flex items-center justify-between border-b-2 border-black px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-display uppercase text-black">
              <Terminal className="h-4 w-4" /> Agent stream
            </div>
            <div className="text-xs text-slate-600 font-comic">{recentLogs.length} recent</div>
          </div>
          <div className="max-h-64 overflow-y-auto px-4 py-3 font-mono text-xs custom-scrollbar">
            {recentLogs.length === 0 ? (
              <div className="text-slate-400">Waiting for first event...</div>
            ) : (
              recentLogs.map((log) => (
                <div key={`${log.timestamp}-${log.message}`} className="border-b border-slate-200 py-2 text-slate-600 last:border-0">
                  <span className="mr-2 text-slate-400">{new Date(log.timestamp).toLocaleTimeString()}</span>
                  {log.message}
                </div>
              ))
            )}
            {status?.isActive && <div className="py-2 text-slate-400">_</div>}
          </div>
        </section>
      </div>
    </AgentStageShell>
  );
};
