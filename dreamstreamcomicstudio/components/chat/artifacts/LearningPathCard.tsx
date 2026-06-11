import React, { useCallback, useMemo, useState } from 'react';
import {
  GraduationCap,
  BookOpen,
  PenLine,
  HelpCircle,
  Layers,
  Hammer,
  Flag,
  Link2,
  Check,
  ChevronDown,
  Sparkles,
  ArrowRight,
  ExternalLink
} from 'lucide-react';
import type { LearningPathArtifact, LearningStep, LearningStepKind } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, useCompact, resolveTheme, Badge, withAlpha } from './kit';
import { ChatMarkdown } from '../ChatMarkdown';

// Guided learning path — an interactive, progress-tracked course card.
//  • detailed — module accordions with per-step round check toggles, inline lesson
//    bodies (markdown), external resources, one-click "Do this with AI" prompts,
//    an overall progress ring and a "Next up" continue footer.
//  • compact — a glance card: title, ring, X/Y steps, level and the next step.
// Progress is client-side only: localStorage `ds.learning.progress.v1`, a JSON map
// of pathId → array of completed step ids. No server round-trip.

const PROGRESS_KEY = 'ds.learning.progress.v1';

const loadDone = (pathId: string): Set<string> => {
  try {
    const raw = window.localStorage.getItem(PROGRESS_KEY);
    if (!raw) return new Set();
    const map = JSON.parse(raw) as Record<string, unknown>;
    const entry = map?.[pathId];
    if (Array.isArray(entry)) return new Set(entry.filter((v): v is string => typeof v === 'string'));
    // Tolerate an object map ({stepId: true}) from older writes.
    if (entry && typeof entry === 'object') return new Set(Object.keys(entry as Record<string, unknown>));
    return new Set();
  } catch {
    return new Set();
  }
};

const saveDone = (pathId: string, done: Set<string>) => {
  try {
    let map: Record<string, unknown> = {};
    const raw = window.localStorage.getItem(PROGRESS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed;
    }
    map[pathId] = Array.from(done);
    window.localStorage.setItem(PROGRESS_KEY, JSON.stringify(map));
  } catch {
    // Storage unavailable (private mode, SSR) — progress just won't persist.
  }
};

const KIND_ICONS: Record<LearningStepKind, React.ComponentType<{ className?: string }>> = {
  read: BookOpen,
  practice: PenLine,
  quiz: HelpCircle,
  flashcards: Layers,
  project: Hammer,
  checkpoint: Flag,
  resource: Link2
};

const LEVEL_COLORS: Record<string, string> = {
  beginner: '#059669',
  intermediate: '#d97706',
  advanced: '#dc2626'
};

