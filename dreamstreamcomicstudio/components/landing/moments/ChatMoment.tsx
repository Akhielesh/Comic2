/**
 * Chat Studio's moment: a question types into the composer and is sent, "Thinking" plays as shimmer text,
 * the answer sharpens in (`.ds-blur-in`) and a greyscale forecast card scales in after it (`.ds-scale-in`;
 * bars on the --ds-chart-* ramp, hue never decorates). No model is named: the picture is the workflow.
 */
import React from 'react';
import { ArrowUp, CloudSun } from 'lucide-react';
import { useMomentClock, type MomentStep } from './useMomentClock';

const PROMPT = 'Plan three days in Kyoto next week';

const STEPS: readonly MomentStep[] = [
  { id: 'type', ms: 350, type: PROMPT },
  { id: 'send', ms: 250 },
  { id: 'think', ms: 1100 },
  { id: 'answer', ms: 650 },
  { id: 'card', ms: 300 },
  { id: 'hold', ms: 3200 },
  { id: 'clear', ms: 450 }
];

/** A three-day forecast drawn as temperature ranges on a 5–25 °C track (the --ds-chart ramp: ink on a pale track). */
const DAYS = [
  { day: 'Mon', high: 19, low: 10 },
  { day: 'Tue', high: 17, low: 9 },
  { day: 'Wed', high: 21, low: 11 }
];
const SCALE = { min: 5, max: 25 };
const pct = (t: number) => `${((t - SCALE.min) / (SCALE.max - SCALE.min)) * 100}%`;

export function ChatMoment() {
  const clock = useMomentClock(STEPS, 'hold');
  const { animated, cycle, step } = clock;
  const sent = clock.reached('send');
  const draft = sent ? '' : clock.typed('type');
  const enter = (cls: string) => (animated ? cls : '');

  return (
    <div ref={clock.ref} data-inview={clock.inview} className="flex h-full flex-col gap-2.5 p-3">
      <div
        key={`thread-${cycle}`}
        className={`flex min-h-0 flex-1 flex-col justify-end gap-2.5 overflow-hidden transition-opacity duration-[var(--ds-motion-panel)] ease-[var(--ds-ease)] ${
          step === 'clear' ? 'opacity-0' : ''
        }`}
      >
        {sent ? (
          <p className={`ml-auto max-w-[80%] rounded-[var(--ds-radius-panel)] bg-ds-surface-soft px-3 py-2 text-[12.5px] leading-5 text-ds-ink ${enter('ds-blur-in')}`}>
            {PROMPT}
          </p>
        ) : null}
        {step === 'think' ? <p className="ds-shimmer-text px-1 text-[12.5px] font-medium">Thinking…</p> : null}
        {clock.reached('answer') ? (
          <p className={`max-w-[92%] px-1 text-[12.5px] leading-5 text-ds-ink ${enter('ds-blur-in')}`}>
            Here’s a plan that keeps mornings for the busiest temples and evenings for Gion. Pack a light jacket:
          </p>
        ) : null}
        {clock.reached('card') ? (
          <div className={`w-full max-w-[17rem] rounded-[var(--ds-radius-panel)] border border-ds-hairline bg-ds-raised p-3 shadow-[shadow:var(--ds-shadow-soft)] ${enter('ds-scale-in')}`}>
            <div className="flex items-center justify-between text-[11.5px]">
              <span className="font-medium text-ds-ink">Kyoto · next 3 days</span>
              <CloudSun className="size-4 text-ds-muted" aria-hidden="true" />
            </div>
            <ul className="mt-2.5 flex flex-col gap-2">
              {DAYS.map((d) => (
                <li key={d.day} className="grid grid-cols-[2.25rem_minmax(0,1fr)_4.5rem] items-center gap-2.5 text-[11.5px]">
                  <span className="font-medium text-ds-ink">{d.day}</span>
                  <span className="relative h-1.5 rounded-full bg-ds-chart-5">
                    <span className="absolute inset-y-0 rounded-full bg-ds-chart-1" style={{ left: pct(d.low), right: `calc(100% - ${pct(d.high)})` }} />
                  </span>
                  <span className="text-right tabular-nums text-ds-muted">
                    {d.high}° / {d.low}°
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="flex h-10 shrink-0 items-center gap-2 rounded-[var(--ds-radius-control)] border border-ds-control-border bg-ds-canvas pl-3 pr-1.5">
        <span className="min-w-0 flex-1 truncate text-[12.5px]">
          {draft ? <span className="text-ds-ink">{draft}</span> : <span className="text-ds-muted">Ask anything</span>}
          {clock.typing('type') ? <span className="ds-caret" /> : null}
        </span>
        <span className={`flex size-7 shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] ${draft ? 'bg-ds-accent-fill text-ds-on-accent' : 'bg-ds-surface-soft text-ds-muted'}`}>
          <ArrowUp className="size-3.5" aria-hidden="true" />
        </span>
      </div>
    </div>
  );
}
