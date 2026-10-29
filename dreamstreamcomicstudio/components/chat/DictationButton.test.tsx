// DictationButton (P2-CONVERSATION composer-dictation-split / composer-dictation-target-size): the mic
// and its settings caret are two real targets — at least 24 px wide with a mouse (axe target-size, WCAG
// 2.5.8: the caret measured 21 x 36) and 44 px on touch (the mic was 36, the caret 21-26) — and every
// recording-bar action has a name.
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const state = vi.hoisted(() => ({ status: 'idle' as string }));
vi.mock('../../hooks/useDictation', () => ({
  voiceInputSupported: () => true,
  webSpeechSupported: () => true,
  useDictation: () => ({
    status: state.status,
    level: 0,
    elapsed: 3,
    error: null,
    download: null,
    settings: { engine: 'whisper', model: 'base', autoSend: false },
    setSettings: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn()
  })
}));

import { DictationButton } from './DictationButton';

/** Tailwind width/height classes → px for the sizes this control uses. */
const px = (cls: string, prefix: string): number => {
  const m = new RegExp(`(?:^|\\s)${prefix}-(\\d+(?:\\.\\d+)?)(?:\\s|$)`).exec(cls);
  return m ? Number(m[1]) * 4 : 0;
};

beforeEach(() => {
  state.status = 'idle';
});

describe('DictationButton target sizes', () => {
  it('the caret is ≥ 24 px wide with a mouse; on touch both halves are 44 px', () => {
    render(<DictationButton onPartial={vi.fn()} onFinal={vi.fn()} />);
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
    expect(screen.getByRole('button', { name: /On-device Whisper/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Balanced' })).toHaveClass('coarse:min-h-11');
  });

  it('the caret discloses a named group of toggles, not a menu (no aria-haspopup); Escape closes it', () => {
    render(<DictationButton onPartial={vi.fn()} onFinal={vi.fn()} />);
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
    fireEvent.keyDown(screen.getByRole('button', { name: 'Balanced' }), { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Dictation settings' })).toBeNull();
    expect(caret).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(caret);
  });

  it('while recording, Discard and Finish are named 44 px touch targets', () => {
    state.status = 'recording';
    render(<DictationButton onPartial={vi.fn()} onFinal={vi.fn()} />);
    for (const name of ['Discard recording', 'Finish and insert text']) {
      const b = screen.getByRole('button', { name });
      expect(b.className).toContain('coarse:h-11');
      expect(b.className).toContain('coarse:w-11');
    }
  });
});
