// Headless proof that ChatMarkdown is memoized: when a parent re-renders but passes
// the SAME `text` prop (the streaming-token case — a token landing on another turn, a
// timer tick, an agent_activity upsert), ChatMarkdown's body must NOT re-run, so
// react-markdown is not re-invoked (no re-parse). Replaces the manual "watch React
// DevTools" check. FAILS (re-parses on every parent render) without the React.memo
// wrapper on ChatMarkdown; PASSES with it.

import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// The only observable signal that ChatMarkdown's body executed is that its child
// <ReactMarkdown> rendered (i.e. a re-parse). Mock react-markdown with a trivial
// render-counting stub — we assert render COUNT, not parsed output, so no real parser
// is needed. remark/rehype are passed to this stub as props (harmless); stub them and
// the markdown children so nothing unrelated inflates the count.
const markdownRenders = vi.fn();
vi.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => {
    markdownRenders();
    return <div data-testid="react-markdown">{children}</div>;
  }
}));
vi.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));
vi.mock('rehype-sanitize', () => ({
  __esModule: true,
  default: () => undefined,
  defaultSchema: { tagNames: [], attributes: {} }
}));
vi.mock('./CodeBlock', () => ({ CodeBlock: () => null }));
vi.mock('./MarkdownTable', () => ({ MarkdownTable: () => null }));

import { ChatMarkdown } from './ChatMarkdown';

// A minimal test parent with a force-update button. Re-rendering it does NOT change the
// `text` passed to ChatMarkdown — exactly what happens as unrelated chat state (a
// streaming token on another turn, a timer tick) updates around a settled turn.
function ForceUpdatingParent({ text }: { text: string }) {
  const [, setTick] = useState(0);
  return (
    <div>
      <button onClick={() => setTick((n) => n + 1)}>force-update</button>
      <ChatMarkdown text={text} />
    </div>
  );
}

beforeEach(() => markdownRenders.mockClear());

describe('ChatMarkdown memoization', () => {
  it('does not re-render (re-parse) when the parent re-renders with the same text', () => {
    render(<ForceUpdatingParent text={'# Title\n\nSome **markdown** body.'} />);

    // Initial mount: parsed once.
    expect(markdownRenders).toHaveBeenCalledTimes(1);

    // Two parent force-updates with an UNCHANGED text prop.
    fireEvent.click(screen.getByText('force-update'));
    fireEvent.click(screen.getByText('force-update'));

    // With React.memo the body is skipped both times → still 1 parse.
    // Without it, each parent render re-runs the body → 3 (this assertion fails).
    expect(markdownRenders).toHaveBeenCalledTimes(1);
  });

  it('DOES re-render when the text prop actually changes (memo must not over-cache)', () => {
    const { rerender } = render(<ChatMarkdown text="first" />);
    expect(markdownRenders).toHaveBeenCalledTimes(1);

    rerender(<ChatMarkdown text="second" />);
    expect(markdownRenders).toHaveBeenCalledTimes(2);

    // Re-passing an identical value does not re-parse.
    rerender(<ChatMarkdown text="second" />);
    expect(markdownRenders).toHaveBeenCalledTimes(2);
  });
});
