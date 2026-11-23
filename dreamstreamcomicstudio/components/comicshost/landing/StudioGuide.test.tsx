// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComicsLanding, type ComicsLandingProps } from '../ComicsLanding';
import { shouldBootToDashboard } from '../hostRouting';

const feedback = vi.hoisted(() => vi.fn());
vi.mock('../../../services/openFeedbackReport', () => ({ openFeedbackReport: feedback }));

function home(tourAccountId?: string) {
  const actions: ComicsLandingProps = { signedIn: Boolean(tourAccountId), tourAccountId, onRequestAccess: vi.fn(), onSignIn: vi.fn(), onOpenComics: vi.fn(), onStartCreating: vi.fn(), onBrowseGallery: vi.fn(), onOpenTerms: vi.fn(), onOpenPrivacy: vi.fn() };
  const rendered = render(<ComicsLanding {...actions} />);
  return { ...rendered, ...actions };
}
const button = (name: string) => screen.getByRole('button', { name });
const click = (name: string) => fireEvent.click(button(name));
const dialog = () => within(screen.getByRole('dialog'));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  feedback.mockClear();
  localStorage.clear();
  history.replaceState(null, '', '/');
});

describe('Studio guide', () => {
  it('waits for a visitor to start, saves a closed stop across a reload, and returns focus to the opener', async () => {
    const first = home();
    expect(screen.queryByRole('dialog')).toBeNull();
    const trigger = button('Take the studio tour');
    trigger.focus();
    fireEvent.click(trigger);
    expect(dialog().getByRole('heading', { name: /Read a comic, step 1 of 4/ })).toHaveFocus();
    click('Next');
    expect(dialog().getByRole('heading', { name: /Make your first comic/ })).toHaveFocus();
    click('Close studio guide');
    await waitFor(() => expect(trigger).toHaveFocus());
    first.unmount();
    home();
    click('Continue studio tour');
    expect(dialog().getByRole('heading', { name: /Make your first comic/ })).toHaveFocus();
    click('Back');
    expect(dialog().getByRole('heading', { name: /Read a comic/ })).toHaveFocus();
    expect(first.onRequestAccess).not.toHaveBeenCalled();
  });

  it('finishes, replays, and can be skipped from any stop, with account-specific progress', () => {
    const member = home('reader-a');
    click('Studio guide');
    click('Next');
    click('Next');
    expect(dialog().getByRole('link', { name: 'Open image workspace' })).toHaveAttribute('href', '/?view=images');
    click('Next');
    expect(dialog().getByRole('link', { name: 'Open chat' })).toHaveAttribute('href', '/?view=chat');
    expect(dialog().getByRole('link', { name: 'Talk by voice' })).toHaveAttribute('href', '/?view=chat&voice=1');
    click('Finish');
    member.unmount();
    const same = home('reader-a');
    click('Replay studio tour');
    expect(dialog().getByRole('heading', { name: /Read a comic/ })).toBeVisible();
    click('Skip tour');
    expect(screen.queryByRole('dialog')).toBeNull();
    same.unmount();
    home('reader-b');
    expect(button('Take the studio tour')).toBeVisible();
  });

  it('opens an explicit member deep link; closing leaves unrelated query, hash and history state intact', () => {
    history.replaceState({ previous: 'home' }, '', '/?tour=1&source=sidebar#top');
    expect(shouldBootToDashboard(location)).toBe(false);
    home('member-1');
    expect(dialog().getByRole('heading', { name: /Read a comic/ })).toBeVisible();
    click('Skip tour');
    expect(location.search + location.hash).toBe('?source=sidebar#top');
    expect(history.state).toMatchObject({ previous: 'home' });
    expect(shouldBootToDashboard(location)).toBe(true);
  });

  it('opens the public Library, sends guests to signup, and starts a comic for a member only when requested', () => {
    const guest = home();
    click('Take the studio tour');
    click('Browse the Library');
    expect(guest.onBrowseGallery).toHaveBeenCalledTimes(1);
    click('Continue studio tour');
    click('Next');
    click('Create an account');
    expect(guest.onRequestAccess).toHaveBeenCalledTimes(1);
    guest.unmount();
    const member = home('maker');
    click('Take the studio tour');
    click('Next');
    click('Start a comic');
    expect(member.onStartCreating).toHaveBeenCalledTimes(1);
    expect(member.onRequestAccess).not.toHaveBeenCalled();
  });

  it('works with damaged or blocked storage; feedback remains available independently of the guide', async () => {
    localStorage.setItem('comic.studio-guide.v1.guest', '4');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage disabled'); });
    home();
    click('Take the studio tour');
    click('Next');
    click('Close studio guide');
    click('Continue studio tour');
    expect(dialog().getByRole('heading', { name: /Make your first comic/ })).toBeVisible();
    click('Skip tour');
    click('Send feedback');
    await waitFor(() => expect(feedback).toHaveBeenCalledTimes(1));
  });
});
