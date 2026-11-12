// The Pro shell's pure rules and pieces (PE-SHELL): the keyboard table, the D7 view rule, the hook (one concept: the
// switch is setMode, never an op), the tool rail, the top bar and the dock frame, with 44 px coarse targets.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import { IN_ART_LETTERING_NOTE, PRO_FREE_FOOTER } from '../../../shared/comic/pro/types';
import { PRO_TOOLS, SHORTCUT_SHEET, cycleReadingOrder, isEditableTarget, selectionHoldsArrows, shellShortcut, type ProTool } from './shortcuts';
import { PRO_COACH_KEY, PRO_COACH_READERS_LINE, coachCardsFor, editorViewFor, reachableParts, readDismissedTips, useProEditor } from './useProEditor';
import { MODE_STORAGE_KEY, useStudioMode } from '../useStudioMode';
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
  it('flag on, phone: Easy until this device has a stored choice (useStudioMode’s key), then studio.mode', () => {
    expect(editorViewFor({ flag: true, canPro: true, phone: true, studioMode: 'pro', stored: null })).toBe('easy');
    expect(editorViewFor({ flag: true, canPro: true, phone: true, studioMode: 'pro', stored: 'pro' })).toBe('pro');
    // A choice exists: the studio's view (a later switch elsewhere on this device included) wins.
    expect(editorViewFor({ flag: true, canPro: true, phone: true, studioMode: 'easy', stored: 'pro' })).toBe('easy');
  });
  it('flag on, larger layouts: studio.mode', () => {
    expect(editorViewFor({ flag: true, canPro: true, phone: false, studioMode: 'pro', stored: 'easy' })).toBe('pro');
  });
});

describe('useProEditor', () => {
  const studioWith = (mode: 'easy' | 'pro' = 'easy', flag = true) => ({ caps: { ...DEFAULT_CAPS, proEditorV2: flag }, mode, setMode: vi.fn() });

  it('setView calls setMode; on a phone the ONE device key (comicstudio.mode) is the memory; it never touches the document', () => {
    const caps = { ...DEFAULT_CAPS, proEditorV2: true, defaultMode: 'pro' as const };
    const setMode = vi.fn();
    const { result } = renderHook(() => {
      const m = useStudioMode(caps);
      return useProEditor({ caps, mode: m.mode, setMode: (x) => (setMode(x), m.setMode(x)) }, { pageId: 'pg_1', phone: true, inArt: false });
    });
    // First open on this device: Easy, though the plan's default is Pro.
    expect(result.current.view).toBe('easy');
    act(() => result.current.setView('pro'));
    expect(setMode).toHaveBeenCalledWith('pro');
    expect(window.localStorage.getItem(MODE_STORAGE_KEY)).toBe('pro');
    expect(result.current.view).toBe('pro');
    expect(result.current.pro).toBe(true);
    expect(window.localStorage.getItem('comicstudio.editor.mode')).toBeNull();
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

  it('the editor opens on the Select tool', () => {
    const { result } = renderHook(() => useProEditor(studioWith('pro'), { pageId: 'pg_2', phone: false, inArt: false }));
    expect(result.current.tool).toBe('select');
  });

  it('coach cards follow the mounted parts, and only the ones this layout can reach', () => {
    const P = () => null;
    expect(coachCardsFor({}).map((c) => c.id)).toEqual([]);
    expect(coachCardsFor({ layers: P, assets: P, animate: P }).map((c) => c.id)).toEqual(['layers', 'effects', 'animate']);
    const all = { layers: P, assets: P, animate: P };
    expect(coachCardsFor(reachableParts(all, 'docked')).map((c) => c.id)).toEqual(['layers', 'effects', 'animate']);
    // 768: Layers and Assets have the tool row's drawer; there is no timeline there in S2.
    expect(coachCardsFor(reachableParts(all, 'tool-row')).map((c) => c.id)).toEqual(['layers', 'effects']);
    // Phones: the thumb bar's Layers button only.
    expect(coachCardsFor(reachableParts(all, 'phone')).map((c) => c.id)).toEqual(['layers']);
  });

  it('the Animate tip promises what readers see only with reader motion on (COMIC_READER_MOTION, off by default)', () => {
    const P = () => null;
    const off = coachCardsFor({ animate: P })[0];
    expect(off.body).toBe('Give a balloon or an effect an entrance you can preview here and export as video.');
    expect(off.body).not.toMatch(/readers/i);
    expect(coachCardsFor({ animate: P }, { readerMotion: true })[0].body).toBe(`${off.body} ${PRO_COACH_READERS_LINE}`);
  });

  it('a dismissed tip stays dismissed per card: a part that mounts later still shows its tip once; "again" resets', () => {
    const P = () => null;
    const caps = { ...DEFAULT_CAPS, proEditorV2: true };
    const studio = { caps, mode: 'pro' as const, setMode: vi.fn() };
    const only = { layers: { part: { id: 'layers' as const, ready: true }, Panel: P } };
    const read1 = (id: string) => (only as Record<string, unknown>)[id] ?? { part: { id, ready: false } };
    const first = renderHook(() => useProEditor(studio, { pageId: 'pg_1', phone: false, inArt: false }, read1 as never));
    expect(first.result.current.coach.cards.map((c) => c.id)).toEqual(['layers']);
    act(() => first.result.current.coach.dismiss());
    expect(JSON.parse(window.localStorage.getItem(PRO_COACH_KEY)!)).toEqual(['layers']);
    expect(first.result.current.coach.open).toBe(false);
    first.unmount();
    // S3: the assets part mounts. Its tip shows; the dismissed Layers tip does not.
    const both = { ...only, assets: { part: { id: 'assets' as const, ready: true }, Panel: P } };
    const read2 = (id: string) => (both as Record<string, unknown>)[id] ?? { part: { id, ready: false } };
    const second = renderHook(() => useProEditor(studio, { pageId: 'pg_1', phone: false, inArt: false }, read2 as never));
    expect(second.result.current.coach.cards.map((c) => c.id)).toEqual(['effects']);
    expect(second.result.current.coach.all.map((c) => c.id)).toEqual(['layers', 'effects']);
    act(() => second.result.current.coach.reopen());
    expect(second.result.current.coach.cards.map((c) => c.id)).toEqual(['layers', 'effects']);
    expect(readDismissedTips()).toEqual([]);
  });

  it('a bad stored value is "none dismissed" (try/catch), never a crash', () => {
    window.localStorage.setItem(PRO_COACH_KEY, '{not json');
    expect(readDismissedTips()).toEqual([]);
    window.localStorage.setItem(PRO_COACH_KEY, JSON.stringify(['layers', 'nope', 'layers']));
    expect(readDismissedTips()).toEqual(['layers']);
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
    // Visible text, read as "Zoom 150%" (no aria-label on a role-less span).
    const zoom = screen.getByTestId('pro-zoom');
    expect(zoom.textContent).toBe('Zoom 150%');
    expect(zoom.querySelector('.sr-only')?.textContent).toBe('Zoom ');
    expect(zoom).not.toHaveAttribute('aria-label');
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
