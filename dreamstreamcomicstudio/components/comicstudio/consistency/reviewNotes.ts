import type { QcReport } from '../../../shared/comic/doc';

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
  return text.length <= 300 ? text : `${text.slice(0, 297)}…`;
}

/** Preserve stored, visible observations. Only real references attached to this drawing may resolve an internal label. */
export function savedReviewNotes(qc: QcReport | undefined, references: ReadonlyMap<string, number>): string[] {
  if (!qc) return [];
  const notes = new Set<string>();
  const structuredText = new Set<string>();
  for (const finding of Array.isArray(qc.findings) ? qc.findings.slice(0, 32) : []) {
    const note = readable(finding?.note, references);
    if (!note) continue;
    const panel = Number.isInteger(finding.panel) && finding.panel > 0 && finding.panel <= 99 ? `Panel ${finding.panel} · ` : '';
    structuredText.add(note);
    structuredText.add(`${panel}${note}`);
    if (!finding.dismissed) notes.add(`${panel}${note}`);
  }
  for (const value of Array.isArray(qc.issues) ? qc.issues.slice(0, 32) : []) {
    const note = readable(value, references);
    if (note && !structuredText.has(note)) notes.add(note);
  }
  return [...notes];
}
