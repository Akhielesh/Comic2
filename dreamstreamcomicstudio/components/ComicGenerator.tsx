import React, { useEffect, useRef, useState } from 'react';
import { ComicState, ComicPanel } from '../types';
import { Zap, Check, AlertTriangle, Loader2, Clock } from 'lucide-react';

interface ComicGeneratorProps {
  state: ComicState;
  onStart: () => void;
  onCancel: () => void;
  onGenerationComplete: (panels: ComicPanel[]) => void;
}

// High-level phases the user moves through during a build. We derive the active one
// from the generation status so the stepper tracks real progress instead of guessing.
const PHASES = ['Initializing', 'Planning', 'Rendering', 'Finishing'] as const;

// Rotating reassurance lines so a long single-panel render never looks frozen.
const TIPS = [
  'Rendering each panel with your locked style…',
  'Keeping characters and props consistent across frames…',
  'High-fidelity panels take a few seconds each — hang tight.',
  'Finished pages appear in the grid as they complete.',
  'You can stop anytime — completed panels are always saved.',
];

const formatDuration = (totalSeconds: number): string => {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
};

const playCompletionSound = () => {
    try {
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);

        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(987.77, audioContext.currentTime); // B5 note
        gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.5);

        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 0.5);
    } catch (e) {
        console.error("Could not play sound", e);
    }
};

