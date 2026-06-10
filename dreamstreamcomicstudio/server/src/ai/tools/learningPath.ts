// Guided learning path tool. The model composes the course (modules + steps); this
// tool validates/coerces the payload into a LearningPathArtifact the client renders
// as an interactive, progress-tracked course card. Deterministic — no network.

import type { ChatTool } from './types.js';
import type { LearningPathArtifact, LearningModule, LearningStep, LearningStepKind } from '../../../../apiTypes.js';

const STEP_KINDS: LearningStepKind[] = ['read', 'practice', 'quiz', 'flashcards', 'project', 'checkpoint', 'resource'];

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'path';

const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

const coerceStep = (raw: unknown, moduleIdx: number, stepIdx: number): LearningStep | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const title = str(r.title, 160);
  if (!title) return null;
  const kind = STEP_KINDS.includes(r.kind as LearningStepKind) ? (r.kind as LearningStepKind) : 'read';
  return {
    id: str(r.id, 64) ?? `m${moduleIdx + 1}-s${stepIdx + 1}`,
    kind,
    title,
    content: str(r.content, 6000),
    url: typeof r.url === 'string' && /^https:\/\//.test(r.url) ? r.url.slice(0, 500) : undefined,
    prompt: str(r.prompt, 500),
    estMinutes: typeof r.estMinutes === 'number' && r.estMinutes > 0 ? Math.min(600, Math.round(r.estMinutes)) : undefined
  };
};

const coerceModule = (raw: unknown, idx: number): LearningModule | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const title = str(r.title, 160);
  const steps = (Array.isArray(r.steps) ? r.steps : [])
    .slice(0, 14)
    .map((s, i) => coerceStep(s, idx, i))
    .filter((s): s is LearningStep => !!s);
  if (!title || steps.length === 0) return null;
  return {
    id: str(r.id, 64) ?? `m${idx + 1}`,
    title,
    summary: str(r.summary, 400),
    estMinutes: typeof r.estMinutes === 'number' && r.estMinutes > 0 ? Math.min(6000, Math.round(r.estMinutes)) : undefined,
    steps
  };
};

export const coerceLearningPath = (args: Record<string, unknown>): LearningPathArtifact | null => {
  const title = str(args.title, 200);
  const modules = (Array.isArray(args.modules) ? args.modules : [])
    .slice(0, 12)
    .map((m, i) => coerceModule(m, i))
    .filter((m): m is LearningModule => !!m);
  if (!title || modules.length === 0) return null;
  const level = args.level === 'beginner' || args.level === 'intermediate' || args.level === 'advanced' ? args.level : undefined;
  return {
    id: str(args.id, 80) ?? slug(title),
    title,
    topic: str(args.topic, 120),
    description: str(args.description, 600),
    level,
    estMinutes: modules.reduce((sum, m) => sum + (m.estMinutes ?? m.steps.reduce((s, st) => s + (st.estMinutes ?? 0), 0)), 0) || undefined,
    outcomes: Array.isArray(args.outcomes)
      ? args.outcomes.map((o) => str(o, 200)).filter((o): o is string => !!o).slice(0, 8)
      : undefined,
    modules,
    palette: str(args.palette, 24)
  };
};

export const learningPathTool: ChatTool = {
  name: 'create_learning_path',
  description:
    'Create a guided, progress-tracked learning path (course) the user can follow inside chat: modules of lessons, ' +
    'practice tasks, quiz/flashcard checkpoints and one-click "do this with me" prompts. Use whenever someone wants to ' +
    'LEARN a topic over time — "teach me X", "make me a study plan / curriculum / roadmap", "how do I get good at X". ' +
    'Write rich markdown lesson content into read steps; add `prompt` to steps the user should practice in chat ' +
    '(e.g. "Quiz me on module 2 of <topic>"). Keep it realistic: 3–6 modules, 3–6 steps each.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Course title, e.g. "Spanish in 30 days".' },
      topic: { type: 'string' },
      description: { type: 'string', description: 'One-paragraph overview of the journey.' },
      level: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] },
      outcomes: { type: 'array', items: { type: 'string' }, description: 'What the learner can do at the end.' },
      modules: {
        type: 'array',
        description: 'Ordered modules; each has ordered steps.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            summary: { type: 'string' },
            estMinutes: { type: 'number' },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: STEP_KINDS },
                  title: { type: 'string' },
                  content: { type: 'string', description: 'Markdown lesson body (read steps) or task description.' },
                  url: { type: 'string', description: 'https resource link (resource steps).' },
                  prompt: { type: 'string', description: 'Ready-to-send chat prompt for this step.' },
                  estMinutes: { type: 'number' }
                },
                required: ['title']
              }
            }
          },
          required: ['title', 'steps']
        }
      }
    },
    required: ['title', 'modules']
  },
  execute: async (args) => {
    const data = coerceLearningPath(args);
    if (!data) {
      return { content: 'Could not build the learning path: provide a title and at least one module with steps.' };
    }
    const steps = data.modules.reduce((n, m) => n + m.steps.length, 0);
    return {
      content: `Created guided learning path "${data.title}": ${data.modules.length} modules, ${steps} steps${data.estMinutes ? `, ~${data.estMinutes} min` : ''}. It renders as an interactive course card with tracked progress.`,
      artifacts: [{ type: 'learning_path', data }]
    };
  }
};
