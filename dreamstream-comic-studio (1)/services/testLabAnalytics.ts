import { TestLabMetrics, TestLabRun } from "../types";

export const buildTestLabSummary = (runs: TestLabRun[]): TestLabMetrics => {
  const totalRuns = runs.length;
  const steps = runs.flatMap((run) => run.steps || []);
  const totalSteps = steps.length;
  const successCount = steps.filter((step) => step.success).length;
  const successRate = totalSteps ? successCount / totalSteps : 0;

  const avgDurationMs: Record<string, number> = {};
  const avgPromptChars: Record<string, number> = {};
  const durationBuckets: Record<string, number[]> = {};
  const promptBuckets: Record<string, number[]> = {};
  const lastErrors: Array<{ id: string; kind: string; error: string; at: number }> = [];

  steps.forEach((step) => {
    const key = step.kind || "unknown";
    if (!durationBuckets[key]) durationBuckets[key] = [];
    if (!promptBuckets[key]) promptBuckets[key] = [];
    durationBuckets[key].push(step.durationMs || 0);
    promptBuckets[key].push(step.promptChars || 0);
    if (!step.success && step.error) {
      lastErrors.push({ id: step.id, kind: key, error: step.error, at: step.endAt || step.startAt });
    }
  });

  Object.keys(durationBuckets).forEach((key) => {
    const values = durationBuckets[key];
    avgDurationMs[key] = values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
  });
  Object.keys(promptBuckets).forEach((key) => {
    const values = promptBuckets[key];
    avgPromptChars[key] = values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
  });

  return {
    totalRuns,
    totalSteps,
    successRate,
    avgDurationMs,
    avgPromptChars,
    lastErrors: lastErrors.slice(-5)
  };
};

export const getRecentTestRuns = (runs: TestLabRun[], limit = 10) =>
  [...runs].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
