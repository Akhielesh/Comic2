// Confirmed finding → labelled GitHub issue.
//
// Phase 3, server side. Called when an admin clicks "Confirm" on a finding in the
// Verification Center (or when a check with auto_fix_enabled=true emits a finding
// above its severity floor in CI). The actual repair is handled by the
// claude-code-action triggered by the `auto-fix` label — this module's only job is
// to file a clean, structured issue and remember the issue number.
//
// We use GitHub's REST API directly so we don't pull in a new dep. The token comes
// from the GITHUB_AUTO_FIX_TOKEN env var (a fine-grained PAT with issues:write +
// contents:read scoped to the repo).

import type { VerificationFinding } from './findingsTypes.js';

const REPO_ENV = 'GITHUB_AUTO_FIX_REPO';   // "owner/repo"
const TOKEN_ENV = 'GITHUB_AUTO_FIX_TOKEN'; // fine-grained PAT

const AUTO_FIX_LABEL = 'auto-fix';
const VERIFICATION_LABEL = 'verification-finding';

const sanitize = (value: string): string =>
  // Strip Markdown-ish formatting that an attacker-controlled finding detail might
  // try to smuggle (HTML tags, leading ATX headings, prompt-injection markers).
  value
    .replace(/<[^>]*>/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/^(system|assistant|user):\s.*/gim, '')
    .trim();

const buildBody = (f: VerificationFinding, checkName: string): string => {
  const title = sanitize(f.title);
  const detail = sanitize(JSON.stringify(f.detail, null, 2));
  return [
    `**Filed by the verification system** (\`${VERIFICATION_LABEL}\`).`,
    '',
    `- Check: \`${sanitize(checkName)}\``,
    `- Severity: \`${f.severity}\``,
    `- Confidence: \`${(f.confidence * 100).toFixed(0)}%\``,
    `- Fingerprint: \`${sanitize(f.fingerprint)}\``,
    `- Finding id: \`${f.id}\``,
    '',
    `### Title`,
    title,
    '',
    `### Detail`,
    '```json',
    detail,
    '```',
    '',
    `### How to fix`,
    `Pick this up via the Claude Code Action — apply the label \`${AUTO_FIX_LABEL}\` to dispatch.`,
    `The fix PR will be auto-merged when CI passes + the originally-failing check passes + protected paths are clean.`,
    `Re-running the check after merge is automatic; if a regression is detected on the default branch, the merge is reverted.`,
    '',
    `_Do not edit the issue body — it is consumed verbatim by the fixer._`
  ].join('\n');
};

export interface FileIssueOptions {
  /** Apply the `auto-fix` label too (default: only when finding is "confirmed"+autoFix). */
  dispatchAutoFix: boolean;
}

export interface FiledIssue {
  number: number;
  url: string;
}

/**
 * File a GitHub issue for a confirmed finding. Returns the new issue number, or
 * null if the GitHub plumbing is not configured (envs missing) — callers should
 * treat that as a soft failure and surface a clear message to the user instead of
 * crashing the request.
 */
export const fileFindingIssue = async (
  finding: VerificationFinding,
  checkName: string,
  opts: FileIssueOptions
): Promise<FiledIssue | null> => {
  const repo = process.env[REPO_ENV];
  const token = process.env[TOKEN_ENV];
  if (!repo || !token) {
    return null;
  }
  const labels = [VERIFICATION_LABEL];
  if (opts.dispatchAutoFix) labels.push(AUTO_FIX_LABEL);

  const url = `https://api.github.com/repos/${repo}/issues`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      title: `[verification] ${sanitize(finding.title).slice(0, 120)}`,
      body: buildBody(finding, checkName),
      labels
    })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub issue creation failed (${res.status}): ${text.slice(0, 500)}`);
  }
  const data = (await res.json()) as { number: number; html_url: string };
  return { number: data.number, url: data.html_url };
};
