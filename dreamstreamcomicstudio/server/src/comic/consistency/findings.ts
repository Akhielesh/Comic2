// Check readings → findings with fix offers (pro plan §4.3, Appendix A; B3). STUB with fixed export names (K2b): B3
// replaces the body in place and owns this file from the moment K2b merges (pro plan §10 stub rule).
//
// Seam: jobs.ts letterPage passes every fresh page check through withFindings before committing it ($0, pure). The
// stub returns the report unchanged.

import type { ComicDoc, Page, QcReport } from '../../../../shared/comic/doc.js';

export interface FindingsInput {
  doc: ComicDoc;
  page: Page;
}

/** The report with its findings (checkV 2) and score caps. STUB: the report as it came. */
export function withFindings(qc: QcReport, _input: FindingsInput): QcReport {
  return qc;
}
