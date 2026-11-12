// The Pro shell's pure rules and pieces (PE-SHELL): the keyboard table, the D7 view rule, the hook (one concept: the
// switch is setMode, never an op), the tool rail, the top bar and the dock frame, with 44 px coarse targets.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import { IN_ART_LETTERING_NOTE, PRO_FREE_FOOTER } from '../../../shared/comic/pro/types';
import { PRO_TOOLS, SHORTCUT_SHEET, cycleReadingOrder, isEditableTarget, selectionHoldsArrows, shellShortcut, type ProTool } from './shortcuts';
import { EDITOR_MODE_KEY, coachCardsFor, editorViewFor, requestEditorTool, takeEditorTool, useProEditor } from './useProEditor';
import { ToolRail } from './ToolRail';
import { MODE_GROUP_LABEL, ProModeSwitch, ProTopBar } from './ProTopBar';
import { ProCoach, ProDock, ShortcutSheet } from './ProWorkspace';

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* none */
  }
});
afterEach(cleanup);

const ALL_TOOLS = new Set<ProTool>(PRO_TOOLS.map((t) => t.id));
const field = () => document.createElement('textarea');

describe('shellShortcut', () => {
  it('Shift+P toggles and ? opens the sheet with the flag on, in either view; nothing with the flag off', () => {
    expect(shellShortcut({ key: 'P', shiftKey: true }, { flag: true, pro: false, tools: ALL_TOOLS })).toEqual({ kind: 'toggle-mode' });
    expect(shellShortcut({ key: '?' }, { flag: true, pro: false, tools: ALL_TOOLS })).toEqual({ kind: 'help' });
    expect(shellShortcut({ key: 'P', shiftKey: true }, { flag: false, pro: true, tools: ALL_TOOLS })).toBeNull();
  });
  it('never fires while typing', () => {
    for (const k of [{ key: 'P', shiftKey: true }, { key: '?' }, { key: 'b' }, { key: 'Tab' }, { key: 'a', metaKey: true }])
      expect(shellShortcut({ ...k, target: field() }, { flag: true, pro: true, tools: ALL_TOOLS })).toBeNull();
    expect(isEditableTarget(document.createElement('input'))).toBe(true);
    expect(isEditableTarget(document.createElement('select'))).toBe(true);
    expect(isEditableTarget(document.createElement('button'))).toBe(false);
  });
  it('tool keys, Tab and ⌘A only in Pro, and only for tools the rail offers', () => {
    expect(shellShortcut({ key: 'b' }, { flag: true, pro: false, tools: ALL_TOOLS })).toBeNull();
    expect(shellShortcut({ key: 'b' }, { flag: true, pro: true, tools: ALL_TOOLS })).toEqual({ kind: 'tool', tool: 'balloon' });
    expect(shellShortcut({ key: 'U' }, { flag: true, pro: true, tools: new Set<ProTool>(['select']) })).toBeNull();
    expect(shellShortcut({ key: 'Tab', shiftKey: true }, { flag: true, pro: true, tools: ALL_TOOLS })).toEqual({ kind: 'cycle', dir: -1 });
    expect(shellShortcut({ key: 'a', ctrlKey: true }, { flag: true, pro: true, tools: ALL_TOOLS })).toEqual({ kind: 'select-all' });
    expect(shellShortcut({ key: 'z', metaKey: true }, { flag: true, pro: true, tools: ALL_TOOLS })).toBeNull(); // ⌘Z stays undo
  });
  it('the sheet lists every rail tool with its key', () => {
    const tools = SHORTCUT_SHEET.find((g) => g.title === 'Tools')!.rows;
    expect(tools.map((r) => r.keys)).toEqual(['V', 'T', 'B', 'S', 'U', 'M', 'H', 'Z']);
  });
});

