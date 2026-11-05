import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import {
  focusedByKeyboard, isEditableTarget, isImeComposing, isModalOpen, isSpaceActivatable, shouldHandleStudioHotkey, spaceBelongsToControl,
  watchFocusOrigin,
} from './hotkeys';

const el = (html: string, pick = '[data-pick]'): Element => {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root.querySelector(pick) ?? root.firstElementChild!;
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('shouldHandleStudioHotkey', () => {
  it('acts on a plain key press aimed at the page, Shift included', () => {
    expect(shouldHandleStudioHotkey({ target: document.body })).toBe(true);
    expect(shouldHandleStudioHotkey(new KeyboardEvent('keydown', { key: 'g' }))).toBe(true);
    expect(shouldHandleStudioHotkey(new KeyboardEvent('keydown', { key: 'G', shiftKey: true }))).toBe(true);
    // Focus on a button or a link is not typing: M / V / digits still work there.
    expect(shouldHandleStudioHotkey({ target: el('<button>Go live</button>') })).toBe(true);
  });

  it('never acts on a browser or OS shortcut (⌘G, Ctrl+R, ⌘V, Alt/AltGr)', () => {
    expect(shouldHandleStudioHotkey(new KeyboardEvent('keydown', { key: 'g', metaKey: true }))).toBe(false);
    expect(shouldHandleStudioHotkey(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true }))).toBe(false);
    expect(shouldHandleStudioHotkey(new KeyboardEvent('keydown', { key: 'v', metaKey: true }))).toBe(false);
    expect(shouldHandleStudioHotkey(new KeyboardEvent('keydown', { key: 'b', altKey: true }))).toBe(false);
    expect(shouldHandleStudioHotkey(new KeyboardEvent('keydown', { key: '/', ctrlKey: true, altKey: true }))).toBe(false);
  });

  it('ignores auto-repeat from a held-down key', () => {
    expect(shouldHandleStudioHotkey(new KeyboardEvent('keydown', { key: 'g', repeat: true }))).toBe(false);
  });

  it('ignores keystrokes an IME is composing (isComposing or keyCode 229)', () => {
    expect(shouldHandleStudioHotkey(new KeyboardEvent('keydown', { key: 'g', isComposing: true }))).toBe(false);
    expect(shouldHandleStudioHotkey({ keyCode: 229, target: document.body })).toBe(false);
  });

  it('ignores typing in fields and rich-text editors', () => {
    expect(shouldHandleStudioHotkey({ target: el('<input>') })).toBe(false);
    expect(shouldHandleStudioHotkey({ target: el('<textarea></textarea>') })).toBe(false);
    expect(shouldHandleStudioHotkey({ target: el('<select><option>a</option></select>') })).toBe(false);
    expect(shouldHandleStudioHotkey({ target: el('<div contenteditable="true">x</div>') })).toBe(false);
    expect(shouldHandleStudioHotkey({ target: el('<div contenteditable><p><b data-pick>x</b></p></div>') })).toBe(false);
  });

  it('leaves a key another handler already claimed', () => {
    const e = new KeyboardEvent('keydown', { key: 'g', cancelable: true });
    e.preventDefault();
    expect(shouldHandleStudioHotkey(e)).toBe(false);
  });
});

