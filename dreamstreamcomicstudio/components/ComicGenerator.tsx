import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertTriangle, Check, Clock, Loader2, RefreshCw, Square, Terminal } from 'lucide-react';
import { AgentOutputTarget, ComicPanel, ComicState } from '../types';
import { AgentStageShell } from './AgentStageShell';
import { outputTargetLabel } from '../services/comicAgentSettings';
import { cn } from '../lib/utils';
import { Button, Progress } from './ds';
import {
  CHIP,
  CHIP_VARIANT,
  HAIRLINE,
  INK,
  INVERSE_SURFACE,
  MAKING_SWEEP,
  MUTED,
  OVERLINE,
  RADIUS_CONTROL,
  RADIUS_PANEL,
  RADIUS_ROUND,
  SECTION_TITLE,
  SHADOW_SOFT,
  STATUS_CHIP_TONE,
  STATUS_DOT,
  STATUS_INK,
  STATUS_SURFACE,
  TEXT_2XL,
  TONE_CHIP_ON_ART,
  TRANSITION,
  WRAP_TEXT,
  type StatusState
} from './chat/studioDesign';

const CARD_SURFACE = 'bg-[var(--ds-surface)]';

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

const PHASE_STATUS: Record<PhaseState, StatusState> = {
  active: 'active',
  done: 'healthy',
  warning: 'attention',
  waiting: 'waiting'
};

