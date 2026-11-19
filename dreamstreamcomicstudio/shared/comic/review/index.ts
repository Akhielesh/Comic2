// The free whole-comic review (liveturn LT-10): import from here. LT-11 (the studio's review), the Director's tool and the
// house runner all call reviewComicFree; the rules and their thresholds live in rules.ts and types.ts.

export { reviewComicFree, contrastOver, readPxPerPageWidth, type ReviewOptions } from './rules.js';
export { REVIEW_LIMITS, REVIEW_RULES, isLineRef, type LineRef, type PageRef, type ReviewFinding, type ReviewFix, type ReviewReport, type ReviewRule, type ReviewSeverity } from './types.js';
