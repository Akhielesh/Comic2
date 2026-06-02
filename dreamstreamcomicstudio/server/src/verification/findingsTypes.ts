// Shared shape for the verification_findings row (between runner, route, and filer).

export interface VerificationFinding {
  id: string;
  run_id: string;
  check_id: string;
  fingerprint: string;
  title: string;
  detail: Record<string, unknown>;
  severity: 'low' | 'med' | 'high' | 'critical';
  confidence: number;
  council_votes: Record<string, unknown> | null;
  status: 'open' | 'confirmed' | 'dismissed' | 'fixing' | 'resolved' | 'wontfix';
  github_issue_number: number | null;
  github_pr_number: number | null;
  fix_attempts: number;
  created_at: string;
  resolved_at: string | null;
}
