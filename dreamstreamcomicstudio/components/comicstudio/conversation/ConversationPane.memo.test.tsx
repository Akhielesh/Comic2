// Memoised rows (PROGRAM3 SETTLE-UI PF-7a; perf.md F9: every streamed token re-rendered the whole conversation). The
// rows are React.memo over a controller kept while only `drafts` changes, so a token delta re-renders only the row
// it streams into. Counted through the markdown renderer each director reply mounts.

import React from 'react';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetRef, Msg } from '../../../shared/comic/doc';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import { ConversationPane } from './ConversationPane';
import { __resetEntrances } from './MessageItem';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices } from './testing/fixtures';

const renders = vi.hoisted(() => new Map<string, number>());
vi.mock('../../chat/ChatMarkdown', () => ({
  ChatMarkdown: ({ text }: { text: string }) => {
    const key = text.split(' ')[0];
    renders.set(key, (renders.get(key) ?? 0) + 1);
    return <p>{text}</p>;
  }
}));

beforeEach(() => {
  showDollarPrices();
  __resetEntrances();
  renders.clear();
});
afterEach(resetUsageStatus);

const conversation = (n: number): Msg[] =>
  Array.from({ length: n }, (_, i): Msg =>
    i % 2 === 0
      ? { id: `u${i}`, role: 'user', text: `note-${i}`, at: 10 + i }
      : { id: `a${i}`, role: 'assistant', text: `reply-${i} done`, at: 10 + i, cards: [{ type: 'notice', id: `n${i}`, tone: 'info', text: `card ${i}` }] }
  );

describe('a token delta', () => {
  it.each([
    ['settled cards off', DEFAULT_CAPS],
    ['settled cards on', { ...DEFAULT_CAPS, admin: true }]
  ])('re-renders only the streaming row (%s)', (_label, caps) => {
    const doc = makeSampleDoc({ conversation: conversation(20) });
    const studio = makeFakeStudio({ doc, caps, messageBusy: true, busy: true, drafts: { a19: 'reply-19 done and' } });
    const { rerender } = render(<ConversationPane studio={studio} />);
    expect(renders.get('reply-1')).toBe(1);
    renders.clear();
    // One SSE text event: only `drafts` changes (useStudio's controller is a new object with every other field equal).
    rerender(<ConversationPane studio={{ ...studio, drafts: { a19: 'reply-19 done and more words' } }} />);
    expect([...renders.keys()]).toEqual(['reply-19']);
    rerender(<ConversationPane studio={{ ...studio, drafts: { a19: 'reply-19 done and more words still' } }} />);
    expect([...renders.entries()]).toEqual([['reply-19', 2]]);
  });

  it.each([
    ['settled cards off', DEFAULT_CAPS],
    ['settled cards on', { ...DEFAULT_CAPS, admin: true }]
  ])('re-renders no user row (%s): a bubble resolves its photos only when it renders', (_label, caps) => {
    const photo = (i: number): AssetRef => ({ path: `u/x/inbox/memo_${i}.webp`, source: 'upload', at: 1 });
    const withPhotos = conversation(20).map((m, i) => (m.role === 'user' ? { ...m, attachments: [photo(i)] } : m));
    const base = makeFakeStudio({ doc: makeSampleDoc({ conversation: withPhotos }), caps, messageBusy: true, busy: true, drafts: { a19: 'reply-19 done and' } });
    // Every UserBubble render asks urlFor for each of its photos: the count of those asks is the count of bubble renders.
    const urlFor = vi.fn(base.urlFor);
    const studio = { ...base, urlFor };
    const bubbleRenders = () => urlFor.mock.calls.filter(([a]) => typeof a === 'object' && !!a && String(a.path).includes('/memo_')).length;
    const { rerender } = render(<ConversationPane studio={studio} />);
    expect(bubbleRenders()).toBeGreaterThanOrEqual(10);
    urlFor.mockClear();
    rerender(<ConversationPane studio={{ ...studio, drafts: { a19: 'reply-19 done and more words' } }} />);
    rerender(<ConversationPane studio={{ ...studio, drafts: { a19: 'reply-19 done and more words still' } }} />);
    expect(bubbleRenders()).toBe(0);
  });

  it('anything else a row can read re-renders the rows (a new doc revision is never hidden by the memo)', () => {
    const doc = makeSampleDoc({ conversation: conversation(6) });
    const studio = makeFakeStudio({ doc });
    const { rerender, container } = render(<ConversationPane studio={studio} />);
    renders.clear();
    const next = makeSampleDoc({ conversation: conversation(6).map((m) => (m.id === 'a1' ? { ...m, text: 'reply-1 edited' } : m)) });
    rerender(<ConversationPane studio={{ ...studio, doc: next }} />);
    expect(container.textContent).toContain('reply-1 edited');
    rerender(<ConversationPane studio={{ ...studio, doc: next, byok: true }} />);
    expect(renders.get('reply-3')).toBeGreaterThanOrEqual(1);
  });
});
