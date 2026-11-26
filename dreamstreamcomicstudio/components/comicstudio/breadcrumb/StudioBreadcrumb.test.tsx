// The studio breadcrumb (SH-C2): which crumbs show (and how they fold on a phone), the last one marked as where you are,
// each crumb past the name going where it says, the name still renaming the comic, and the classes that keep it from ever
// pushing the header sideways. Synthetic labels only.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { breadcrumbCrumbs } from './breadcrumbModel';
import { StudioBreadcrumb } from './StudioBreadcrumb';

afterEach(cleanup);

const keys = (input: Parameters<typeof breadcrumbCrumbs>[0]) => breadcrumbCrumbs(input).map((c) => `${c.key}${c.current ? '*' : ''}`);

describe('breadcrumbCrumbs', () => {
  it('My comics › the comic › the area › the part, the last one current', () => {
    expect(keys({ myComics: true, room: 'wide', area: 'Pages', item: 'Page 3' })).toEqual(['comics', 'title', 'area', 'item*']);
    expect(keys({ myComics: true, room: 'wide', area: 'Pages' })).toEqual(['comics', 'title', 'area*']);
    expect(keys({ myComics: true, room: 'wide' })).toEqual(['comics', 'title*']);
    // A part needs its area: with the board out of sight there is neither.
    expect(keys({ myComics: true, room: 'wide', item: 'Page 3' })).toEqual(['comics', 'title*']);
    // Where the header has its own Back, My comics is not repeated.
    expect(keys({ myComics: false, room: 'wide', area: 'Cast' })).toEqual(['title', 'area*']);
  });

  it('folds below 1024 px (My comics is the drawer’s first row) and on a phone held upright (the name alone)', () => {
    expect(keys({ myComics: true, room: 'medium', area: 'Pages', item: 'Page 3' })).toEqual(['title', 'area', 'item*']);
    expect(keys({ myComics: true, room: 'medium', area: 'Pages' })).toEqual(['title', 'area*']);
    // 40 to 110 px of header: no crumb beside the name, which stays readable; the drawer's tree marks where you are.
    expect(keys({ myComics: true, room: 'narrow', area: 'Pages', item: 'Page 3' })).toEqual(['title*']);
    expect(keys({ myComics: true, room: 'narrow', area: 'Pages' })).toEqual(['title*']);
    expect(keys({ myComics: true, room: 'narrow' })).toEqual(['title*']);
  });
});

