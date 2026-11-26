// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ComicTaskActivity } from './ComicTaskActivity';
import { consumeTaskTarget } from './workspaceTaskTarget';
import { loadComicActivity, type ComicActivityRow } from '../../../services/comicWorkspaceActivity';

vi.mock('../../../services/comicWorkspaceActivity', () => ({ loadComicActivity: vi.fn() }));
const load = vi.mocked(loadComicActivity);
const row = (title: string): ComicActivityRow => ({
  v: 1, title, id: 'comic-1', working: false, attention: 'approval', finished: [{ kind: 'pages', at: 1000, count: 2 }]
});
const result = (rows: ComicActivityRow[]) => ({ rows, hasMore: false, next: 25 });
const mount = (account: string, onOpen = vi.fn()) => <ComicTaskActivity key={account} accountId={account} onOpen={onOpen} />;
const expand = () => fireEvent.click(screen.getByRole('button', { name: /AI activity/i }));

beforeEach(() => { localStorage.clear(); load.mockReset(); Object.defineProperty(navigator, 'onLine', { value: true, configurable: true }); });
afterEach(cleanup);
it('opens completed pages or a pending estimate without approving, and clearing finished survives a reload', async () => {
  load.mockResolvedValue(result([row('Night ferry')]));
  const open = vi.fn();
  const first = render(mount('owner', open)); expand();
  const pages = await screen.findByRole('link', { name: /Night ferry .*2 pages drawn/ });
  expect(pages.getAttribute('href')).toContain('task=pages');
  fireEvent.click(pages); expect(open).toHaveBeenCalledWith('comic-1');
  expect(consumeTaskTarget('owner', 'comic-1')).toBe('pages');
  fireEvent.click(screen.getByRole('link', { name: /Review drawing estimate/ }));
  expect(consumeTaskTarget('owner', 'comic-1')).toBe('conversation');
  fireEvent.click(screen.getByRole('button', { name: 'Clear finished here' }));
  first.unmount(); render(mount('owner')); expand();
  expect(await screen.findByRole('link', { name: /Review drawing estimate/ })).toBeTruthy();
  expect(screen.queryByRole('link', { name: /pages drawn/ })).toBeNull();
  load.mockResolvedValue(result([{ ...row('Night ferry'), finished: [{ kind: 'pages', at: 2000, count: 2 }] }]));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh AI activity' }));
  expect(await screen.findByRole('link', { name: /2 pages drawn/ })).toBeTruthy();
});
it('keeps last checked results on failure, recovers on reconnect and never shows a previous owner’s late response', async () => {
  load.mockResolvedValueOnce(result([row('Private A')])).mockRejectedValueOnce(new Error('network'));
  const view = render(mount('A')); expand();
  await screen.findByRole('link', { name: /Private A .*2 pages/ });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh AI activity' }));
  await screen.findByText('Couldn’t refresh'); expect(screen.getByText(/Last checked /)).toBeTruthy();
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
  fireEvent(window, new Event('offline')); await screen.findByText('Offline');
  let late!: (value: ReturnType<typeof result>) => void;
  load.mockImplementationOnce(() => new Promise((resolve) => { late = resolve; }));
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  fireEvent(window, new Event('online')); await waitFor(() => expect(late).toBeTypeOf('function'));
  load.mockResolvedValueOnce(result([row('Private B')]));
  view.rerender(mount('B')); expand();
  await screen.findByRole('link', { name: /Private B .*2 pages/ });
  await act(async () => late(result([row('Private A')])));
  expect(screen.queryByText('Private A')).toBeNull();
});
it('a comic whose key ran out says what to do (top up or switch key), not "Answer the Director", and opens the conversation', async () => {
  load.mockResolvedValue(result([{ ...row('Night ferry'), attention: 'credit' }, { ...row('Old summary'), id: 'comic-2', attention: 'question' }]));
  render(mount('owner')); expand();
  const credit = await screen.findByRole('link', { name: /Night ferry .*Top up or switch key/ });
  expect(screen.queryByRole('link', { name: /Night ferry .*Answer the Director/ })).toBeNull();
  // A summary saved before money had its own reason still reads as it did.
  expect(screen.getByRole('link', { name: /Old summary .*Answer the Director/ })).toBeTruthy();
  fireEvent.click(credit);
  expect(consumeTaskTarget('owner', 'comic-1')).toBe('conversation');
});
