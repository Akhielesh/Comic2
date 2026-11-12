/**
 * Menu and Popover (Radix): the Atlas classes on the tokens (OVERLAY on Z.popover; the highlighted row on
 * --ds-overlay-hover; a destructive row in the danger text ink), the keyboard contract (Enter / ↓ open the menu on its
 * first item, the arrow keys move with roving focus, a letter jumps by typeahead, Esc closes and focus returns to the
 * trigger; the popover moves focus in and back out), a finger opening the menu on its tap and never on touch-down,
 * 44 px rows under a coarse pointer, and no entrance animation under reduced motion (the submenu's too).
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  MENU_PANEL,
  MENU_ROW,
  MENU_SEPARATOR
} from './Menu';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger, POPOVER_PANEL } from './Popover';
import { Button } from './Button';
import { FOCUS_ITEM, OVERLAY } from '../chat/studioDesign';
import { DENSITY, TONE_TEXT, Z } from './recipes';
import { expectClasses } from './ds.testkit';

let reducedMotion = false;
beforeEach(() => {
  reducedMotion = false;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reducedMotion && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  }));
  // jsdom has no ResizeObserver; Radix's popper measures with it.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
/** A key on whatever has focus; Radix moves roving focus and typeahead focus in a timer, so let it run. */
const press = async (key: string) => {
  fireEvent.keyDown(document.activeElement!, { key });
  await flush();
};

