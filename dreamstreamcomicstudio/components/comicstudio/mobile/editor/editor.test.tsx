import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { EditorToolbar, type EditorToolbarProps } from './EditorToolbar';
import { EditorToolsSheet, type EditorToolsSheetProps } from './EditorToolsSheet';

const toolbar = (props: Partial<EditorToolbarProps> = {}) => {
  const p: EditorToolbarProps = {
    orientation: 'horizontal',
    mode: 'move',
    onModeChange: vi.fn(),
    canUndo: true,
    canRedo: false,
    undoLabel: 'move a balloon',
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    lettering: { open: false, onToggle: vi.fn(), attention: 2 },
    tools: { open: true, onToggle: vi.fn() },
    tray: null,
    ...props
  };
  render(<EditorToolbar {...p} />);
  return p;
};

describe('EditorToolbar (mobile.md §5.6 bottom toolbar)', () => {
  it('Move | Mark up is one radio group; Undo / Redo / Lettering / Tools are 44 px labelled buttons', () => {
    const p = toolbar();
    const bar = screen.getByRole('toolbar', { name: 'Page editor' });
    const modes = within(bar).getByRole('radiogroup', { name: 'Editing mode' });
    expect(within(modes).getByRole('radio', { name: 'Move' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(modes).getByRole('radio', { name: 'Mark up' }));
    expect(p.onModeChange).toHaveBeenCalledWith('markup');
    fireEvent.click(within(bar).getByRole('button', { name: 'Undo move a balloon' }));
    expect(p.onUndo).toHaveBeenCalled();
    expect(within(bar).getByRole('button', { name: 'Redo' })).toBeDisabled();
    const lettering = within(bar).getByRole('button', { name: 'Lettering' });
    expect(lettering).toHaveAttribute('aria-expanded', 'false');
    expect(lettering).toHaveTextContent('2'); // free fixes waiting (outside the safe area, crowded, too long)
    fireEvent.click(lettering);
    expect(p.lettering!.onToggle).toHaveBeenCalled();
    fireEvent.click(within(bar).getByRole('button', { name: 'Hide page tools' }));
    expect(p.tools.onToggle).toHaveBeenCalled();
    for (const b of within(bar).getAllByRole('button')) expect(b.className).toMatch(/\bh-12\b/);
    // Visible labels in portrait (thumbs need words, not just icons).
    expect(bar).toHaveTextContent('Mark up');
    expect(bar).toHaveTextContent('Tools');
    // Safe area under the bar.
    expect(bar.getAttribute('style')).toContain('--sa-bottom-eff');
  });

  it('mark up is disabled without a drawing; in-art comics have no Lettering button', () => {
    toolbar({ markupDisabled: true, lettering: null });
    expect(screen.getByRole('radio', { name: 'Mark up' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Lettering' })).toBeNull();
  });

  it('the lettering tray adds balloons and runs the free fixes; it is part of the layout, above the bar', () => {
    const tray = { addKind: null, onAddKind: vi.fn(), canAdd: true, onTidy: vi.fn(), outsideCount: 3, onFixEdges: vi.fn(), hidden: false, onToggleHidden: vi.fn() };
    toolbar({ lettering: { open: true, onToggle: vi.fn() }, tray });
    const t = screen.getByRole('toolbar', { name: 'Lettering tools' });
    fireEvent.click(within(t).getByRole('button', { name: 'Add a speech balloon' }));
    expect(tray.onAddKind).toHaveBeenCalledWith('speech');
    fireEvent.click(within(t).getByRole('button', { name: 'Add a sound effect' }));
    expect(tray.onAddKind).toHaveBeenCalledWith('sfx');
    fireEvent.click(within(t).getByRole('button', { name: 'Tidy the balloons (free)' }));
    expect(tray.onTidy).toHaveBeenCalled();
    fireEvent.click(within(t).getByRole('button', { name: 'Move 3 balloons inside the safe area (free)' }));
    expect(tray.onFixEdges).toHaveBeenCalled();
    fireEvent.click(within(t).getByRole('button', { name: 'Hide lettering' }));
    expect(tray.onToggleHidden).toHaveBeenCalled();
    // In-flow before the bar (never floating over the page).
    const host = screen.getByTestId('editor-toolbar-host');
    expect(host.firstElementChild).toBe(t);
    expect(t.className).toContain('overflow-x-auto');
  });

  it('in a translated edition the add buttons are off (new lines start in the original)', () => {
    const tray = { addKind: null, onAddKind: vi.fn(), canAdd: false, onTidy: null, outsideCount: 0, onFixEdges: vi.fn(), hidden: false, onToggleHidden: vi.fn() };
    toolbar({ lettering: { open: true, onToggle: vi.fn() }, tray });
    expect(screen.getByRole('button', { name: 'Add a speech balloon' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add a speech balloon' })).toHaveAttribute('title', 'Add lines in the original language');
    expect(screen.getByRole('button', { name: 'Tidy the balloons (free)' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /inside the safe area/ })).toBeNull();
  });

  it('vertical rail (landscape phones): icon buttons with names, the tray beside the rail', () => {
    const tray = { addKind: 'thought' as const, onAddKind: vi.fn(), canAdd: true, onTidy: null, outsideCount: 0, onFixEdges: vi.fn(), hidden: false, onToggleHidden: vi.fn() };
    toolbar({ orientation: 'vertical', lettering: { open: true, onToggle: vi.fn() }, tray });
    const bar = screen.getByRole('toolbar', { name: 'Page editor' });
    expect(bar).toHaveAttribute('aria-orientation', 'vertical');
    expect(bar).not.toHaveTextContent('Tools');
    expect(screen.getByRole('button', { name: 'Hide page tools' }).className).toMatch(/\bh-11 w-11\b/);
    const host = screen.getByTestId('editor-toolbar-host');
    expect(host.firstElementChild).toBe(bar);
    expect(screen.getByRole('button', { name: 'Add a thought balloon' })).toHaveAttribute('aria-pressed', 'true');
  });
});

const sheet = (props: Partial<EditorToolsSheetProps> = {}) => {
  const p: EditorToolsSheetProps = {
    presentation: 'sheet',
    open: true,
    onOpenChange: vi.fn(),
    detent: 'peek',
    onDetentChange: vi.fn(),
    avail: 636,
    dismissible: true,
    children: <p>Edit with AI</p>,
    ...props
  };
  const utils = render(<EditorToolsSheet {...p} />);
  return { ...utils, p };
};

describe('EditorToolsSheet (mobile.md §4.3 page editor tools)', () => {
  it('sheet: rests at the detent height, holds ONE "Page tools" landmark, and the grabber steps through detents', () => {
    const { p } = sheet({ detent: 'half' });
    const region = screen.getByRole('region', { name: 'Page tools sheet' });
    expect(region).toHaveAttribute('data-detent', 'half');
    expect(region.style.height).toBe('318px');
    expect(within(region).getByRole('complementary', { name: 'Page tools' })).toHaveTextContent('Edit with AI');
    fireEvent.click(screen.getByRole('button', { name: /Resize page tools/ }));
    expect(p.onDetentChange).toHaveBeenCalledWith('full');
    fireEvent.click(screen.getByRole('button', { name: 'Close page tools' }));
    expect(p.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('sheet: Esc from half or full steps back to peek (not out of the editor)', () => {
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    try {
      const { p } = sheet({ detent: 'full' });
      fireEvent.keyDown(screen.getByRole('complementary', { name: 'Page tools' }), { key: 'Escape' });
      expect(p.onDetentChange).toHaveBeenCalledWith('peek');
      expect(outer).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', outer);
    }
  });

  it('sheet: dragging the header down past peek closes it; up snaps to a detent', () => {
    const { p } = sheet({ detent: 'peek' });
    const header = document.querySelector<HTMLElement>('[data-sheet-header]')!;
    fireEvent.pointerDown(header, { clientY: 400, pointerId: 1, button: 0, pointerType: 'touch' });
    fireEvent.pointerMove(header, { clientY: 600, pointerId: 1 });
    expect(screen.getByRole('region', { name: 'Page tools sheet' }).style.height).toBe('8px');
    fireEvent.pointerUp(header, { clientY: 600, pointerId: 1 });
    expect(p.onOpenChange).toHaveBeenCalledWith(false);

    // A slow drag up (110 px over a second) settles on the nearest detent: half.
    const now = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(1000);
    fireEvent.pointerDown(header, { clientY: 400, pointerId: 2, button: 0, pointerType: 'touch' });
    fireEvent.pointerMove(header, { clientY: 290, pointerId: 2 });
    fireEvent.pointerUp(header, { clientY: 290, pointerId: 2 });
    expect(p.onDetentChange).toHaveBeenLastCalledWith('half');
    now.mockRestore();
  });

  it('sheet: the root never scrolls, so the header (grabber, title, Close) stays at its top over the tools (gate: editor-tools-sheet-header-scrolled-away)', () => {
    sheet({ detent: 'peek', avail: 636 });
    const region = screen.getByRole('region', { name: 'Page tools sheet' });
    const header = region.querySelector<HTMLElement>('[data-sheet-header]')!;
    expect(region.firstElementChild).toBe(header);
    expect(within(header).getByRole('button', { name: 'Close page tools' })).toBeInTheDocument();
    // overflow: clip: not a scroll container, so a scrollIntoView()/focus() inside the tools can't scroll it
    // (an overflow: hidden box can be scrolled by script — that pushed the header out at 360×740).
    expect(region.className).toMatch(/\boverflow-clip\b/);
    // Where `clip` is unsupported (overflow: hidden fallback), a scroll that reaches the root snaps back.
    region.scrollTop = 44;
    fireEvent.scroll(region);
    expect(region.scrollTop).toBe(0);
    // The tools aside itself still scrolls freely (only it scrolls).
    const aside = within(region).getByRole('complementary', { name: 'Page tools' });
    expect(aside.className).toMatch(/\boverflow-y-auto\b/);
    aside.scrollTop = 300;
    fireEvent.scroll(aside);
    expect(aside.scrollTop).toBe(300);
    expect(region.scrollTop).toBe(0);
  });

  it('sheet: tablets cannot dismiss it; a closed sheet renders nothing', () => {
    const { unmount } = sheet({ dismissible: false });
    expect(screen.queryByRole('button', { name: 'Close page tools' })).toBeNull();
    unmount();
    sheet({ open: false });
    expect(screen.queryByRole('complementary', { name: 'Page tools' })).toBeNull();
  });

  it('side (landscape phones): 320 px beside the stage, collapses to a 44 px tab and back', () => {
    const { p, rerender } = sheet({ presentation: 'side', width: 320 });
    const side = document.querySelector<HTMLElement>('[data-tools="side"]')!;
    expect(side.style.width).toBe('320px');
    expect(side.style.paddingRight).toBe('var(--sa-right, 0px)');
    fireEvent.click(screen.getByRole('button', { name: 'Hide page tools' }));
    expect(p.onOpenChange).toHaveBeenCalledWith(false);
    rerender(<EditorToolsSheet {...p} presentation="side" open={false} />);
    expect(screen.queryByRole('complementary', { name: 'Page tools' })).toBeNull();
    const tab = screen.getByRole('button', { name: 'Show page tools' });
    expect(tab.className).toContain('w-11');
    fireEvent.click(tab);
    expect(p.onOpenChange).toHaveBeenLastCalledWith(true);
  });

  it('aside (desktop) and segment (foldables)', () => {
    const { rerender, p } = sheet({ presentation: 'aside', width: 400 });
    expect(document.querySelector<HTMLElement>('[data-tools="aside"]')!.style.width).toBe('400px');
    expect(screen.getByRole('complementary', { name: 'Page tools' })).toBeInTheDocument();
    rerender(<EditorToolsSheet {...p} presentation="segment" stacked header={<div data-testid="mode-row" />} />);
    expect(screen.getByTestId('mode-row')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Page tools' })).toBeInTheDocument();
  });
});
