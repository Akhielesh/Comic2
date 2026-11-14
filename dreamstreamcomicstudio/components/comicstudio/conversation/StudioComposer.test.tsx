import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// The mic is a stand-in that hands its props to the test, which then plays the take's end (the hook's own tests
// cover the take itself).
const mic = vi.hoisted(() => ({
  props: null as null | {
    onFinal: (t: string, info: { end: string; engine: string }) => void;
    onPartial?: (t: string) => void;
    onTypeInstead?: () => void;
    align?: string;
    showHeard?: boolean;
    disabled?: boolean;
    sendsOnDone?: boolean;
    stackAboveRef?: { current: HTMLElement | null };
    onEngineChange?: (engine: 'whisper' | 'webspeech') => void;
  },
  webSpeech: true,
  /** The engine stored in the mic's settings (ds.dictation.v1). */
  engine: 'webspeech' as 'whisper' | 'webspeech'
}));
vi.mock('../../chat/DictationButton', () => ({
  DictationButton: (props: NonNullable<typeof mic.props>) => {
    mic.props = props;
    return <button type="button">mock-mic</button>;
  }
}));
vi.mock('../../../hooks/useDictation', () => ({
  voiceInputSupported: () => true,
  webSpeechSupported: () => mic.webSpeech,
  loadDictationSettings: () => ({ engine: mic.engine, model: 'base' })
}));
// jsdom can't decode images: the shared refs pipeline is stubbed to "prepared as is" (its own tests cover it).
vi.mock('../refs/downscale', async (importOriginal) => {
  const real = await importOriginal<typeof import('../refs/downscale')>();
  return {
    ...real,
    prepareImageFile: vi.fn(async (file: File & { hash?: string }) => ({
      blob: file,
      mimeType: file.type || 'image/jpeg',
      w: 1200,
      h: 900,
      ...(file.hash ? { hash: file.hash } : {}),
      name: file.name,
      bytes: file.size,
      sourceBytes: file.size
    }))
  };
});
vi.mock('../studioApi', async (importOriginal) => ({ ...(await importOriginal<typeof import('../studioApi')>()), deleteInboxRef: vi.fn(async () => undefined) }));

import { MAX_IMAGES, MAX_MESSAGE_CHARS, StudioComposer, VOICE_AUTOSEND_KEY, buildOutgoing, textToDataUrl } from './StudioComposer';
import { prepareImageFile, PrepareError } from '../refs/downscale';
import { deleteInboxRef } from '../studioApi';
import { composeInStudio } from './composerBus';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices } from './testing/fixtures';
import { TIER_PRESETS, getImageModel, resolveImageJob } from '../../../shared/comic/models';
import { FormFactorProvider, formFactorFor } from '../mobile/useFormFactor';
import { labelInName } from '../mobile/testing/labelInName';
import { enterAction, selectionLabel, sendArgs } from './StudioComposer';
import type { ComicStudioController } from '../useStudio';

const textarea = () => screen.getByLabelText('Message the Comic Director') as HTMLTextAreaElement;

beforeEach(() => {
  window.localStorage.clear();
  showDollarPrices();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetUsageStatus();
});

