import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../../chat/DictationButton', () => ({
  DictationButton: (props: { onStart?: () => void; onPartial: (t: string) => void; onFinal: (t: string) => void; disabled?: boolean }) => (
    <div>
      <button type="button" onClick={() => props.onStart?.()}>
        mock-mic-start
      </button>
      <button type="button" onClick={() => props.onPartial('make it')}>
        mock-mic-partial
      </button>
      <button type="button" onClick={() => props.onFinal('make it rain')}>
        mock-mic-final
      </button>
    </div>
  )
}));
vi.mock('../../../hooks/useDictation', () => ({ voiceInputSupported: () => true }));

import { MAX_MESSAGE_CHARS, StudioComposer, VOICE_AUTOSEND_KEY, buildOutgoing, shrinkImage, textToDataUrl } from './StudioComposer';
import { composeInStudio } from './composerBus';
import { makeFakeStudio, makeSampleDoc } from './testing/fixtures';

const textarea = () => screen.getByLabelText('Message the Comic Director') as HTMLTextAreaElement;

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('StudioComposer — sending', () => {
  it('Enter sends the trimmed message; Shift+Enter does not', () => {
    const studio = makeFakeStudio();
    render(<StudioComposer studio={studio} />);
    fireEvent.change(textarea(), { target: { value: '  A heist on the rooftops  ' } });
    fireEvent.keyDown(textarea(), { key: 'Enter', shiftKey: true });
    expect(studio.send).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(studio.send).toHaveBeenCalledWith('A heist on the rooftops', []);
    expect(textarea().value).toBe('');
  });

  it('the send button is disabled while empty, and becomes Stop during a director turn', () => {
    const idle = makeFakeStudio();
    const { rerender } = render(<StudioComposer studio={idle} />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.change(textarea(), { target: { value: 'hi' } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();

    const busy = makeFakeStudio({ messageBusy: true, busy: true });
    rerender(<StudioComposer studio={busy} />);
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(busy.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(busy.cancel).toHaveBeenCalled();
    expect(textarea().value).toBe('hi'); // the draft survives the busy turn
  });

  it('is disabled until the doc has loaded', () => {
    render(<StudioComposer studio={makeFakeStudio({ doc: null })} />);
    expect(textarea()).toBeDisabled();
  });
});

describe('StudioComposer — option chips', () => {
  it('Format chip shows aspect and pages and opens the format panel; picking a kind patches instantly', () => {
    const studio = makeFakeStudio();
    render(<StudioComposer studio={studio} />);
    const chip = screen.getByRole('button', { name: /Format/ });
    expect(chip).toHaveTextContent('2:3 · 6p');
    fireEvent.click(chip);
    const panel = screen.getByRole('dialog', { name: 'Format' });
    fireEvent.click(within(panel).getByRole('radio', { name: /Manga/ }));
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'format', patch: { kind: 'manga', readingDirection: 'rtl' } }]);
    fireEvent.click(within(panel).getByRole('button', { name: '12' }));
    expect(studio.patch).toHaveBeenLastCalledWith([{ op: 'format', patch: { pageCount: 12 } }]);
  });

  it('Escape and outside clicks close the panel', async () => {
    render(<StudioComposer studio={makeFakeStudio()} />);
    fireEvent.click(screen.getByRole('button', { name: /Quality/ }));
    expect(screen.getByRole('dialog', { name: 'Quality' })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Art style/ }));
    expect(screen.getByRole('dialog', { name: 'Style' })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Quality panel lists tiers with per-page prices and patches the setting', () => {
    const studio = makeFakeStudio();
    render(<StudioComposer studio={studio} />);
    fireEvent.click(screen.getByRole('button', { name: /Quality/ }));
    const panel = screen.getByRole('dialog', { name: 'Quality' });
    expect(within(panel).getByRole('radio', { name: /Standard/ })).toHaveAttribute('aria-checked', 'true');
    expect(within(panel).getByRole('radio', { name: /Pro/ })).toHaveTextContent('Nano Banana Pro');
    expect(within(panel).getByRole('radio', { name: /Draft/ })).toHaveTextContent('$0.05/page');
    fireEvent.click(within(panel).getByRole('radio', { name: /Pro/ }));
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'settings', patch: { quality: 'pro' } }]);
  });

  it('Style panel: a preset drafts the style; exploring directions runs the spend action', () => {
    const doc = makeSampleDoc();
    doc.style = { ...doc.style, options: [] };
    const studio = makeFakeStudio({ doc });
    render(<StudioComposer studio={studio} />);
    const chip = screen.getByRole('button', { name: /Art style/ });
    expect(chip).toHaveTextContent('Noir ink');
    fireEvent.click(chip);
    const panel = screen.getByRole('dialog', { name: 'Style' });
    expect(within(panel).getByRole('radio', { name: /Noir ink/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(panel).getByRole('radio', { name: /^Manga/ }));
    const ops = studio.patch.mock.calls[0][0];
    expect(ops[0]).toMatchObject({ op: 'style', patch: { status: 'drafted', presetId: 'manga-screentone', name: 'Manga' } });
    expect(ops[1]).toEqual({ op: 'format', patch: { colorMode: 'bw' } });

    fireEvent.click(within(panel).getByRole('button', { name: /Explore 3 directions/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_style_options' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('exploring is disabled while style options are still drawing', () => {
    render(<StudioComposer studio={makeFakeStudio()} />);
    fireEvent.click(screen.getByRole('button', { name: /Art style/ }));
    expect(screen.getByRole('button', { name: /Drawing style options/ })).toBeDisabled();
  });

  it('a locked style asks before a preset replaces it', () => {
    const doc = makeSampleDoc();
    doc.style = { ...doc.style, status: 'locked', board: { path: 'u/x/board.webp', source: 'generated', at: 1 } };
    const studio = makeFakeStudio({ doc });
    render(<StudioComposer studio={studio} />);
    fireEvent.click(screen.getByRole('button', { name: /Art style/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Retro pop/ }));
    expect(studio.patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Replace style' }));
    expect(studio.patch.mock.calls[0][0][0]).toMatchObject({ op: 'style', patch: { presetId: 'retro-pop', board: null } });
  });

  it('"Describe your own…" prefills the composer', () => {
    render(<StudioComposer studio={makeFakeStudio()} />);
    fireEvent.click(screen.getByRole('button', { name: /Art style/ }));
    fireEvent.click(screen.getByRole('button', { name: /Describe your own/ }));
    expect(textarea().value).toBe('Art style: ');
    expect(textarea().placeholder).toMatch(/Describe the look/);
  });
});

describe('StudioComposer — voice', () => {
  it('auto-sends the transcript by default', () => {
    const studio = makeFakeStudio();
    render(<StudioComposer studio={studio} />);
    expect(screen.getByRole('button', { name: 'Auto-send when I stop talking' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByText('mock-mic-start'));
    fireEvent.click(screen.getByText('mock-mic-final'));
    expect(studio.send).toHaveBeenCalledWith('make it rain', []);
  });

  it('the toggle is persisted; when off the transcript joins the typed draft for review', () => {
    const studio = makeFakeStudio();
    const { unmount } = render(<StudioComposer studio={studio} />);
    fireEvent.click(screen.getByRole('button', { name: 'Auto-send when I stop talking' }));
    expect(window.localStorage.getItem(VOICE_AUTOSEND_KEY)).toBe('false');
    fireEvent.change(textarea(), { target: { value: 'Page 2:' } });
    fireEvent.click(screen.getByText('mock-mic-start'));
    fireEvent.click(screen.getByText('mock-mic-partial'));
    expect(textarea().value).toBe('Page 2: make it');
    fireEvent.click(screen.getByText('mock-mic-final'));
    expect(textarea().value).toBe('Page 2: make it rain');
    expect(studio.send).not.toHaveBeenCalled();
    unmount();

    render(<StudioComposer studio={makeFakeStudio()} />);
    expect(screen.getByRole('button', { name: 'Auto-send when I stop talking' })).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('StudioComposer — attachments', () => {
  const fileInput = () => screen.getByTestId('composer-file-input') as HTMLInputElement;

  const decode = (dataUrl: string) => new TextDecoder().decode(Uint8Array.from(atob(dataUrl.split(',')[1]), (c) => c.charCodeAt(0)));

  it('sends attached scripts as UTF-8 text attachments (the server files long ones as the source)', async () => {
    const studio = makeFakeStudio();
    render(<StudioComposer studio={studio} />);
    const script = new File(['INT. ROOFTOP — NIGHT\r\nMaya runs. Café lights.'], 'script.md', { type: 'text/markdown' });
    fireEvent.change(fileInput(), { target: { files: [script] } });
    await screen.findByText('script.md');
    fireEvent.change(textarea(), { target: { value: 'Adapt this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const [text, attachments] = studio.send.mock.calls[0];
    expect(text).toBe('Adapt this');
    expect(attachments).toEqual([{ name: 'script.md', mimeType: 'text/markdown', dataUrl: expect.stringMatching(/^data:text\/markdown;base64,/) }]);
    expect(decode(attachments[0].dataUrl)).toBe('INT. ROOFTOP — NIGHT\nMaya runs. Café lights.');
  });

  it('sends images as attachments and can send them without text', async () => {
    const studio = makeFakeStudio();
    render(<StudioComposer studio={studio} />);
    const photo = new File([new Uint8Array([137, 80, 78, 71])], 'maya.png', { type: 'image/png' });
    fireEvent.change(fileInput(), { target: { files: [photo] } });
    await screen.findByAltText('maya.png');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(studio.send).toHaveBeenCalledWith('', [{ name: 'maya.png', mimeType: 'image/png', dataUrl: expect.stringMatching(/^data:image\/png/) }]);
  });

  it('rejects oversized images and unsupported files with a clear notice', async () => {
    render(<StudioComposer studio={makeFakeStudio()} />);
    const big = new File(['x'], 'huge.jpg', { type: 'image/jpeg' });
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
    fireEvent.change(fileInput(), { target: { files: [big] } });
    expect(await screen.findByText(/huge\.jpg is over 10 MB/)).toBeInTheDocument();
    const pdf = new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput(), { target: { files: [pdf] } });
    expect(await screen.findByText(/notes\.pdf isn't supported/)).toBeInTheDocument();
  });

  it('a removed attachment is not sent', async () => {
    const studio = makeFakeStudio();
    render(<StudioComposer studio={studio} />);
    fireEvent.change(fileInput(), { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    await screen.findByAltText('a.png');
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }));
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('pasted images attach; pasted text stays in the box', async () => {
    render(<StudioComposer studio={makeFakeStudio()} />);
    const img = new File(['x'], 'clip.png', { type: 'image/png' });
    fireEvent.paste(textarea(), { clipboardData: { files: [img], getData: () => '' } });
    expect(await screen.findByAltText('clip.png')).toBeInTheDocument();
  });

  it('shrinkImage downsizes big photos to a 2048 px WebP, and keeps small ones as they are', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4000, height: 3000, close })));
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/webp;base64,AA');
    const big = new File(['x'], 'big.jpg', { type: 'image/jpeg' });
    expect(await shrinkImage(big, `data:image/jpeg;base64,${'A'.repeat(5000)}`)).toEqual({ dataUrl: 'data:image/webp;base64,AA', mimeType: 'image/webp' });
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 2048, 1536);
    expect(close).toHaveBeenCalled();

    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 800, height: 600, close })));
    expect(await shrinkImage(new File(['x'], 'small.png', { type: 'image/png' }), 'data:image/png;base64,AA')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('caps files per message', async () => {
    render(<StudioComposer studio={makeFakeStudio()} />);
    const files = Array.from({ length: 7 }, (_, i) => new File(['x'], `p${i}.png`, { type: 'image/png' }));
    fireEvent.change(fileInput(), { target: { files } });
    expect(await screen.findByText(/Up to 6 files per message/)).toBeInTheDocument();
    expect(screen.getAllByRole('img')).toHaveLength(6);
  });

  it('text over the server message cap goes up as a script file instead of failing', () => {
    const long = 'x'.repeat(MAX_MESSAGE_CHARS + 1);
    const out = buildOutgoing(long, []);
    expect(out.text).toBe('');
    expect(out.attachments).toEqual([{ name: 'pasted-script.txt', mimeType: 'text/plain', dataUrl: textToDataUrl(long) }]);
    expect(buildOutgoing('  hi  ', [])).toEqual({ text: 'hi', attachments: [] });
  });
});

describe('StudioComposer — external requests', () => {
  it('fills the draft and hint from the composer bus', async () => {
    render(<StudioComposer studio={makeFakeStudio()} />);
    act(() => composeInStudio({ text: 'Turn my script into a comic:\n\n', hint: 'Paste your script below' }));
    await waitFor(() => expect(textarea().value).toBe('Turn my script into a comic:\n\n'));
    expect(textarea().placeholder).toBe('Paste your script below');
  });

  it('Cmd/Ctrl+K focuses the composer', async () => {
    render(
      <>
        <button type="button">elsewhere</button>
        <StudioComposer studio={makeFakeStudio()} />
      </>
    );
    screen.getByText('elsewhere').focus();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await waitFor(() => expect(document.activeElement).toBe(textarea()));
  });
});
