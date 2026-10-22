import { it } from 'vitest';
import { GOLDEN_DOCS } from './fixtures.js';
import { DIRECTOR_SYSTEM_PROMPT, summarizeDocForDirector } from '../director.js';
import { buildTurnToolset, createDirectorTurn } from '../tools.js';
import { toolGroups } from '../tools/index.js';
import { newSession, testContext } from '../orchestrator.fakes.js';
it('baseline', () => {
  const out: Record<string, number> = {};
  for (const [key, make] of Object.entries(GOLDEN_DOCS)) {
    const doc = make();
    const ctx = testContext(newSession(doc));
    const turn = createDirectorTurn({ userText: 'hello' });
    const ts = buildTurnToolset(ctx, turn, toolGroups());
    const prompt = ts.promptRules.length ? `${DIRECTOR_SYSTEM_PROMPT}\n\n${ts.promptRules.join('\n')}` : DIRECTOR_SYSTEM_PROMPT;
    const sys = prompt + '\n\n' + summarizeDocForDirector(doc, false, ts.summaryLines);
    out[key] = sys.length + JSON.stringify(ts.tools.map((t) => t.spec)).length;
    out[key + ':sys'] = prompt.length;
    out[key + ':tools'] = JSON.stringify(ts.tools.map((t) => t.spec)).length;
    out[key + ':n'] = ts.tools.length;
  }
  console.log('BASELINE', JSON.stringify(out));
});