function PageMenu({ onSelect, sub = false }: { onSelect?: (what: string) => void; sub?: boolean }) {
  const [grid, setGrid] = React.useState(true);
  const [view, setView] = React.useState('page');
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="outline">Page actions</Button>
      </MenuTrigger>
      <MenuContent>
        <MenuLabel>Page 3</MenuLabel>
        <MenuItem onSelect={() => onSelect?.('rename')}>
          Rename<MenuShortcut>F2</MenuShortcut>
        </MenuItem>
        <MenuItem onSelect={() => onSelect?.('duplicate')}>Duplicate</MenuItem>
        <MenuItem disabled>Move to another comic</MenuItem>
        <MenuItem onSelect={() => onSelect?.('download')}>Download</MenuItem>
        {sub ? (
          <MenuSub>
            <MenuSubTrigger>Move to</MenuSubTrigger>
            <MenuSubContent>
              <MenuItem onSelect={() => onSelect?.('chapter 1')}>Chapter 1</MenuItem>
            </MenuSubContent>
          </MenuSub>
        ) : null}
        <MenuSeparator />
        <MenuCheckboxItem checked={grid} onCheckedChange={setGrid}>
          Show the grid
        </MenuCheckboxItem>
        <MenuRadioGroup value={view} onValueChange={setView}>
          <MenuRadioItem value="page">One page</MenuRadioItem>
          <MenuRadioItem value="spread">Spread</MenuRadioItem>
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem variant="destructive" onSelect={() => onSelect?.('delete')}>
          Delete page
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

const openByKeyboard = (key: 'Enter' | 'ArrowDown' = 'Enter') => {
  const trigger = screen.getByRole('button', { name: 'Page actions' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key });
  return screen.getByRole('menu');
};

describe('Menu', () => {
  it('renders the Atlas classes: the OVERLAY panel on the popover layer, rows, separators, the destructive ink', () => {
    render(<PageMenu />);
    const menu = openByKeyboard();
    expectClasses(menu, OVERLAY, MENU_PANEL, Z.popover, 'ds-scale-in');
    expect(menu.closest('[data-radix-popper-content-wrapper]')?.parentElement).toBe(document.body); // portalled
    const rename = screen.getByRole('menuitem', { name: 'Rename' });
    expectClasses(rename, MENU_ROW, 'text-[var(--ds-ink)]');
    expect(rename.className).toContain('data-[highlighted]:bg-[var(--ds-overlay-hover)]');
    // Keyboard focus is the FOCUS_ITEM recipe (the overlay-row tint and the inset ring), not a re-spelling of it.
    expect(MENU_ROW).toContain(FOCUS_ITEM);
    expectClasses(rename, FOCUS_ITEM);
    const del = screen.getByRole('menuitem', { name: 'Delete page' });
    expectClasses(del, MENU_ROW, TONE_TEXT.danger);
    expect(del.className).not.toContain('text-[var(--ds-ink)]'); // one ink, never two stacked
    expectClasses(document.querySelector('[data-slot="menu-separator"]')!, MENU_SEPARATOR);
    expect(screen.getByRole('menuitemcheckbox', { name: 'Show the grid' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'One page' })).toHaveAttribute('aria-checked', 'true');
  });

  it('Enter opens it on the first item; ↓ / ↑ move with roving focus and skip the disabled item; Home / End jump', async () => {
    render(<PageMenu />);
    openByKeyboard('Enter');
    const item = (name: string) => screen.getByRole('menuitem', { name });
    expect(document.activeElement).toBe(item('Rename'));
    await press('ArrowDown');
    expect(document.activeElement).toBe(item('Duplicate'));
    await press('ArrowDown');
    expect(document.activeElement).toBe(item('Download')); // "Move to another comic" is disabled
    await press('ArrowUp');
    expect(document.activeElement).toBe(item('Duplicate'));
    await press('End');
    expect(document.activeElement).toBe(item('Delete page'));
    await press('Home');
    expect(document.activeElement).toBe(item('Rename'));
    // The focused row is the highlighted one, and only one row is in the tab order.
    expect(item('Rename')).toHaveAttribute('data-highlighted');
    expect(screen.getAllByRole('menuitem').filter((el) => el.tabIndex === 0)).toEqual([item('Rename')]);
  });

  it('typeahead: a letter jumps to the next item that starts with it, and the letters typed together narrow it', async () => {
    render(<PageMenu />);
    openByKeyboard('ArrowDown');
    await press('d');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Duplicate' }));
    await press('o');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Download' }));
  });

  it('Enter chooses an item and closes; Esc closes; focus goes back to the trigger each time', async () => {
    const onSelect = vi.fn();
    render(<PageMenu onSelect={onSelect} />);
    const trigger = screen.getByRole('button', { name: 'Page actions' });
    openByKeyboard();
    await press('ArrowDown');
    await press('Enter');
    expect(onSelect).toHaveBeenCalledWith('duplicate');
    expect(screen.queryByRole('menu')).toBeNull();
    await flush();
    expect(document.activeElement).toBe(trigger);
    openByKeyboard();
    await press('Escape');
    expect(screen.queryByRole('menu')).toBeNull();
    await flush();
    expect(document.activeElement).toBe(trigger);
  });

  it('opens on a press too (the trigger reports aria-expanded)', () => {
    render(<PageMenu />);
    const trigger = screen.getByRole('button', { name: 'Page actions' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('a finger opens it on the tap, never on touch-down: a scroll that starts on the trigger opens nothing', () => {
    render(<PageMenu />);
    const trigger = screen.getByRole('button', { name: 'Page actions' });
    // Touch-down, then the page scrolls (the browser cancels the pointer; no click follows).
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'touch' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.pointerCancel(trigger, { pointerType: 'touch' });
    expect(screen.queryByRole('menu')).toBeNull();
    // A tap: down, up, click.
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'touch' });
    fireEvent.pointerUp(trigger, { button: 0, pointerType: 'touch' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    // A plain click that no touch started (a mouse already toggled on its press) never toggles a second time.
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('a controlled menu follows open / onOpenChange (and a tap asks it to open)', () => {
    const onOpenChange = vi.fn();
    render(
      <Menu open={false} onOpenChange={onOpenChange}>
        <MenuTrigger>More</MenuTrigger>
        <MenuContent>
          <MenuItem>One</MenuItem>
        </MenuContent>
      </Menu>
    );
    const trigger = screen.getByRole('button', { name: 'More' });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'touch' });
    fireEvent.click(trigger);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Esc in a submenu closes the whole menu and focus goes back to the trigger', async () => {
    render(<PageMenu sub />);
    const trigger = screen.getByRole('button', { name: 'Page actions' });
    openByKeyboard();
    act(() => screen.getByRole('menuitem', { name: 'Move to' }).focus());
    await press('ArrowRight');
    expect(screen.getAllByRole('menu')).toHaveLength(2);
    await press('Escape');
    expect(screen.queryByRole('menu')).toBeNull();
    await flush();
    expect(document.activeElement).toBe(trigger);
  });

  it('44 px under a coarse pointer: every row', () => {
    render(<PageMenu />);
    openByKeyboard();
    for (const row of [...screen.getAllByRole('menuitem'), ...screen.getAllByRole('menuitemcheckbox'), ...screen.getAllByRole('menuitemradio')]) {
      expectClasses(row, DENSITY.coarse);
    }
  });

  it('under reduced motion nothing animates', () => {
    reducedMotion = true;
    render(<PageMenu />);
    expect(openByKeyboard().className).not.toContain('ds-scale-in');
  });

  it('the submenu enters with ds-scale-in, and not under reduced motion', async () => {
    const subPanel = async () => {
      openByKeyboard();
      act(() => screen.getByRole('menuitem', { name: 'Move to' }).focus());
      await press('ArrowRight');
      const sub = document.querySelector<HTMLElement>('[data-slot="menu-sub-content"]')!;
      expectClasses(sub, OVERLAY, MENU_PANEL);
      return sub;
    };
    const { unmount } = render(<PageMenu sub />);
    expect((await subPanel()).className).toContain('ds-scale-in');
    unmount();
    reducedMotion = true;
    render(<PageMenu sub />);
    expect((await subPanel()).className).not.toContain('ds-scale-in');
  });
});

function FilterPopover() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">Filters</Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Filters">
        <label>
          Kids only <input type="checkbox" />
        </label>
        <PopoverClose asChild>
          <Button size="sm">Done</Button>
        </PopoverClose>
      </PopoverContent>
    </Popover>
  );
}

describe('Popover', () => {
  it('renders the OVERLAY panel on the popover layer; the trigger reports and controls it', () => {
    render(<FilterPopover />);
    const trigger = screen.getByRole('button', { name: 'Filters' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    const panel = screen.getByRole('dialog', { name: 'Filters' });
    expectClasses(panel, OVERLAY, POPOVER_PANEL, Z.popover, 'ds-scale-in');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger.getAttribute('aria-controls')).toBe(panel.id);
  });

  it('moves focus in on open; Esc closes it and focus returns to the trigger; Done closes it too', async () => {
    render(<FilterPopover />);
    const trigger = screen.getByRole('button', { name: 'Filters' });
    fireEvent.click(trigger);
    await flush();
    const panel = screen.getByRole('dialog', { name: 'Filters' });
    expect(panel.contains(document.activeElement)).toBe(true);
    await press('Escape');
    expect(screen.queryByRole('dialog')).toBeNull();
    await flush();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('never opens on hover (so touch loses nothing)', () => {
    render(<FilterPopover />);
    const trigger = screen.getByRole('button', { name: 'Filters' });
    fireEvent.pointerMove(trigger, { pointerType: 'mouse' });
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('under reduced motion nothing animates', () => {
    reducedMotion = true;
    render(<FilterPopover />);
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.getByRole('dialog', { name: 'Filters' }).className).not.toContain('ds-scale-in');
  });
});