describe('StudioComposer — sending', () => {
  it('Start sends its opening idea once after loading, with image work gated', async () => {
    const studio = makeFakeStudio();
    const consumed = vi.fn();
    const initialIdea = { id: 'new-project-idea', text: 'A heist on the rooftops' };
    const { rerender } = render(<StudioComposer studio={{ ...studio, doc: null }} initialIdea={initialIdea} onInitialIdeaConsumed={consumed} />);
    expect(consumed).not.toHaveBeenCalled();
    rerender(<StudioComposer studio={studio} initialIdea={initialIdea} onInitialIdeaConsumed={consumed} />);
    expect(studio.send).toHaveBeenCalledExactlyOnceWith(initialIdea.text, { attachments: [], planningOnly: true });
    expect(consumed).toHaveBeenCalledExactlyOnceWith(initialIdea.id);
    fireEvent.change(textarea(), { target: { value: 'My next note' } });
    rerender(<StudioComposer studio={studio} initialIdea={{ ...initialIdea }} onInitialIdeaConsumed={consumed} />);
    expect(textarea()).toHaveValue('My next note');
    expect(studio.send).toHaveBeenCalledTimes(1);
  });

  it('preserves an existing draft while Start sends only its captured long script', () => {
    const studio = makeFakeStudio();
    const { rerender } = render(<StudioComposer studio={studio} />);
    fireEvent.change(textarea(), { target: { value: 'Keep this note.' } });
    const script = 'Scene: '.repeat(12000);
    rerender(<StudioComposer studio={studio} initialIdea={{ id: 'long-script', text: script }} />);
    expect(textarea()).toHaveValue('Keep this note.');
    const expected = buildOutgoing(script, []);
    expect(studio.send).toHaveBeenCalledExactlyOnceWith(expected.text, { attachments: expected.attachments, planningOnly: true });
  });

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
  it('Format chip shows aspect and story-led length and opens the format panel; picking a kind patches instantly', () => {
    const studio = makeFakeStudio();
    const { rerender } = render(<StudioComposer studio={studio} />);
    const chip = screen.getByRole('button', { name: /Format/ });
    expect(chip).toHaveTextContent('2:3 · Story-led length');
    fireEvent.click(chip);
    const panel = screen.getByRole('dialog', { name: 'Format' });
    fireEvent.click(within(panel).getByRole('radio', { name: /Manga/ }));
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'format', patch: { kind: 'manga', readingDirection: 'rtl' } }]);
    fireEvent.click(within(panel).getByRole('button', { name: 'Set page count' }));
    expect(studio.patch).toHaveBeenLastCalledWith([{ op: 'format', patch: { pageCountMode: 'fixed' } }]);
    studio.doc = { ...studio.doc!, format: { ...studio.doc!.format, pageCountMode: 'fixed' } };
    rerender(<StudioComposer studio={studio} />);
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

  // DC-1 wave note 3 (lead D10): from 1024 the composer chip is quality's on-screen home (the header has none there).
  it('the quality chip is one home of the quality action and reads "{Tier} · {Model}" when roomy, never a price', () => {
    const studio = makeFakeStudio();
    render(<StudioComposer studio={studio} />);
    const chip = screen.getByRole('button', { name: /^Quality:/ });
    expect(chip).toHaveAttribute('data-action', 'quality');
    const doc = studio.doc!;
    const model = resolveImageJob('page', doc.settings.quality, doc.settings.imageModelOverride).spec.nickname;
    expect(chip).toHaveTextContent(`${TIER_PRESETS[doc.settings.quality]!.label} · ${model}`);
    expect(chip.textContent).not.toMatch(/[$¢]/);
    expect(within(chip).queryByTestId('composer-quality-lock')).toBeNull();
    // The other chips carry no action id.
    expect(screen.getByRole('button', { name: /^Format/ })).not.toHaveAttribute('data-action');
  });

  it('a locked comic shows the locked model, the lock glyph and the words ", locked for this comic"', () => {
    const doc = makeSampleDoc();
    // Lock to the Pro tier's model (the registry names it; no model id spelled out here).
    const locked = resolveImageJob('page', 'pro').spec;
    doc.imageModel = { modelId: locked.id, lockedAt: 1, origin: 'user_change' };
    render(<StudioComposer studio={makeFakeStudio({ doc })} />);
    const chip = screen.getByRole('button', { name: /^Quality:/ });
    expect(chip).toHaveTextContent(`· ${getImageModel(locked.id)!.nickname}`);
    expect(within(chip).getByTestId('composer-quality-lock')).toBeInTheDocument();
    expect(chip).toHaveAccessibleName(expect.stringContaining(', locked for this comic'));
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
  // How a take ended, and on which engine (hooks/useDictation FinalInfo).
  const done = { end: 'user', engine: 'browser-cloud' } as const;
  const speak = (words: string, info: { end: string; engine: string } = done) =>
    act(() => {
      mic.props!.onFinal(words, info);
    });
  const chooseAutoSend = () => window.localStorage.setItem(VOICE_AUTOSEND_KEY, 'true');
  const setLanguage = (lang: string) => Object.defineProperty(window.navigator, 'language', { configurable: true, get: () => lang });

  beforeEach(() => {
    mic.props = null;
    mic.webSpeech = true;
    mic.engine = 'webspeech';
    setLanguage('en-US');
  });

  it('with nothing chosen, a Done take puts the words in the box and sends nothing', () => {
    const studio = makeFakeStudio();
    render(<StudioComposer studio={studio} />);
    expect(screen.getByRole('button', { name: 'Send when I tap Done' })).toHaveAttribute('aria-pressed', 'false');
    speak('make it rain');
    expect(textarea().value).toBe('make it rain');
    expect(studio.send).not.toHaveBeenCalled();
  });

  it('auto-send, once chosen, sends only on a Done tap: never on a pause, the limit, a hidden tab, Esc or the browser’s own end', () => {
    chooseAutoSend();
    for (const end of ['escape', 'silence', 'no-speech', 'limit', 'hidden', 'device', 'engine']) {
      const studio = makeFakeStudio();
      const { unmount } = render(<StudioComposer studio={studio} />);
      speak('make it rain', { end, engine: 'browser-cloud' });
      expect(studio.send, end).not.toHaveBeenCalled();
      expect(textarea().value, end).toBe('make it rain');
      unmount();
    }
    const studio = makeFakeStudio();
    render(<StudioComposer studio={studio} />);
    expect(screen.getByRole('button', { name: 'Send when I tap Done' })).toHaveAttribute('aria-pressed', 'true');
    speak('make it rain');
    expect(studio.send).toHaveBeenCalledWith('make it rain', []);
  });

  it('auto-send never sends the private voice model’s words, a language other than English, or a removal', () => {
    chooseAutoSend();
    const whisper = makeFakeStudio();
    const first = render(<StudioComposer studio={whisper} />);
    speak('make it rain', { end: 'user', engine: 'whisper' });
    expect(whisper.send).not.toHaveBeenCalled();
    expect(textarea().value).toBe('make it rain');
    first.unmount();

    const removal = makeFakeStudio();
    const second = render(<StudioComposer studio={removal} />);
    speak('delete page 3');
    expect(removal.send).not.toHaveBeenCalled();
    expect(textarea().value).toBe('delete page 3');
    expect(screen.getByRole('status')).toHaveTextContent('This asks to remove something, so it waits for you. Check it, then tap Send.');
    second.unmount();

    setLanguage('es-ES');
    const spanish = makeFakeStudio();
    render(<StudioComposer studio={spanish} />);
    expect(screen.queryByRole('button', { name: 'Send when I tap Done' })).toBeNull(); // it could never act here
    speak('haz que llueva');
    expect(spanish.send).not.toHaveBeenCalled();
  });

  it('the words land at the cursor, replacing a selection, with one space on each side', () => {
    render(<StudioComposer studio={makeFakeStudio()} />);
    fireEvent.change(textarea(), { target: { value: 'Page 2 is moody' } });
    textarea().setSelectionRange(6, 6);
    speak('and page 3');
    expect(textarea().value).toBe('Page 2 and page 3 is moody');

    fireEvent.change(textarea(), { target: { value: 'Give the hero a cape' } });
    textarea().setSelectionRange(9, 13); // "hero"
    speak('dragon');
    expect(textarea().value).toBe('Give the dragon a cape');
  });

  it('only a Done tap moves focus into the box; a hidden tab or the limit leaves it where it was', () => {
    render(<StudioComposer studio={makeFakeStudio()} />);
    const other = document.createElement('button');
    document.body.appendChild(other);
    other.focus();
    speak('make it rain', { end: 'hidden', engine: 'whisper' });
    expect(document.activeElement).toBe(other);
    speak('and windy', { end: 'limit', engine: 'whisper' });
    expect(document.activeElement).toBe(other);
    speak('at night', { end: 'user', engine: 'whisper' });
    expect(document.activeElement).toBe(textarea());
    other.remove();
  });

  it('the mic lines up its boxes with its left edge and shows the words heard in its own bar, not in the box', () => {
    render(<StudioComposer studio={makeFakeStudio()} />);
    expect(mic.props?.align).toBe('start');
    expect(mic.props?.showHeard).toBe(true);
    expect(mic.props?.onPartial).toBeUndefined(); // the draft is never rewritten while the person talks
    expect(typeof mic.props?.onTypeInstead).toBe('function');
  });

  it('the toggle says exactly what it does and is remembered', () => {
    const studio = makeFakeStudio();
    const { unmount } = render(<StudioComposer studio={studio} />);
    const toggle = screen.getByRole('button', { name: 'Send when I tap Done' });
    expect(toggle.getAttribute('title')).toMatch(/^Off: your words wait in the box for you to read and send/);
    fireEvent.click(toggle);
    expect(window.localStorage.getItem(VOICE_AUTOSEND_KEY)).toBe('true');
    expect(toggle.getAttribute('title')).toMatch(/^On: browser dictation in English sends when you tap Done\. The private voice model, and messages that ask to remove something, always wait/);
    unmount();

    render(<StudioComposer studio={makeFakeStudio()} />);
    expect(screen.getByRole('button', { name: 'Send when I tap Done' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText(/stop talking/i)).toBeNull();
  });

  it('the send setting shows only while browser dictation is the chosen engine, and follows a change in the mic’s settings', () => {
    mic.engine = 'whisper'; // the default: the private voice model, which never sends by itself
    chooseAutoSend();
    render(<StudioComposer studio={makeFakeStudio()} />);
    expect(screen.queryByRole('button', { name: 'Send when I tap Done' })).toBeNull();
    expect(mic.props?.sendsOnDone).toBe(false);
    act(() => mic.props!.onEngineChange!('webspeech'));
    expect(screen.getByRole('button', { name: 'Send when I tap Done' })).toHaveAttribute('aria-pressed', 'true');
    expect(mic.props?.sendsOnDone).toBe(true);
    act(() => mic.props!.onEngineChange!('whisper'));
    expect(screen.queryByRole('button', { name: 'Send when I tap Done' })).toBeNull();
  });

  it('the mic is told Done sends exactly when it will: the setting on, browser dictation, English, ready to send', () => {
    const off = render(<StudioComposer studio={makeFakeStudio()} />);
    expect(mic.props?.sendsOnDone).toBe(false);
    off.unmount();

    chooseAutoSend();
    const on = render(<StudioComposer studio={makeFakeStudio()} />);
    expect(mic.props?.sendsOnDone).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Send when I tap Done' })); // turned off again
    expect(mic.props?.sendsOnDone).toBe(false);
    on.unmount();

    chooseAutoSend();
    setLanguage('es-ES');
    render(<StudioComposer studio={makeFakeStudio()} />);
    expect(mic.props?.sendsOnDone).toBe(false);
  });

  it('the mic keeps its boxes clear of the composer box: they open above the box that holds the text area', () => {
    render(<StudioComposer studio={makeFakeStudio()} />);
    const box = mic.props?.stackAboveRef?.current;
    expect(box).toBeInstanceOf(HTMLElement);
    expect(box).toHaveAttribute('data-composer-box');
    expect(box!.contains(textarea())).toBe(true);
    expect(box!.contains(screen.getByText('mock-mic'))).toBe(true);
  });

  it('the toggle is hidden where browser dictation does not exist (it could never act)', () => {
    mic.webSpeech = false;
    render(<StudioComposer studio={makeFakeStudio()} />);
    expect(screen.getByText('mock-mic')).toBeInTheDocument(); // the mic itself stays
    expect(screen.queryByRole('button', { name: /send when|auto-send/i })).toBeNull();
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

  it('photos go through the shared refs pipeline (prepare → inbox); one the server could not take goes inline, never lost', async () => {
    const studio = makeFakeStudio(); // its uploadRef answers {} — no stored copy
    render(<StudioComposer studio={studio} />);
    const photo = new File([new Uint8Array([137, 80, 78, 71])], 'maya.png', { type: 'image/png' });
    fireEvent.change(fileInput(), { target: { files: [photo] } });
    await screen.findByAltText('maya.png');
    expect(prepareImageFile).toHaveBeenCalledWith(photo);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    expect(screen.getByText(/Couldn’t add that photo to the comic — it will go with your message instead/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(studio.send).toHaveBeenCalledWith('', [{ name: 'maya.png', mimeType: 'image/png', dataUrl: expect.stringMatching(/^data:image\/png/) }]);
  });

  it('refuses honestly: originals over 40 MB, unsafe SVGs and unsupported files', async () => {
    const studio = makeFakeStudio();
    render(<StudioComposer studio={studio} />);
    const big = new File(['x'], 'huge.jpg', { type: 'image/jpeg' });
    Object.defineProperty(big, 'size', { value: 41 * 1024 * 1024 });
    const fifteen = new File(['x'], 'phone.jpg', { type: 'image/jpeg' });
    Object.defineProperty(fifteen, 'size', { value: 15 * 1024 * 1024 });
    fireEvent.change(fileInput(), { target: { files: [big, fifteen] } });
    const rows = await screen.findByRole('list', { name: 'Uploads' });
    expect(within(rows).getByText('huge.jpg').closest('li')).toHaveTextContent(/over 40 MB/);
    // A 15 MB phone photo is fine: it is shrunk in the browser before it uploads.
    expect(await screen.findByAltText('phone.jpg')).toBeInTheDocument();
    vi.mocked(prepareImageFile).mockRejectedValueOnce(new PrepareError('svg', 'Use a static SVG or export it as PNG.'));
    fireEvent.change(fileInput(), { target: { files: [new File(['<svg onload="unsupported()"/>'], 'logo.svg', { type: 'image/svg+xml' })] } });
    expect(await within(screen.getByRole('list', { name: 'Uploads' })).findByText('logo.svg')).toBeInTheDocument();
    expect(screen.getByText(/Use a static SVG or export it as PNG/)).toBeInTheDocument();
    const zip = new File(['x'], 'archive.zip', { type: 'application/zip' });
    fireEvent.change(fileInput(), { target: { files: [zip] } });
    expect(await screen.findByText(/archive\.zip isn't supported/)).toBeInTheDocument();
  });

  it('prepares a file selected by its SVG extension and passes only the raster to the inbox and inline fallback', async () => {
    const studio = makeFakeStudio();
    render(<StudioComposer studio={studio} />);
    const vector = new File(['<svg viewBox="0 0 32 32"><rect width="16" height="16"/></svg>'], 'sticker.svg', { type: 'application/octet-stream' });
    const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
    vi.mocked(prepareImageFile).mockResolvedValueOnce({ blob, mimeType: 'image/png', w: 2048, h: 2048, name: vector.name, bytes: blob.size, sourceBytes: vector.size });
    expect(fileInput().getAttribute('accept')).toContain('image/svg+xml');
    fireEvent.change(fileInput(), { target: { files: [vector] } });
    await screen.findByAltText('sticker.svg');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    expect(prepareImageFile).toHaveBeenCalledWith(vector);
    expect(studio.uploadRef).toHaveBeenCalledWith(blob, expect.anything(), expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(studio.send).toHaveBeenCalledWith('', [{ name: 'sticker.svg', mimeType: 'image/png', dataUrl: expect.stringMatching(/^data:image\/png/) }]);
  });

  it('a removed photo is not sent, and its inbox copy is deleted', async () => {
    const uploadRef = vi.fn(async () => ({ ref: { path: 'u/1/p/proj_1/ref/inbox/a.webp' } }));
    const studio = makeFakeStudio({ uploadRef: uploadRef as never });
    render(<StudioComposer studio={studio} />);
    fireEvent.change(fileInput(), { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    await screen.findByAltText('a.png');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    const remove = screen.getByRole('button', { name: 'Remove a.png' });
    // The corner position sits on a wrapper: on touch, `.tap-target { position: relative }` (index.css,
    // after the utilities) would otherwise override `absolute` and drop the ✕ under the thumbnail.
    expect(remove).toHaveClass('tap-target');
    expect(remove).not.toHaveClass('absolute');
    expect(remove.parentElement).toHaveClass('absolute');
    fireEvent.click(remove);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(deleteInboxRef).toHaveBeenCalledWith('proj_1', 'u/1/p/proj_1/ref/inbox/a.webp');
  });

  it('removing a photo that REUSED an inbox copy keeps that copy (another draft or a failed message may still send it)', async () => {
    vi.mocked(deleteInboxRef).mockClear();
    // One copy already waits in the inbox (same original file), the other is the server's exact duplicate.
    const doc = makeSampleDoc({ refInbox: [{ path: 'u/1/p/proj_1/ref/inbox/waiting.webp', source: 'upload', at: 1, hash: 'cccccccccccccccc' }] });
    const uploadRef = vi.fn(async () => ({ duplicateOf: 'u/1/p/proj_1/ref/inbox/earlier.webp' }));
    render(<StudioComposer studio={makeFakeStudio({ doc, uploadRef: uploadRef as never })} />);
    const waiting = Object.assign(new File(['w'], 'waiting.png', { type: 'image/png' }), { hash: 'cccccccccccccccc' });
    const dup = Object.assign(new File(['d'], 'dup.png', { type: 'image/png' }), { hash: 'dddddddddddddddd' });
    fireEvent.change(fileInput(), { target: { files: [waiting, dup] } });
    await waitFor(() => expect(uploadRef).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Remove waiting.png' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove dup.png' }));
    expect(screen.queryByRole('list', { name: 'Attachments' })).toBeNull();
    expect(deleteInboxRef).not.toHaveBeenCalled();
  });

  it('pasted images attach; pasted text stays in the box', async () => {
    render(<StudioComposer studio={makeFakeStudio()} />);
    const img = new File(['x'], 'clip.png', { type: 'image/png' });
    fireEvent.paste(textarea(), { clipboardData: { files: [img], getData: () => '' } });
    expect(await screen.findByAltText('clip.png')).toBeInTheDocument();
  });

  it(`caps photos per message at ${MAX_IMAGES} (they upload to the inbox, not inside the message)`, async () => {
    render(<StudioComposer studio={makeFakeStudio()} />);
    const files = Array.from({ length: MAX_IMAGES + 1 }, (_, i) => new File([`x${i}`], `p${i}.png`, { type: 'image/png' }));
    fireEvent.change(fileInput(), { target: { files } });
    expect(await screen.findByText(new RegExp(`Up to ${MAX_IMAGES} photos per message`))).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Attachments' })).getAllByRole('img')).toHaveLength(MAX_IMAGES));
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
  it('adds a selected research image through the upload pipeline and preserves the draft and attribution', async () => {
    const path = 'u/1/ref/inbox/station.webp';
    const uploadRef = vi.fn(async () => ({ ref: { path } }));
    const studio = makeFakeStudio({ uploadRef: uploadRef as never });
    render(<StudioComposer studio={studio} />);
    fireEvent.change(textarea(), { target: { value: 'Keep the station entrance visible.' } });
    const result = { title: 'Station exterior', source: 'https://commons.wikimedia.org/wiki/File:Station.jpg', credit: 'Photographer', license: 'CC BY 4.0' };
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'station.png', { type: 'image/png' });
    act(() => composeInStudio({ research: { projectId: studio.doc!.id, result, file } }));
    await waitFor(() => expect(uploadRef).toHaveBeenCalledWith(file, { kind: 'inbox' }, expect.objectContaining({ name: 'station.png' })));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    expect(textarea().value).toBe(`Keep the station entrance visible.\n\nVisual reference: Station exterior (Photographer · CC BY 4.0)\n${result.source}`);
    expect(textarea()).toHaveFocus();
    expect(studio.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(studio.send).toHaveBeenCalledWith(expect.stringContaining(result.source), { attachments: [], inboxPaths: [path] });
  });

  it('ignores research downloads belonging to a different comic', () => {
    const studio = makeFakeStudio();
    render(<StudioComposer studio={studio} />);
    act(() => composeInStudio({ research: { projectId: 'previous_comic', result: { title: 'Station', source: 'https://en.wikipedia.org/wiki/Station' }, file: new File(['image'], 'station.png', { type: 'image/png' }) } }));
    expect(textarea().value).toBe('');
    expect(studio.uploadRef).not.toHaveBeenCalled();
    expect(studio.send).not.toHaveBeenCalled();
  });

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

describe('StudioComposer — the quality chip is quality’s home from 1024 px (DC-1 #3, D10; s2b review)', () => {
  const lockedDoc = () => {
    const doc = makeSampleDoc();
    doc.imageModel = { modelId: resolveImageJob('page', 'pro').spec.id, lockedAt: 1, origin: 'user_change' };
    return doc;
  };
  /** A composer narrower than ROOMY_PX (400): jsdom measures 0, so the width is faked for the size hook. */
  const narrow = () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 120, width: 320, height: 120, toJSON: () => ({}) } as DOMRect);
    return spy;
  };

  it('leads the chip row, so the row’s scroller can never clip it, and the lock leads its words', () => {
    renderAt(DESKTOP, makeFakeStudio({ doc: lockedDoc() }));
    const chips = within(screen.getByRole('toolbar', { name: 'Comic options' })).getAllByRole('button');
    expect(chips[0]).toHaveAttribute('data-action', 'quality');
    const chip = chips[0];
    const lock = within(chip).getByTestId('composer-quality-lock');
    const words = within(chip).getByText(/·|Standard|Pro|Draft/);
    expect(lock.compareDocumentPosition(words) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('at 1024 px and up it never hides, even in a composer narrower than 400 px: a compact "{Tier}" and the lock', () => {
    const spy = narrow();
    try {
      for (const w of [1024, 1280]) {
        const { unmount } = renderAt(formFactorFor({ w, h: 800, coarse: false }), makeFakeStudio({ doc: lockedDoc() }));
        const chip = document.querySelector<HTMLElement>('[data-action="quality"]')!;
        expect(chip.className.split(/\s+/), `${w} px`).not.toContain('hidden');
        expect(within(chip).getByTestId('composer-quality-lock')).toBeInTheDocument();
        // Compact: the tier only; the model is in the title (a tier and a model, never a price).
        expect(chip.textContent).not.toContain('·');
        expect(chip.getAttribute('title')).toMatch(/·/);
        expect(chip.getAttribute('title')).not.toMatch(/[$¢]/);
        unmount();
      }
      // Below 1024 the header has the chip, so a narrow composer still steps aside.
      renderAt(formFactorFor({ w: 900, h: 800, coarse: false }), makeFakeStudio({ doc: lockedDoc() }));
      expect(document.querySelector<HTMLElement>('[data-action="quality"]')!.className.split(/\s+/)).toContain('hidden');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('StudioComposer — option chips say what they show (composer-chip-names, WCAG 2.5.3)', () => {
  it('each chip’s accessible name contains its visible text', () => {
    renderAt(TABLET, makeFakeStudio());
    const chips = within(screen.getByRole('toolbar', { name: 'Comic options' })).getAllByRole('button');
    expect(chips.length).toBeGreaterThanOrEqual(2);
    for (const c of chips) {
      const r = labelInName(c);
      expect(r.ok, `"${r.visible}" ⊄ "${r.name}"`).toBe(true);
    }
  });
});

describe('StudioComposer — short windows (phones in landscape)', () => {
  const LANDSCAPE = formFactorFor({ w: 844, h: 390, coarse: true });

  it('the box and its controls share one row (the conversation keeps its height); portrait keeps two rows', () => {
    const { unmount } = renderAt(LANDSCAPE, makeFakeStudio());
    expect(LANDSCAPE.layout).toBe('single-rail');
    const box = screen.getByLabelText('Message the Comic Director');
    const row = box.closest('[data-composer-row="inline"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.className).toContain('flex');
    // The Send button and the option chips sit in the same row as the box.
    expect(row.contains(screen.getByRole('button', { name: 'Send' }))).toBe(true);
    expect(row.contains(screen.getByRole('toolbar', { name: 'Comic options' }))).toBe(true);
    expect(box.className).toContain('flex-1');
    expect(box.className).not.toMatch(/(^| )w-full( |$)/);
    unmount();
    renderAt(PHONE, makeFakeStudio());
    const tall = screen.getByLabelText('Message the Comic Director');
    expect(tall.closest('[data-composer-row="inline"]')).toBeNull();
    expect(tall.className).toMatch(/(^| )w-full( |$)/);
  });
});

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
    // GIF and AVIF are offered; HEIC is left out on purpose so the iOS picker hands over JPEG.
    expect(camera.accept).toBe('image/jpeg,image/png,image/webp,image/gif,image/avif');
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

  it('attaches a saved image by path without uploading or deleting its inbox copy', () => {
    const path = 'u/1/ref/inbox/toolbox.webp';
    const doc = makeSampleDoc({ refInbox: [{ path, name: 'Toolbox', source: 'upload', at: 1 }] });
    const uploadRef = vi.fn();
    const studio = makeFakeStudio({ doc, uploadRef });
    renderAt(DESKTOP, studio);
    const chooseSaved = () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add images or a script' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /Saved images/ }));
    };
    chooseSaved();
    fireEvent.click(screen.getByRole('button', { name: 'Toolbox' }));
    expect(screen.getByAltText('Toolbox')).toBeInTheDocument();
    chooseSaved();
    expect(screen.getByRole('button', { name: /Toolbox · Added/ })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Toolbox' }));
    chooseSaved();
    fireEvent.click(screen.getByRole('button', { name: 'Toolbox' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(uploadRef).not.toHaveBeenCalled();
    expect(deleteInboxRef).not.toHaveBeenCalled();
    expect(studio.send).toHaveBeenCalledWith('', { attachments: [], inboxPaths: [path] });
  });

  it('photos upload to the inbox with a progress ring; Send waits for them, then they travel by path', async () => {
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
    const photo = Object.assign(new File([new Uint8Array([137, 80, 78, 71])], 'maya.png', { type: 'image/png' }), { hash: '0123456789abcdef' });
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [photo] } });
    await screen.findByAltText('maya.png');
    await waitFor(() => expect(uploadRef).toHaveBeenCalledWith(photo, { kind: 'inbox' }, expect.objectContaining({ name: 'maya.png', hash: '0123456789abcdef' })));
    fireEvent.change(textarea(), { target: { value: 'This is Maya' } });
    // Still uploading: Send waits (the server only takes inbox paths that exist) and says why.
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute('title', 'Waiting for your photos to finish uploading');
    expect(screen.getByText(/Uploading 1 photo — Send waits until it’s in/)).toBeInTheDocument();
    act(() => progress?.(0.4));
    expect(screen.getByRole('progressbar', { name: 'Uploading maya.png' })).toHaveAttribute('aria-valuenow', '40');
    await act(async () => finish({ ref: { path: 'u/1/ref/inbox/maya.webp' } }));
    expect(screen.queryByRole('progressbar')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(studio.send).toHaveBeenCalledWith('This is Maya', { attachments: [], inboxPaths: ['u/1/ref/inbox/maya.webp'] });
  });

  it('an exact duplicate the server already holds reuses that copy (duplicateOf → inboxPath)', async () => {
    const uploadRef = vi.fn(async () => ({ duplicateOf: 'u/1/ref/inbox/earlier.webp' }));
    const studio = makeFakeStudio({ uploadRef: uploadRef as never });
    renderAt(DESKTOP, studio);
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [new File(['x'], 'again.png', { type: 'image/png' })] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(studio.send).toHaveBeenCalledWith('', { attachments: [], inboxPaths: ['u/1/ref/inbox/earlier.webp'] });
  });

  it('a photo already waiting in the comic inbox is reused for free; the same photo twice in one message is kept once', async () => {
    const doc = makeSampleDoc({ refInbox: [{ path: 'u/1/ref/inbox/kept.webp', source: 'upload', at: 1, hash: 'aaaaaaaaaaaaaaaa' }] });
    const uploadRef = vi.fn(async () => ({ ref: { path: 'u/1/ref/inbox/new.webp' } }));
    const studio = makeFakeStudio({ doc, uploadRef: uploadRef as never });
    renderAt(DESKTOP, studio);
    const known = Object.assign(new File(['k'], 'known.png', { type: 'image/png' }), { hash: 'aaaaaaaaaaaaaaaa' });
    const twin1 = Object.assign(new File(['t'], 'twin.png', { type: 'image/png' }), { hash: 'bbbbbbbbbbbbbbbb' });
    const twin2 = Object.assign(new File(['t'], 'twin-copy.png', { type: 'image/png' }), { hash: 'bbbbbbbbbbbbbbbb' });
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [known, twin1, twin2] } });
    expect(await screen.findByText(/twin-copy\.png is already in this message/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    expect(uploadRef).toHaveBeenCalledTimes(1); // only twin.png; known.png reused the inbox copy
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(studio.send).toHaveBeenCalledWith('', { attachments: [], inboxPaths: ['u/1/ref/inbox/kept.webp', 'u/1/ref/inbox/new.webp'] });
  });

  it('a photo the content rules refuse leaves the message with an honest row (never re-sent inline to fail later)', async () => {
    const refusal = Object.assign(new Error("This image doesn't fit DreamStream's content rules."), { kind: 'content_policy', code: 'CONTENT_POLICY' });
    const uploadRef = vi.fn(() => Promise.reject(refusal));
    const studio = makeFakeStudio({ uploadRef: uploadRef as never });
    renderAt(DESKTOP, studio);
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [new File(['x'], 'bad.png', { type: 'image/png' })] } });
    const rows = await screen.findByRole('list', { name: 'Uploads' });
    const row = within(rows).getByText('bad.png').closest('li') as HTMLElement;
    await waitFor(() => expect(row).toHaveAttribute('data-state', 'rejected'));
    expect(row).toHaveTextContent(/Not added — this image doesn't fit DreamStream's content rules/);
    expect(within(row).getByRole('button', { name: "What's allowed?" })).toBeInTheDocument();
    expect(screen.queryByAltText('bad.png')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.click(within(row).getByRole('button', { name: 'Dismiss bad.png' }));
    expect(screen.queryByRole('list', { name: 'Uploads' })).toBeNull();
  });

  it('a full inbox says so on the row and nothing is sent for it', async () => {
    const full = Object.assign(new Error('Send or assign the 24 photos you’ve added first.'), { kind: 'limit', code: 'LIMIT' });
    const studio = makeFakeStudio({ uploadRef: vi.fn(() => Promise.reject(full)) as never });
    renderAt(DESKTOP, studio);
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [new File(['x'], 'more.png', { type: 'image/png' })] } });
    const row = (await screen.findByText(/Send or assign the 24 photos/)).closest('li') as HTMLElement;
    expect(row).toHaveAttribute('data-state', 'over_cap');
    expect(screen.queryByAltText('more.png')).toBeNull();
  });

  it('a network blip is retried once; after that the photo goes inline (Retry stays on its row)', async () => {
    const uploadRef = vi.fn(() => Promise.reject(Object.assign(new Error('offline'), { kind: 'network', retryable: true })));
    const studio = makeFakeStudio({ uploadRef: uploadRef as never });
    renderAt(DESKTOP, studio);
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [new File(['x'], 'ok.png', { type: 'image/png' })] } });
    await screen.findByAltText('ok.png');
    await waitFor(() => expect(uploadRef).toHaveBeenCalledTimes(2), { timeout: 4000 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    const row = screen.getByText('ok.png', { selector: 'p' }).closest('li') as HTMLElement;
    expect(row).toHaveTextContent(/it will go with your message instead/);
    expect(within(row).getByRole('button', { name: /Retry/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(studio.send).toHaveBeenCalledWith('', [{ name: 'ok.png', mimeType: 'image/png', dataUrl: expect.stringMatching(/^data:image\/png/) }]);
  });
});

describe('StudioComposer — quick-assign ("Who’s this?")', () => {
  const upload = () => {
    let n = 0;
    return vi.fn(async () => ({ ref: { path: `u/1/ref/inbox/p${(n += 1)}.webp` } }));
  };

  it('tap a photo to say who it is; the message carries attachmentTargets aligned with its photos', async () => {
    const studio = makeFakeStudio({ uploadRef: upload() as never });
    renderAt(DESKTOP, studio);
    fireEvent.change(screen.getByTestId('composer-file-input'), {
      target: { files: [new File(['a'], 'a.png', { type: 'image/png' }), new File(['b'], 'b.png', { type: 'image/png' })] }
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: "a.png: who's this?" }));
    const menu = screen.getByRole('menu', { name: "Who's in this photo?" });
    // The cast comes first (leads and support), then New character, places, the style.
    const rows = within(menu).getAllByRole('menuitemradio').map((r) => r.textContent || '');
    expect(rows[0]).toMatch(/^MAYA/);
    expect(rows[1]).toMatch(/^ARJUN/);
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /MAYA/ }));
    expect(screen.getByRole('button', { name: 'a.png: MAYA. Change who this is' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(studio.send).toHaveBeenCalledWith('', {
      attachments: [],
      inboxPaths: ['u/1/ref/inbox/p1.webp', 'u/1/ref/inbox/p2.webp'],
      attachmentTargets: [{ kind: 'character', id: 'c_maya' }, null]
    });
  });

  it('"Assign all" files every photo at once — including a brand-new character by name', async () => {
    const studio = makeFakeStudio({ uploadRef: upload() as never });
    renderAt(DESKTOP, studio);
    fireEvent.change(screen.getByTestId('composer-file-input'), {
      target: { files: [new File(['a'], 'a.png', { type: 'image/png' }), new File(['b'], 'b.png', { type: 'image/png' })] }
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Assign all 2 to/ }));
    const menu = screen.getByRole('menu', { name: "Who's in these 2 photos?" });
    fireEvent.click(within(menu).getByRole('menuitem', { name: /New character/ }));
    // Naming is its own step: the field is never inside role="menu" (axe aria-required-children).
    const field = screen.getByLabelText("New character's name");
    expect(field.closest('[role="menu"]')).toBeNull();
    // "Back to the cast" returns to the list without choosing anything.
    fireEvent.click(screen.getByRole('button', { name: 'Back to the cast' }));
    fireEvent.click(within(screen.getByRole('menu', { name: "Who's in these 2 photos?" })).getByRole('menuitem', { name: /New character/ }));
    fireEvent.change(screen.getByLabelText("New character's name"), { target: { value: '  Bruno ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getAllByText('New: BRUNO')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const opts = studio.send.mock.calls[0][1];
    expect(opts.attachmentTargets).toEqual([
      { kind: 'new_character', name: 'Bruno' },
      { kind: 'new_character', name: 'Bruno' }
    ]);
  });

  it('"Let the director decide" clears a choice (no targets are sent when nothing is assigned)', async () => {
    const studio = makeFakeStudio({ uploadRef: upload() as never });
    renderAt(DESKTOP, studio);
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [new File(['a'], 'a.png', { type: 'image/png' })] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: "a.png: who's this?" }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: /Art style reference/ }));
    fireEvent.click(screen.getByRole('button', { name: 'a.png: Style. Change who this is' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: /Let the director decide/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(studio.send).toHaveBeenCalledWith('', { attachments: [], inboxPaths: ['u/1/ref/inbox/p1.webp'] });
  });

  it('sendArgs only sends targets when at least one photo is assigned', () => {
    expect(sendArgs({ text: 'hi', attachments: [] }, ['p'], false, [null])).toEqual(['hi', { attachments: [], inboxPaths: ['p'] }]);
    expect(sendArgs({ text: 'hi', attachments: [] }, ['p'], false, [{ kind: 'style' }])).toEqual([
      'hi',
      { attachments: [], inboxPaths: ['p'], attachmentTargets: [{ kind: 'style' }] }
    ]);
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
    fireEvent.click(screen.getByRole('button', { name: /^Format:/ }));
    expect(screen.getByRole('dialog', { name: 'Format' })).toHaveAttribute('data-sheet', 'bottom');
  });

  it('the bus can open a panel (and the sheet variant leaves the bus to the docked composer)', async () => {
    const docked = makeFakeStudio();
    renderAt(DESKTOP, docked);
    act(() => composeInStudio({ openPanel: 'quality' }));
    expect(await screen.findByRole('dialog', { name: 'Quality' })).toBeInTheDocument();
  });

  it('the sheet (no activity line) puts "Stop drawing" beside Send while pages still draw after the reply', () => {
    const at = (studio: ComicStudioController) => (
      <FormFactorProvider value={PHONE}>
        <StudioComposer studio={studio} variant="sheet" />
      </FormFactorProvider>
    );
    const drawing = makeFakeStudio({ busy: true, messageBusy: false, renderingTotal: 2 });
    const { rerender } = render(at(drawing));
    fireEvent.change(textarea(), { target: { value: 'Darker sky' } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    const stop = screen.getByRole('button', { name: 'Stop drawing' });
    expect(stop).toHaveAttribute('title', 'Stop drawing (images already drawing finish and are kept)');
    fireEvent.click(stop);
    expect(drawing.cancel).toHaveBeenCalledTimes(1);
    // Stopping: disabled until the streams close.
    rerender(at(makeFakeStudio({ busy: true, messageBusy: false, renderingTotal: 2, cancelling: true })));
    expect(screen.getByRole('button', { name: 'Stopping' })).toBeDisabled();
    // While the director works it is the director's Stop; with nothing drawing there is no Stop drawing.
    rerender(at(makeFakeStudio({ busy: true, messageBusy: true, renderingTotal: 2 })));
    expect(screen.queryByRole('button', { name: 'Stop drawing' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    rerender(at(makeFakeStudio()));
    expect(screen.queryByRole('button', { name: /^Stop/ })).toBeNull();
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
