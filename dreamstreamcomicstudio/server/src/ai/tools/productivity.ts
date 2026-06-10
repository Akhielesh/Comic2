// Productivity widget tools — the server half of /goal, /code-review and the
// "what changed" card.
//
//  - create_goal_tracker:   interactive goal/milestone tracker (progress persists
//    on the user's device, like learning paths).
//  - render_whats_changed:  agent-authored changelog card ("since you last looked").
//  - fetch_github_pr:       LIVE data for code review — pulls a real PR/commit diff
//    from the public GitHub API (keyless; GITHUB_TOKEN lifts rate limits).
//  - render_code_review:    the structured review verdict card.

import type { ChatTool } from './types.js';
import type {
  GoalTrackerArtifact,
  GoalMilestone,
  WhatsChangedArtifact,
  ChangeItem,
  CodeReviewArtifact,
  ReviewFinding,
  ReviewSeverity,
  ReviewCategory
} from '../../../../apiTypes.js';
import { fetchJson, fetchText, envKey } from './http.js';

const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const strList = (v: unknown, maxItems: number, maxLen: number): string[] =>
  Array.isArray(v) ? v.map((x) => str(x, maxLen)).filter((x): x is string => !!x).slice(0, maxItems) : [];

const slugId = (seed: string): string =>
  `${seed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item'}-${Date.now().toString(36)}`;

// ----------------------------------------------------------------- goal tracker ---

export const goalTrackerTool: ChatTool = {
  name: 'create_goal_tracker',
  description:
    'Create an interactive GOAL TRACKER the user follows over time — the goal, why it matters, a target date, a measurable metric (start → target), 4–8 concrete milestones the user checks off (progress persists on their device), and the next actions to take now. Use whenever the user states a goal, resolution, habit or target ("I want to run a 10k", "save $5k by December", "learn Spanish"). Make milestones concrete and sequenced; the FIRST one should be startable today.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Stable id for saved progress; omit to auto-generate.' },
      title: { type: 'string', description: 'The goal, stated as an outcome, e.g. "Run a 10k under 60 minutes".' },
      why: { type: 'string', description: 'One line on why this matters to the user.' },
      targetDate: { type: 'string', description: 'ISO target date for the goal.' },
      cadence: { type: 'string', description: 'Rhythm, e.g. "3 runs / week".' },
      metric: {
        type: 'object',
        description: 'The measurable, when one exists.',
        properties: {
          label: { type: 'string', description: 'e.g. "Longest run".' },
          start: { type: 'number' },
          target: { type: 'number' },
          unit: { type: 'string', description: 'e.g. "km".' }
        },
        required: ['label']
      },
      milestones: {
        type: 'array',
        description: '4–8 sequenced, checkable milestones.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            due: { type: 'string', description: 'ISO date when relevant.' },
            notes: { type: 'string' }
          },
          required: ['title']
        }
      },
      nextActions: { type: 'array', items: { type: 'string' }, description: '1–3 things to do this week.' }
    },
    required: ['title', 'milestones']
  },
  execute: async (args) => {
    const title = str(args?.title, 160);
    const milestones: GoalMilestone[] = (Array.isArray(args?.milestones) ? args.milestones : [])
      .flatMap((m, i): GoalMilestone[] => {
        if (!m || typeof m !== 'object') return [];
        const r = m as Record<string, unknown>;
        const mTitle = str(r.title, 160);
        if (!mTitle) return [];
        return [{ id: str(r.id, 40) ?? `m${i + 1}`, title: mTitle, due: str(r.due, 24), notes: str(r.notes, 240) }];
      })
      .slice(0, 12);
    if (!title || !milestones.length) return { content: 'A goal tracker needs a title and at least one milestone.' };
    const metricRaw = args?.metric && typeof args.metric === 'object' ? (args.metric as Record<string, unknown>) : undefined;
    const metricLabel = metricRaw ? str(metricRaw.label, 60) : undefined;
    const data: GoalTrackerArtifact = {
      id: str(args?.id, 60) ?? slugId(title),
      title,
      why: str(args?.why, 200),
      targetDate: str(args?.targetDate, 24),
      cadence: str(args?.cadence, 60),
      metric: metricLabel ? { label: metricLabel, start: num(metricRaw?.start), target: num(metricRaw?.target), unit: str(metricRaw?.unit, 16) } : undefined,
      milestones,
      nextActions: strList(args?.nextActions, 3, 160)
    };
    return {
      content: `Created the goal tracker "${title}" with ${milestones.length} milestones${data.targetDate ? `, target ${data.targetDate}` : ''}. It is interactive — check-offs persist on the user's device. Close with one short line of encouragement, not a restatement.`,
      artifacts: [{ type: 'goal_tracker', data }]
    };
  }
};

