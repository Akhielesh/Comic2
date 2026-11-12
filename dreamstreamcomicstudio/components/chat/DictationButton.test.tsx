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
  start: null as unknown as ReturnType<typeof vi.fn>,
  stop: null as unknown as ReturnType<typeof vi.fn>,
  cancel: null as unknown as ReturnType<typeof vi.fn>,
  dismissError: null as unknown as ReturnType<typeof vi.fn>
}));
vi.mock('../../hooks/useDictation', () => ({
  voiceInputSupported: () => true,
  webSpeechSupported: () => true,
  useDictation: () => ({
    status: state.status,
    level: 0,
    elapsed: 3,
    error: (state.errorInfo?.message as string) ?? null,
    errorInfo: state.errorInfo,
    download: null,
    settings: { engine: state.engine, model: 'base' },
    setSettings: vi.fn(),
    liveEngine: null,
    start: state.start,
    stop: state.stop,
    cancel: state.cancel,
    dismissError: state.dismissError
  })
}));

import { DictationButton } from './DictationButton';
import { placeVoiceBox } from './dictationPlacement';

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

  it('the settings give the true one-time download and say the voice model comes from Hugging Face', () => {
    render(<DictationButton onFinal={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dictation settings' }));
    const group = screen.getByRole('group', { name: 'Dictation settings' });
    expect(group).toHaveTextContent(/Hugging Face \(up to about \d+ MB\)/);
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

  it('a blocked mic offers "Allow microphone"; a page that turns voice off offers "Type instead"; Dismiss closes it', () => {
    state.status = 'error';
    state.errorInfo = { ...dictationError('mic-blocked') };
    const first = render(<DictationButton onFinal={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Allow microphone' }));
    expect(state.start).toHaveBeenCalledTimes(1); // the browser asks again where it still can
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
