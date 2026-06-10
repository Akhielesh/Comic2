import React, { useCallback, useMemo, useState } from 'react';
import { ArrowRight, CalendarDays, Check, Repeat, Target } from 'lucide-react';
import type { GoalTrackerArtifact, GoalMilestone } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, RadialGauge, useCompact, shortDate, BULL, BEAR } from './kit';

// Goal tracker — the /goal skill's interactive, progress-tracked goal card.
//  • detailed — title + "why" header with a percent progress gauge, meta chips
//    (target date with days-left / overdue tint, cadence, metric), a vertical
//    milestone timeline with round check toggles, an "Up next" action list and a
//    quiet celebratory footer once every milestone is done.
//  • compact — a glance card: title, progress gauge, "3 of 7 milestones" and the
//    next unchecked milestone.
// Completion is client-side only: localStorage `ds.goal.v1`, a JSON map of
// artifact id → array of completed milestone ids. No server round-trip.

const STORE_KEY = 'ds.goal.v1';
const ACCENT = '#D97757';

const loadDone = (goalId: string): Set<string> => {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return new Set();
    const map = JSON.parse(raw) as Record<string, unknown>;
    const entry = map?.[goalId];
    if (Array.isArray(entry)) return new Set(entry.filter((v): v is string => typeof v === 'string'));
    return new Set();
  } catch {
    return new Set();
  }
};

const saveDone = (goalId: string, done: Set<string>) => {
  try {
    let map: Record<string, unknown> = {};
    const raw = window.localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed;
    }
    map[goalId] = Array.from(done);
    window.localStorage.setItem(STORE_KEY, JSON.stringify(map));
  } catch {
    // Storage unavailable (private mode, SSR) — progress just won't persist.
  }
};

/** Whole days from now to an ISO date; null when the date is missing/invalid. */
const daysUntil = (iso?: string): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
};

/** Small rounded meta chip ("Target · Jul 30", cadence, metric). */
const MetaChip: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  danger?: boolean;
  children: React.ReactNode;
}> = ({ icon: Icon, danger = false, children }) => (
  <span
    className={`inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums ${
      danger ? '' : 'border border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] text-[var(--ds-muted)]'
    }`}
    style={danger ? { color: BEAR, backgroundColor: `${BEAR}1a` } : undefined}
  >
    <Icon className="h-3 w-3 shrink-0" />
    <span className="min-w-0 truncate">{children}</span>
  </span>
);

