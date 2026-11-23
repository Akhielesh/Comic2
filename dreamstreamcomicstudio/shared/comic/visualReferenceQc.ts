// Page drawings may establish a character, setting or style on another page.
// Lettering and panel layout are taken from the destination page's own script.
import type { QcReport } from './doc.js';

const lettering = /\b(?:lettering|typeface|typography|font|captions?|balloons?|bubbles?|dialogue|text|spelling|spelled|misspell\w*|punctuation|kerning|legib\w*|illegib\w*)\b/i;
const visual = /\b(?:art(?:work)?|visuals?|medium|styl(?:e|ing|istic(?:ally)?)|palette|colou?rs?|linework|designs?|appearances?|identit(?:y|ies)|character(?:s)?|cast|hero(?:es)?|subject(?:s)?|figur(?:e|es|ine|ines)|vehicles?|creatures?|props?|outfits?|wardrobes?|costumes?|faces?|likeness|proportions?|silhouettes?|markings?|hair|uniforms?|species|setting|locations?)\b/i;
const depicted = /\b(?:drawn|rendered|illustrated|painted|portrayed|depicted|shown|appears?|resembl(?:e|es)|looks?)\b/i;
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
    if ((hasVisual || (depicted.test(subject) && !lettering.test(subject))) && defect.test(subject)) return 'visual-defect';
    if (!lettering.test(clause) && !affirmative.test(clause)) known = false;
  }
  return known ? 'unrelated' : 'unknown';
}

/** Unchecked immediate neighbours retain their existing eligibility; older automatic evidence also needs an attested check. */
export function visualReferenceQcAllows(qc: QcReport | undefined, checkedEvidence = false): boolean {
  if (!qc) return !checkedEvidence;
  if (qc.missingSpeakers?.length) return false;
  if (qc.findings?.some(f => !f.dismissed && (f.severity === 'major' ||
      ((f.kind === 'identity' || f.kind === 'style' || f.kind === 'continuity') && legacyIssue(f.note, true) !== 'unrelated')))) return false;
  if (!Array.isArray(qc.issues)) return !checkedEvidence;
  return qc.issues.every(issue => {
    const result = legacyIssue(issue);
    return result !== 'visual-defect' && (!checkedEvidence || result === 'unrelated');
  });
}
