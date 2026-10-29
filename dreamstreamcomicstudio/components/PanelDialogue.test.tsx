import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicPanel, DialogueBlock, TextLayout } from '../types';
import { PanelDialogue, STACK_BELOW_PX } from './PanelDialogue';

// Legacy dialogue on phones (mobile-reading hotfix): fixed-pixel speech bubbles and captions covered 2-3x more of a
// phone-sized panel, so on phones a panel narrower than ~480 px stacks them under the image at the native text size.
// Desktop keeps the overlay. Readers never show the scene description as dialogue.

const realMatchMedia = window.matchMedia;
const realRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
const realRect = HTMLElement.prototype.getBoundingClientRect;

/** Phone = coarse pointer / narrow viewport. */
const setPhone = (phone: boolean) => {
  window.matchMedia = ((query: string) => ({
    matches: phone && /pointer:\s*coarse|max-width/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
};

/** Every dialogue root reports this rendered width (jsdom has no layout). */
let panelWidth = 0;
const roCallbacks: Array<() => void> = [];
beforeEach(() => {
  panelWidth = 0;
  roCallbacks.length = 0;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const w = this.getAttribute('data-testid') === 'panel-dialogue' ? panelWidth : 0;
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: 100, width: w, height: 100, toJSON: () => ({}) } as DOMRect;
  };
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    private cb: () => void;
    constructor(cb: () => void) {
      this.cb = cb;
      roCallbacks.push(() => this.cb());
    }
    observe() {}
    disconnect() {}
  };
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = realRO;
  HTMLElement.prototype.getBoundingClientRect = realRect;
});

const LONG = 'This is a long line of dialogue that the overlay would cut off after three lines, but stacked under the art every single word is shown so nothing is lost on a phone.';
const block = (id: string, text: string, extra: Partial<DialogueBlock> = {}): DialogueBlock => ({ id, kind: 'speech', text, ...extra });
const panel = (blocks: DialogueBlock[], extra: Partial<ComicPanel> = {}): ComicPanel => ({
  id: 'p1',
  sceneId: 1,
  description: '',
  dialogue: '',
  dialogueBlocks: blocks,
  imageUrl: 'data:image/svg+xml,x',
  imageIdHistory: [],
  ...extra
});
const five = () => [
  block('a', 'One', { speaker: 'MEERA' }),
  block('b', 'Two'),
  block('n', 'Meanwhile, at the harbour.', { kind: 'narration' }),
  block('c', 'Three'),
  block('d', LONG)
];
const root = () => screen.getByTestId('panel-dialogue');
const renderAt = (layout: TextLayout, width: number, p = panel(five()), extra: Record<string, unknown> = {}) => {
  panelWidth = width;
  return render(
    <div className="relative">
      <img alt="art" src="data:image/svg+xml,x" />
      <PanelDialogue panel={p} layout={layout} {...extra} />
    </div>
  );
};

describe('desktop keeps the overlay exactly as before', () => {
  beforeEach(() => setPhone(false));

  it('speech bubbles: absolute overlay, clamped, capped at 4 blocks with "+1 more", even on a narrow desktop panel', () => {
    renderAt('speech_bubbles', 280);
    expect(root()).toHaveAttribute('data-placement', 'overlay');
    expect(root().className).toMatch(/\babsolute inset-0\b/);
    expect(screen.getByText('+1 more')).toBeInTheDocument();
    expect(screen.queryByText(LONG)).toBeNull(); // 5th block not shown
    expect(screen.getByText('One').className).toMatch(/line-clamp-3/);
    expect(screen.getByText('One').className).not.toMatch(/whitespace-pre-line/);
  });

  it('captions: the gradient bar at the bottom of the art', () => {
    renderAt('caption', 280);
    expect(root()).toHaveAttribute('data-placement', 'overlay');
    expect(root().className).toMatch(/absolute bottom-0 left-0 right-0/);
    expect(root().className).toMatch(/bg-gradient-to-t/);
  });

  it('chat bubbles keep their 4-line cap on desktop', () => {
    renderAt('chat_bubbles', 700);
    expect(screen.getByText('+1 more lines')).toBeInTheDocument();
    expect(root().className).not.toMatch(/min-w-full/);
  });
});