/** One timeline row: round check toggle, title, due date, notes. */
const MilestoneRow: React.FC<{
  milestone: GoalMilestone;
  done: boolean;
  last: boolean;
  onToggle: () => void;
}> = ({ milestone, done, last, onToggle }) => (
  <li className="relative flex items-start gap-2.5 px-3 py-2">
    {/* Thin connector to the next milestone's toggle. */}
    {!last && <span aria-hidden className="absolute left-[21px] top-[30px] -bottom-2.5 w-px bg-[var(--ds-hairline-soft)]" />}
    <button
      onClick={onToggle}
      aria-pressed={done}
      aria-label={done ? `Mark "${milestone.title}" as not done` : `Mark "${milestone.title}" as done`}
      className="relative z-[1] mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors duration-200"
      style={done ? { backgroundColor: BULL, borderColor: BULL } : { borderColor: 'var(--ds-hairline)', backgroundColor: 'var(--ds-surface)' }}
    >
      {done && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
    </button>
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={`min-w-0 text-[13px] font-medium leading-snug transition-colors duration-200 ${
            done ? 'text-[var(--ds-muted)] line-through decoration-[var(--ds-hairline)]' : 'text-[var(--ds-ink)]'
          }`}
        >
          {milestone.title}
        </span>
        {milestone.due && <span className="shrink-0 text-[10px] tabular-nums text-[var(--ds-muted)]">{shortDate(milestone.due)}</span>}
      </div>
      {milestone.notes && <p className="mt-0.5 text-[11px] leading-snug text-[var(--ds-muted)]">{milestone.notes}</p>}
    </div>
  </li>
);

export const GoalTracker: React.FC<{ data: GoalTrackerArtifact }> = ({ data }) => {
  const compact = useCompact();
  const milestones = data.milestones ?? [];
  const nextActions = data.nextActions ?? [];

  const [done, setDone] = useState<Set<string>>(() => loadDone(data.id));

  const toggle = useCallback(
    (milestoneId: string) => {
      setDone((prev) => {
        const next = new Set(prev);
        if (next.has(milestoneId)) next.delete(milestoneId);
        else next.add(milestoneId);
        saveDone(data.id, next);
        return next;
      });
    },
    [data.id]
  );

  const doneCount = useMemo(() => milestones.filter((m) => done.has(m.id)).length, [milestones, done]);
  const total = milestones.length;
  const pct = total ? (doneCount / total) * 100 : 0;
  const allDone = total > 0 && doneCount === total;
  const nextMilestone = useMemo(() => milestones.find((m) => !done.has(m.id)) ?? null, [milestones, done]);

  if (!data.title && !total && !nextActions.length) return null;

  const header = (
    <div className="min-w-0">
      <SurfaceTitle>{data.title}</SurfaceTitle>
      {data.why && <SurfaceSubtitle>{data.why}</SurfaceSubtitle>}
    </div>
  );

  // ── Compact: gauge + "3 of 7 milestones" + the next unchecked milestone. ─────
  if (compact) {
    return (
      <Surface
        header={header}
        right={<RadialGauge value={doneCount} max={total || 1} display={`${Math.round(pct)}%`} color={ACCENT} size={44} />}
      >
        <div className="px-3 pb-3 pt-0.5">
          <p className="text-xs font-semibold tabular-nums text-[var(--ds-ink)]">
            {doneCount} of {total} milestone{total === 1 ? '' : 's'}
          </p>
          {nextMilestone ? (
            <p className="truncate text-[11px] text-[var(--ds-muted)]">Next: {nextMilestone.title}</p>
          ) : allDone ? (
            <p className="text-[11px] font-medium" style={{ color: BULL }}>
              Goal complete 🎉
            </p>
          ) : null}
        </div>
      </Surface>
    );
  }

  // ── Detailed: meta chips, milestone timeline, up-next actions. ───────────────
  const daysLeft = daysUntil(data.targetDate);
  const overdue = typeof daysLeft === 'number' && daysLeft < 0 && !allDone;
  const daysLabel =
    typeof daysLeft !== 'number' ? null : daysLeft === 0 ? 'due today' : daysLeft > 0 ? `${daysLeft}d left` : `${-daysLeft}d overdue`;

  const metric = data.metric;
  const hasMetricRange = typeof metric?.start === 'number' && typeof metric?.target === 'number';
  const metricLabel = metric
    ? `${metric.label}${hasMetricRange ? ` · ${metric.start} → ${metric.target}${metric.unit ? ` ${metric.unit}` : ''}` : ''}`
    : null;

  return (
    <Surface
      header={header}
      right={<RadialGauge value={doneCount} max={total || 1} display={`${Math.round(pct)}%`} color={ACCENT} size={56} />}
      footer={
        allDone ? (
          <div className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: BULL }}>
            <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={3} />
            Goal complete 🎉
          </div>
        ) : undefined
      }
    >
      {/* Meta chips — only what the goal actually defines. */}
      {(data.targetDate || data.cadence || metricLabel) && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
          {data.targetDate && (
            <MetaChip icon={CalendarDays} danger={overdue}>
              Target · {shortDate(data.targetDate)}
              {daysLabel && <span className={overdue ? '' : 'opacity-70'}> · {daysLabel}</span>}
            </MetaChip>
          )}
          {data.cadence && <MetaChip icon={Repeat}>{data.cadence}</MetaChip>}
          {metricLabel && <MetaChip icon={Target}>{metricLabel}</MetaChip>}
        </div>
      )}

      {/* Milestone timeline with persisted round check toggles. */}
      {total > 0 && (
        <ul className="border-t border-[var(--ds-hairline-soft)] pb-1 pt-0.5">
          {milestones.map((m, i) => (
            <MilestoneRow key={m.id} milestone={m} done={done.has(m.id)} last={i === total - 1} onToggle={() => toggle(m.id)} />
          ))}
        </ul>
      )}

      {/* Up next — the skill's suggested immediate actions. */}
      {nextActions.length > 0 && (
        <div className="border-t border-[var(--ds-hairline-soft)] px-3 py-2">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">Up next</div>
          <ul className="space-y-1">
            {nextActions.map((action, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs leading-snug text-[var(--ds-ink)] opacity-80">
                <ArrowRight className="mt-0.5 h-3 w-3 shrink-0" style={{ color: ACCENT }} />
                <span className="min-w-0">{action}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Surface>
  );
};