// ----------------------------------------------------------------- what changed ---

const CHANGE_KINDS = ['price', 'news', 'event', 'metric', 'other'] as const;

export const whatsChangedTool: ChatTool = {
  name: 'render_whats_changed',
  description:
    'Render a "WHAT CHANGED" changelog card — a prioritized diff of the world since the user last looked: price moves, fresh news, events that fired, metrics that shifted. Use after re-checking live data the user tracks ("what changed since yesterday?", a morning catch-up, re-running a watchlist). Gather facts with live tools FIRST (get_stock, get_news, …), then summarize the deltas here with weight 3 for headline changes down to 1 for minor ones.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      since: { type: 'string', description: 'The window covered, e.g. "since yesterday".' },
      summary: { type: 'string', description: 'One-paragraph agent synthesis of the diff.' },
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...CHANGE_KINDS] },
            title: { type: 'string' },
            detail: { type: 'string' },
            delta: { type: 'number', description: 'Absolute change when numeric.' },
            deltaPercent: { type: 'number' },
            weight: { type: 'number', description: '1–3; 3 = headline change.' },
            url: { type: 'string' }
          },
          required: ['title']
        }
      }
    },
    required: ['changes']
  },
  execute: async (args) => {
    const changes: ChangeItem[] = (Array.isArray(args?.changes) ? args.changes : [])
      .flatMap((c): ChangeItem[] => {
        if (!c || typeof c !== 'object') return [];
        const r = c as Record<string, unknown>;
        const title = str(r.title, 160);
        if (!title) return [];
        const weight = num(r.weight);
        return [
          {
            kind: CHANGE_KINDS.includes(r.kind as (typeof CHANGE_KINDS)[number]) ? (r.kind as ChangeItem['kind']) : undefined,
            title,
            detail: str(r.detail, 280),
            delta: num(r.delta),
            deltaPercent: num(r.deltaPercent),
            weight: weight !== undefined ? Math.max(1, Math.min(3, Math.round(weight))) : undefined,
            url: typeof r.url === 'string' && /^https:\/\//.test(r.url) ? r.url.slice(0, 500) : undefined
          }
        ];
      })
      .slice(0, 16);
    if (!changes.length) return { content: 'No usable changes were provided (each needs a title).' };
    const data: WhatsChangedArtifact = {
      title: str(args?.title, 100),
      since: str(args?.since, 60),
      summary: str(args?.summary, 600),
      changes
    };
    return {
      content: `Rendered the "what changed" card (${changes.length} changes${data.since ? ` ${data.since}` : ''}). The card carries the detail — keep prose to one short line.`,
      artifacts: [{ type: 'whats_changed', data }]
    };
  }
};

// ----------------------------------------------------------- GitHub PR fetcher ---

const GH_API = 'https://api.github.com';
const MAX_DIFF_CHARS = 50_000;

export interface GithubTarget {
  owner: string;
  repo: string;
  kind: 'pull' | 'commit';
  ref: string; // PR number or commit SHA
}

/** Parse "https://github.com/o/r/pull/12", "o/r#12" or a commit URL into a target. */
export const parseGithubTarget = (input: string): GithubTarget | null => {
  const t = input.trim();
  const pullUrl = t.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i);
  if (pullUrl) return { owner: pullUrl[1], repo: pullUrl[2], kind: 'pull', ref: pullUrl[3] };
  const commitUrl = t.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/commit\/([0-9a-f]{7,40})/i);
  if (commitUrl) return { owner: commitUrl[1], repo: commitUrl[2], kind: 'commit', ref: commitUrl[3] };
  const shorthand = t.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (shorthand) return { owner: shorthand[1], repo: shorthand[2], kind: 'pull', ref: shorthand[3] };
  return null;
};

