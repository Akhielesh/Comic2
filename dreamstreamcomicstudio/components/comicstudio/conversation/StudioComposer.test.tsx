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
import { FormFactorProvider, formFactorFor } from '../mobile/useFormFactor';
import { enterAction, selectionLabel, sendArgs } from './StudioComposer';
import type { ComicStudioController } from '../useStudio';

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
    // The action carries the quote the user saw (P1-CONVERSATION's StylePanel).
    expect(studio.act).toHaveBeenCalledWith(expect.objectContaining({ type: 'render_style_options' }));
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
    // .pdf/.docx/.fdx are now accepted (extracted in-browser); a .zip is genuinely unsupported.
    const zip = new File(['x'], 'archive.zip', { type: 'application/zip' });
    fireEvent.change(fileInput(), { target: { files: [zip] } });
    expect(await screen.findByText(/archive\.zip isn't supported/)).toBeInTheDocument();
  });

  it('a removed attachment is not sent', async () => {
    const studio = makeFakeStudio();
    render(<StudioComposer studio={studio} />);
    fireEvent.change(fileInput(), { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    await screen.findByAltText('a.png');
    const remove = screen.getByRole('button', { name: 'Remove a.png' });
    // The corner position sits on a wrapper: on touch, `.tap-target { position: relative }` (index.css,
    // after the utilities) would otherwise override `absolute` and drop the ✕ under the thumbnail.
    expect(remove).toHaveClass('tap-target');
    expect(remove).not.toHaveClass('absolute');
    expect(remove.parentElement).toHaveClass('absolute');
    fireEvent.click(remove);
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

// ── v5: touch Enter rule, inbox uploads, focus chip, attach sheet (contract §13.4; mobile.md §3.8) ──


const PHONE = formFactorFor({ w: 390, h: 844, coarse: true });
const TABLET = formFactorFor({ w: 1180, h: 820, coarse: true });
const DESKTOP = formFactorFor({ w: 1440, h: 900, coarse: false });

const renderAt = (ff: ReturnType<typeof formFactorFor>, studio: ComicStudioController, props: Partial<React.ComponentProps<typeof StudioComposer>> = {}) =>
  render(
    <FormFactorProvider value={ff}>
      <StudioComposer studio={studio} {...props} />
    </FormFactorProvider>
  );

describe('StudioComposer — the Enter rule by pointer', () => {
  it('enterAction: coarse → newline, fine → send, Shift → newline, ⌘/Ctrl → always send, IME → nothing', () => {
    expect(enterAction({ key: 'Enter' }, true)).toBe('newline');
    expect(enterAction({ key: 'Enter' }, false)).toBe('send');
    expect(enterAction({ key: 'Enter', shiftKey: true }, false)).toBe('newline');
    expect(enterAction({ key: 'Enter', metaKey: true }, true)).toBe('send');
    expect(enterAction({ key: 'Enter', ctrlKey: true }, true)).toBe('send');
    expect(enterAction({ key: 'Enter', isComposing: true }, false)).toBe('none');
    expect(enterAction({ key: 'a' }, false)).toBe('none');
  });

  it.each([
    ['phone', PHONE],
    ['touch tablet', TABLET]
  ])('on a %s Enter is a newline and the button sends; ⌘/Ctrl+Enter still sends', (_label, ff) => {
    const studio = makeFakeStudio();
    renderAt(ff, studio);
    const box = textarea();
    expect(box).toHaveAttribute('enterkeyhint', 'enter');
    expect(box.className).toContain('text-base');
    expect(box.className).not.toContain('sm:text-[14px]');
    fireEvent.change(box, { target: { value: 'Line one' } });
    const notPrevented = fireEvent.keyDown(box, { key: 'Enter' });
    expect(notPrevented).toBe(true); // the textarea inserts its newline
    expect(studio.send).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(studio.send).toHaveBeenCalledWith('Line one', []);
  });

  it('with a mouse Enter sends (Shift+Enter is a newline) and the key hint says send', () => {
    const studio = makeFakeStudio();
    renderAt(DESKTOP, studio);
    const box = textarea();
    expect(box).toHaveAttribute('enterkeyhint', 'send');
    fireEvent.change(box, { target: { value: 'Hello' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(studio.send).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(studio.send).toHaveBeenCalledWith('Hello', []);
  });

  it('phones cap the box at 30 % of the visible height; 44 px send/attach targets on touch', () => {
    renderAt(PHONE, makeFakeStudio());
    expect(textarea().style.maxHeight).toContain('var(--app-h');
    expect(screen.getByRole('button', { name: 'Send' }).className).toContain('coarse:h-11');
    expect(screen.getByRole('button', { name: 'Add images or a script' }).className).toContain('coarse:h-11');
  });
});

describe('StudioComposer — attach sheet and inbox uploads', () => {
  it('on touch, + opens Photo library · Take a photo · Script — the camera input captures', () => {
    renderAt(PHONE, makeFakeStudio());
    fireEvent.click(screen.getByRole('button', { name: 'Add images or a script' }));
    const menu = screen.getByRole('menu', { name: 'Add to your message' });
    expect(within(menu).getByRole('menuitem', { name: /Photo library/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Script or document/ })).toBeInTheDocument();
    const camera = screen.getByTestId('composer-camera-input') as HTMLInputElement;
    expect(camera).toHaveAttribute('capture', 'environment');
    const click = vi.spyOn(camera, 'click').mockImplementation(() => undefined);
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Take a photo/ }));
    expect(click).toHaveBeenCalled();
    expect(screen.queryByRole('menu', { name: 'Add to your message' })).toBeNull();
  });

  it('a mouse on a roomy composer gets the file dialog directly (no camera row)', () => {
    renderAt(DESKTOP, makeFakeStudio());
    const click = vi.spyOn(screen.getByTestId('composer-file-input') as HTMLInputElement, 'click').mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Add images or a script' }));
    expect(click).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('images upload to the inbox with progress and travel by path when done', async () => {
    let finish: (v: unknown) => void = () => undefined;
    let progress: ((f: number) => void) | undefined;
    const uploadRef = vi.fn((_file: Blob, _target: unknown, opts?: { onProgress?: (f: number) => void }) => {
      progress = opts?.onProgress;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const studio = makeFakeStudio({ uploadRef: uploadRef as never });
    renderAt(DESKTOP, studio);
    const photo = new File([new Uint8Array([137, 80, 78, 71])], 'maya.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [photo] } });
    await screen.findByAltText('maya.png');
    expect(uploadRef).toHaveBeenCalledWith(expect.any(Blob), { kind: 'inbox' }, expect.objectContaining({ name: 'maya.png' }));
    act(() => progress?.(0.4));
    expect(screen.getByRole('progressbar', { name: 'Uploading maya.png' })).toHaveAttribute('aria-valuenow', '40');
    await act(async () => finish({ ref: { path: 'u/1/ref/inbox/maya.webp' } }));
    expect(screen.queryByRole('progressbar')).toBeNull();
    fireEvent.change(textarea(), { target: { value: 'This is Maya' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(studio.send).toHaveBeenCalledWith('This is Maya', { attachments: [], inboxPaths: ['u/1/ref/inbox/maya.webp'] });
  });

  it('an upload still running at send time goes inline instead and is aborted (never lost, no orphan)', async () => {
    let signal: AbortSignal | undefined;
    const uploadRef = vi.fn((_f: Blob, _t: unknown, opts?: { signal?: AbortSignal }) => {
      signal = opts?.signal;
      return new Promise(() => undefined);
    });
    const studio = makeFakeStudio({ uploadRef: uploadRef as never });
    renderAt(DESKTOP, studio);
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    await screen.findByAltText('a.png');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(studio.send).toHaveBeenCalledWith('', [{ name: 'a.png', mimeType: 'image/png', dataUrl: expect.stringMatching(/^data:image\/png/) }]);
    expect(signal?.aborted).toBe(true);
  });

  it('a photo the content rules refuse is taken out with the reason (never re-sent inline to fail later)', async () => {
    const refusal = Object.assign(new Error("This image doesn't fit DreamStream's content rules, so it wasn't added."), { kind: 'content_policy', code: 'CONTENT_POLICY' });
    const uploadRef = vi.fn(() => Promise.reject(refusal));
    const studio = makeFakeStudio({ uploadRef: uploadRef as never });
    renderAt(DESKTOP, studio);
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [new File(['x'], 'bad.png', { type: 'image/png' })] } });
    expect(await screen.findByText(/bad\.png: This image doesn't fit DreamStream's content rules/)).toBeInTheDocument();
    expect(screen.queryByAltText('bad.png')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('any other upload failure keeps the photo: it goes inline with the message', async () => {
    const uploadRef = vi.fn(() => Promise.reject(Object.assign(new Error('offline'), { kind: 'network' })));
    const studio = makeFakeStudio({ uploadRef: uploadRef as never });
    renderAt(DESKTOP, studio);
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [new File(['x'], 'ok.png', { type: 'image/png' })] } });
    await screen.findByAltText('ok.png');
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(studio.send).toHaveBeenCalledWith('', [{ name: 'ok.png', mimeType: 'image/png', dataUrl: expect.stringMatching(/^data:image\/png/) }]);
  });
});

describe('StudioComposer — the selection focus chip', () => {
  const withSelection = () => makeFakeStudio({ selection: { pageId: 'pg_2', lineIds: ['l1', 'l2'], surface: 'page_editor' } });

  it('selectionLabel names the page and what is selected', () => {
    const doc = makeSampleDoc();
    expect(selectionLabel(doc, { pageId: 'pg_2', lineIds: ['a'] })).toBe('Page 2 · 1 balloon');
    expect(selectionLabel(doc, { pageId: 'pg_2', lineIds: [], panelN: 3 })).toBe('Page 2 · panel 3');
    expect(selectionLabel(doc, { pageId: 'missing', lineIds: [] })).toBeNull();
    expect(selectionLabel(doc, null)).toBeNull();
  });

  it('a selection rides along as the message focus; dismissing the chip sends a plain message', () => {
    const studio = withSelection();
    const { unmount } = renderAt(DESKTOP, studio);
    expect(screen.getByText('About Page 2 · 2 balloons')).toBeInTheDocument();
    fireEvent.change(textarea(), { target: { value: 'Shorter, please' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(studio.send).toHaveBeenLastCalledWith('Shorter, please', { attachments: [], focus: 'selection' });
    unmount();

    const plain = withSelection();
    renderAt(DESKTOP, plain);
    fireEvent.click(screen.getByRole('button', { name: /Don’t tie the next message to Page 2/ }));
    expect(screen.queryByText(/About Page 2/)).toBeNull();
    fireEvent.change(textarea(), { target: { value: 'Something else' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(plain.send).toHaveBeenLastCalledWith('Something else', []);
  });

  it('sendArgs keeps the legacy array form unless inbox paths or a focus ride along', () => {
    expect(sendArgs({ text: 'hi', attachments: [] }, [], false)).toEqual(['hi', []]);
    expect(sendArgs({ text: 'hi', attachments: [] }, ['p'], true)).toEqual(['hi', { attachments: [], inboxPaths: ['p'], focus: 'selection' }]);
  });
});

describe('StudioComposer — phones and the sheet variant', () => {
  it('option panels open as bottom sheets on phones', () => {
    renderAt(PHONE, makeFakeStudio());
    fireEvent.click(screen.getByRole('button', { name: /Format: page shape/ }));
    expect(screen.getByRole('dialog', { name: 'Format' })).toHaveAttribute('data-sheet', 'bottom');
  });

  it('the bus can open a panel (and the sheet variant leaves the bus to the docked composer)', async () => {
    const docked = makeFakeStudio();
    renderAt(DESKTOP, docked);
    act(() => composeInStudio({ openPanel: 'quality' }));
    expect(await screen.findByRole('dialog', { name: 'Quality' })).toBeInTheDocument();
  });

  it('the sheet variant ignores the composer bus and ⌘K, and reports a send', () => {
    const onSent = vi.fn();
    renderAt(PHONE, makeFakeStudio(), { variant: 'sheet', onSent, placeholder: 'Ask about this board' });
    expect(textarea()).toHaveAttribute('placeholder', 'Ask about this board');
    act(() => composeInStudio({ text: 'from the bus' }));
    expect(textarea()).toHaveValue('');
    fireEvent.change(textarea(), { target: { value: 'Darker sky' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSent).toHaveBeenCalled();
  });
});
