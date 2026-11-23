// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioDirectory } from './StudioDirectory';

afterEach(cleanup);

function mount(signedIn: boolean) {
  const actions = { onSignIn: vi.fn(), onStartCreating: vi.fn(), onOpenComics: vi.fn(), onBrowseGallery: vi.fn() };
  render(<StudioDirectory signedIn={signedIn} {...actions} />);
  return actions;
}

describe('workspace directory', () => {
  it('sends guests to sign-in for creator work and opens the public library directly', () => {
    const actions = mount(false);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to create' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to edit' }));
    expect(actions.onSignIn).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('link', { name: 'Sign in to draw' })).toHaveAttribute('href', '/?view=images');
    expect(actions.onOpenComics).not.toHaveBeenCalled();
    expect(actions.onStartCreating).not.toHaveBeenCalled();
    const library = screen.getByRole('link', { name: 'Browse published comics' });
    expect(library.getAttribute('href')).toBe('/?view=gallery');
    fireEvent.click(library);
    expect(actions.onBrowseGallery).toHaveBeenCalledOnce();
  });

  it.each([false, true])('offers project-free text and voice chat (signed in %s)', signedIn => {
    mount(signedIn);
    expect(screen.getByRole('link', { name: 'Start a chat' })).toHaveAttribute('href', '/?view=chat');
    expect(screen.getByRole('link', { name: 'Talk by voice' })).toHaveAttribute('href', '/?view=chat&voice=1');
  });

  it('leaves modified library clicks to the browser', () => {
    const actions = mount(true);
    const library = screen.getByRole('link', { name: 'Browse published comics' });
    let appClaimedClick = true;
    // Inspect the event after React's handler, then cancel jsdom's default navigation.
    window.addEventListener('click', (event) => {
      appClaimedClick = event.defaultPrevented;
      event.preventDefault();
    }, { once: true });
    fireEvent.click(library, { ctrlKey: true });
    expect(appClaimedClick).toBe(false);
    expect(actions.onBrowseGallery).not.toHaveBeenCalled();
  });

  it('opens the new comic flow or the project chooser for members', () => {
    const actions = mount(true);
    fireEvent.click(screen.getByRole('button', { name: 'Start a comic' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose a project' }));
    expect(actions.onStartCreating).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: 'Open image workspace' })).toHaveAttribute('href', '/?view=images');
    expect(actions.onOpenComics).toHaveBeenCalledOnce();
    expect(actions.onSignIn).not.toHaveBeenCalled();
  });
});
