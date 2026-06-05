// Swarm verifier / critic stage (Phase 9 · shared with Phase 11 guardrails).
//
// Runs AFTER the agents finish and BEFORE synthesis. It reads each agent's finding and
// scores how trustworthy it is — did it carry sources, did it actually run tools, did it
// hedge, did it state figures it never verified, did it come back empty or errored? Each
// finding gets a confidence (0–1) plus flags, and the swarm gets an overall confidence
// and a few cross-finding notes. The synthesizer is handed this assessment so it can
// down-weight weak findings and label unverified claims instead of laundering them into
// a confident answer.
//
// Deliberately deterministic and free (no extra model round-trip): it's a fast heuristic
// pass, so it's cheap, testable, and always runs. A model-based critic can layer on top
// later, but the heuristic already catches the failure modes that matter (no sources,
// fabricated figures, empty/errored agents).

import type { ChatCitation, ChatToolEvent, SwarmAgentStatus } from '../../../../apiTypes.js';

export interface AgentFinding {
  id: string;
  name: string;
  task: string;
  text: string;
  citations: ChatCitation[];
  status: SwarmAgentStatus;
  toolEvents?: ChatToolEvent[];
}

export type FindingFlag =
  | 'empty'
  | 'errored'
  | 'no_sources'
  | 'unverified_figures'
  | 'hedged'
  | 'thin';

export interface FindingAssessment {
  id: string;
  /** 0 (untrustworthy) … 1 (well-supported). */
  confidence: number;
  flags: FindingFlag[];
}

export interface VerificationResult {
  assessments: FindingAssessment[];
  /** Weighted confidence across all findings (0–1). */
  overallConfidence: number;
  /** Human-readable cross-finding observations for the synthesizer. */
  notes: string[];
}

const HEDGE_RE = /\b(i'?m not sure|not certain|i think|i believe|might be|may be|possibly|perhaps|as of my (?:last )?knowledge|cannot confirm|unverified|i don'?t have (?:access|real-?time))\b/i;
const FIGURE_RE = /(?:[$€£¥]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|%)\b)/;

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Score one agent finding. Pure. */
export const assessFinding = (f: AgentFinding): FindingAssessment => {
  const flags: FindingFlag[] = [];
  const text = (f.text || '').trim();
  const hasSources = (f.citations?.length || 0) > 0;
  const ranTool = (f.toolEvents || []).some((t) => t.ok);

  if (f.status === 'error') flags.push('errored');
  if (!text) flags.push('empty');

  let confidence = 0.6;
  if (flags.includes('errored') || flags.includes('empty')) {
    // A finding that errored or returned nothing carries almost no weight.
    return { id: f.id, confidence: 0.05, flags: flags.length ? flags : ['empty'] };
  }

  if (hasSources) confidence += 0.2;
  else flags.push('no_sources');

  if (ranTool) confidence += 0.1;

  if (HEDGE_RE.test(text)) {
    confidence -= 0.2;
    flags.push('hedged');
  }

  // Figures stated with neither a citation nor a successful tool call are the classic
  // fabrication risk — penalize and flag so synthesis labels them, not repeats them.
  if (FIGURE_RE.test(text) && !hasSources && !ranTool) {
    confidence -= 0.25;
    flags.push('unverified_figures');
  }

  if (text.length < 80) {
    confidence -= 0.1;
    flags.push('thin');
  }

  return { id: f.id, confidence: round2(clamp01(confidence)), flags };
};

/** Assess every finding and summarize corroboration across the swarm. Pure. */
export const verifyFindings = (findings: AgentFinding[]): VerificationResult => {
  const assessments = findings.map(assessFinding);
  const usable = findings.filter((f) => f.status !== 'error' && (f.text || '').trim());
  const sourced = usable.filter((f) => (f.citations?.length || 0) > 0);

  const overallConfidence = assessments.length
    ? round2(assessments.reduce((s, a) => s + a.confidence, 0) / assessments.length)
    : 0;

  const notes: string[] = [];
  if (!findings.length) {
    notes.push('No agent findings were produced.');
  } else {
    if (!sourced.length && usable.length) {
      notes.push('No finding carried a citation — corroboration is weak; present claims cautiously and label anything not independently verifiable.');
    }
    const flaggedFigures = assessments.filter((a) => a.flags.includes('unverified_figures'));
    if (flaggedFigures.length) {
      notes.push(`${flaggedFigures.length} finding(s) state figures without a live source — treat those numbers as unverified and do not present them as confirmed.`);
    }
    const failed = assessments.filter((a) => a.flags.includes('errored') || a.flags.includes('empty'));
    if (failed.length) {
      notes.push(`${failed.length} agent(s) returned nothing usable — rely on the remaining findings and note the gap if it matters.`);
    }
  }

  return { assessments, overallConfidence, notes };
};

/** Render the verification result as a compact block to inject into the synthesizer prompt. */
export const verificationBlock = (
  findings: AgentFinding[],
  result: VerificationResult
): string => {
  const lines = findings.map((f) => {
    const a = result.assessments.find((x) => x.id === f.id);
    const pct = a ? Math.round(a.confidence * 100) : 0;
    const flags = a?.flags.length ? ` [${a.flags.join(', ')}]` : '';
    return `- ${f.name}: confidence ${pct}%${flags}`;
  });
  const notes = result.notes.length ? `\nNotes:\n${result.notes.map((n) => `- ${n}`).join('\n')}` : '';
  return `Verifier assessment (use this to weight the findings — prefer high-confidence ones, and explicitly label or omit low-confidence/unverified claims):\nOverall confidence: ${Math.round(result.overallConfidence * 100)}%\n${lines.join('\n')}${notes}`;
};
