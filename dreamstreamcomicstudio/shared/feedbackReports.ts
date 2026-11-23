export const REPORT_LIMITS = {
  images: 10,
  originalBytes: 10 * 1024 * 1024,
  uploadBytes: 512 * 1024,
  storedBytes: 384 * 1024,
  maxEdge: 1920,
  maxPixels: 16_000_000,
  comment: 4000
} as const;
export type ReportKind = 'feedback' | 'bug';
export interface FeedbackReportInput {
  submissionId: string;
  kind: ReportKind;
  comment: string;
  category?: string;
  sentiment?: 'positive' | 'neutral' | 'negative' | 'frustrated';
  surface?: string;
  images: string[];
}
export interface FeedbackReportReceipt {
  id: string;
}