// An opaque card on the page: the hairline, the soft shadow and the panel radius.
const SURFACE_CARD = cn(CARD_SURFACE, HAIRLINE, SHADOW_SOFT, RADIUS_PANEL);
// A panel thumbnail's frame: the art inside it stays content.
const TILE = cn('border border-[var(--ds-hairline)] bg-[var(--ds-well)]', RADIUS_CONTROL);
// The label over a thumbnail on hover: the inverse ink panel, never a gradient over the art.
const OVERLAY_LABEL = INVERSE_SURFACE;

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

  const progressTone = isFailed ? 'attention' : isDone ? 'healthy' : status?.isActive ? 'making' : undefined;

  const sidebar = (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className={OVERLINE}>Run Status</div>
        <div className={cn(SURFACE_CARD, 'p-4')}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className={cn(TEXT_2XL, 'font-semibold tabular-nums', INK)}>{percent}%</div>
              <div className={cn('mt-1 text-xs', MUTED, WRAP_TEXT)}>{description}</div>
            </div>
            {status?.isActive ? (
              <Loader2 className={cn('h-5 w-5 shrink-0 animate-spin', INK)} aria-hidden />
            ) : isDone ? (
              <Check className={cn('h-5 w-5 shrink-0', STATUS_INK.healthy)} aria-hidden />
            ) : (
              <Activity className={cn('h-5 w-5 shrink-0', MUTED)} aria-hidden />
            )}
          </div>
          <Progress
            className="mt-4"
            label="Build progress"
            value={Math.max(percent, status?.isActive ? 3 : 0)}
            valueText={`${percent}%`}
            tone={progressTone}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className={cn(SURFACE_CARD, 'p-3')}>
          <div className={cn(OVERLINE, 'flex items-center gap-1.5')}>
            <Clock className="h-3 w-3" aria-hidden /> Elapsed
          </div>
          <div className={cn('mt-1 text-sm font-semibold tabular-nums', INK)}>{formatDuration(elapsedSec)}</div>
        </div>
        <div className={cn(SURFACE_CARD, 'p-3')}>
          <div className={OVERLINE}>Left</div>
          <div className={cn('mt-1 text-sm font-semibold tabular-nums', INK, WRAP_TEXT)}>{remainingDisplay}</div>
        </div>
        <div className={cn(SURFACE_CARD, 'p-3')}>
          <div className={OVERLINE}>Panels</div>
          <div className={cn('mt-1 text-sm font-semibold tabular-nums', INK)}>{doneCount} / {total}</div>
        </div>
        <div className={cn(SURFACE_CARD, 'p-3')}>
          <div className={OVERLINE}>Retries</div>
          <div className={cn('mt-1 text-sm font-semibold tabular-nums', INK)}>{failedCount}</div>
        </div>
      </div>

      <div className="space-y-2">
        <div className={OVERLINE}>Outputs</div>
        <div className="flex flex-wrap gap-2">
          {outputTargets.map((target) => (
            <span key={target} className={cn(CHIP, CHIP_VARIANT.outline, INK)}>
              {outputTargetLabel(target)}
            </span>
          ))}
        </div>
      </div>

      {(failedCount > 0 || fallbackCount > 0 || billingHit || latestProblem) && (
        <div className={cn('border p-3 text-xs leading-5', RADIUS_CONTROL, STATUS_SURFACE.attention, INK)}>
          <div className="mb-1 flex items-center gap-2 font-semibold">
            <AlertTriangle className={cn('h-4 w-4 shrink-0', STATUS_INK.attention)} aria-hidden />
            {latestProblem ? summarizeFailure(latestProblem.message) : 'Build notice'}
          </div>
          {billingHit && <div>Limit reached; completed panels remain saved.</div>}
          {fallbackCount > 0 && <div>Backup model used on {fallbackCount} panel{fallbackCount === 1 ? '' : 's'}.</div>}
          {failedCount > 0 && <div>{failedCount} panel{failedCount === 1 ? '' : 's'} can be retried in review.</div>}
        </div>
      )}

      {!showStopConfirm ? (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => setShowStopConfirm(true)}
          disabled={!status?.isActive}
        >
          <Square className="h-4 w-4" aria-hidden /> Stop
        </Button>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              onCancel();
              setShowStopConfirm(false);
            }}
          >
            Confirm
          </Button>
          <Button type="button" variant="outline" onClick={() => setShowStopConfirm(false)}>
            Cancel
          </Button>
        </div>
      )}

      {isFailed && (
        <Button
          type="button"
          className="w-full"
          onClick={() => {
            hasAutoAdvanced.current = false;
            hasTriggeredStart.current = true;
            onStart();
          }}
        >
          <RefreshCw className="h-4 w-4" aria-hidden /> Retry
        </Button>
      )}
    </div>
  );

  const actions = (
    <div className="flex min-w-0 items-center gap-2">
      {status?.isActive && !isFailed && (
        <span className={cn(CHIP, CHIP_VARIANT.outline, 'hidden sm:inline-flex')}>
          {TIPS[tipIndex]}
        </span>
      )}
      {isDone && (
        <span className={cn(CHIP, STATUS_CHIP_TONE.healthy)}>
          <Check className="h-3.5 w-3.5" aria-hidden /> Ready
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
            const phaseStatus = PHASE_STATUS[stateForPhase];
            return (
              <div key={phase.id} className={cn('border p-4', RADIUS_PANEL, STATUS_SURFACE[phaseStatus], TRANSITION)}>
                <div className="flex items-center justify-between gap-2">
                  <div className={cn('text-sm font-semibold', INK)}>{phase.label}</div>
                  {stateForPhase === 'done' ? <Check className={cn('h-4 w-4 shrink-0', STATUS_INK.healthy)} aria-hidden />
                    : stateForPhase === 'active' ? <Loader2 className={cn('h-4 w-4 shrink-0 animate-spin', INK)} aria-hidden />
                    : stateForPhase === 'warning' ? <AlertTriangle className={cn('h-4 w-4 shrink-0', STATUS_INK.attention)} aria-hidden />
                    : <span aria-hidden className={cn('h-2 w-2 shrink-0', RADIUS_ROUND, STATUS_DOT.waiting)} />}
                </div>
                <Progress
                  className="mt-5"
                  size="sm"
                  label={phase.label}
                  value={stateForPhase === 'done' ? 100 : stateForPhase === 'active' ? Math.max(12, percent) : 0}
                  tone={stateForPhase === 'active' ? 'making' : phaseStatus}
                />
              </div>
            );
          })}
        </section>

        <section className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className={OVERLINE}>Panel Wall</div>
              <h3 className={cn('mt-1', SECTION_TITLE)}>{doneCount} of {total} rendered</h3>
            </div>
            <div className={cn('text-xs', MUTED, WRAP_TEXT)}>{description}</div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-5 xl:grid-cols-6">
            {Array.from({ length: total }).map((_, index) => {
              const panel = state.panels[index];
              if (panel?.imageUrl) {
                return (
                  <div key={panel.id || `done-${index}`} className={cn('group relative aspect-square overflow-hidden', TILE)}>
                    <img src={panel.imageUrl} alt={panel.description || `Panel ${index + 1}`} className="h-full w-full object-cover" />
                    <div className={cn('absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center border', RADIUS_ROUND, TONE_CHIP_ON_ART.success)}>
                      <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
                    </div>
                    <div className={cn('absolute inset-x-0 bottom-0 px-2 py-1 text-[10px] font-semibold opacity-0 transition-opacity motion-reduce:transition-none group-hover:opacity-100', OVERLAY_LABEL)}>
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
                    className={cn('flex aspect-square flex-col items-center justify-center border', RADIUS_CONTROL, STATUS_SURFACE.attention, INK)}
                  >
                    <AlertTriangle className={cn('h-4 w-4', STATUS_INK.attention)} aria-hidden />
                    <span className="mt-1 text-[10px] font-semibold">Panel {index + 1}</span>
                  </div>
                );
              }

              const isNext = status?.isActive && index === nextIndex;
              return (
                <div
                  key={panel?.id || `pending-${index}`}
                  className={cn(
                    'relative aspect-square overflow-hidden border bg-[var(--ds-well)]',
                    RADIUS_CONTROL,
                    isNext ? cn('border-[var(--ds-ink)]', MAKING_SWEEP) : 'border-[var(--ds-hairline)]'
                  )}
                >
                  {isNext && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Loader2 className={cn('h-5 w-5 animate-spin', INK)} aria-hidden />
                    </div>
                  )}
                  <span className={cn('absolute bottom-1.5 left-2 text-[10px] font-semibold', MUTED)}>Panel {index + 1}</span>
                </div>
              );
            })}
          </div>
        </section>

        <section className={SURFACE_CARD}>
          <div className="flex items-center justify-between gap-2 border-b border-[var(--ds-hairline)] px-4 py-3">
            <div className={cn('flex items-center gap-2 text-sm font-semibold', INK)}>
              <Terminal className="h-4 w-4" aria-hidden /> Agent stream
            </div>
            <div className={cn('text-xs tabular-nums', MUTED)}>{recentLogs.length} recent</div>
          </div>
          <div className="max-h-64 overflow-y-auto px-4 py-3 font-mono text-xs custom-scrollbar">
            {recentLogs.length === 0 ? (
              <div className={MUTED}>Waiting for first event...</div>
            ) : (
              recentLogs.map((log) => (
                <div key={`${log.timestamp}-${log.message}`} className={cn('border-b border-[var(--ds-hairline-soft)] py-2 last:border-0', MUTED, WRAP_TEXT)}>
                  <span className="mr-2 text-[var(--ds-faint)]">{new Date(log.timestamp).toLocaleTimeString()}</span>
                  {log.message}
                </div>
              ))
            )}
            {status?.isActive && <div className={cn('py-2', MUTED)}>_</div>}
          </div>
        </section>
      </div>
    </AgentStageShell>
  );
};
