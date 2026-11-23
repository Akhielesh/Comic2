// Page drawings may establish a character, setting or style on another page.
// Lettering and panel layout are taken from the destination page's own script.
import { legacyIssueDismissed } from './reviewNotes.js';
import type { ConsistencyFinding, QcReport } from './doc.js';

const lettering = /\b(?:lettering|typeface|typography|font|captions?|balloons?|bubbles?|dialogue|text|spelling|spelled|misspell\w*|punctuation|kerning|legib\w*|illegib\w*)\b/i;
const visual = /\b(?:art(?:work)?|visuals?|medium|styl(?:e|ing|istic(?:ally)?)|palette|colou?rs?|linework|designs?|appearances?|identit(?:y|ies)|character(?:s)?|cast|hero(?:es)?|subject(?:s)?|figur(?:e|es|ine|ines)|vehicles?|creatures?|props?|outfits?|wardrobes?|costumes?|faces?|likeness|proportions?|silhouettes?|markings?|hair|uniforms?|species|setting|locations?)\b/i;
const depicted = /\b(?:drawn|rendered|illustrated|painted|portrayed|depicted|shown|appears?|resembl(?:e|es)|looks?)\b/i;
const obscured = /\b(?:obscur(?:e[sd]?|ing)|occlud(?:e[sd]?|ing)|hid(?:es?|den|ing)|cover(?:s|ed|ing)?)\b.{0,32}\b(?:faces?|silhouettes?|markings?|costumes?|figures?)\b|\b(?:faces?|silhouettes?|markings?|costumes?|figures?)\b.{0,30}\b(?:obscured|occluded|hidden|covered)\b/i;
const comparison = /\b(?:rather than|instead of|in place of)\b/i;
const defect = /\b(?:wrong|incorrect(?:ly)?|inaccurate|inconsistent|unrecogniz(?:able|eable)|unrecognisable|off[- ](?:model|style)|mismatch(?:ed|es)?|drift(?:s|ed|ing)?|deviat(?:es?|ed|ion)|differ(?:s|ent)(?:\s+from)?|depart(?:s|ure|ed)?\s+from|does(?:n['’]t| not) (?:resemble|match|follow|reflect)|(?:fails?|failed) to (?:resemble|match|follow)|contradicts?|(?:changed|swapped|replaced|substituted) (?:from|with|by|for|to)|missing|omitted)\b/i;
const negatedDefect = /\b(?:no(?: (?:clear|visible|noticeable|significant|major|obvious|apparent|visual|character|style|identity|design|continuity))* (?:issues?|errors?|problems?|defects?|mismatch(?:es)?|drift|inconsistenc(?:y|ies)|deviations?|discrepanc(?:y|ies)|changes?)|no (?:sign|evidence) of|(?:is|are|looks?|appears?) (?:not|never) (?:wrong|incorrect|inconsistent|off[- ]model|missing|unrecogniz\w*)|(?:does not|doesn['’]t|never) (?:drift|deviate|differ|depart)|(?:no|without) (?:wrong|incorrect|missing|mismatched))\b/i;
const affirmative = /\b(?:match(?:es)?|consistent|correct|accurate|true to|faithful to|on[- ]model|as (?:intended|requested|specified))\b/i;
const intended = /\b(?:correct|accurate|faithful|intended|requested|approved|specified|reference|expected|matching)\b/i;

type LegacyIssue = 'visual-defect' | 'unrelated' | 'unknown';

function legacyIssue(issue: string, visualFinding = false): LegacyIssue {
  let known = true;
  // Evaluate separate observations independently: a reassuring first clause cannot cancel a later defect.
  const observations = issue.slice(0, 1000).replace(/["“][^"”]*["”]/g, 'quoted text')
    // These are lettering-only diagnostics emitted by the page check itself (vision.ts).
    .replace(/line missing from the art|(?:stray|unexpected) text (?:drawn )?in the art|lettering differs from the script/gi, 'lettering');
  for (const fragment of observations.split(/[.;!?,\n]|\b(?:but|however|yet|except(?: for)?|apart from|other than)\b|\band (?=(?:the|there|its|their|no)\b)/i)) {
    const clause = fragment.trim();
    if (!clause) continue;
    if (negatedDefect.test(clause) && !/\b(?:instead of|rather than|fails? to match|does not match)\b/i.test(clause)) continue;
    // The style of a caption or font is lettering, even when QC calls that style wrong.
    const subject = clause.replace(/\b(?:style of (?:the )?(?:text|caption|lettering|font)|(?:font|text|lettering|caption) style|characters?(?:['’]s|[’'])? names?|(?:font|text|lettering|caption) colou?rs?)\b/gi, 'lettering');
    const hasVisual = visual.test(subject) || (visualFinding && !lettering.test(subject));
    const [described, alternative] = subject.split(comparison);
    if (alternative && (depicted.test(subject) || hasVisual)) {
      if (intended.test(described) && !intended.test(alternative) && !defect.test(described)) continue;
      if (!lettering.test(subject) || hasVisual) return 'visual-defect';
    }
    if (obscured.test(subject)) return 'visual-defect';
    if ((hasVisual || (depicted.test(subject) && !lettering.test(subject))) && defect.test(subject)) return 'visual-defect';
    if (!lettering.test(clause) && !affirmative.test(clause)) known = false;
  }
  return known ? 'unrelated' : 'unknown';
}

function observation(text: string) {
  const prefix = /^\s*panel\s+(\d+)\s*[:–—-]\s*/i.exec(text);
  const body = (prefix ? text.slice(prefix[0].length) : text).trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!]+$/, '');
  return { body, panel: prefix ? Number(prefix[1]) : undefined };
}

function dismissedDuplicate(issue: string, findings: readonly ConsistencyFinding[]) {
  const { body, panel } = observation(issue);
  if (!body) return false;
  const matches = findings.filter(f => {
    const note = observation(f.note);
    const sourcePanel = note.panel ?? f.panel;
    return note.body === body && (panel === undefined || panel === sourcePanel);
  });
  return matches.length > 0 && matches.every(f => f.dismissed);
}

function blocksVisualReference(finding: ConsistencyFinding) {
  if (finding.dismissed) return false;
  const concernsVisual = ['identity', 'style', 'continuity'].includes(finding.kind);
  const evidence = legacyIssue(finding.note, concernsVisual);
  // Severity can describe how unreadable the words are. A new page supplies its own lettering.
  if (evidence === 'unrelated' && lettering.test(finding.note)) return false;
  return finding.severity === 'major' || (concernsVisual && evidence !== 'unrelated');
}

/** Unchecked immediate neighbours retain their existing eligibility; older automatic evidence also needs an attested check. */
export function visualReferenceQcAllows(qc: QcReport | undefined, checkedEvidence = false, sourcePath?: string): boolean {
  if (!qc) return !checkedEvidence;
  if (qc.missingSpeakers?.length) return false;
  const findings = qc.findings ?? [];
  if (findings.some(blocksVisualReference)) return false;
  if (!Array.isArray(qc.issues)) return !checkedEvidence;
  return qc.issues.every((issue, index) => {
    if (legacyIssueDismissed(qc, sourcePath, index)) return true;
    if (findings.some(f => f.dismissed) && dismissedDuplicate(issue, findings)) return true;
    const result = legacyIssue(issue);
    return result !== 'visual-defect' && (!checkedEvidence || result === 'unrelated');
  });
}
