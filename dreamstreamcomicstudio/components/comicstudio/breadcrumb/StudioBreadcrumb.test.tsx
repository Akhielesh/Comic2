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

  it('folds below 1024 px (My comics is the drawer’s first row) and on a phone (only the deepest crumb follows)', () => {
    expect(keys({ myComics: true, room: 'medium', area: 'Pages', item: 'Page 3' })).toEqual(['title', 'area', 'item*']);
    expect(keys({ myComics: true, room: 'narrow', area: 'Pages', item: 'Page 3' })).toEqual(['title', 'item*']);
    expect(keys({ myComics: true, room: 'narrow', area: 'Pages' })).toEqual(['title', 'area*']);
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

  it('truncates gracefully: the name shrinks first to a floor, the part clips with its words in the tooltip', () => {
    mount({ room: 'narrow' });
    expect(within(nav()).queryByRole('button', { name: 'My comics' })).toBeNull();
    expect(within(nav()).queryByRole('button', { name: 'Cast' })).toBeNull();
    const part = within(nav()).getByRole('button', { name: /^Maya/ });
    expect(part).toHaveAttribute('title', 'Maya the cartographer of the salt flats');
    expect(part.querySelector('.truncate')).not.toBeNull();
    expect(part.closest('li')!.className).toMatch(/(?:^|\s)min-w-0(?:\s|$)/);
    expect(part.closest('li')!.className).toContain('max-w-[10rem]');
    const name = within(nav()).getByRole('textbox', { name: 'Comic title' });
    expect(name.className).toContain('truncate');
    expect(name.closest('li')!.className.split(' ')).toEqual(expect.arrayContaining(['min-w-[2.5rem]', 'sm:min-w-[4rem]']));
    // The breadcrumb shrinks and clips sideways rather than ever pushing the header's controls.
    expect(nav().className.split(' ')).toEqual(expect.arrayContaining(['min-w-0', 'overflow-x-clip']));
    // Touch targets.
    expect(part.className).toContain('coarse:h-11');
  });

  it('stays ink: muted words for the way back, ink for where you are', () => {
    mount();
    const classes = Array.from(nav().querySelectorAll('[class]'), (el) => el.getAttribute('class')).join(' ');
    expect(classes).not.toMatch(/hue|wash|spark|accent|success|warning|danger/);
    expect(within(nav()).getByRole('button', { name: 'Cast' }).className).toContain('text-[var(--ds-muted)]');
    expect(within(nav()).getByRole('button', { name: /^Maya/ }).className).toContain('text-[var(--ds-ink)]');
  });
});
