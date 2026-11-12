// DictationButton (P2-CONVERSATION composer-dictation-split / composer-dictation-target-size): the mic
// and its settings caret are two real targets — at least 24 px wide with a mouse (axe target-size, WCAG
// 2.5.8: the caret measured 21 x 36) and 44 px on touch (the mic was 36, the caret 21-26) — and every
// recording-bar action has a name.
//
// Voice hotfix: the boxes it opens are placed next to the mic and clamped inside what the person can see
// (placeVoiceBox), they use the design tokens (no raw red, no raw z-index), the copy is true, an error is one
// calm sentence with one action and its technical detail only behind "Show details", and Esc stops a take
// keeping the words.
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { dictationError } from '../../services/dictation/errors';

const state = vi.hoisted(() => ({
  status: 'idle' as string,
  errorInfo: null as null | Record<string, unknown>,
  engine: 'whisper' as string,
  liveEngine: null as null | string,
  openingMic: false,
  /** The options the button gave the hook (its onPartial feeds the words heard). */
  opts: null as null | { onPartial?: (t: string) => void; onFinal: (t: string, i: unknown) => void },
  start: null as unknown as ReturnType<typeof vi.fn>,
  stop: null as unknown as ReturnType<typeof vi.fn>,
  cancel: null as unknown as ReturnType<typeof vi.fn>,
  dismissError: null as unknown as ReturnType<typeof vi.fn>,
  setSettings: null as unknown as ReturnType<typeof vi.fn>
}));
vi.mock('../../hooks/useDictation', () => ({
  voiceInputSupported: () => true,
  webSpeechSupported: () => true,
  useDictation: (opts: NonNullable<typeof state.opts>) => {
    state.opts = opts;
    return {
      status: state.status,
      level: 0,
      elapsed: 3,
      error: (state.errorInfo?.message as string) ?? null,
      errorInfo: state.errorInfo,
      download: null,
      openingMic: state.openingMic,
      settings: { engine: state.engine, model: 'base' },
      setSettings: state.setSettings,
      liveEngine: state.liveEngine,
      start: state.start,
      stop: state.stop,
      cancel: state.cancel,
      dismissError: state.dismissError
    };
  }
}));

import { DictationButton } from './DictationButton';
import { placeVoiceBox, placeVoiceBoxClearOf } from './dictationPlacement';

/** Tailwind width/height classes → px for the sizes this control uses. */
const px = (cls: string, prefix: string): number => {
  const m = new RegExp(`(?:^|\\s)${prefix}-(\\d+(?:\\.\\d+)?)(?:\\s|$)`).exec(cls);
  return m ? Number(m[1]) * 4 : 0;
};

/** Raw hues and raw z-index steps the design system replaces with STATUS_* and Z. */
const OFF_TOKEN = /(?:^|\s)(?:[a-z:]*-)?(?:red|rose|amber|emerald|sky|violet)-\d{2,3}(?:\/\d+)?(?:\s|$)|(?:^|\s)z-\d+(?:\s|$)|(?:^|\s)animate-(?:ping|pulse)(?:\s|$)|\d+vw/;

beforeEach(() => {
  state.status = 'idle';
  state.errorInfo = null;
  state.engine = 'whisper';
  state.liveEngine = null;
  state.openingMic = false;
  state.opts = null;
  state.setSettings = vi.fn();
  state.start = vi.fn();
  state.stop = vi.fn();
  state.cancel = vi.fn();
  state.dismissError = vi.fn();
});