describe('StudioBreadcrumb', () => {
  const mount = (props: Partial<React.ComponentProps<typeof StudioBreadcrumb>> = {}) => {
    const handlers = { onRename: vi.fn(), onMyComics: vi.fn(), area: vi.fn(), item: vi.fn() };
    render(
      <StudioBreadcrumb
        title="Salt Road"
        onRename={handlers.onRename}
        onMyComics={handlers.onMyComics}
        area={{ label: 'Cast', onGo: handlers.area }}
        item={{ label: 'Maya the cartographer of the salt flats', onGo: handlers.item }}
        {...props}
      />
    );
    return handlers;
  };
  const nav = () => screen.getByRole('navigation', { name: 'Breadcrumb' });

  it('is a labelled list; every crumb past the name navigates and the last is the current page', () => {
    const h = mount();
    const list = within(nav()).getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    fireEvent.click(within(nav()).getByRole('button', { name: 'My comics' }));
    fireEvent.click(within(nav()).getByRole('button', { name: 'Cast' }));
    fireEvent.click(within(nav()).getByRole('button', { name: 'Maya the cartographer of the salt flats' }));
    expect(h.onMyComics).toHaveBeenCalledTimes(1);
    expect(h.area).toHaveBeenCalledTimes(1);
    expect(h.item).toHaveBeenCalledTimes(1);
    expect(nav().querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(within(nav()).getByRole('button', { name: /^Maya/ })).toHaveAttribute('aria-current', 'page');
    // The separators are decoration.
    for (const svg of Array.from(nav().querySelectorAll('svg'))) expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('the comic’s crumb is its name field: rename on blur, Escape puts it back', () => {
    const h = mount();
    const title = within(nav()).getByRole('textbox', { name: 'Comic title' });
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: 'Salt Road, Part Two' } });
    fireEvent.blur(title);
    expect(h.onRename).toHaveBeenCalledWith('Salt Road, Part Two');
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: 'Oops' } });
    fireEvent.keyDown(title, { key: 'Escape' });
    expect(title).toHaveValue('Salt Road');
    expect(h.onRename).toHaveBeenCalledTimes(1);
  });

  it('truncates gracefully: the name shrinks first to a readable floor, then each crumb ends in an ellipsis at 44 px', () => {
    mount({ room: 'medium' });
    expect(within(nav()).queryByRole('button', { name: 'My comics' })).toBeNull();
    const name = within(nav()).getByRole('textbox', { name: 'Comic title' });
    expect(name.closest('li')!.className.split(' ')).toContain('min-w-[5rem]');
    for (const crumb of [within(nav()).getByRole('button', { name: 'Cast' }), within(nav()).getByRole('button', { name: /^Maya/ })]) {
      const li = crumb.closest('li')!;
      // It may shrink (never a fixed width that the nav would cut mid-word), down to its 44 px target, ending in "…".
      expect(li.className.split(' ')).not.toContain('shrink-0');
      expect(li.className).toContain('max-w-[10rem]');
      expect(crumb.className.split(' ')).toEqual(expect.arrayContaining(['min-w-11', 'coarse:h-11']));
      expect(crumb.querySelector('.truncate')).not.toBeNull();
      expect(crumb).toHaveAttribute('title', crumb.textContent);
    }
    // The breadcrumb shrinks, and clips sideways only as a last resort, rather than ever pushing the header's controls.
    expect(nav().className.split(' ')).toEqual(expect.arrayContaining(['min-w-0', 'overflow-x-clip']));
  });

  it('a phone held upright: the name alone, taking all the room there is', () => {
    mount({ room: 'narrow' });
    expect(within(nav()).queryAllByRole('button')).toEqual([]);
    const name = within(nav()).getByRole('textbox', { name: 'Comic title' });
    expect(name).toHaveAttribute('aria-current', 'page');
    expect(name.closest('li')!.className.split(' ')).toContain('min-w-0');
    expect(name.className).toContain('truncate');
  });

  it('the name ends where its words do: its hidden copy sets the width and the field lies over it', () => {
    mount();
    const name = within(nav()).getByRole('textbox', { name: 'Comic title' });
    // Placed over the copy, so the field's own intrinsic width never widens the name (the e2e measures the real gap).
    expect(name.className.split(' ')).toEqual(expect.arrayContaining(['absolute', 'inset-0', 'w-full', 'min-w-0']));
    expect(name.parentElement!.className.split(' ')).toEqual(expect.arrayContaining(['relative', 'inline-grid']));
    const copy = name.parentElement!.querySelector('[data-title-copy]')!;
    expect(copy).toHaveAttribute('aria-hidden', 'true');
    expect(copy.textContent).toBe('Salt Road ');
    // The same type and padding as the field, and the field's 44 px height on touch.
    expect(copy.className).toContain('coarse:min-h-[44px]');
    expect(copy.className).toContain('px-2');
  });

  it('stays ink: muted words for the way back, ink for where you are', () => {
    mount();
    const classes = Array.from(nav().querySelectorAll('[class]'), (el) => el.getAttribute('class')).join(' ');
    expect(classes).not.toMatch(/hue|wash|spark|accent|success|warning|danger/);
    expect(within(nav()).getByRole('button', { name: 'Cast' }).className).toContain('text-[var(--ds-muted)]');
    expect(within(nav()).getByRole('button', { name: /^Maya/ }).className).toContain('text-[var(--ds-ink)]');
  });
});
