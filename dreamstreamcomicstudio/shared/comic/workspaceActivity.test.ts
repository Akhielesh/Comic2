// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { makeSampleDoc, SAMPLE_NOW } from '../../components/comicstudio/board/__fixtures__/sampleDoc';
import { summarizeComicWork } from './workspaceActivity';

describe('private comic summaries', () => {
  it('distinguishes saved output, running work and current attention; history never stores private content', () => {
    const doc = makeSampleDoc();
    const summary = summarizeComicWork(doc);
    expect(summary.working).toBe(true);
    expect(summary.finished).toContainEqual({ kind: 'pages', at: SAMPLE_NOW, count: 2 });
    expect(JSON.stringify(summary)).not.toMatch(/Saffron|\.webp|summar|script|modelId|price/i);
    doc.gate = { id: 'approved-expense', status: 'open', imageCount: 1 } as NonNullable<typeof doc.gate>;
    expect(summarizeComicWork(doc).attention).toBe('approval');
    doc.gate.status = 'approved';
    expect(summarizeComicWork(doc).attention).not.toBe('approval');
  });
  it('does not advertise uploads, withheld pictures or a welcome message as a finished task', () => {
    const doc = makeSampleDoc();
    doc.pages = [];
    doc.conversation = [{ id: 'hi', role: 'assistant', text: 'Welcome', at: 2 }];
    doc.cover.render = { status: 'ready', history: [], asset: { path: 'private', source: 'upload', at: 3 } };
    expect(summarizeComicWork(doc).finished.map((item) => item.kind)).not.toContain('cover');
    doc.cover.render.asset = { path: 'withheld', source: 'generated', at: 4, safety: { quarantined: true, at: 4 } };
    expect(summarizeComicWork(doc).finished.map((item) => item.kind)).not.toContain('cover');
    expect(summarizeComicWork(doc).finished.map((item) => item.kind)).not.toContain('reply');
    doc.conversation.push({ id: 'ask', role: 'user', text: 'Explore a theme', at: 8 }, { id: 'answer', role: 'assistant', text: 'Draft completed.', at: 9 });
    expect(summarizeComicWork(doc).finished).toContainEqual({ kind: 'reply', at: 9 });
  });
});