describe('isEditableTarget', () => {
  it('reads the nearest contenteditable: a "false" island inside an editor is not editable', () => {
    expect(isEditableTarget(el('<div contenteditable="plaintext-only">x</div>'))).toBe(true);
    expect(isEditableTarget(el('<div contenteditable="true"><span contenteditable="false" data-pick>chip</span></div>'))).toBe(false);
    expect(isEditableTarget(el('<div contenteditable="false">x</div>'))).toBe(false);
    expect(isEditableTarget(el('<div>plain</div>'))).toBe(false);
  });

  it('treats window / document / no target as the page', () => {
    expect(isEditableTarget(window)).toBe(false);
    expect(isEditableTarget(document)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('isSpaceActivatable', () => {
  it('is true for buttons, links, toggles, tabs, menu items and <summary>', () => {
    expect(isSpaceActivatable(el('<button>x</button>'))).toBe(true);
    expect(isSpaceActivatable(el('<button><span data-pick>icon</span></button>'))).toBe(true);
    expect(isSpaceActivatable(el('<a href="#x">x</a>'))).toBe(true);
    expect(isSpaceActivatable(el('<details><summary>More</summary></details>', 'summary'))).toBe(true);
    for (const role of ['button', 'switch', 'checkbox', 'menuitem', 'tab', 'radio']) {
      expect(isSpaceActivatable(el(`<div role="${role}" tabindex="0">x</div>`))).toBe(true);
    }
  });

  it('is false for the page itself and plain content', () => {
    expect(isSpaceActivatable(document.body)).toBe(false);
    expect(isSpaceActivatable(el('<a>no href</a>'))).toBe(false);
    expect(isSpaceActivatable(el('<div tabindex="0">stage</div>'))).toBe(false);
    expect(isSpaceActivatable(window)).toBe(false);
  });
});

describe('watchFocusOrigin · focusedByKeyboard', () => {
  /** A real click: pointerdown + mousedown, then (in Chrome / Edge / Firefox on Windows) focus stays on the button. */
  const click = (b: HTMLElement) => {
    fireEvent.pointerDown(b);
    fireEvent.mouseDown(b);
    b.focus();
    fireEvent.click(b);
  };
  const tabTo = (b: HTMLElement) => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab' });
    b.focus();
  };

  it('a clicked button is not keyboard focus, so Space stays the studio’s key there', () => {
    const stop = watchFocusOrigin();
    const rec = el('<button>Record</button>') as HTMLElement;
    click(rec);
    expect(document.activeElement).toBe(rec);
    expect(focusedByKeyboard(rec)).toBe(false);
    expect(spaceBelongsToControl(rec)).toBe(false);
    // Pressing keys while it keeps focus (Space itself, hotkeys) doesn't change how it got focus.
    fireEvent.keyDown(rec, { key: ' ' });
    fireEvent.keyDown(rec, { key: 'm' });
    expect(spaceBelongsToControl(rec)).toBe(false);
    stop();
  });

  it('a control reached by Tab, Shift+Tab or arrow keys is keyboard focus: Space is its own press', () => {
    const stop = watchFocusOrigin();
    const a = el('<button>Chat</button>') as HTMLElement;
    const b = el('<div role="tab" tabindex="0">People</div>') as HTMLElement;
    tabTo(a);
    expect(spaceBelongsToControl(a)).toBe(true);
    fireEvent.keyDown(a, { key: 'ArrowRight' });
    b.focus();
    expect(spaceBelongsToControl(b)).toBe(true);
    expect(focusedByKeyboard(a)).toBe(false); // only what has focus now
    // Clicked afterwards: back to pointer focus — the one it had already included (no focusin then).
    click(b);
    expect(spaceBelongsToControl(b)).toBe(false);
    tabTo(a);
    click(a);
    expect(spaceBelongsToControl(a)).toBe(false);
    stop();
  });

  it('a ⌘/Ctrl/Alt chord is not the host moving focus (⌘Tab away and back keeps a clicked button a click)', () => {
    const stop = watchFocusOrigin();
    const rec = el('<button>Record</button>') as HTMLElement;
    click(rec);
    fireEvent.keyDown(rec, { key: 'Tab', metaKey: true });
    fireEvent.keyDown(rec, { key: 'Tab', altKey: true });
    rec.blur();
    rec.focus(); // the window coming back re-focuses it
    expect(spaceBelongsToControl(rec)).toBe(false);
    stop();
  });

  it('does nothing until watched, and forgets when the last watcher stops', () => {
    const b = el('<button>x</button>') as HTMLElement;
    tabTo(b);
    expect(focusedByKeyboard(b)).toBe(false); // nobody watching
    const stopA = watchFocusOrigin();
    const stopB = watchFocusOrigin();
    b.blur();
    tabTo(b);
    stopA();
    expect(focusedByKeyboard(b)).toBe(true); // still watched by B
    stopA(); // a second stop from the same watcher is a no-op
    expect(focusedByKeyboard(b)).toBe(true);
    stopB();
    expect(focusedByKeyboard(b)).toBe(false);
  });
});

describe('isModalOpen', () => {
  it('sees any aria-modal sheet on the page', () => {
    expect(isModalOpen()).toBe(false);
    el('<div role="dialog" aria-label="All reactions">not modal</div>');
    expect(isModalOpen()).toBe(false);
    el('<div class="sheet-scrim" role="dialog" aria-modal="true">sheet</div>');
    expect(isModalOpen()).toBe(true);
  });
});

describe('isImeComposing', () => {
  it('reads DOM and React keyboard events', () => {
    expect(isImeComposing(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }))).toBe(true);
    expect(isImeComposing({ keyCode: 229 })).toBe(true); // Safari's composition-ending Enter
    expect(isImeComposing({ keyCode: 13, nativeEvent: { isComposing: true } })).toBe(true); // React synthetic event
    expect(isImeComposing(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(false);
    expect(isImeComposing({ keyCode: 13, nativeEvent: { isComposing: false } })).toBe(false);
  });
});
