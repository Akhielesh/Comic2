// Gate L7: "Improve my prompt" is never silent. When the server skips the polish because the included usage
// is used up (`skipped: 'usage'`, nothing spent, draft echoed back) the composer says so in one calm line,
// and a failed request says the draft is unchanged — never a raw error. A real polish still offers undo.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const chat = vi.hoisted(() => ({ enhancePrompt: vi.fn() }));
vi.mock('../../services/chatApi', () => ({ enhancePrompt: chat.enhancePrompt }));
vi.mock('./DictationButton', () => ({ DictationButton: () => null }));

import { ChatComposer, ENHANCE_FAILED_NOTE, ENHANCE_PAUSED_NOTE } from './ChatComposer';

const features = { reasoning: false, webSearch: false, vision: false, structured: false, longContext: false, contextLength: 8000 };

const setup = () => {
  const onSend = vi.fn();
  render(
    <ChatComposer
      busy={false}
      features={features}
      reasoningLevel={'medium' as never}
      webSearch={false}
      dreamstreamAccess={false}
      enabledTools={[]}
      toolsSupported={false}
      mcpServers={[]}
      enabledMcpServers={[]}
      onReasoningChange={() => undefined}
      onWebToggle={() => undefined}
      onDreamstreamToggle={() => undefined}
      onToggleConnector={() => undefined}
      onToggleMcpServer={() => undefined}
      onSend={onSend}
      onStop={() => undefined}
    />
  );
  const box = screen.getByPlaceholderText(/Message the model/) as HTMLTextAreaElement;
  const polish = screen.getByTitle(/Improve my prompt/);
  return { box, polish, onSend };
};

const type = (box: HTMLTextAreaElement, value: string) => fireEvent.change(box, { target: { value } });

beforeEach(() => {
  chat.enhancePrompt.mockReset();
});

describe('ChatComposer prompt polish', () => {
  it('usage used up: a calm note, the draft untouched, nothing to undo', async () => {
    chat.enhancePrompt.mockResolvedValue({ enhanced: 'draw a fox comic', skipped: 'usage' });
    const { box, polish } = setup();
    type(box, 'draw a fox comic');
    await act(async () => {
      fireEvent.click(polish);
    });
    expect(chat.enhancePrompt).toHaveBeenCalledWith('draw a fox comic');
    expect(screen.getByRole('status')).toHaveTextContent(ENHANCE_PAUSED_NOTE);
    expect(box.value).toBe('draw a fox comic');
    expect(screen.queryByText('Prompt enhanced.')).toBeNull();
    // The note goes away as soon as they keep typing.
    type(box, 'draw a fox comic, please');
    expect(screen.queryByText(ENHANCE_PAUSED_NOTE)).toBeNull();
  });

  it('a failed request says the draft is unchanged (never a raw error)', async () => {
    chat.enhancePrompt.mockRejectedValue(new Error('ECONNRESET socket hang up'));
    const { box, polish } = setup();
    type(box, 'a robot in the rain');
    await act(async () => {
      fireEvent.click(polish);
    });
    expect(screen.getByRole('status')).toHaveTextContent(ENHANCE_FAILED_NOTE);
    expect(screen.queryByText(/ECONNRESET/)).toBeNull();
    expect(box.value).toBe('a robot in the rain');
  });

  it('a real polish replaces the draft and offers undo (no note)', async () => {
    chat.enhancePrompt.mockResolvedValue({ enhanced: 'A moody four-panel comic: a small robot waits in the rain.' });
    const { box, polish } = setup();
    type(box, 'a robot in the rain');
    await act(async () => {
      fireEvent.click(polish);
    });
    expect(box.value).toBe('A moody four-panel comic: a small robot waits in the rain.');
    expect(screen.getByText('Prompt enhanced.')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