describe('phones: dialogue under the art when the rendered panel is narrow', () => {
  beforeEach(() => setPhone(true));

  it(`speech bubbles stack under the image (panel ${STACK_BELOW_PX - 140} px), every block and word, native 11 px text, tails pointing up`, () => {
    const { container } = renderAt('speech_bubbles', STACK_BELOW_PX - 140);
    expect(root()).toHaveAttribute('data-placement', 'below');
    expect(root().className).not.toMatch(/\babsolute\b/);
    expect(root().className).toMatch(/\bw-0 min-w-full\b/);
    // Rendered after the image, in flow.
    expect(container.querySelector('img')!.nextElementSibling).toBe(root());
    expect(screen.getByText(LONG)).toBeInTheDocument();
    expect(screen.queryByText(/more$/)).toBeNull();
    expect(screen.getByText(LONG).className).not.toMatch(/line-clamp/);
    expect(screen.getByText('One').closest('div')!.className).toMatch(/text-\[11px\]/);
    // Narration keeps its box; speakers keep their label.
    expect(screen.getByText('Meanwhile, at the harbour.')).toBeInTheDocument();
    expect(screen.getByText('MEERA')).toBeInTheDocument();
    const tails = container.querySelectorAll('svg');
    expect(tails.length).toBeGreaterThan(0);
    tails.forEach((t) => expect(t.getAttribute('class')).toMatch(/-top-\[9px\]/));
  });

  it('captions stack under the image too (14 px speech line, 11 px narration), unclamped', () => {
    renderAt('caption', 340);
    expect(root()).toHaveAttribute('data-placement', 'below');
    expect(root().className).not.toMatch(/\babsolute\b/);
    expect(screen.getByText('Meanwhile, at the harbour.').className).toMatch(/text-\[11px\]/);
    expect(screen.getByText('One').closest('div')!.className).toMatch(/\btext-sm\b/);
    expect(screen.getByText('One').closest('div')!.className).not.toMatch(/max-h-\[4em\]/);
    expect(screen.getByText(LONG, { exact: false })).toBeInTheDocument();
  });

  it('a wide panel (tablet) keeps the overlay; crossing the threshold on resize re-places it', () => {
    renderAt('speech_bubbles', STACK_BELOW_PX + 120);
    expect(root()).toHaveAttribute('data-placement', 'overlay');
    act(() => {
      panelWidth = 360;
      roCallbacks.forEach((cb) => cb());
    });
    expect(root()).toHaveAttribute('data-placement', 'below');
  });

  it('chat bubbles show every line on phones, unclamped, as wide as the panel', () => {
    renderAt('chat_bubbles', 340);
    expect(screen.getByText(LONG)).toBeInTheDocument();
    expect(screen.queryByText(/more lines/)).toBeNull();
    expect(screen.getByText(LONG).className).not.toMatch(/line-clamp/);
    expect(root().className).toMatch(/\bw-0 min-w-full\b/);
  });

  it('layout "none" still renders nothing', () => {
    renderAt('none', 340);
    expect(screen.queryByTestId('panel-dialogue')).toBeNull();
  });
});

describe('explicit placement', () => {
  it('placement="below" stacks even on desktop (the phone Page Flip passes it); "overlay" never stacks', () => {
    setPhone(false);
    const { unmount } = renderAt('speech_bubbles', 900, panel(five()), { placement: 'below' });
    expect(root()).toHaveAttribute('data-placement', 'below');
    unmount();
    setPhone(true);
    renderAt('speech_bubbles', 300, panel(five()), { placement: 'overlay' });
    expect(root()).toHaveAttribute('data-placement', 'overlay');
  });
});

describe('never the scene description as dialogue', () => {
  const DESC = 'Wide establishing shot of the harbour at dawn, cinematic lighting, gulls over the masts.';
  for (const layout of ['speech_bubbles', 'caption', 'chat_bubbles'] as TextLayout[]) {
    for (const phone of [false, true]) {
      it(`${layout}, ${phone ? 'phone' : 'desktop'}: no fallback, and a stored echo is hidden`, () => {
        setPhone(phone);
        const { unmount } = renderAt(layout, 340, panel([], { description: DESC }));
        expect(screen.queryByTestId('panel-dialogue')).toBeNull();
        unmount();
        renderAt(layout, 340, panel([block('e', DESC, { kind: 'caption' }), block('r', 'Look, the boats!')], { description: DESC }));
        expect(screen.queryByText(DESC)).toBeNull();
        expect(screen.getByText('Look, the boats!')).toBeInTheDocument();
      });
    }
  }
});

describe('guards', () => {
  it('jsdom without ResizeObserver still measures once', () => {
    setPhone(true);
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = undefined;
    renderAt('speech_bubbles', 300);
    expect(root()).toHaveAttribute('data-placement', 'below');
  });

  it('an unmeasurable panel (width 0) falls back to the viewport guess', () => {
    setPhone(true);
    const spy = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
    renderAt('speech_bubbles', 0);
    expect(root()).toHaveAttribute('data-placement', 'below');
    spy.mockRestore();
  });
});
