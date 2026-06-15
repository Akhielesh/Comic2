import { describe, it, expect } from 'vitest';
import { buildAttachmentsBlock, isTrivialChat, isFastLaneChat } from './chat.js';

const dataUri = (mime: string, content: string): string =>
  `data:${mime};base64,${Buffer.from(content, 'utf8').toString('base64')}`;

describe('buildAttachmentsBlock', () => {
  it('returns an empty string when there are no attachments', () => {
    expect(buildAttachmentsBlock(undefined)).toBe('');
    expect(buildAttachmentsBlock([])).toBe('');
  });

  it('inlines the decoded contents of a text/data file so the model can read it', () => {
    const block = buildAttachmentsBlock([
      { name: 'sales.csv', mimeType: 'text/csv', dataUri: dataUri('text/csv', 'region,total\nEMEA,42\n') }
    ]);
    expect(block).toContain('ATTACHED FILES');
    expect(block).toContain('sales.csv');
    expect(block).toContain('contents included below');
    // The actual file content is present, not just the name.
    expect(block).toContain('region,total');
    expect(block).toContain('EMEA,42');
  });

  it('treats images as already-visible (vision) rather than inlining bytes', () => {
    const block = buildAttachmentsBlock([
      { name: 'photo.png', mimeType: 'image/png', dataUri: 'data:image/png;base64,iVBORw0KGgo=' }
    ]);
    expect(block).toContain('photo.png');
    expect(block).toMatch(/as an image/i);
    expect(block).not.toContain('iVBORw0KGgo=');
  });

  it('points binary files at run_python when tools are available', () => {
    const block = buildAttachmentsBlock(
      [{ name: 'report.pdf', mimeType: 'application/pdf', dataUri: 'data:application/pdf;base64,JVBERi0=' }],
      { canRunPython: true }
    );
    expect(block).toContain('report.pdf');
    expect(block).toContain('run_python');
    expect(block).toContain('/input/report.pdf');
  });

  it('does not mention run_python for binary files when it is unavailable', () => {
    const block = buildAttachmentsBlock(
      [{ name: 'report.pdf', mimeType: 'application/pdf', dataUri: 'data:application/pdf;base64,JVBERi0=' }],
      { canRunPython: false }
    );
    expect(block).toContain('report.pdf');
    expect(block).not.toContain('run_python');
  });

  it('truncates very large text files and notes where the rest lives', () => {
    const big = 'x'.repeat(20_000);
    const block = buildAttachmentsBlock([
      { name: 'big.txt', mimeType: 'text/plain', dataUri: dataUri('text/plain', big) }
    ]);
    expect(block).toContain('big.txt');
    expect(block).toMatch(/truncated/i);
    // Capped well under the original size.
    expect(block.length).toBeLessThan(20_000);
  });
});

describe('isTrivialChat', () => {
  it('treats greetings and acknowledgements as trivial (no web grounding needed)', () => {
    for (const t of ['hi', 'Hey!', 'hello', 'thanks', 'thank you so much', 'ok', 'cool', 'got it', 'bye']) {
      expect(isTrivialChat(t)).toBe(true);
    }
  });

  it('treats bare arithmetic as trivial', () => {
    expect(isTrivialChat('2+2')).toBe(true);
    expect(isTrivialChat('15 * (3 + 4)')).toBe(true);
    expect(isTrivialChat('what is 2+2')).toBe(true);
    expect(isTrivialChat("what's 100 / 4?")).toBe(true);
  });

  it('treats empty input as trivial', () => {
    expect(isTrivialChat('')).toBe(true);
    expect(isTrivialChat('   ')).toBe(true);
  });

  it('does NOT treat real questions as trivial', () => {
    expect(isTrivialChat('what is the capital of France')).toBe(false);
    expect(isTrivialChat('summarize the attached report')).toBe(false);
    expect(isTrivialChat('latest news on nvidia')).toBe(false);
    expect(isTrivialChat('hi, can you explain how recursion works?')).toBe(false);
  });
});

describe('isFastLaneChat', () => {
  it('fast-lanes focused knowledge questions the model can answer from training', () => {
    for (const t of [
      'what is the capital of France',
      'why is the sky blue?',
      'explain how recursion works',
      'what is photosynthesis',
      'tell me about Paris',
      "what's the difference between TCP and UDP",
      'how do I reverse a string in python?',
      'define entropy'
    ]) {
      expect(isFastLaneChat(t)).toBe(true);
    }
  });

  it('does NOT fast-lane questions that need live data, the web, or connectors', () => {
    for (const t of [
      'latest news on nvidia',
      "what's the price of bitcoin",
      'who won the 2024 election',
      'what is the weather in Tokyo',
      'search the web for the best laptop',
      'summarize my inbox',
      'check my calendar for tomorrow',
      'when is the next SpaceX launch'
    ]) {
      expect(isFastLaneChat(t)).toBe(false);
    }
  });

  it('does NOT fast-lane artifact builds or long, open-ended instructions', () => {
    expect(isFastLaneChat('build me a dashboard app')).toBe(false);
    expect(isFastLaneChat('write a 2000 word essay on the French revolution')).toBe(false);
    expect(isFastLaneChat('x'.repeat(300))).toBe(false);
  });

  it('keeps trivial turns out of the fast lane (they already route fast on their own)', () => {
    expect(isFastLaneChat('hi')).toBe(false);
    expect(isFastLaneChat('thanks')).toBe(false);
    expect(isFastLaneChat('2+2')).toBe(false);
    expect(isFastLaneChat('')).toBe(false);
  });
});