/** A small full-circle progress ring with the percent in the hub. */
const ProgressRing: React.FC<{ fraction: number; accent: string; size?: number }> = ({ fraction, accent, size = 44 }) => {
  const stroke = 4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, fraction));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${Math.round(frac * 100)}% complete`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--ds-hairline-soft)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={accent}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${frac * c} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dasharray 0.4s ease-out' }}
      />
      <text x="50%" y="50%" dy="0.36em" textAnchor="middle" fontSize={size * 0.27} fontWeight="600" fill="var(--ds-ink)" style={{ letterSpacing: '-0.02em' }}>
        {Math.round(frac * 100)}%
      </text>
    </svg>
  );
};

const composeWithAI = (prompt: string) => {
  window.dispatchEvent(new CustomEvent('dreamstream:compose', { detail: { text: prompt } }));
};

/** One step row: check toggle, kind icon, title, est minutes, and per-kind actions. */
const StepRow: React.FC<{
  step: LearningStep;
  done: boolean;
  accent: string;
  onToggle: () => void;
}> = ({ step, done, accent, onToggle }) => {
  const [open, setOpen] = useState(false);
  const Icon = KIND_ICONS[step.kind] ?? BookOpen;
  const expandable = step.kind === 'read' && !!step.content;
  return (
    <li>
      <div className="group flex items-center gap-2.5 px-3 py-2">
        <button
          onClick={onToggle}
          aria-pressed={done}
          aria-label={done ? `Mark "${step.title}" as not done` : `Mark "${step.title}" as done`}
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border transition-colors duration-200"
          style={done ? { backgroundColor: accent, borderColor: accent } : { borderColor: 'rgba(0,0,0,0.2)', backgroundColor: 'transparent' }}
        >
          {done && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
        </button>

        <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)]" />

        {expandable ? (
          <button
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className={`min-w-0 flex-1 text-left text-xs transition-colors duration-200 ${done ? 'text-[var(--ds-muted)] line-through decoration-[var(--ds-hairline)]' : 'text-[var(--ds-ink)]'}`}
          >
            <span className="truncate align-middle">{step.title}</span>
            <ChevronDown className={`ml-1 inline h-3 w-3 align-middle text-[var(--ds-muted)] transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
          </button>
        ) : step.kind === 'resource' && step.url ? (
          <a
            href={step.url}
            target="_blank"
            rel="noopener noreferrer"
            className={`min-w-0 flex-1 truncate text-xs font-medium transition-colors duration-200 hover:underline ${done ? 'text-[var(--ds-muted)] line-through decoration-[var(--ds-hairline)]' : ''}`}
            style={done ? undefined : { color: accent }}
          >
            {step.title}
            <ExternalLink className="ml-1 inline h-3 w-3 align-[-1px] opacity-70" />
          </a>
        ) : (
          <span className={`min-w-0 flex-1 truncate text-xs ${done ? 'text-[var(--ds-muted)] line-through decoration-[var(--ds-hairline)]' : 'text-[var(--ds-ink)]'}`}>
            {step.title}
          </span>
        )}

        {step.prompt && (
          <button
            onClick={() => composeWithAI(step.prompt!)}
            className="hidden shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold transition-colors duration-200 hover:brightness-95 sm:inline-flex"
            style={{ color: accent, backgroundColor: withAlpha(accent, 0.1) }}
          >
            <Sparkles className="h-3 w-3" />
            Do this with AI
            <ArrowRight className="h-3 w-3" />
          </button>
        )}
        {typeof step.estMinutes === 'number' && (
          <span className="shrink-0 text-[10px] tabular-nums text-[var(--ds-muted)]">{step.estMinutes}m</span>
        )}
      </div>

      {expandable && open && (
        <div className="animate-fade-in mx-3 mb-2 ml-[42px] rounded-xl border border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] px-3 py-2">
          <ChatMarkdown text={step.content!} className="text-xs" />
          {step.prompt && (
            <button
              onClick={() => composeWithAI(step.prompt!)}
              className="mt-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold transition-colors duration-200 hover:brightness-95 sm:hidden"
              style={{ color: accent, backgroundColor: withAlpha(accent, 0.1) }}
            >
              <Sparkles className="h-3 w-3" />
              Do this with AI
            </button>
          )}
        </div>
      )}
    </li>
  );
};

