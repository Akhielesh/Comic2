// InsightsPanel — the studio's "did it actually verify the code?" surface.
//
// Renders the live code-insights (health score + grade, real metrics, import health, a categorized
// & clickable issue list, model-free "what next" suggestions, and a one-click "Fix issues"). Driven
// by the pure analyzeProject() engine, so it updates instantly on every edit. This is what turns the
// studio from a black box into a product that shows its work.

import React, { useState } from 'react';
import {
  ShieldCheck, ChevronDown, ChevronRight, AlertTriangle, AlertCircle, Info, Wand2,
  FileWarning, Sparkles, Download, GitBranch,
} from 'lucide-react';
import { useStudioTheme } from '../kit';
import type { CodeInsights, CodeIssue, InsightSeverity } from './codeInsights';
import { issuesToFixPrompt, suggestNextSteps } from './codeInsights';

export interface InsightsPanelProps {
  insights: CodeInsights;
  onOpenFile?: (path: string) => void;
  /** Feed a refine prompt that fixes the verifier's issues. */
  onFix?: (prompt: string) => void;
  /** Feed a one-click suggestion as a refine prompt. */
  onSuggest?: (prompt: string) => void;
  /** Export a markdown project report. */
  onExport?: () => void;
  busy?: boolean;
}

const SEV_ICON: Record<InsightSeverity, React.FC<{ className?: string }>> = {
  error: AlertCircle, warn: AlertTriangle, info: Info,
};
const SEV_COLOR: Record<InsightSeverity, string> = {
  error: 'text-rose-400', warn: 'text-amber-400', info: 'text-sky-400',
};

const scoreColor = (score: number): string =>
  score >= 75 ? 'text-emerald-400' : score >= 55 ? 'text-amber-400' : 'text-rose-400';
const scoreRing = (score: number): string =>
  score >= 75 ? 'border-emerald-500/40' : score >= 55 ? 'border-amber-500/40' : 'border-rose-500/40';

export const InsightsPanel: React.FC<InsightsPanelProps> = ({ insights, onOpenFile, onFix, onSuggest, onExport, busy }) => {
  const t = useStudioTheme();
  const [open, setOpen] = useState(true);
  const { score, grade, files, loc, languages, issues, counts, imports } = insights;
  const fixable = counts.error + counts.warn;
  const suggestions = suggestNextSteps(insights);
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className={`rounded-lg border ${t.edge} ${t.panel} overflow-hidden`}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center gap-2 px-3 py-2 ${t.panelAlt} ${t.hover} ${t.focusRing}`}
        aria-expanded={open}
      >
        <ShieldCheck className={`w-4 h-4 ${scoreColor(score)}`} />
        <span className={`text-[11px] font-bold uppercase tracking-wide ${t.textDim}`}>Code health</span>
        <span className={`inline-flex items-center justify-center h-6 min-w-[2.6rem] rounded-full border ${scoreRing(score)} px-1.5 text-xs font-bold ${scoreColor(score)}`}>
          {score} {grade}
        </span>
        {counts.error > 0 && (
          <span className="text-[10px] font-semibold text-rose-400">{counts.error} error{counts.error === 1 ? '' : 's'}</span>
        )}
        <Chevron className={`ml-auto w-4 h-4 ${t.textFaint}`} />
      </button>

      {open && (
        <div className="p-3 space-y-3">
          {/* Metrics */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            <span className={t.textDim}><span className={`font-bold ${t.text}`}>{files}</span> files</span>
            <span className={t.textFaint}>·</span>
            <span className={t.textDim}><span className={`font-bold ${t.text}`}>{loc}</span> LOC</span>
            <span className={t.textFaint}>·</span>
            <span className={`inline-flex items-center gap-1 ${t.textDim}`}>
              <GitBranch className="w-3 h-3" />
              <span className={`font-bold ${imports.dangling ? 'text-rose-400' : t.text}`}>{imports.resolved}</span> imports
              {imports.dangling > 0 && <span className="text-rose-400">· {imports.dangling} broken</span>}
            </span>
          </div>

          {languages.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {languages.slice(0, 5).map((l) => (
                <span key={l.language} className={`rounded-full border ${t.edge} px-2 py-0.5 text-[10px] font-medium ${t.textDim}`}>
                  {l.language} · {l.loc}
                </span>
              ))}
            </div>
          )}

          {/* Fix-all action */}
          {fixable > 0 && onFix && (
            <button
              onClick={() => onFix(issuesToFixPrompt(issues))}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-full bg-violet-500 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-violet-400 disabled:opacity-50"
            >
              <Wand2 className="w-3.5 h-3.5" /> Fix {fixable} issue{fixable === 1 ? '' : 's'} with AI
            </button>
          )}

          {/* Issues */}
          {issues.length > 0 ? (
            <ul className="space-y-1 max-h-52 overflow-auto">
              {issues.slice(0, 30).map((iss: CodeIssue, i) => {
                const Icon = SEV_ICON[iss.severity];
                const clickable = !!(iss.file && onOpenFile);
                return (
                  <li key={i}>
                    <button
                      onClick={() => clickable && onOpenFile!(iss.file!)}
                      disabled={!clickable}
                      className={`flex w-full items-start gap-1.5 rounded px-1.5 py-1 text-left text-[11px] ${clickable ? `${t.hover} ${t.focusRing}` : 'cursor-default'}`}
                    >
                      <Icon className={`mt-0.5 w-3.5 h-3.5 shrink-0 ${SEV_COLOR[iss.severity]}`} />
                      <span className="min-w-0">
                        {iss.file && <span className={`font-mono ${t.textDim}`}>{iss.file.split('/').pop()}</span>}
                        <span className={t.textDim}>{iss.file ? ' — ' : ''}{iss.message}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className={`flex items-center gap-1.5 text-[11px] ${t.textDim}`}>
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" /> No issues found — the code verifies cleanly.
            </p>
          )}

          {/* Suggestions */}
          {onSuggest && suggestions.length > 0 && (
            <div className="space-y-1.5 pt-1">
              <p className={`flex items-center gap-1.5 text-[10px] font-bold uppercase ${t.textFaint}`}>
                <Sparkles className="w-3 h-3" /> Suggested next
              </p>
              <div className="flex flex-wrap gap-1.5">
                {suggestions.map((s, i) => (
                  <button
                    key={i}
                    onClick={() => onSuggest(s)}
                    disabled={busy}
                    title={s}
                    className={`max-w-full truncate rounded-full border ${t.edge} px-2.5 py-1 text-[11px] font-medium ${t.textDim} ${t.hover} disabled:opacity-50 ${t.focusRing}`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {onExport && (
            <button
              onClick={onExport}
              className={`inline-flex items-center gap-1.5 text-[11px] font-semibold ${t.textDim} ${t.hover} rounded-md px-1.5 py-1 ${t.focusRing}`}
            >
              <Download className="w-3.5 h-3.5" /> Export report
            </button>
          )}
        </div>
      )}
    </div>
  );
};

// Re-export the icon used by the empty state so consumers can show a matching badge if needed.
export { FileWarning };
