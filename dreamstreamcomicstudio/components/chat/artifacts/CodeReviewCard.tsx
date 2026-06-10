import React, { useMemo, useState } from 'react';
import { AlertCircle, Check, CheckCircle2, ChevronDown } from 'lucide-react';
import type { CodeReviewArtifact, ReviewFinding, ReviewSeverity } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, Badge, LinearGauge, useCompact, BULL, BEAR, NEUTRAL } from './kit';

// Code review verdict card — the /code-review skill's result.
//  • detailed — title + reviewed target (linked when it's a URL) with a tinted
//    verdict badge, a "4 files · +120 −36" stats line, per-dimension score gauges,
//    the summary paragraph, findings grouped by severity (critical first, each with
//    a `file:line` mono chip and an expandable suggested fix) and a "What's good"
//    positives section.
//  • compact — a single glance Surface: verdict badge, per-severity count chips
//    and the most important finding's title.

const SEVERITY_ORDER: ReviewSeverity[] = ['critical', 'major', 'minor', 'nit'];

const SEVERITY_COLORS: Record<ReviewSeverity, string> = {
  critical: '#dc2626',
  major: '#f97316',
  minor: '#f59e0b',
  nit: '#64748b'
};

const VERDICTS: Record<CodeReviewArtifact['verdict'], { label: string; color: string; Icon: React.ComponentType<{ className?: string }> }> = {
  approve: { label: 'Approve', color: BULL, Icon: CheckCircle2 },
  'approve-with-nits': { label: 'Approve with nits', color: '#84cc16', Icon: CheckCircle2 },
  'request-changes': { label: 'Request changes', color: BEAR, Icon: AlertCircle }
};

/** Clamp a model-supplied severity to the known set so a typo can't drop a finding. */
const severityOf = (f: ReviewFinding): ReviewSeverity => (SEVERITY_ORDER.includes(f.severity) ? f.severity : 'nit');

const scoreColor = (score: number): string => (score >= 8 ? BULL : score >= 5 ? '#f59e0b' : BEAR);

const isUrl = (s: string): boolean => /^https?:\/\//i.test(s);

/** One finding: severity dot, title, `file:line` chip, detail, expandable fix. */
const FindingRow: React.FC<{ finding: ReviewFinding }> = ({ finding }) => {
  const [showFix, setShowFix] = useState(false);
  const color = SEVERITY_COLORS[severityOf(finding)] ?? NEUTRAL;
  const location = finding.file ? `${finding.file}${typeof finding.line === 'number' ? `:${finding.line}` : ''}` : null;
  return (
    <li className="min-w-0">
      <div className="flex items-start gap-2">
        <span aria-hidden className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="min-w-0 text-[13px] font-medium leading-snug text-[var(--ds-ink)]">{finding.title}</span>
            {location && (
              <span className="shrink-0 rounded bg-[var(--ds-well)] px-1.5 py-px font-mono text-[10px] tabular-nums text-[var(--ds-muted)]">
                {location}
              </span>
            )}
          </div>
          {finding.detail && <p className="mt-0.5 text-[11px] leading-snug text-[var(--ds-muted)]">{finding.detail}</p>}
          {finding.suggestion && (
            <>
              <button
                onClick={() => setShowFix((v) => !v)}
                aria-expanded={showFix}
                className="mt-1 inline-flex items-center gap-1 text-[10px] font-semibold text-[var(--ds-muted)] transition-colors duration-200 hover:text-[var(--ds-ink)]"
              >
                <ChevronDown className={`h-3 w-3 transition-transform duration-200 ${showFix ? 'rotate-180' : ''}`} />
                Suggested fix
              </button>
              {showFix && (
                <pre className="animate-fade-in mt-1 overflow-x-auto whitespace-pre-wrap rounded-lg bg-[var(--ds-well)] p-2 font-mono text-[11px] leading-relaxed text-[var(--ds-ink)]">
                  {finding.suggestion}
                </pre>
              )}
            </>
          )}
        </div>
      </div>
    </li>
  );
};