describe('cycleReadingOrder and the arrow guard', () => {
  it('walks forward and back with wrapping, from nothing to the first / last', () => {
    const order = ['a', 'b', 'c'];
    expect(cycleReadingOrder(order, 'a', 1)).toBe('b');
    expect(cycleReadingOrder(order, 'c', 1)).toBe('a');
    expect(cycleReadingOrder(order, 'a', -1)).toBe('c');
    expect(cycleReadingOrder(order, undefined, 1)).toBe('a');
    expect(cycleReadingOrder(order, undefined, -1)).toBe('c');
    expect(cycleReadingOrder([], 'a', 1)).toBeUndefined();
  });
  it('holds the arrows for balloons, overlays AND panels (graft 4)', () => {
    expect(selectionHoldsArrows({ lineIds: ['l'] })).toBe(true);
    expect(selectionHoldsArrows({ lineIds: [], layerIds: ['ly_1'] })).toBe(true);
    expect(selectionHoldsArrows({ lineIds: [], panelIds: ['pn_1'] })).toBe(true);
    expect(selectionHoldsArrows({ lineIds: [] })).toBe(false);
    expect(selectionHoldsArrows(null)).toBe(false);
  });
});

describe('editorViewFor (D7)', () => {
  it('flag off: exactly studio.mode; Easy without caps.proEditor', () => {
    expect(editorViewFor({ flag: false, canPro: true, phone: true, studioMode: 'pro', stored: null })).toBe('pro');
    expect(editorViewFor({ flag: false, canPro: false, phone: false, studioMode: 'pro', stored: null })).toBe('easy');
  });
  it('flag on, phone: Easy on the first open, then the last choice on this device', () => {
    expect(editorViewFor({ flag: true, canPro: true, phone: true, studioMode: 'pro', stored: null })).toBe('easy');
    expect(editorViewFor({ flag: true, canPro: true, phone: true, studioMode: 'easy', stored: 'pro' })).toBe('pro');
  });
  it('flag on, larger layouts: studio.mode', () => {
    expect(editorViewFor({ flag: true, canPro: true, phone: false, studioMode: 'pro', stored: 'easy' })).toBe('pro');
  });
});

describe('useProEditor', () => {
  const studioWith = (mode: 'easy' | 'pro' = 'easy', flag = true) => ({ caps: { ...DEFAULT_CAPS, proEditorV2: flag }, mode, setMode: vi.fn() });

  it('setView calls setMode (and remembers on a phone); it never touches the document', () => {
    const studio = studioWith('easy');
    const { result } = renderHook(() => useProEditor(studio, { pageId: 'pg_1', phone: true, inArt: false }));
    expect(result.current.view).toBe('easy');
    act(() => result.current.setView('pro'));
    expect(studio.setMode).toHaveBeenCalledWith('pro');
    expect(window.localStorage.getItem(EDITOR_MODE_KEY)).toBe('pro');
    expect(result.current.view).toBe('pro');
    expect(result.current.pro).toBe(true);
  });

  it('flag off: off, today’s view, no parts; storage throwing never breaks it', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useProEditor(studioWith('pro', false), { pageId: 'pg_1', phone: true, inArt: false }));
    expect(result.current.on).toBe(false);
    expect(result.current.pro).toBe(false);
    expect(result.current.view).toBe('pro');
    expect(result.current.parts.inspector).toBeUndefined();
    spy.mockRestore();
  });

  it('in-art comics turn the lettering tools off with the note; Shapes waits for compose', () => {
    const { result } = renderHook(() => useProEditor(studioWith('pro'), { pageId: 'pg_1', phone: false, inArt: true }));
    expect(result.current.disabled).toMatchObject({ text: IN_ART_LETTERING_NOTE, balloon: IN_ART_LETTERING_NOTE, sfx: IN_ART_LETTERING_NOTE });
    expect(result.current.tools).not.toContain('shapes');
  });

  it('"Edit lettering" hands the next editor on that page its tool, once', () => {
    requestEditorTool('pg_2', 'balloon');
    expect(takeEditorTool('pg_1')).toBeNull();
    const { result } = renderHook(() => useProEditor(studioWith('pro'), { pageId: 'pg_2', phone: false, inArt: false }));
    expect(result.current.tool).toBe('balloon');
    expect(takeEditorTool('pg_2')).toBeNull();
  });

  it('coach cards follow the mounted parts', () => {
    const P = () => null;
    expect(coachCardsFor({}).map((c) => c.id)).toEqual([]);
    expect(coachCardsFor({ layers: P, assets: P, animate: P }).map((c) => c.id)).toEqual(['layers', 'effects', 'animate']);
  });
});

