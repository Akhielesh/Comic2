// usePublicComic: the share-link channel (?via=) and the server's dead-link boot card.
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSampleDoc } from '../conversation/testing/fixtures';
import { readShareBootNotFound, readShareVia, usePublicComic } from './usePublicComic';

vi.mock('../studioApi', async (orig) => {
  const mod = await orig<typeof import('../studioApi')>();
  return { ...mod, loadPublicComicBySlug: vi.fn(), trackPublicEvent: vi.fn(async () => undefined) };
});
import * as api from '../studioApi';

const SLUG = 'Ab3dEf6hIj9kLm2nP';

const Probe: React.FC<{ slug?: string; owner?: boolean }> = ({ slug = SLUG, owner }) => {
  const r = usePublicComic(slug, { isOwner: owner });
  return (
    <div>
      <span data-testid="status">{r.status}</span>
      <button type="button" onClick={() => r.track('view', undefined, 'en')}>
        view
      </button>
      <button type="button" onClick={() => r.track('complete')}>
        complete
      </button>
      <button type="button" onClick={() => r.track('share', 'native')}>
        share
      </button>
    </div>
  );
};

beforeEach(() => {
  vi.mocked(api.loadPublicComicBySlug).mockResolvedValue({ publication: { slug: SLUG }, doc: makeSampleDoc(), urls: {} } as never);
});
afterEach(() => {
  vi.clearAllMocks();
  document.getElementById('ds-share-boot')?.remove();
  window.history.replaceState(null, '', '/');
});

describe('share-link channel attribution (?via=)', () => {
  it('a link opened from a share action records its view under that channel, then the address loses ?via=', async () => {
    window.history.replaceState(null, '', `/c/${SLUG}?p=2&via=whatsapp`);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(window.location.search).toBe('?p=2');
    fireEvent.click(screen.getByRole('button', { name: 'view' }));
    expect(api.trackPublicEvent).toHaveBeenCalledWith(SLUG, { type: 'view', channel: 'whatsapp', lang: 'en' });
    // Only the view carries the channel; an explicit channel (share → native) always wins.
    fireEvent.click(screen.getByRole('button', { name: 'complete' }));
    expect(api.trackPublicEvent).toHaveBeenLastCalledWith(SLUG, { type: 'complete' });
    fireEvent.click(screen.getByRole('button', { name: 'share' }));
    expect(api.trackPublicEvent).toHaveBeenLastCalledWith(SLUG, { type: 'share', channel: 'native' });
  });

  it('anything but a known share channel counts as direct (no channel sent), and is dropped from the address too', async () => {
    window.history.replaceState(null, '', `/c/${SLUG}?via=webdriver`);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(window.location.search).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'view' }));
    expect(api.trackPublicEvent).toHaveBeenCalledWith(SLUG, { type: 'view', lang: 'en' });
    expect(readShareVia('?via=qr')).toBe('qr');
    expect(readShareVia('?via=webdriver')).toBeUndefined();
    expect(readShareVia('')).toBeUndefined();
  });

});

describe('the server’s dead-link boot ({"notFound":true})', () => {
  const setBoot = (boot: unknown) => {
    const el = document.createElement('script');
    el.type = 'application/json';
    el.id = 'ds-share-boot';
    el.textContent = typeof boot === 'string' ? boot : JSON.stringify(boot);
    document.body.appendChild(el);
  };

  it('is honoured for the link’s own address (/embed with embedding off, a dead slug): not_found at once, the API never asked', async () => {
    window.history.replaceState(null, '', `/c/${SLUG}/embed`);
    setBoot({ notFound: true });
    render(<Probe />);
    expect(screen.getByTestId('status')).toHaveTextContent('not_found');
    await new Promise((r) => setTimeout(r, 5));
    expect(screen.getByTestId('status')).toHaveTextContent('not_found');
    expect(api.loadPublicComicBySlug).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'view' }));
    expect(api.trackPublicEvent).toHaveBeenCalledTimes(1); // analytics are blind to live vs dead, as on the edge
  });

  it('a boot left in the page for another address never kills this comic’s reader', async () => {
    window.history.replaceState(null, '', '/c/Zz3dEf6hIj9kLm2nP');
    setBoot({ notFound: true });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(api.loadPublicComicBySlug).toHaveBeenCalledTimes(1);
  });

  it('readShareBootNotFound: only the exact marker, for the slug’s own path (with or without a tail)', () => {
    setBoot({ notFound: true });
    expect(readShareBootNotFound(SLUG, document, `/c/${SLUG}`)).toBe(true);
    expect(readShareBootNotFound(SLUG, document, `/c/${SLUG}/embed`)).toBe(true);
    expect(readShareBootNotFound(SLUG, document, `/c/${SLUG}/playtime-at-the-lake`)).toBe(true);
    expect(readShareBootNotFound(SLUG, document, '/c/Zz3dEf6hIj9kLm2nP')).toBe(false);
    expect(readShareBootNotFound(SLUG, document, `/c/${SLUG}x`)).toBe(false);
    expect(readShareBootNotFound('', document, `/c/${SLUG}`)).toBe(false);
    document.getElementById('ds-share-boot')!.remove();
    setBoot({ slug: SLUG, card: { title: 'Live' } });
    expect(readShareBootNotFound(SLUG, document, `/c/${SLUG}`)).toBe(false);
    document.getElementById('ds-share-boot')!.remove();
    setBoot('{not json');
    expect(readShareBootNotFound(SLUG, document, `/c/${SLUG}`)).toBe(false);
  });
});

describe('owner', () => {
  it('never sends for the owner, channel or not', async () => {
    window.history.replaceState(null, '', `/c/${SLUG}?via=copy`);
    render(<Probe owner />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    fireEvent.click(screen.getByRole('button', { name: 'view' }));
    expect(api.trackPublicEvent).not.toHaveBeenCalled();
  });
});