export const CodeReviewCard: React.FC<{ data: CodeReviewArtifact }> = ({ data }) => {
  const compact = useCompact();
  const findings = data.findings ?? [];
  const scores = data.scores ?? [];
  const positives = data.positives ?? [];

  const groups = useMemo(
    () =>
      SEVERITY_ORDER.map((sev) => ({ sev, items: findings.filter((f) => severityOf(f) === sev) })).filter(
        (g) => g.items.length > 0
      ),
    [findings]
  );

  if (!data.verdict && !findings.length && !data.summary) return null;

  const verdict = VERDICTS[data.verdict] ?? { label: 'Review', color: NEUTRAL, Icon: AlertCircle };
  const verdictBadge = (
    <Badge color={verdict.color}>
      <verdict.Icon className="h-3 w-3" />
      {verdict.label}
    </Badge>
  );

  const header = (
    <div className="min-w-0">
      <SurfaceTitle>{data.title || 'Code review'}</SurfaceTitle>
      {data.target &&
        (isUrl(data.target) ? (
          <a
            href={data.target}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate text-[11px] text-[var(--ds-muted)] transition-colors duration-200 hover:text-[var(--ds-ink)] hover:underline"
          >
            {data.target}
          </a>
        ) : (
          <SurfaceSubtitle>{data.target}</SurfaceSubtitle>
        ))}
    </div>
  );

  // ── Compact: verdict + severity counts + the most important finding. ─────────
  if (compact) {
    const lead =
      findings.find((f) => severityOf(f) === 'critical') ?? findings.find((f) => severityOf(f) === 'major') ?? null;
    return (
      <Surface header={header} right={verdictBadge}>
        <div className="px-3 pb-3 pt-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {groups.map((g) => (
              <span
                key={g.sev}
                className="rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums"
                style={{ color: SEVERITY_COLORS[g.sev], backgroundColor: `${SEVERITY_COLORS[g.sev]}1a` }}
              >
                {g.items.length} {g.sev}
              </span>
            ))}
            {!groups.length && <span className="text-[11px] text-[var(--ds-muted)]">No findings</span>}
          </div>
          {lead && <p className="mt-1.5 truncate text-[11px] text-[var(--ds-muted)]">{lead.title}</p>}
        </div>
      </Surface>
    );
  }

  // ── Detailed: stats, scores, summary, grouped findings, positives. ───────────
  const files = typeof data.stats?.files === 'number' ? data.stats.files : null;
  const additions = typeof data.stats?.additions === 'number' ? data.stats.additions : null;
  const deletions = typeof data.stats?.deletions === 'number' ? data.stats.deletions : null;
  const hasStats = files !== null || additions !== null || deletions !== null;

  return (
    <Surface header={header} right={verdictBadge}>
      {/* "4 files · +120 −36" diff stats. */}
      {hasStats && (
        <div className="flex items-center gap-1.5 px-3 pb-2 text-[11px] tabular-nums text-[var(--ds-muted)]">
          {files !== null && (
            <span>
              {files} file{files === 1 ? '' : 's'}
            </span>
          )}
          {files !== null && (additions !== null || deletions !== null) && <span>·</span>}
          {additions !== null && (
            <span className="font-medium" style={{ color: BULL }}>
              +{additions}
            </span>
          )}
          {deletions !== null && (
            <span className="font-medium" style={{ color: BEAR }}>
              −{deletions}
            </span>
          )}
        </div>
      )}

      {/* Per-dimension 0–10 score gauges. */}
      {scores.length > 0 && (
        <div
          className={`grid gap-x-4 gap-y-2 px-3 pb-2.5 ${
            scores.length >= 4 ? 'grid-cols-2 sm:grid-cols-4' : scores.length === 3 ? 'grid-cols-3' : 'grid-cols-2'
          }`}
        >
          {scores.map((s, i) => (
            <div key={`${s.label}-${i}`} className="min-w-0">
              <div className="mb-1 flex items-baseline justify-between gap-1 text-[10px]">
                <span className="truncate font-semibold uppercase tracking-wider text-[var(--ds-muted)]">{s.label}</span>
                <span className="shrink-0 font-semibold tabular-nums text-[var(--ds-ink)]">{s.score}/10</span>
              </div>
              <LinearGauge value={s.score} max={10} color={scoreColor(s.score)} height={5} />
            </div>
          ))}
        </div>
      )}

      {data.summary && <p className="px-3 pb-2.5 text-[13px] leading-snug text-[var(--ds-ink)]">{data.summary}</p>}

      {/* Findings, critical first. */}
      {groups.map((g) => (
        <div key={g.sev} className="border-t border-[var(--ds-hairline-soft)] px-3 py-2">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider tabular-nums" style={{ color: SEVERITY_COLORS[g.sev] }}>
            {g.sev} · {g.items.length}
          </div>
          <ul className="space-y-2">
            {g.items.map((f, i) => (
              <FindingRow key={`${f.title}-${i}`} finding={f} />
            ))}
          </ul>
        </div>
      ))}

      {/* Things done well — reviews should not only criticize. */}
      {positives.length > 0 && (
        <div className="border-t border-[var(--ds-hairline-soft)] px-3 py-2 pb-2.5">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: BULL }}>
            What&rsquo;s good
          </div>
          <ul className="space-y-1">
            {positives.map((p, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs leading-snug text-[var(--ds-ink)] opacity-80">
                <Check className="mt-0.5 h-3 w-3 shrink-0" style={{ color: BULL }} strokeWidth={3} />
                <span className="min-w-0">{p}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Surface>
  );
};