describe('DictationButton target sizes', () => {
  it('the caret is ≥ 24 px wide with a mouse; on touch both halves are 44 px', () => {
    render(<DictationButton onFinal={vi.fn()} />);
    const mic = screen.getByRole('button', { name: 'Start voice dictation' });
    const caret = screen.getByRole('button', { name: 'Dictation settings' });
    expect(px(caret.className, 'min-w')).toBeGreaterThanOrEqual(24);
    for (const b of [mic, caret]) {
      expect(b.className).toContain('coarse:min-h-11');
      expect(b.className).toContain('coarse:min-w-11');
    }
    expect(caret).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(caret);
    expect(caret).toHaveAttribute('aria-expanded', 'true');
    // The engine rows and model choices are 44 px on touch too, and say which one is on.
    expect(screen.getByRole('button', { name: /Private, on this device/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^Balanced/ })).toHaveClass('coarse:min-h-11');
  });

  it('the caret discloses a named group of toggles, not a menu (no aria-haspopup); Escape closes it', () => {
    render(<DictationButton onFinal={vi.fn()} />);
    const caret = screen.getByRole('button', { name: 'Dictation settings' });
    // aria-haspopup="true" announces a menu, and the popup has no menu role or menu keys.
    expect(caret).not.toHaveAttribute('aria-haspopup');
    expect(caret).not.toHaveAttribute('aria-controls');
    fireEvent.click(caret);
    const group = screen.getByRole('group', { name: 'Dictation settings' });
    expect(caret).toHaveAttribute('aria-controls', group.id);
    expect(group.id).not.toBe('');
    expect(screen.queryByRole('menu')).toBeNull();
    // Its options are toggle buttons that never submit the composer's form.
    for (const b of Array.from(group.querySelectorAll('button'))) {
      expect(b).toHaveAttribute('type', 'button');
      expect(b).toHaveAttribute('aria-pressed');
    }
    fireEvent.keyDown(screen.getByRole('button', { name: /^Balanced/ }), { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Dictation settings' })).toBeNull();
    expect(caret).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(caret);
  });

  it('while recording, Discard and Finish are named 44 px touch targets', () => {
    state.status = 'recording';
    render(<DictationButton onFinal={vi.fn()} />);
    for (const name of ['Discard recording', 'Finish and insert text']) {
      const b = screen.getByRole('button', { name });
      expect(b.className).toContain('coarse:h-11');
      expect(b.className).toContain('coarse:w-11');
    }
  });
});

describe('DictationButton: true copy and design tokens', () => {
  it('the mic names the engine that will listen; nothing claims "on-device" for browser dictation', () => {
    const first = render(<DictationButton onFinal={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Start voice dictation' })).toHaveAttribute('title', 'Voice typing · private, on this device');
    first.unmount();
    state.engine = 'webspeech';
    render(<DictationButton onFinal={vi.fn()} />);
    const mic = screen.getByRole('button', { name: 'Start voice dictation' });
    expect(mic).toHaveAttribute('title', 'Voice typing · browser dictation, online');
    expect(mic.getAttribute('title')).not.toMatch(/on-device/);
  });

  it('the settings give the true one-time download and where it comes from: the model from Hugging Face, the engine from DreamStream', () => {
    render(<DictationButton onFinal={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dictation settings' }));
    const group = screen.getByRole('group', { name: 'Dictation settings' });
    expect(group).toHaveTextContent(/the voice model once from Hugging Face, and the voice engine from DreamStream \(up to about \d+ MB in all\)/);
    expect(group).not.toHaveTextContent(/jsDelivr/i); // the engine is never fetched from a third-party CDN (whisperEngine.test)
    expect(group).not.toHaveTextContent(/~\s*(40|80|250) MB/);
    expect(group).toHaveTextContent(/Your browser may send your voice to its speech service/);
  });

  it('while it prepares, the bar says the mic stays off, and tapping the mic stops it (it never opens later)', () => {
    state.status = 'starting';
    render(<DictationButton onFinal={vi.fn()} />);
    expect(screen.getByText("Your microphone stays off until it's ready.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel voice dictation' }));
    expect(state.stop).toHaveBeenCalledTimes(1); // the hook cancels a take that is still preparing
  });

  it('the boxes use the popover layer and status tokens, never a raw hue, a raw z-index, a pulse or a vw width', () => {
    for (const status of ['recording', 'starting', 'transcribing', 'error']) {
      state.status = status;
      state.errorInfo = status === 'error' ? { ...dictationError('mic-blocked') } : null;
      const { container, unmount } = render(<DictationButton onFinal={vi.fn()} />);
      const box = container.querySelector('[data-voice-bar],[data-voice-error]') as HTMLElement;
      expect(box, status).not.toBeNull();
      expect(box.className, status).toContain('z-[var(--ds-z-popover)]');
      for (const el of [container, ...Array.from(container.querySelectorAll('*'))]) {
        expect((el.getAttribute('class') ?? '').match(OFF_TOKEN), `${status}: ${el.getAttribute('class')}`).toBeNull();
      }
      unmount();
    }
  });
});

describe('DictationButton: errors', () => {
  it('one calm sentence and one action; the technical detail only behind "Show details"', () => {
    state.status = 'error';
    state.errorInfo = { ...dictationError('model-download', new TypeError('Failed to fetch')) };
    render(<DictationButton onFinal={vi.fn()} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("The voice model didn't download, so your microphone stayed off.");
    expect(alert).not.toHaveTextContent('Failed to fetch');
    expect(alert.querySelectorAll('button')).toHaveLength(3); // the action, Show details, Dismiss
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
    expect(alert).toHaveTextContent('model-download · TypeError: Failed to fetch');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(state.start).toHaveBeenCalledTimes(1);
  });

  it('a blocked mic says where to allow it and offers "Try again"; a page that turns voice off offers "Type instead"; Dismiss closes it', () => {
    state.status = 'error';
    state.errorInfo = { ...dictationError('mic-blocked') };
    const first = render(<DictationButton onFinal={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent("allow the microphone for this site in your browser's settings, then try again.");
    expect(screen.queryByRole('button', { name: 'Allow microphone' })).toBeNull(); // a tap cannot unblock a blocked site
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(state.start).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(state.dismissError).toHaveBeenCalledTimes(1);
    first.unmount();

    state.errorInfo = { ...dictationError('mic-off-here') };
    const onTypeInstead = vi.fn();
    render(<DictationButton onFinal={vi.fn()} onTypeInstead={onTypeInstead} />);
    fireEvent.click(screen.getByRole('button', { name: 'Type instead' }));
    expect(onTypeInstead).toHaveBeenCalledTimes(1);
    expect(state.dismissError).toHaveBeenCalledTimes(2);
    expect(state.start).toHaveBeenCalledTimes(1);
  });
});

describe('DictationButton: Esc and the words heard', () => {
  it('Esc while listening stops the take keeping the words, before a sheet underneath sees it', () => {
    state.status = 'recording';
    const sheetEsc = vi.fn();
    document.addEventListener('keydown', sheetEsc, true); // a sheet's own Esc listener (document, capture)
    render(<DictationButton onFinal={vi.fn()} />);
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(state.stop).toHaveBeenCalledWith('escape');
    expect(sheetEsc).not.toHaveBeenCalled();
    document.removeEventListener('keydown', sheetEsc, true);
  });

  it('showHeard shows the words so far in the bar, never as a live region', () => {
    state.status = 'recording';
    render(<DictationButton onFinal={vi.fn()} showHeard />);
    const heard = screen.getByText('Speak now…');
    expect(heard).toHaveAttribute('aria-live', 'off');
  });
});

describe('DictationButton: review fixes (the bar tells the truth about this take)', () => {
  it('a second take never shows the first take’s words as just heard (browser dictation goes straight to Listening)', () => {
    state.status = 'recording';
    state.liveEngine = 'browser-cloud';
    const view = render(<DictationButton onFinal={vi.fn()} showHeard />);
    act(() => state.opts!.onPartial?.('first take words'));
    expect(screen.getByText('first take words')).toBeInTheDocument();
    // Done: the take ends and the bar closes.
    state.status = 'idle';
    state.liveEngine = null;
    view.rerender(<DictationButton onFinal={vi.fn()} showHeard />);
    // Tap the mic again: browser dictation goes idle → recording with no 'starting' in between.
    fireEvent.click(screen.getByRole('button', { name: 'Start voice dictation' }));
    expect(state.start).toHaveBeenCalledTimes(1);
    state.status = 'recording';
    state.liveEngine = 'browser-cloud';
    view.rerender(<DictationButton onFinal={vi.fn()} showHeard />);
    expect(screen.queryByText('first take words')).toBeNull();
    expect(screen.getByText('Speak now…')).toBeInTheDocument();
  });

  it('a long take shows its newest words, not its first two lines', () => {
    state.status = 'recording';
    state.liveEngine = 'browser-cloud';
    render(<DictationButton onFinal={vi.fn()} showHeard />);
    const words = Array.from({ length: 60 }, (_, i) => `word${i + 1}`).join(' ');
    act(() => state.opts!.onPartial?.(words));
    const heard = screen.getByText((_, el) => el?.getAttribute('aria-live') === 'off' && /word60$/.test(el.textContent ?? ''));
    expect(heard.textContent).toMatch(/^…/);
    expect(heard.textContent).not.toMatch(/\bword1\b/);
    expect(heard.textContent!.length).toBeLessThanOrEqual(141);
  });

  it('with "Send when I tap Done" armed (browser dictation), Done and the mic say Send; the private model never reads Send', () => {
    state.status = 'recording';
    state.liveEngine = 'browser-cloud';
    const view = render(<DictationButton onFinal={vi.fn()} sendsOnDone />);
    const send = screen.getByRole('button', { name: 'Send the message' });
    expect(send.getAttribute('title')).toMatch(/^Send/);
    expect(screen.queryByRole('button', { name: 'Finish and insert text' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Finish and send' })).toHaveAttribute('title', 'Send the message');
    fireEvent.click(send);
    expect(state.stop).toHaveBeenCalledWith();

    state.liveEngine = 'whisper'; // its final pass can add words never said: it always waits
    view.rerender(<DictationButton onFinal={vi.fn()} sendsOnDone />);
    expect(screen.queryByRole('button', { name: 'Send the message' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Finish and insert text' })).toHaveAttribute('title', 'Done: add the words to your message');

    state.liveEngine = 'browser-cloud';
    view.rerender(<DictationButton onFinal={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Finish and insert text' })).toBeInTheDocument();
  });

  it('while the mic opens after the download, the bar no longer says it stays off', () => {
    state.status = 'starting';
    state.liveEngine = 'whisper';
    state.openingMic = true;
    render(<DictationButton onFinal={vi.fn()} />);
    expect(screen.getByText('Opening your microphone…')).toBeInTheDocument();
    expect(screen.queryByText("Your microphone stays off until it's ready.")).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel voice typing' })).toBeInTheDocument();
  });

  it('on any width the bar says browser dictation is online (no hidden-only label, no idle meter)', () => {
    state.status = 'recording';
    state.liveEngine = 'browser-cloud';
    const { container } = render(<DictationButton onFinal={vi.fn()} />);
    const bar = container.querySelector('[data-voice-bar]') as HTMLElement;
    const mark = Array.from(bar.querySelectorAll('span')).find((el) => el.textContent === 'online');
    expect(mark, 'a short "online" mark').toBeTruthy();
    for (let el: HTMLElement | null = mark as HTMLElement; el && el !== bar; el = el.parentElement) {
      expect(el.className, 'never hidden at some width').not.toMatch(/(?:^|\s)hidden(?:\s|$)/);
    }
    expect(bar.querySelector('.h-5[aria-hidden]'), 'no level meter: the online engine gives us no level').toBeNull();
  });

  it('Esc while the words are written down is held (a sheet underneath never closes), and Discard is there', () => {
    state.status = 'transcribing';
    const sheetEsc = vi.fn();
    document.addEventListener('keydown', sheetEsc, true);
    render(<DictationButton onFinal={vi.fn()} />);
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(sheetEsc).not.toHaveBeenCalled();
    expect(state.stop).not.toHaveBeenCalled(); // ignored: the words then land
    expect(state.cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard what you said' }));
    expect(state.cancel).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', sheetEsc, true);
  });

  it('the open settings, bar and error box come after the mic in tab order (they are placed absolutely, so nothing moves)', () => {
    const view = render(<DictationButton onFinal={vi.fn()} />);
    const caret = screen.getByRole('button', { name: 'Dictation settings' });
    fireEvent.click(caret);
    const group = screen.getByRole('group', { name: 'Dictation settings' });
    expect(caret.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    view.unmount();

    state.status = 'error';
    state.errorInfo = { ...dictationError('no-mic') };
    const err = render(<DictationButton onFinal={vi.fn()} />);
    const mic = screen.getByRole('button', { name: 'Start voice dictation' });
    expect(mic.compareDocumentPosition(screen.getByRole('alert')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    err.unmount();

    state.status = 'recording';
    state.errorInfo = null;
    const { container } = render(<DictationButton onFinal={vi.fn()} />);
    const bar = container.querySelector('[data-voice-bar]') as HTMLElement;
    expect(screen.getByRole('button', { name: 'Finish dictation' }).compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('choosing how it listens tells the caller (Comic Studio shows its send setting only where it can act)', () => {
    const onEngineChange = vi.fn();
    render(<DictationButton onFinal={vi.fn()} onEngineChange={onEngineChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dictation settings' }));
    fireEvent.click(screen.getByRole('button', { name: /Browser dictation, online/ }));
    expect(state.setSettings).toHaveBeenCalledWith({ engine: 'webspeech', model: 'base' });
    expect(onEngineChange).toHaveBeenCalledWith('webspeech');
  });

  it('with a box to keep clear (the composer the words go into), the bar opens above that box, lined up with the mic', () => {
    const rects: Record<string, DOMRect> = {
      box: { left: 0, right: 400, top: 500, bottom: 700, width: 400, height: 200, x: 0, y: 500, toJSON: () => ({}) } as DOMRect,
      mic: { left: 60, right: 104, top: 640, bottom: 684, width: 44, height: 44, x: 60, y: 640, toJSON: () => ({}) } as DOMRect
    };
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-composer-box')) return rects.box;
      if (this.hasAttribute('data-voice-root')) return rects.mic;
      return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    // jsdom reports no overflow at all; a browser reports 'visible' for the composer box, which clips nothing.
    const realStyle = window.getComputedStyle.bind(window);
    const styleSpy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
      const cs = realStyle(el);
      return new Proxy(cs, { get: (t, k) => (k === 'overflowX' || k === 'overflowY' ? 'visible' : (t as unknown as Record<string | symbol, unknown>)[k]) });
    });
    const Composer = () => {
      const boxRef = React.useRef<HTMLDivElement>(null);
      return (
        <div ref={boxRef} data-composer-box>
          <textarea aria-label="draft" />
          <DictationButton onFinal={vi.fn()} align="start" stackAboveRef={boxRef} />
        </div>
      );
    };
    // The composer is on screen first; then the person taps the mic and the take starts.
    const { container, rerender } = render(<Composer />);
    state.status = 'recording';
    state.liveEngine = 'browser-cloud';
    rerender(<Composer />);
    const bar = container.querySelector('[data-voice-bar]') as HTMLElement;
    expect(bar.dataset.side).toBe('top');
    // Above the whole box (top 500, gap 8), not just above the mic (top 640), and starting at the mic's left edge.
    expect(bar.style.top).toBe(`${500 - 8 - 640}px`);
    expect(bar.style.left).toBe('0px');
    spy.mockRestore();
    styleSpy.mockRestore();
  });
});

describe('placeVoiceBox: next to the mic, never off screen', () => {
  const viewport = (w: number, h = 740) => ({ left: 0, top: 0, right: w, bottom: h });

  it('a mic at the left of a 320 px composer: the bar starts at the mic and is clamped inside the screen', () => {
    const mic = { left: 76, top: 622, right: 120, bottom: 666 };
    const p = placeVoiceBox(mic, { width: 336, height: 60 }, viewport(320), 'start');
    expect(p.side).toBe('top');
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + p.width).toBeLessThanOrEqual(312);
    expect(p.top).toBe(622 - 8 - 60);
    // The old right-aligned box began 85–190 px off the left edge.
    const wide = placeVoiceBox(mic, { width: 256, height: 200 }, viewport(1280, 800), 'start');
    expect(wide.left).toBe(76);
  });

  it('a mic at the right edge lines up with its right edge, still inside', () => {
    const mic = { left: 1200, top: 700, right: 1244, bottom: 744 };
    const p = placeVoiceBox(mic, { width: 320, height: 80 }, viewport(1280, 800), 'end');
    expect(p.left + p.width).toBe(1244);
  });

  it('a mic in a header pinned to the top flips below it', () => {
    const mic = { left: 900, top: 8, right: 944, bottom: 52 };
    const p = placeVoiceBox(mic, { width: 336, height: 60 }, viewport(1024, 768), 'end');
    expect(p.side).toBe('bottom');
    expect(p.top).toBe(60);
  });

  it('inside a clipping sheet the box stays inside the sheet', () => {
    const sheet = { left: 0, top: 400, right: 390, bottom: 844 };
    const mic = { left: 60, top: 420, right: 104, bottom: 464 };
    const p = placeVoiceBox(mic, { width: 336, height: 120 }, sheet, 'start');
    expect(p.side).toBe('bottom');
    expect(p.top + Math.min(120, p.maxHeight)).toBeLessThanOrEqual(844 - 8);
    expect(p.left + p.width).toBeLessThanOrEqual(390 - 8);
  });
});

describe('placeVoiceBoxClearOf: above the box the words go into, when it fits', () => {
  const viewport = { left: 0, top: 0, right: 390, bottom: 844 };
  const mic = { left: 60, top: 760, right: 104, bottom: 804 };
  const composer = { left: 8, top: 680, right: 382, bottom: 820 };

  it('opens above the composer box, lined up with the mic', () => {
    const p = placeVoiceBoxClearOf(mic, composer, { width: 336, height: 72 }, viewport, 'start');
    expect(p.side).toBe('top');
    expect(p.top + 72).toBe(680 - 8);
    expect(p.left).toBe(46); // the mic's left edge, pulled in so the box stays 8 px inside the screen
  });

  it('falls back to the mic when there is no room above the composer (a short screen)', () => {
    const short = { left: 0, top: 0, right: 390, bottom: 844 };
    const tallBox = { left: 8, top: 40, right: 382, bottom: 820 };
    const p = placeVoiceBoxClearOf(mic, tallBox, { width: 336, height: 72 }, short, 'start');
    expect(p).toEqual(placeVoiceBox(mic, { width: 336, height: 72 }, short, 'start'));
  });

  it('reads a real DOMRect (its edges are getters, which a spread would drop)', () => {
    // What getBoundingClientRect returns: the edges live on the prototype, not on the object.
    class RectLike {
      constructor(private readonly r: { left: number; top: number; right: number; bottom: number }) {}
      get left() {
        return this.r.left;
      }
      get top() {
        return this.r.top;
      }
      get right() {
        return this.r.right;
      }
      get bottom() {
        return this.r.bottom;
      }
    }
    const p = placeVoiceBoxClearOf(new RectLike(mic), new RectLike(composer), { width: 336, height: 72 }, viewport, 'start');
    expect(Number.isFinite(p.left)).toBe(true);
    expect(p.left).toBe(46);
    expect(p.left + p.width).toBeLessThanOrEqual(390 - 8);
    expect(p.top + 72).toBe(680 - 8);
  });

  it('stays within the composer column in a side pane (it never spills into the pane next to it, which paints over it)', () => {
    // iPad mini portrait, measured in Chromium: the chat pane is 0–302 px of a 744 px screen, the composer box 16–286.
    const ipad = { left: 0, top: 0, right: 744, bottom: 1133 };
    const micInPane = { left: 79, top: 1055, right: 169, bottom: 1101 };
    const paneBox = { left: 16, top: 1001, right: 286, bottom: 1113 };
    const p = placeVoiceBoxClearOf(micInPane, paneBox, { width: 336, height: 83 }, ipad, 'start');
    expect(p.side).toBe('top');
    expect(p.left).toBeGreaterThanOrEqual(16 - 8);
    expect(p.left + p.width).toBeLessThanOrEqual(286 + 8);
    expect(p.top + 83).toBe(1001 - 8);
    // The fallback beside the mic keeps to the column too.
    const tall = placeVoiceBoxClearOf(micInPane, { ...paneBox, top: 20 }, { width: 336, height: 83 }, ipad, 'start');
    expect(tall.left + tall.width).toBeLessThanOrEqual(286 + 8);
  });

  it('with nothing to keep clear it is the plain mic placement', () => {
    expect(placeVoiceBoxClearOf(mic, null, { width: 336, height: 72 }, viewport, 'start')).toEqual(placeVoiceBox(mic, { width: 336, height: 72 }, viewport, 'start'));
  });
});
