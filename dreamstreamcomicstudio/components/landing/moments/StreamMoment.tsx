/**
 * Stream Studio's moment, on the dark stage (the frame is an inverse surface in both themes, like Stream
 * Studio's own video room). Each loop shows one of its three uses:
 *   live     a LIVE badge (the one hue: status, with the word), the viewer count climbing, chat rising in,
 *            and the Stream mark broadcasting its on-air arcs;
 *   monitor  a quiet nursery: asleep for a while, the live sound level, the night's log;
 *   call     a family call ringing, then connected.
 * Under reduced motion it is the live event, finished and still.
 */
import React, { useEffect, useState } from 'react';
import { Eye, Mic, Moon, Video } from 'lucide-react';
import { StudioMark } from '../../brand/StudioMark';
import { useMomentClock, type MomentStep } from './useMomentClock';

const STEPS: readonly MomentStep[] = [
  { id: 'enter', ms: 1500 },
  { id: 'hold', ms: 3200 },
  { id: 'clear', ms: 450 }
];

const SCENES = ['live', 'monitor', 'call'] as const;
type Scene = (typeof SCENES)[number];
const TAB_LABEL: Record<Scene, string> = { live: 'Live event', monitor: 'Baby monitor', call: 'Calls' };

const VIEWERS = 128;