export const LearningPathCard: React.FC<{ data: LearningPathArtifact }> = ({ data }) => {
  const compact = useCompact();
  const theme = resolveTheme({ palette: (data.palette as never) ?? 'violet' });
  const accent = theme.accent;
  const modules = data.modules ?? [];

  const [done, setDone] = useState<Set<string>>(() => loadDone(data.id));

  const toggleStep = useCallback(
    (stepId: string) => {
      setDone((prev) => {
        const next = new Set(prev);
        if (next.has(stepId)) next.delete(stepId);
        else next.add(stepId);
        saveDone(data.id, next);
        return next;
      });
    },
    [data.id]
  );

  const totalSteps = useMemo(() => modules.reduce((n, m) => n + m.steps.length, 0), [modules]);
  const doneCount = useMemo(
    () => modules.reduce((n, m) => n + m.steps.filter((s) => done.has(s.id)).length, 0),
    [modules, done]
  );

  // The first step (and its module) not yet completed — drives the default-open
  // accordion and the "Next up" continue footer.
  const next = useMemo(() => {
    for (const m of modules) {
      for (const s of m.steps) {
        if (!done.has(s.id)) return { module: m, step: s };
      }
    }
    return null;
  }, [modules, done]);

  const [openModules, setOpenModules] = useState<Set<string>>(() => {
    const initial = loadDone(data.id);
    const firstIncomplete = modules.find((m) => m.steps.some((s) => !initial.has(s.id)));
    return new Set(firstIncomplete ? [firstIncomplete.id] : []);
  });

  const toggleModule = (id: string) =>
    setOpenModules((prev) => {
      const next2 = new Set(prev);
      if (next2.has(id)) next2.delete(id);
      else next2.add(id);
      return next2;
    });

  const levelColor = data.level ? LEVEL_COLORS[data.level] ?? theme.neutral : theme.neutral;
  const subtitleBits = [
    data.topic,
    `${modules.length} module${modules.length === 1 ? '' : 's'}`,
    data.estMinutes ? `~${data.estMinutes} min` : null
  ].filter(Boolean);

  const header = (
    <div className="flex min-w-0 items-center gap-2">
      <GraduationCap className="h-4 w-4 shrink-0" style={{ color: accent }} />
      <div className="min-w-0">
        <SurfaceTitle>{data.title}</SurfaceTitle>
        <SurfaceSubtitle>{subtitleBits.join(' · ')}</SurfaceSubtitle>
      </div>
    </div>
  );

  // ── Compact: a ~140px glance card — ring, counts, level, next step. ──────────
  if (compact) {
    return (
      <Surface accent={accent} header={header} right={data.level && <Badge color={levelColor}>{data.level}</Badge>}>
        <div className="flex items-center gap-3 px-3 pb-3 pt-0.5">
          <ProgressRing fraction={totalSteps ? doneCount / totalSteps : 0} accent={accent} size={48} />
          <div className="min-w-0">
            <p className="text-xs font-semibold tabular-nums text-[var(--ds-ink)]">
              {doneCount} of {totalSteps} steps
            </p>
            <p className="truncate text-[11px] text-[var(--ds-muted)]">
              {next ? (
                <>
                  Next up: <span className="font-medium text-[var(--ds-ink)] opacity-80">{next.step.title}</span>
                </>
              ) : (
                'Path complete — nice work.'
              )}
            </p>
          </div>
        </div>
      </Surface>
    );
  }

  // ── Detailed: outcomes, module accordions with tracked steps, continue footer. ──
  return (
    <Surface
      accent={accent}
      header={header}
      right={
        <div className="flex items-center gap-2.5">
          {data.level && <Badge color={levelColor}>{data.level}</Badge>}
          <div className="flex items-center gap-2">
            <ProgressRing fraction={totalSteps ? doneCount / totalSteps : 0} accent={accent} size={44} />
            <span className="whitespace-nowrap text-[11px] tabular-nums text-[var(--ds-muted)]">
              <span className="font-semibold text-[var(--ds-ink)]">{doneCount}</span> of {totalSteps} steps
            </span>
          </div>
        </div>
      }
      footer={
        next ? (
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--ds-muted)]">
              Next up: <span className="font-medium text-[var(--ds-ink)]">{next.step.title}</span>
            </span>
            {next.step.prompt && (
              <button
                onClick={() => composeWithAI(next.step.prompt!)}
                className="inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold text-white transition-colors duration-200 hover:brightness-110"
                style={{ backgroundColor: accent }}
              >
                <Sparkles className="h-3 w-3" />
                Do it with AI
              </button>
            )}
            <button
              onClick={() => setOpenModules((prev) => new Set(prev).add(next.module.id))}
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--ds-ink)] transition-colors duration-200 hover:bg-[var(--ds-hover)]"
            >
              Continue
              <ArrowRight className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: accent }}>
            <Check className="h-3.5 w-3.5" strokeWidth={3} />
            All {totalSteps} steps complete — path finished.
          </div>
        )
      }
    >
      <div className="px-3 pb-3 pt-0.5">
        {data.description && <p className="mb-2 text-xs leading-relaxed text-[var(--ds-ink)] opacity-80">{data.description}</p>}

        {data.outcomes && data.outcomes.length > 0 && (
          <div className="mb-3 rounded-xl border border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] px-3 py-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">You&rsquo;ll be able to…</div>
            <ul className="space-y-0.5">
              {data.outcomes.map((o, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs text-[var(--ds-ink)] opacity-80">
                  <Check className="mt-0.5 h-3 w-3 shrink-0" style={{ color: accent }} strokeWidth={3} />
                  <span className="min-w-0">{o}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="overflow-hidden rounded-xl border border-[var(--ds-hairline-soft)] divide-y divide-[var(--ds-hairline-soft)]">
          {modules.map((m, mi) => {
            const open = openModules.has(m.id);
            const mDone = m.steps.filter((s) => done.has(s.id)).length;
            const complete = m.steps.length > 0 && mDone === m.steps.length;
            return (
              <div key={m.id}>
                <button
                  onClick={() => toggleModule(m.id)}
                  aria-expanded={open}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors duration-200 hover:bg-[var(--ds-well)]"
                >
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold tabular-nums"
                    style={complete ? { color: '#fff', backgroundColor: accent } : { color: '#6e6a60', backgroundColor: 'rgba(0,0,0,0.04)' }}
                  >
                    {complete ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : mi + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold text-[var(--ds-ink)]">{m.title}</span>
                    {m.summary && <span className="block truncate text-[11px] text-[var(--ds-muted)]">{m.summary}</span>}
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums text-[var(--ds-muted)]">
                    {mDone}/{m.steps.length}
                    {m.estMinutes ? ` · ${m.estMinutes}m` : ''}
                  </span>
                  <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)] transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                </button>
                {open && (
                  <ul className="animate-fade-in divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)] bg-[var(--ds-well)]">
                    {m.steps.map((s) => (
                      <StepRow key={s.id} step={s} done={done.has(s.id)} accent={accent} onToggle={() => toggleStep(s.id)} />
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Surface>
  );
};
