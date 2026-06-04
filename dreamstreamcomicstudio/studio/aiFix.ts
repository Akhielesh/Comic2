// "Debug with AI" — sends the failing project + error log to the model and asks for
// corrected files. Reuses the platform chat endpoint (so auth/BYOK/model-routing all
// apply); parses a strict JSON file list back out of the answer.

import { sendChatMessage } from '../services/chatApi';

export interface FixResult {
  files: Record<string, string>;
  note?: string;
}

const extractJsonObject = (text: string): unknown => {
  // Prefer a fenced ```json block, else the first balanced {...} span.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
};

export const requestAiFix = async (
  files: Record<string, string>,
  errorLog: string,
  focus?: string
): Promise<FixResult> => {
  const fileBlock = Object.entries(files)
    .map(([p, c]) => `FILE: ${p}\n\`\`\`\n${c}\n\`\`\``)
    .join('\n\n');

  const prompt = `You are a debugging engineer. A project fails to build or run. Diagnose the root cause from the error log and fix it.

ERROR / CONSOLE LOG:
${errorLog || '(no log captured — inspect the code for obvious issues)'}
${focus ? `\nThe user specifically wants you to focus on: ${focus}\n` : ''}
PROJECT FILES:

${fileBlock}

Return ONLY a JSON object — no prose, no markdown outside the JSON — of this exact shape:
{"note":"one short sentence on what you fixed","files":[{"path":"<path>","content":"<COMPLETE corrected file content>"}]}
Include the FULL content of every file you change. Do not truncate. Only include files you actually changed.`;

  const res = await sendChatMessage({ messages: [{ role: 'user', content: prompt }] });
  const parsed = extractJsonObject(res.text) as
    | { note?: string; files?: { path?: string; content?: string }[] }
    | null;

  const out: Record<string, string> = {};
  for (const f of parsed?.files || []) {
    if (f && typeof f.path === 'string' && typeof f.content === 'string') {
      out[f.path.replace(/^\/+/, '')] = f.content;
    }
  }
  return { files: out, note: parsed?.note };
};