const ghHeaders = (accept: string): Record<string, string> => {
  const token = envKey('GITHUB_TOKEN');
  return {
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
};

export const fetchGithubPrTool: ChatTool = {
  name: 'fetch_github_pr',
  description:
    'Fetch a REAL pull-request or commit diff from public GitHub (live, keyless) so a code review is grounded in the actual changes. Accepts a PR URL ("https://github.com/owner/repo/pull/123"), shorthand ("owner/repo#123") or a commit URL. Returns the PR title/description/stats plus the unified diff. ALWAYS call this before render_code_review when the user gives a GitHub link — never review a PR from memory.',
  parameters: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'PR URL, "owner/repo#number", or commit URL.' }
    },
    required: ['target']
  },
  execute: async (args, signal) => {
    const target = str(args?.target, 300);
    const parsed = target ? parseGithubTarget(target) : null;
    if (!parsed) {
      return { content: 'Could not parse a GitHub PR/commit from that input. Expected "https://github.com/owner/repo/pull/123", "owner/repo#123", or a commit URL.' };
    }
    const { owner, repo, kind, ref } = parsed;
    const base = kind === 'pull' ? `${GH_API}/repos/${owner}/${repo}/pulls/${ref}` : `${GH_API}/repos/${owner}/${repo}/commits/${ref}`;
    try {
      const [meta, diff] = await Promise.all([
        fetchJson<Record<string, unknown>>(base, { signal, headers: ghHeaders('application/vnd.github+json') }),
        fetchText(base, { signal, headers: ghHeaders('application/vnd.github.v3.diff'), accept: 'application/vnd.github.v3.diff' })
      ]);
      const truncated = diff.length > MAX_DIFF_CHARS;
      const body = truncated ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… [diff truncated at ${MAX_DIFF_CHARS} chars]` : diff;
      const title = typeof meta.title === 'string' ? meta.title : typeof (meta.commit as Record<string, unknown>)?.message === 'string' ? String((meta.commit as Record<string, unknown>).message).split('\n')[0] : '';
      const stats =
        kind === 'pull'
          ? `${meta.changed_files ?? '?'} files · +${meta.additions ?? '?'} −${meta.deletions ?? '?'} · state ${meta.state ?? '?'}`
          : (() => {
              const s = meta.stats as Record<string, unknown> | undefined;
              return s ? `+${s.additions ?? '?'} −${s.deletions ?? '?'}` : '';
            })();
      const description = typeof meta.body === 'string' && meta.body.trim() ? `\n\nDescription:\n${meta.body.trim().slice(0, 2000)}` : '';
      return {
        content:
          `${kind === 'pull' ? `PR #${ref}` : `Commit ${ref.slice(0, 10)}`} in ${owner}/${repo}: "${title}" (${stats}).${description}\n\n` +
          `Unified diff:\n\`\`\`diff\n${body}\n\`\`\`\n` +
          'Review THIS diff (cite real files/lines from it), then call render_code_review with your structured findings.',
        citations: [{ url: `https://github.com/${owner}/${repo}/${kind === 'pull' ? 'pull' : 'commit'}/${ref}`, title: `${owner}/${repo} ${kind === 'pull' ? `#${ref}` : ref.slice(0, 10)}` }],
        ...(truncated ? { notice: { level: 'info' as const, message: 'Large diff — truncated for review; findings cover the included portion.' } } : {})
      };
    } catch (err) {
      const message = (err as Error)?.message || 'unknown error';
      const rateLimited = /\b403\b|\b429\b/.test(message);
      return {
        content: `Could not fetch ${owner}/${repo} ${kind} ${ref}: ${message}. ${rateLimited ? 'GitHub rate limit hit (keyless tier is 60 req/hr).' : 'Check that the repo is public and the reference exists.'} Do NOT review from memory — tell the user the diff could not be fetched, or ask them to paste it.`,
        notice: {
          level: 'error' as const,
          message: rateLimited ? 'GitHub API rate limit reached.' : `GitHub fetch failed for ${owner}/${repo}.`,
          fix: rateLimited && !envKey('GITHUB_TOKEN') ? 'Set GITHUB_TOKEN to lift GitHub API rate limits' : undefined
        }
      };
    }
  }
};

// ------------------------------------------------------------------ code review ---

const SEVERITIES: ReviewSeverity[] = ['critical', 'major', 'minor', 'nit'];
const CATEGORIES: ReviewCategory[] = ['correctness', 'security', 'performance', 'readability', 'style', 'testing', 'other'];
const VERDICTS = ['approve', 'approve-with-nits', 'request-changes'] as const;

