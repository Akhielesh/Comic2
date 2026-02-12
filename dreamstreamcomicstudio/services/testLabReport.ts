import { TestLabRun } from "../types";

const truncate = (value: string, max = 240) => (value.length > max ? `${value.slice(0, max)}…` : value);

export const buildTestLabReport = (run: TestLabRun) => {
  const step = run.steps[0];
  const json = {
    runId: run.id,
    createdAt: run.createdAt,
    templateId: run.templateId || "custom",
    step: {
      kind: step.kind,
      success: step.success,
      durationMs: step.durationMs,
      apiMs: step.apiMs,
      saveMs: step.saveMs,
      totalMs: step.totalMs,
      provider: step.provider,
      model: step.model,
      prompt: step.prompt,
      promptChars: step.promptChars,
      aspectRatio: step.aspectRatio,
      resolution: step.resolution,
      outputImageBytes: step.outputImageBytes,
      outputImageId: step.outputImageId,
      error: step.error
    }
  };

  const markdown = [
    `# Test Lab Report`,
    ``,
    `**Run ID:** ${run.id}`,
    `**Created:** ${new Date(run.createdAt).toLocaleString()}`,
    `**Template:** ${run.templateId || "Custom"}`,
    ``,
    `## Step Summary`,
    `- **Kind:** ${step.kind}`,
    `- **Success:** ${step.success ? "Yes" : "No"}`,
    `- **Duration:** ${step.durationMs} ms`,
    step.apiMs !== undefined ? `- **API Time:** ${step.apiMs} ms` : null,
    step.saveMs !== undefined ? `- **Save Time:** ${step.saveMs} ms` : null,
    step.totalMs !== undefined ? `- **Total Time:** ${step.totalMs} ms` : null,
    step.provider ? `- **Provider:** ${step.provider}` : null,
    step.model ? `- **Model:** ${step.model}` : null,
    step.aspectRatio ? `- **Aspect Ratio:** ${step.aspectRatio}` : null,
    step.resolution ? `- **Resolution:** ${step.resolution}` : null,
    step.outputImageBytes ? `- **Output Size:** ${step.outputImageBytes} bytes` : null,
    step.outputImageId ? `- **Output Image ID:** ${step.outputImageId}` : null,
    ``,
    `## Prompt`,
    `\n\`\`\`\n${truncate(step.prompt)}\n\`\`\`\n`,
    step.error ? `## Error\n${step.error}` : null,
    ``,
    `## Technical JSON`,
    `\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`
  ].filter(Boolean).join("\n");

  return { json, markdown };
};
