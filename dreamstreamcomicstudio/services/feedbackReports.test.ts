import { afterEach, expect, it, vi } from 'vitest';
import { feedbackReportHelp, sendFeedbackReport } from './feedbackReports';

const input = { kind: 'bug' as const, submissionId: 'ef09c19a-613e-447b-bd26-27d6cd6aedbe', comment: 'Page froze', images: [] };
afterEach(() => vi.unstubAllGlobals());

it.each([
  [400, '', 'Check the description and screenshots'],
  [429, 'RATE_LIMITED', 'Wait a minute'],
  [429, '', 'remove the screenshots and send the text now']
] as const)('shows reviewed guidance for report response %s/%s', async (status, code, expected) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code, message: 'private upstream details' } }, { status })));
  const problem = await sendFeedbackReport(input, undefined, new AbortController().signal).catch(reason => reason);
  const guidance = feedbackReportHelp(problem, 'Please retry.');
  expect(guidance).toContain(expected);
  expect(guidance).not.toContain('private upstream details');
});