export const ComicGenerator: React.FC<ComicGeneratorProps> = ({ state, onStart, onCancel, onGenerationComplete }) => {
  const hasTriggeredStart = useRef(false);
  const hasAutoAdvanced = useRef(false);
  const status = state.generationStatus;
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [stopInput, setStopInput] = useState('');
  // A live clock so the elapsed timer keeps ticking between server status updates —
  // the server only refreshes the ETA once per batch, which made the screen look stuck.
  const [now, setNow] = useState(() => Date.now());
  const [tipIndex, setTipIndex] = useState(0);

  useEffect(() => {
    // If not active and not finished, start it
    if (!status?.isActive && state.panels.length === 0 && !hasTriggeredStart.current) {
        hasTriggeredStart.current = true;
        onStart();
    }
  }, [status, state.panels, onStart]);

  useEffect(() => {
    if (status?.isActive && !hasTriggeredStart.current) {
      hasTriggeredStart.current = true;
    }
  }, [status?.isActive]);

  // Tick the live clock + rotate tips while a build is running.
  useEffect(() => {
    if (!status?.isActive) return;
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const tips = setInterval(() => setTipIndex((i) => (i + 1) % TIPS.length), 3500);
    return () => { clearInterval(clock); clearInterval(tips); };
  }, [status?.isActive]);

  useEffect(() => {
    // Watch for completion
    const isComplete = status && !status.isActive && (
      status.progress >= 99 ||
      (typeof status.completedPanels === 'number' && typeof status.totalPanels === 'number' && status.completedPanels >= status.totalPanels) ||
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
    if (state.panels.length === 0) return;
    if (hasAutoAdvanced.current) return;
    const timer = setTimeout(() => {
      if (!status.isActive && state.panels.length > 0 && !hasAutoAdvanced.current) {
        hasAutoAdvanced.current = true;
        onGenerationComplete(state.panels);
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, [status?.isActive, state.panels, onGenerationComplete]);

  if (!status) return <div className="text-center py-20 font-display text-xl">Initializing Build Protocol...</div>;

  const handleStopKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && stopInput.trim().toLowerCase() === 'stop') {
      onCancel();
      setShowStopConfirm(false);
      setStopInput('');
    }
  };

  // ---- Derived, "realistic" progress state ---------------------------------
  const description = status.currentStepDescription || '';
  const descLower = description.toLowerCase();
  const isFailed = /^failed|^stopped/i.test(description);
  const isDone = !status.isActive && (status.progress >= 99 || description === 'Complete');

  const percent = Math.round(Math.min(Math.max(status.progress, 0), 100));
  const elapsedSec = Math.max(0, (now - status.startTime) / 1000);

  // Total expected panels: the server estimate, but never fewer than what we've already
  // processed (so the grid never shrinks below reality).
  const total = Math.max(status.totalPanels || 0, state.panels.length, 1);
  const doneCount = state.panels.filter((p) => p.imageUrl).length;
  const failedCount = state.panels.filter((p) => !p.imageUrl && p.failureReason).length;
  const processedCount = doneCount + failedCount;
  const nextIndex = processedCount; // slot currently being rendered

  // Macro phase: planning → rendering → finishing, inferred from the live status.
  const phase = (() => {
    if (isDone) return 3;
    if (descLower.includes('plan') || descLower.includes('breakdown')) return 1;
    if (descLower.includes('scene') || descLower.includes('panel') || descLower.includes('batch') || doneCount > 0) return 2;
    if (status.progress >= 99) return 3;
    if (status.progress > 0) return 2;
    return 0;
  })();

  // Surface fallback / failure / billing signals pulled from the live log stream.
  const fallbackCount = status.logs.filter((l) => /fallback/i.test(l.message)).length;
  const billingHit = status.logs.some((l) => /token limit|billing limit/i.test(l.message));

  const remainingDisplay = !status.isActive
    ? (isDone ? 'Done' : '—')
    : (!status.estimatedTimeRemaining || /calculating/i.test(status.estimatedTimeRemaining) || percent === 0
        ? 'Estimating…'
        : status.estimatedTimeRemaining);

  const headline = isDone ? 'Pages Ready!' : isFailed ? description : status.isActive ? 'Making Magic…' : 'Wrapping Up…';

  return (
    <div className="max-w-3xl mx-auto py-16 text-center space-y-8 animate-fade-in">
        <div className="space-y-5 relative">
            {!isFailed && (
              <div className="absolute -top-10 left-1/2 -translate-x-1/2 text-6xl font-display text-brand-yellow animate-bounce drop-shadow-lg" style={{ textShadow: '4px 4px 0 #000' }}>
                  {isDone ? 'TADA!' : 'POW!'}
              </div>
            )}
            <div className="w-28 h-28 mx-auto bg-white rounded-full flex items-center justify-center border-4 border-black shadow-comic relative overflow-hidden">
                <div className="absolute inset-0 bg-brand-blue/10 animate-pulse"></div>
                {isDone
                  ? <Check className="w-14 h-14 text-brand-blue relative z-10" strokeWidth={3} />
                  : <Zap className="w-14 h-14 text-brand-yellow fill-brand-yellow animate-pulse relative z-10" />}
            </div>
            <h2 className="text-5xl font-display text-white drop-shadow-[4px_4px_0_#000]">{headline}</h2>

            {/* Live stat pills — elapsed clock keeps ticking so it never looks frozen */}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-white font-comic text-sm font-bold bg-black/25 px-3 py-1 rounded-full backdrop-blur-sm">
                <Clock className="w-3.5 h-3.5" /> Elapsed {formatDuration(elapsedSec)}
              </span>
              <span className="text-white font-comic text-sm font-bold bg-black/25 px-3 py-1 rounded-full backdrop-blur-sm">
                Est. left: {remainingDisplay}
              </span>
              <span className="text-white font-comic text-sm font-bold bg-black/25 px-3 py-1 rounded-full backdrop-blur-sm">
                Panels {doneCount} / {total}
              </span>
            </div>
        </div>

        {/* Macro phase stepper */}
        <div className="flex items-center justify-center gap-1 flex-wrap">
          {PHASES.map((label, idx) => {
            const stepDone = idx < phase;
            const stepActive = idx === phase && status.isActive && !isFailed;
            return (
              <React.Fragment key={label}>
                <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border-2 text-xs font-bold transition-all duration-300 ${
                  stepActive ? 'bg-brand-yellow border-black text-black scale-105 shadow-comic'
                  : stepDone ? 'bg-brand-blue border-black text-white'
                  : 'bg-white/70 border-black/30 text-black/40'
                }`}>
                  {stepDone ? <Check className="w-3 h-3" strokeWidth={3} />
                    : stepActive ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <span className="w-3 h-3 rounded-full border-2 border-current inline-block" />}
                  {label}
                </div>
                {idx < PHASES.length - 1 && <div className={`h-0.5 w-2 sm:w-4 ${idx < phase ? 'bg-black' : 'bg-black/20'}`} />}
              </React.Fragment>
            );
          })}
        </div>

        {/* Progress bar with live percentage */}
        <div className="space-y-1.5">
          <div className="flex justify-between items-center px-1 text-white font-mono text-xs font-bold drop-shadow-[2px_2px_0_#000]">
            <span className="truncate max-w-[70%] text-left">{description || 'Working…'}</span>
            <span>{percent}%</span>
          </div>
          <div className="bg-white h-7 w-full rounded-full border-4 border-black shadow-comic overflow-hidden relative">
              <div
                  className={`h-full ${isFailed ? 'bg-brand-red' : 'bg-brand-yellow'} border-r-4 border-black transition-all duration-700 ease-out relative`}
                  style={{ width: `${Math.max(percent, status.isActive ? 4 : 0)}%` }}
              >
                  <div className={`absolute inset-0 opacity-20 bg-[linear-gradient(45deg,#000_25%,transparent_25%,transparent_50%,#000_50%,#000_75%,transparent_75%,transparent)] bg-[length:20px_20px] ${status.isActive ? 'animate-barberpole' : ''}`}></div>
              </div>
          </div>
          {status.isActive && !isFailed && (
            <p className="text-white/90 font-comic text-sm italic min-h-[1.25rem] transition-opacity">{TIPS[tipIndex]}</p>
          )}
        </div>

        {/* Fallback / failure / billing notice, pulled from the live log stream */}
        {(failedCount > 0 || fallbackCount > 0 || billingHit) && (
          <div className="rounded-xl border-2 border-amber-400 bg-amber-50 px-4 py-2.5 text-left text-xs font-bold text-amber-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              {billingHit && 'Token limit reached — completed panels are saved. '}
              {fallbackCount > 0 && `Used a backup image model on ${fallbackCount} panel${fallbackCount === 1 ? '' : 's'}. `}
              {failedCount > 0 && `${failedCount} panel${failedCount === 1 ? '' : 's'} couldn't render — you can retry ${failedCount === 1 ? 'it' : 'them'} from the Done step.`}
            </span>
          </div>
        )}

        {/* Live panel grid — the page filling in, slot by slot */}
        <div className="bg-white rounded-xl border-4 border-black shadow-comic p-4 space-y-3">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="text-left">
              <div className="font-display text-lg">Live Panels</div>
              <div className="text-xs font-comic text-slate-500">
                {doneCount} of {total} rendered{failedCount > 0 ? ` · ${failedCount} to retry` : ''}
              </div>
            </div>
            {!showStopConfirm ? (
              <button
                onClick={() => setShowStopConfirm(true)}
                disabled={!status.isActive}
                className="bg-brand-red text-white border-2 border-black px-4 py-2 rounded-lg font-bold uppercase text-xs disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Stop Generation
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  value={stopInput}
                  onChange={(e) => setStopInput(e.target.value)}
                  onKeyDown={handleStopKey}
                  placeholder={'Type "stop" + Enter'}
                  className="border-2 border-black rounded px-3 py-2 text-xs font-mono"
                />
                <button
                  onClick={() => { setShowStopConfirm(false); setStopInput(''); }}
                  className="border-2 border-black px-3 py-2 rounded text-xs font-bold bg-white"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2 max-h-60 overflow-y-auto custom-scrollbar">
            {Array.from({ length: total }).map((_, i) => {
              const panel = state.panels[i];
              if (panel?.imageUrl) {
                return (
                  <div key={panel.id || `done-${i}`} className="relative border-2 border-black rounded overflow-hidden aspect-square bg-black animate-fade-in">
                    <img src={panel.imageUrl} alt={panel.description || `Panel ${i + 1}`} className="w-full h-full object-cover" />
                    <div className="absolute top-0.5 right-0.5 w-4 h-4 bg-brand-yellow border border-black rounded-full flex items-center justify-center">
                      <Check className="w-2.5 h-2.5" strokeWidth={3} />
                    </div>
                  </div>
                );
              }
              if (panel?.failureReason) {
                return (
                  <div
                    key={panel.id || `failed-${i}`}
                    title={panel.failureReason}
                    className="relative border-2 border-red-400 bg-red-50 rounded aspect-square flex flex-col items-center justify-center text-red-500"
                  >
                    <AlertTriangle className="w-4 h-4" />
                    <span className="text-[8px] font-bold mt-0.5 uppercase">Retry</span>
                  </div>
                );
              }
              const isNext = status.isActive && i === nextIndex;
              return (
                <div
                  key={panel?.id || `pending-${i}`}
                  className={`relative rounded aspect-square overflow-hidden border-2 ${isNext ? 'border-brand-blue' : 'border-slate-300'}`}
                >
                  <div className="absolute inset-0 bg-gradient-to-br from-slate-200 via-slate-100 to-slate-300 animate-pulse" />
                  {isNext && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Loader2 className="w-4 h-4 text-brand-blue animate-spin" />
                    </div>
                  )}
                  <span className="absolute bottom-0.5 left-1 text-[8px] font-mono text-slate-400">#{i + 1}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Raw log console */}
        <div className="h-56 overflow-y-auto bg-black rounded-xl border-4 border-white p-6 text-left font-mono text-sm text-brand-yellow shadow-comic custom-scrollbar">
            <div className="mb-2 border-b border-white/20 pb-1 flex items-start text-white opacity-50">
                <span>Current Step: {description || '—'}</span>
            </div>
            {[...status.logs].reverse().map((log) => (
                <div key={`${log.timestamp}-${log.message}`} className="mb-2 border-b border-white/20 pb-1 flex items-start">
                    <span className="mr-2 text-brand-red">{'>'}</span> {log.message}
                </div>
            ))}
            {status.isActive && <div className="animate-pulse text-white">{'>'} _</div>}
        </div>
    </div>
  );
};
