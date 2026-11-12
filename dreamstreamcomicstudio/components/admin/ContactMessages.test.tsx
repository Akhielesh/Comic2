// Settings › Admin › Analytics › Contact (CONTACT-1): the admin reader for Settings › Contact messages.
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContactMessages } from './ContactMessages';
import { DENSITY } from '../ds';
import type { ContactMessage, ContactMessagesApi, ContactMessagesPage } from '../../services/adminContact';

const msg = (i: number, over: Partial<ContactMessage> = {}): ContactMessage => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  email: `person${i}@example.com`,
  message: `Message number ${i}\nsecond line`,
  created_at: new Date(Date.UTC(2026, 10, 12, 9, 0, 0) - i * 60_000).toISOString(),
  handled_at: null,
  ...over
});

const fakeApi = (pages: Array<ContactMessagesPage | Error>, mark?: ContactMessagesApi['markHandled']) => {
  const list = vi.fn(async (_cursor?: string) => {
    const next = pages.length > 1 ? pages.shift()! : pages[0];
    if (next instanceof Error) throw next;
    return next;
  });
  const markHandled = vi.fn(mark ?? (async (id: string) => ({ ok: true as const, id, handledAt: '2026-11-12T10:00:00.000Z' })));
  return { list, markHandled } satisfies ContactMessagesApi;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('ContactMessages', () => {
  it('lists messages newest first with a reply link, the full text and an Open chip', async () => {
    const api = fakeApi([{ items: [msg(1), msg(2, { handled_at: '2026-11-11T08:00:00.000Z' })], storageEnabled: true }]);
    render(<ContactMessages api={api} />);
    const list = await screen.findByRole('list', { name: 'Messages' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole('link', { name: /person1@example\.com/ })).toHaveAttribute('href', 'mailto:person1@example.com');
    expect(rows[0].textContent).toContain('Message number 1');
    expect(within(rows[0]).getByText('Open')).toBeInTheDocument();
    expect(within(rows[0]).getByRole('button', { name: 'Mark handled' })).toBeInTheDocument();
    expect(within(rows[1]).getByText('Handled')).toBeInTheDocument();
    expect(within(rows[1]).queryByRole('button', { name: 'Mark handled' })).toBeNull();
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.list).toHaveBeenCalledWith();
  });

  it('marks a message handled and shows it without reloading', async () => {
    const api = fakeApi([{ items: [msg(1)], storageEnabled: true }]);
    render(<ContactMessages api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark handled' }));
    await waitFor(() => expect(screen.getByText('Handled')).toBeInTheDocument());
    expect(api.markHandled).toHaveBeenCalledWith(msg(1).id);
    expect(screen.queryByRole('button', { name: 'Mark handled' })).toBeNull();
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('says so calmly when marking fails, and keeps the message open', async () => {
    const api = fakeApi([{ items: [msg(1)], storageEnabled: true }], async () => { throw new Error('503'); });
    render(<ContactMessages api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark handled' }));
    expect(await screen.findByText('Couldn’t mark it handled. Try again.')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
  });

  it('explains when storage is not set up yet', async () => {
    render(<ContactMessages api={fakeApi([{ items: [], storageEnabled: false }])} />);
    expect(await screen.findByText('Contact messages aren’t stored yet')).toBeInTheDocument();
    expect(screen.getByText(/server\/sql\/contact_messages\.sql/)).toBeInTheDocument();
  });

  it('shows an empty state when there are no messages', async () => {
    render(<ContactMessages api={fakeApi([{ items: [], storageEnabled: true }])} />);
    expect(await screen.findByText('No messages yet')).toBeInTheDocument();
  });

  it('offers a retry when the list fails to load', async () => {
    const api = fakeApi([new Error('403'), { items: [msg(1)], storageEnabled: true }]);
    render(<ContactMessages api={api} />);
    expect(await screen.findByText('Messages didn’t load')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: /person1@example\.com/ })).toBeInTheDocument();
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('loads older messages with the cursor the server returned, without duplicates', async () => {
    const api = fakeApi([
      { items: [msg(1), msg(2)], nextCursor: '50', storageEnabled: true },
      { items: [msg(2), msg(3)], storageEnabled: true }
    ]);
    render(<ContactMessages api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load older messages' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3));
    expect(api.list).toHaveBeenLastCalledWith('50');
    expect(screen.queryByRole('button', { name: 'Load older messages' })).toBeNull();
  });

  it('loads under React.StrictMode (dev mounts, unmounts and mounts again)', async () => {
    const api = fakeApi([{ items: [msg(1)], storageEnabled: true }]);
    render(
      <React.StrictMode>
        <ContactMessages api={api} />
      </React.StrictMode>
    );
    expect(await screen.findByRole('link', { name: /person1@example\.com/ })).toBeInTheDocument();
    expect(screen.queryByText('Loading messages…')).toBeNull();
    // Marking still settles: the button goes away once it is handled.
    fireEvent.click(screen.getByRole('button', { name: 'Mark handled' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Mark handled' })).toBeNull());
    expect(screen.getByText('Handled')).toBeInTheDocument();
  });

  it('links a reply only for a real address: one that would rewrite the mailto: stays plain text', async () => {
    const injected = 'x@evil.com?cc=boss%40corp.com&subject=Invoice&body=pay';
    const api = fakeApi([{ items: [msg(1), msg(2, { email: injected })], storageEnabled: true }]);
    render(<ContactMessages api={api} />);
    const rows = within(await screen.findByRole('list', { name: 'Messages' })).getAllByRole('listitem');
    expect(within(rows[0]).getByRole('link', { name: /person1@example\.com/ })).toHaveAttribute('href', 'mailto:person1@example.com');
    expect(within(rows[1]).queryByRole('link')).toBeNull();
    expect(rows[1].textContent).toContain(injected);
    expect(within(rows[1]).getByText('Not a reply address, so no Reply link.')).toBeInTheDocument();
    expect(document.querySelectorAll('a[href^="mailto:"]')).toHaveLength(1);
  });

  it('gives the reply link a 44 px target on coarse pointers', async () => {
    render(<ContactMessages api={fakeApi([{ items: [msg(1)], storageEnabled: true }])} />);
    const link = await screen.findByRole('link', { name: /person1@example\.com/ });
    expect(link.className.split(/\s+/)).toEqual(expect.arrayContaining([DENSITY.coarse, 'coarse:py-2']));
  });

  it('never polls: one request on open, none while it sits there', async () => {
    vi.useFakeTimers();
    const api = fakeApi([{ items: [msg(1)], storageEnabled: true }]);
    render(<ContactMessages api={api} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60_000); });
    expect(api.list).toHaveBeenCalledTimes(1);
  });
});
