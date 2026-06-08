// Autopilot intake — idea → venture spec + roadmap (Epic A3). Mirrors ai/studio/studioPlan.ts:
// a pure prompt builder + a hardened JSON parser + a DI runner (the LLM `complete` is injected,
// so the orchestration is unit-testable without a model key). The route feeds the same
// `studioStageComplete` closure the studio uses; the resulting roadmap seeds venture_goals and
// is gated behind a roadmap_approval checkpoint before the loop works it.

import type { GoalKind } from './controlPlane.js';

export interface RoadmapGoal {
  title: string;
  detail?: string;
  kind: GoalKind;
  priority: number;
}

export interface VentureRoadmap {
  name: string;
  summary: string;
  scope: string;
  goals: RoadmapGoal[];
}

const GOAL_KINDS: readonly GoalKind[] = ['epic', 'feature', 'task', 'fix', 'chore'];
const MAX_GOALS = 40;

export const buildIntakePrompt = (idea: string): string =>
  `You are a product strategist + tech lead scoping a brand-new software product a team of AI agents will build and ship autonomously. Turn the user's idea into a concrete, buildable venture spec and an initial roadmap of concrete goals.

USER'S IDEA:
${idea}

Produce:
- name: a short product name.
- summary: 1-2 sentences on what it is and who it's for.
- scope: a crisp statement of what is IN scope for v1 (used later as a guardrail — agents won't drift outside it without approval).
- goals: 6-14 concrete, independently-shippable backlog items ordered by priority (most important first). Each goal: a clear title, a one-line detail, a kind (one of: epic, feature, task, fix, chore), and a priority number (lower = sooner). Start with foundational goals (scaffold, core data model, primary screen) before nice-to-haves.

Return ONLY a JSON object — no prose, no markdown:
{"name":"...","summary":"...","scope":"...","goals":[{"title":"...","detail":"...","kind":"feature","priority":10}]}`;

const trimTo = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const sanitizeGoals = (raw: unknown): RoadmapGoal[] => {
  if (!Array.isArray(raw)) return [];
  const out: RoadmapGoal[] = [];
  raw.slice(0, MAX_GOALS).forEach((g, i) => {
    const r = (g || {}) as { title?: unknown; detail?: unknown; kind?: unknown; priority?: unknown };
    const title = trimTo(r.title, 300);
    if (!title) return;
    const kind: GoalKind = GOAL_KINDS.includes(r.kind as GoalKind) ? (r.kind as GoalKind) : 'feature';
    const priority =
      typeof r.priority === 'number' && Number.isFinite(r.priority) && r.priority >= 0
        ? Math.floor(r.priority)
        : (i + 1) * 10;
    const detail = trimTo(r.detail, 2000) || undefined;
    out.push({ title, detail, kind, priority });
  });
  return out;
};

// Robustly pull the top-level JSON object out of an LLM response that may include prose and/or
// ```json fences. Unlike the shared extractJson, this takes the OUTERMOST {...} (first '{' to
// last '}') so a nested array (e.g. goals) is never mistaken for the whole payload.
const extractObject = (text: string): Record<string, unknown> | null => {
  const cleaned = text.replace(/```json\n?|```/g, '').trim();
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(cleaned);
  if (direct) return direct;
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) return tryParse(cleaned.slice(start, end + 1));
  return null;
};

/** Parse + harden the model's roadmap JSON, or null when unusable. */
export const parseRoadmap = (text: string): VentureRoadmap | null => {
  const parsed = extractObject(text);
  if (!parsed) return null;
  const name = trimTo(parsed.name, 200);
  const goals = sanitizeGoals(parsed.goals);
  // A usable roadmap needs a name and at least one concrete goal.
  if (!name || goals.length === 0) return null;
  return {
    name,
    summary: trimTo(parsed.summary, 2000),
    scope: trimTo(parsed.scope, 8000),
    goals
  };
};

/** Compose prompt → model → parsed roadmap, with one stricter retry when the first is unusable. */
export const runIntake = async (
  idea: string,
  complete: (prompt: string) => Promise<string>
): Promise<VentureRoadmap | null> => {
  const p = buildIntakePrompt(idea);
  let roadmap = parseRoadmap(await complete(p));
  if (!roadmap) {
    roadmap = parseRoadmap(await complete(`${p}\n\nIMPORTANT: Output ONLY the JSON object — begin with "{" and end with "}".`));
  }
  return roadmap;
};
