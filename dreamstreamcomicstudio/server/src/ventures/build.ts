// Compose a build request for one venture goal (Epic A4). Pure + unit-testable: turns the
// venture context + the chosen goal (+ the project's current files) into the GenerateInput the
// existing studio generator (runGenerate) consumes. New project → fresh build; existing files →
// refine mode (keep what works). The approved scope is threaded in as a guardrail.

import type { GenerateInput } from '../ai/studio/studioGenerate.js';

export interface BuildGoalContext {
  ventureName?: string;
  ventureSummary?: string | null;
  ventureScope?: string | null;
  goalTitle: string;
  goalDetail?: string | null;
}

export const buildGoalGenerateInput = (
  ctx: BuildGoalContext,
  currentFiles?: { path: string; content: string }[]
): GenerateInput => {
  const contextLines = [
    ctx.ventureName ? `Product: ${ctx.ventureName}` : '',
    ctx.ventureSummary ? `About: ${ctx.ventureSummary}` : '',
    ctx.ventureScope ? `Approved scope (stay within this): ${ctx.ventureScope}` : ''
  ]
    .filter(Boolean)
    .join('\n');
  const goalLine = `Current goal: ${ctx.goalTitle}${ctx.goalDetail ? ` — ${ctx.goalDetail}` : ''}`;
  const body = contextLines ? `${contextLines}\n\n${goalLine}` : goalLine;
  const hasFiles = Array.isArray(currentFiles) && currentFiles.length > 0;

  return {
    prompt: hasFiles
      ? `Continue building this product. Implement the current goal while keeping everything that already works.\n\n${body}`
      : `Start building this product. Implement the current goal as a complete, runnable app.\n\n${body}`,
    template: 'react-ts',
    ...(hasFiles ? { currentFiles, currentTitle: ctx.ventureName } : {})
  };
};
