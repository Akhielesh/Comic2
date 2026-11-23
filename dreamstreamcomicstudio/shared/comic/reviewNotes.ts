import type { ComicDoc, Page, QcReport } from './doc.js';
import { hashString } from './hash.js';
import { safetyStatusOf, PLATFORM_CEILING } from './safety.js';

// Older checks can contain raw provider text. A review note is plain prose, never a URL, key, storage path or markup.
const LINKS_OR_MARKUP = /\b(?:https?|ftp|file|blob|data|javascript|s3|gs):|www\.|<[^>]*>/iu;
const INTERNAL_PATH = /[\\]|(?:^|[\s(\["'])\.{0,2}\/|\b(?:[\w.-]+\/){2,}|\b(?:pub|q|u|comic-assets|comic-private)\/|\b(?:prev|sheet|photo|anchor|character):[\w-]+|[\w.-]+\.(?:webp|png|jpeg|jpg|gif|avif|svg|json|log)\b/iu;
const ID_OR_KEY = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\bbearer\s+[\w.\/-]{12,}|\b(?:token|signature|api[_ -]?key|password)\s*[:=]|\bsk-[\w-]{12,}|\beyJ[\w-]{9,}\./iu;
const CONTROL = /[\u0000-\u0008\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const SCORE_CLAIM = /\b(?:confidence|score|accuracy|probability)\s*[:=]?\s*(?:\d|\.\d)|\d+(?:\.\d+)?%\s+(?:confidence|confident|accurate)/iu;
const OMIT = [LINKS_OR_MARKUP, INTERNAL_PATH, ID_OR_KEY, CONTROL, SCORE_CLAIM];

function readable(value: unknown, references: ReadonlyMap<string, number>): string | undefined {
  if (typeof value !== 'string' || value.length > 1200) return undefined;
  const text = value.replace(/\bprev:([\w-]+)/g, (key, id: string) => {
    const page = references.get(id);
    return page === undefined ? key : `reference page ${page}`;
  }).replace(/\s+/g, ' ').trim();
  if (!text || OMIT.some(pattern => pattern.test(text))) return undefined;
  return text;
}

export interface DrawingCheck { path: string; checkedAt: number }
export interface ReviewNote { id: string; text: string; dismissed: boolean; issueIndex?: number; readOnly?: boolean }

export function currentDrawingCheck(page: Page): DrawingCheck | undefined {
  const { asset, qc, status, withheld } = page.render;
  if (!asset?.path || !qc || !Number.isFinite(qc.checkedAt) || withheld || (status !== 'ready' && status !== 'stale')) return;
  const safety = safetyStatusOf(asset.safety, PLATFORM_CEILING);
  if (safety !== 'unchecked' && safety !== 'pass') return;
  return { path: asset.path, checkedAt: qc.checkedAt };
}

export const sameDrawingCheck = (a?: DrawingCheck, b?: DrawingCheck): boolean =>
  !!a && !!b && a.path === b.path && a.checkedAt === b.checkedAt;

export const legacyIssueId = (issue: string, index: number) => `issue_${index}_${hashString(issue)}`;

export function legacyIssueDismissed(qc: QcReport, path: string | undefined, index: number): boolean {
  const review = qc.legacyReview;
  return !!path && !!review && review.path === path && review.checkedAt === qc.checkedAt &&
    typeof qc.issues?.[index] === 'string' && Array.isArray(review.notes) && review.notes.some(n => n?.index === index && n.text === qc.issues[index]);
}

const protectedNote = /\b(?:quarantin\w*|safety (?:check|verdict|policy)|content (?:moderation|policy|rating)|blocked by|restricted content)\b/i;

/** The UI and the patch validator use the same bounded, readable original notes. */
export function savedReviewNotes(doc: ComicDoc, page: Page): ReviewNote[] {
  const qc = page.render.qc;
  if (!qc || page.render.withheld || (page.render.asset && !currentDrawingCheck(page))) return [];
  const refs = new Map(doc.pages.filter(p => page.render.anchorKeys?.includes('prev:' + p.id)).map(p => [p.id, p.n]));
  const notes: ReviewNote[] = [];
  const structuredText = new Set<string>();
  for (const finding of Array.isArray(qc.findings) ? qc.findings.slice(0, 32) : []) {
    const note = readable(finding?.note, refs);
    if (!note) continue;
    const panel = Number.isInteger(finding.panel) && finding.panel > 0 && finding.panel <= 99 ? `Panel ${finding.panel} · ` : '';
    structuredText.add(note);
    structuredText.add(`Panel ${finding.panel}: ${note}`);
    notes.push({ id: finding.id, text: panel + note, dismissed: !!finding.dismissed, readOnly: protectedNote.test(note) });
  }
  for (const [index, issue] of (Array.isArray(qc.issues) ? qc.issues.slice(0, 32) : []).entries()) {
    const text = readable(issue, refs);
    if (!text || structuredText.has(text)) continue;
    notes.push({ id: legacyIssueId(issue, index), text, readOnly: protectedNote.test(text), issueIndex: index, dismissed: legacyIssueDismissed(qc, page.render.asset?.path, index) });
  }
  return notes;
}