describe('the pieces', () => {
  it('the switch: "Easy or Pro mode", Pro off without caps.proEditor, 44 px segments under a coarse pointer', () => {
    const onChange = vi.fn();
    render(<ProModeSwitch value="easy" onChange={onChange} canPro={false} />);
    const group = screen.getByRole('radiogroup', { name: MODE_GROUP_LABEL });
    const pro = within(group).getByRole('radio', { name: 'Pro mode' });
    expect(pro).toBeDisabled();
    for (const r of within(group).getAllByRole('radio')) expect(r.className).toMatch(/coarse:min-h-\[44px\]/);
  });

  it('the rail: one pressed tool, keys in the tooltip, in-art reason as a description, 44 px coarse squares', () => {
    const onTool = vi.fn();
    render(<ToolRail tool="select" onTool={onTool} tools={PRO_TOOLS.map((t) => t.id)} disabled={{ text: IN_ART_LETTERING_NOTE }} />);
    const rail = screen.getByRole('toolbar', { name: 'Tools' });
    const buttons = within(rail).getAllByRole('button');
    expect(buttons).toHaveLength(8);
    expect(buttons.filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    for (const b of buttons) expect(b.className).toMatch(/coarse:min-h-\[var\(--ds-density-touch\)\] coarse:min-w-\[var\(--ds-density-touch\)\]/);
    const text = within(rail).getByRole('button', { name: 'Text' });
    expect(text).toHaveAttribute('aria-disabled', 'true');
    expect(text).toHaveAccessibleDescription(IN_ART_LETTERING_NOTE);
    fireEvent.click(text);
    expect(onTool).not.toHaveBeenCalled();
    fireEvent.click(within(rail).getByRole('button', { name: 'Hand' }));
    expect(onTool).toHaveBeenCalledWith('hand');
    expect(within(rail).getByRole('button', { name: 'Balloon' })).toHaveAttribute('aria-keyshortcuts', 'B');
  });

  it('the top bar: undo says what it undoes, the zoom shows, phones get the switch only', () => {
    render(<ProTopBar mode="pro" onModeChange={vi.fn()} canPro variant="full" canUndo undoLabel="Move balloon" onUndo={vi.fn()} zoom={1.5} onHelp={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Undo Move balloon' }).textContent).toBe('Undo · Move balloon');
    expect(screen.getByTestId('pro-zoom').textContent).toBe('150%');
    cleanup();
    render(<ProTopBar mode="pro" onModeChange={vi.fn()} canPro variant="phone" onHelp={vi.fn()} />);
    expect(screen.queryByTestId('pro-undo')).toBeNull();
    expect(screen.queryByTestId('pro-help')).toBeNull();
    expect(screen.getByRole('radiogroup', { name: MODE_GROUP_LABEL })).toBeInTheDocument();
  });

  it('the dock: tabs, the free footer under free panels only, a fixed column width', () => {
    const onChange = vi.fn();
    render(
      <ProDock
        width={360}
        value="properties"
        onChange={onChange}
        tabs={[
          { id: 'properties', label: 'Properties', content: <p>props</p>, free: true },
          { id: 'ai', label: 'AI', content: <p>ai</p>, free: false }
        ]}
      />
    );
    const dock = screen.getByTestId('pro-dock');
    expect(dock.style.width).toBe('360px');
    expect(within(dock).getByTestId('pro-free-footer').textContent).toBe(PRO_FREE_FOOTER);
    fireEvent.click(within(dock).getByRole('tab', { name: 'AI' }));
    expect(onChange).toHaveBeenCalledWith('ai');
  });

  it('the coach: one tip at a time, Next, Got it', () => {
    const onDismiss = vi.fn();
    render(<ProCoach cards={coachCardsFor({ layers: () => null, assets: () => null })} onDismiss={onDismiss} />);
    expect(screen.getByTestId('pro-coach').getAttribute('data-card')).toBe('layers');
    fireEvent.click(screen.getByRole('button', { name: 'Next tip' }));
    expect(screen.getByTestId('pro-coach').getAttribute('data-card')).toBe('effects');
    expect(screen.queryByRole('button', { name: 'Next tip' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('the shortcut sheet: non-modal, focus moves in, Esc closes', () => {
    const onClose = vi.fn();
    render(<ShortcutSheet onClose={onClose} />);
    const sheet = screen.getByRole('dialog', { name: 'Shortcuts and Pro tips' });
    expect(sheet).not.toHaveAttribute('aria-modal');
    expect(document.activeElement).toBe(sheet);
    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