/** A count that climbs to `target` while `run` is true (and simply shows it otherwise). */
function useClimb(target: number, run: boolean, key: number): number {
  const [n, setN] = useState(target);
  useEffect(() => {
    if (!run || typeof window.requestAnimationFrame !== 'function') {
      setN(target);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const from = Math.round(target * 0.6);
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 1100);
      setN(Math.round(from + (target - from) * (1 - Math.pow(1 - t, 3))));
      if (t < 1) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [target, run, key]);
  return n;
}

const ROW = 'flex min-w-0 max-w-full items-baseline gap-1.5 rounded-[var(--ds-radius-control)] bg-ds-canvas/10 px-2.5 py-1.5 text-[11.5px] leading-4';

export function StreamMoment() {
  const clock = useMomentClock(STEPS, 'hold');
  const { animated, cycle, step } = clock;
  const scene: Scene = animated ? SCENES[cycle % SCENES.length] : 'live';
  const entering = animated && step === 'enter';
  const viewers = useClimb(VIEWERS, entering && scene === 'live', cycle);
  const stagger = animated ? 'ds-stagger' : '';

  return (
    <div ref={clock.ref} data-inview={clock.inview} className="flex h-full flex-col gap-2.5 p-3">
      <div className="flex shrink-0 items-center gap-1" role="presentation">
        {SCENES.map((s) => (
          <span
            key={s}
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors duration-[var(--ds-motion-slow)] ease-[var(--ds-ease)] ${
              s === scene ? 'bg-ds-canvas/15 text-ds-canvas' : 'text-ds-canvas/60'
            }`}
          >
            {TAB_LABEL[s]}
          </span>
        ))}
      </div>

      <div
        key={`${scene}-${cycle}`}
        className={`relative min-h-0 flex-1 overflow-hidden rounded-[var(--ds-radius-panel)] border border-ds-canvas/10 bg-ds-canvas/[0.05] transition-opacity duration-[var(--ds-motion-panel)] ease-[var(--ds-ease)] ${
          step === 'clear' ? 'opacity-0' : ''
        } ${animated ? 'ds-fade-in' : ''}`}
      >
        {scene === 'live' ? (
          <>
            <div className="absolute inset-x-3 top-3 flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 rounded-[var(--ds-radius-sm)] bg-ds-danger px-2 py-0.5 text-[11px] font-semibold tracking-wide text-ds-on-danger">
                <span className="ds-live-dot size-1.5" />
                LIVE
              </span>
              <span className="inline-flex items-center gap-1 text-[11.5px] tabular-nums text-ds-canvas/80">
                <Eye className="size-3.5" aria-hidden="true" />
                {viewers} watching
              </span>
            </div>
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pb-10 text-ds-canvas">
              <StudioMark studio="stream" loading={animated} size={52} />
              <span className="text-[12px] font-medium text-ds-canvas/80">Workshop: lettering basics</span>
            </div>
            <ul className={`absolute inset-x-3 bottom-3 flex flex-col items-start gap-1.5 ${stagger}`}>
              <li className={ROW}>
                <span className="font-semibold text-ds-canvas">Maya</span>
                <span className="truncate text-ds-canvas/80">Hi from Lisbon!</span>
              </li>
              <li className={ROW}>
                <span className="font-semibold text-ds-canvas">Sam</span>
                <span className="truncate text-ds-canvas/80">Can we see the brush up close?</span>
              </li>
            </ul>
          </>
        ) : null}

        {scene === 'monitor' ? (
          <div className="absolute inset-0 flex flex-col gap-3 p-3">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-ds-canvas">
                <span className="size-1.5 rounded-full bg-ds-success" />
                Nursery · Quiet
              </span>
              <span className="text-[11px] text-ds-canvas/70">Never recorded</span>
            </div>
            <div className={`flex flex-1 items-center gap-4 ${stagger}`}>
              <div className="flex flex-col gap-1 text-ds-canvas">
                <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ds-canvas/70">
                  <Moon className="size-3.5" aria-hidden="true" />
                  Asleep
                </span>
                <span className="ds-display text-[26px] font-semibold leading-none tabular-nums">1 h 42 m</span>
              </div>
              <div className="ml-auto flex flex-col items-end gap-1">
                <span className="ds-home-meter flex h-8 items-end gap-1">
                  <span className="h-3 w-1.5 rounded-full bg-ds-canvas/70" />
                  <span className="h-5 w-1.5 rounded-full bg-ds-canvas/70" />
                  <span className="h-8 w-1.5 rounded-full bg-ds-canvas/70" />
                  <span className="h-4 w-1.5 rounded-full bg-ds-canvas/70" />
                  <span className="h-6 w-1.5 rounded-full bg-ds-canvas/70" />
                </span>
                <span className="text-[11px] tabular-nums text-ds-canvas/70">31 dB(A)</span>
              </div>
            </div>
            <ul className={`flex flex-col gap-1.5 ${stagger}`}>
              <li className={ROW}>
                <span className="tabular-nums text-ds-canvas/70">9:12 pm</span>
                <span className="truncate text-ds-canvas">Fell asleep</span>
              </li>
              <li className={ROW}>
                <span className="tabular-nums text-ds-canvas/70">11:40 pm</span>
                <span className="truncate text-ds-canvas">Stirred, settled on her own</span>
              </li>
            </ul>
          </div>
        ) : null}

        {scene === 'call' ? (
          <div className="absolute inset-0 flex flex-col p-3">
            <div className="flex items-center justify-between text-[11.5px]">
              {clock.reached('hold') ? (
                <span key="connected" className="ds-blur-in font-medium text-ds-canvas">
                  Connected · <span className="tabular-nums">0:12</span>
                </span>
              ) : (
                <span className="ds-shimmer-text font-medium [--ds-shimmer-base:color-mix(in_srgb,var(--ds-canvas)_60%,transparent)] [--ds-shimmer-glint:var(--ds-canvas)]">
                  Calling Grandma…
                </span>
              )}
              <span className="inline-flex items-center gap-2 text-ds-canvas/70">
                <Mic className="size-3.5" aria-hidden="true" />
                <Video className="size-3.5" aria-hidden="true" />
              </span>
            </div>
            <div className="relative mt-2.5 flex-1 overflow-hidden rounded-[var(--ds-radius-control)] bg-ds-canvas/[0.08]">
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                <span className={`flex size-14 items-center justify-center rounded-full bg-ds-canvas/15 text-lg font-semibold text-ds-canvas ${animated ? 'ds-scale-in' : ''}`}>
                  G
                </span>
                <span className="text-[12px] font-medium text-ds-canvas">Grandma</span>
              </div>
              <span className="absolute bottom-2 right-2 flex h-14 w-11 items-end justify-center rounded-[var(--ds-radius-sm)] bg-ds-canvas/20 pb-1 text-[10px] text-ds-canvas/90">
                You
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
