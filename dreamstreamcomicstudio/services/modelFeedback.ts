// User feedback on models — the signal that lets Smart auto-pick keep improving.
//
// Stored client-side (localStorage), per model, optionally scoped to a task/scenario.
// Likes nudge a model up in future Smart picks; dislikes nudge it down. Users may add an
// optional free-text note (never forced). The smart selection engine reads feedbackScore().

export type FeedbackVote = 'like' | 'dislike';

export interface ModelFeedbackEntry {
  vote: FeedbackVote;
  note?: string;
  /** Optional scenario this feedback was about (e.g. 'panel_art'); weighted higher when it matches. */
  task?: string;
  at: number;
}

type Store = Record<string, ModelFeedbackEntry[]>;

const STORAGE = 'dreamstream_model_feedback_v1';
export const MODEL_FEEDBACK_CHANGED = 'dreamstream:model-feedback-changed';

const read = (): Store => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
};

const write = (store: Store) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE, JSON.stringify(store));
    window.dispatchEvent(new CustomEvent(MODEL_FEEDBACK_CHANGED));
  } catch {
    /* ignore quota errors */
  }
};

export const recordModelFeedback = (
  modelId: string,
  vote: FeedbackVote,
  opts?: { note?: string; task?: string }
) => {
  if (!modelId) return;
  const store = read();
  const entries = store[modelId] ? [...store[modelId]] : [];
  entries.push({ vote, note: opts?.note?.trim() || undefined, task: opts?.task, at: Date.now() });
  // Keep the most recent 20 per model — recency matters, storage stays bounded.
  store[modelId] = entries.slice(-20);
  write(store);
};

export const getModelFeedback = (modelId: string): ModelFeedbackEntry[] => read()[modelId] || [];

export const clearModelFeedback = (modelId: string) => {
  const store = read();
  if (store[modelId]) {
    delete store[modelId];
    write(store);
  }
};

/** The net like/dislike for a model's most recent entry (for compact UI state). */
export const latestVote = (modelId: string): FeedbackVote | null => {
  const entries = read()[modelId];
  return entries && entries.length ? entries[entries.length - 1].vote : null;
};

/**
 * Net feedback signal for a model, optionally weighted toward a specific task. Likes are +1,
 * dislikes −1; entries that match the task in question count 1.5×; more recent entries count
 * slightly more. Returned raw — the selection engine bounds it before applying.
 */
export const feedbackScore = (modelId: string, task?: string): number => {
  const entries = read()[modelId];
  if (!entries || !entries.length) return 0;
  let score = 0;
  entries.forEach((e, i) => {
    const taskWeight = e.task && task && e.task === task ? 1.5 : 1;
    const recencyWeight = 0.6 + 0.4 * (i / Math.max(1, entries.length - 1)); // 0.6 → 1.0
    score += (e.vote === 'like' ? 1 : -1) * taskWeight * recencyWeight;
  });
  return score;
};