export const codeReviewTool: ChatTool = {
  name: 'render_code_review',
  description:
    'Render a structured CODE REVIEW verdict card — overall verdict, dimension scores (0–10), findings with severity / file:line / suggested fixes, diff stats and positives. Use to conclude any code review: of a fetched GitHub PR (call fetch_github_pr first for live diffs), pasted code, or code you generated. Findings must cite real files/lines from the code actually reviewed; include at least one positive when deserved.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'e.g. "Review: add retry logic to fetcher".' },
      target: { type: 'string', description: 'What was reviewed — the PR URL or "pasted code".' },
      verdict: { type: 'string', enum: [...VERDICTS] },
      summary: { type: 'string', description: '2–3 sentence overall assessment.' },
      scores: {
        type: 'array',
        description: 'Dimension scores 0–10, e.g. correctness, readability, security, tests.',
        items: { type: 'object', properties: { label: { type: 'string' }, score: { type: 'number' } }, required: ['label', 'score'] }
      },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: SEVERITIES },
            title: { type: 'string' },
            detail: { type: 'string' },
            file: { type: 'string' },
            line: { type: 'number' },
            suggestion: { type: 'string', description: 'Suggested replacement code.' },
            category: { type: 'string', enum: CATEGORIES }
          },
          required: ['severity', 'title']
        }
      },
      stats: {
        type: 'object',
        properties: { files: { type: 'number' }, additions: { type: 'number' }, deletions: { type: 'number' } }
      },
      positives: { type: 'array', items: { type: 'string' } }
    },
    required: ['verdict', 'findings']
  },
  execute: async (args) => {
    const findings: ReviewFinding[] = (Array.isArray(args?.findings) ? args.findings : [])
      .flatMap((f): ReviewFinding[] => {
        if (!f || typeof f !== 'object') return [];
        const r = f as Record<string, unknown>;
        const title = str(r.title, 200);
        if (!title) return [];
        return [
          {
            severity: SEVERITIES.includes(r.severity as ReviewSeverity) ? (r.severity as ReviewSeverity) : 'minor',
            title,
            detail: str(r.detail, 500),
            file: str(r.file, 200),
            line: num(r.line),
            suggestion: typeof r.suggestion === 'string' && r.suggestion.trim() ? r.suggestion.slice(0, 2000) : undefined,
            category: CATEGORIES.includes(r.category as ReviewCategory) ? (r.category as ReviewCategory) : undefined
          }
        ];
      })
      .slice(0, 20);
    const verdict = VERDICTS.includes(args?.verdict as (typeof VERDICTS)[number]) ? (args?.verdict as CodeReviewArtifact['verdict']) : 'approve-with-nits';
    if (!findings.length && verdict === 'request-changes') {
      return { content: 'A "request-changes" review needs at least one finding explaining what to change.' };
    }
    const scores = (Array.isArray(args?.scores) ? args.scores : [])
      .flatMap((s) => {
        if (!s || typeof s !== 'object') return [];
        const r = s as Record<string, unknown>;
        const label = str(r.label, 40);
        const score = num(r.score);
        return label && score !== undefined ? [{ label, score: Math.max(0, Math.min(10, score)) }] : [];
      })
      .slice(0, 6);
    const statsRaw = args?.stats && typeof args.stats === 'object' ? (args.stats as Record<string, unknown>) : undefined;
    const data: CodeReviewArtifact = {
      title: str(args?.title, 140),
      target: str(args?.target, 300),
      verdict,
      summary: str(args?.summary, 600),
      scores: scores.length ? scores : undefined,
      findings,
      stats: statsRaw ? { files: num(statsRaw.files), additions: num(statsRaw.additions), deletions: num(statsRaw.deletions) } : undefined,
      positives: strList(args?.positives, 5, 200)
    };
    const counts = SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length] as const).filter(([, n]) => n > 0);
    return {
      content: `Rendered the code review card: ${verdict}${counts.length ? ` (${counts.map(([s, n]) => `${n} ${s}`).join(', ')})` : ''}. The card carries the findings — close with a 1–2 sentence overall take, not a re-list.`,
      artifacts: [{ type: 'code_review', data }]
    };
  }
};

export const PRODUCTIVITY_TOOLS: ChatTool[] = [goalTrackerTool, whatsChangedTool, fetchGithubPrTool, codeReviewTool];
