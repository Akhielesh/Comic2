import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { makeSampleDoc } from './board/__fixtures__/sampleDoc';

const loadPublicComic = vi.fn();
vi.mock('./studioApi', () => ({
  loadPublicComic: (...args: unknown[]) => loadPublicComic(...args)
}));

// Imported after the mock is registered.
const { PublicComicReader } = await import('./PublicComicReader');

const urls = { 'u/proj/pages/p1.png': 'https://signed.test/p1.png?token=a', 'u/proj/pages/p5.png': 'https://signed.test/p5.png?token=b' };

beforeEach(() => {
  loadPublicComic.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('PublicComicReader', () => {
  it('shows a loading state, then the title, logline and the comic', async () => {
    let resolve!: (v: unknown) => void;
    loadPublicComic.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<PublicComicReader projectId="proj_1" />);
    expect(screen.getByText('Opening the comic…')).toBeInTheDocument();
    resolve({ doc: makeSampleDoc(), urls });
    expect(await screen.findByRole('heading', { name: 'The Saffron Thief' })).toBeInTheDocument();
    expect(screen.getByText('A pickpocket steals saffron to pay for her brother’s surgery.')).toBeInTheDocument();
    expect(loadPublicComic).toHaveBeenCalledWith('proj_1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const img = screen.getAllByRole('img', { name: /Page 1/ })[0];
    expect(img).toHaveAttribute('src', 'https://signed.test/p1.png?token=a');
  });

  it('says plainly when the comic is not published', async () => {
    loadPublicComic.mockRejectedValue(Object.assign(new Error('nope'), { kind: 'not_found', status: 404 }));
    render(<PublicComicReader projectId="proj_1" />);
    expect(await screen.findByText('This comic isn’t available')).toBeInTheDocument();
    expect(screen.getByText("This comic isn't published, or its creator made it private.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Try again/ })).toBeNull();
  });

  it('offers a retry for network trouble', async () => {
    loadPublicComic.mockRejectedValueOnce(Object.assign(new Error("Couldn't reach the studio server."), { kind: 'network', status: 0 }));
    loadPublicComic.mockResolvedValueOnce({ doc: makeSampleDoc(), urls });
    render(<PublicComicReader projectId="proj_1" />);
    expect(await screen.findByText("Couldn't reach the studio server.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByRole('heading', { name: 'The Saffron Thief' })).toBeInTheDocument();
    expect(loadPublicComic).toHaveBeenCalledTimes(2);
  });

  it('closes when asked', async () => {
    loadPublicComic.mockResolvedValue({ doc: makeSampleDoc(), urls });
    const onClose = vi.fn();
    render(<PublicComicReader projectId="proj_1" onClose={onClose} />);
    await screen.findByRole('heading', { name: 'The Saffron Thief' });
    fireEvent.click(screen.getByRole('button', { name: 'Close reader' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('has no close button without onClose', async () => {
    loadPublicComic.mockResolvedValue({ doc: makeSampleDoc(), urls });
    render(<PublicComicReader projectId="proj_1" />);
    await screen.findByRole('heading', { name: 'The Saffron Thief' });
    expect(screen.queryByRole('button', { name: 'Close reader' })).toBeNull();
  });

  it('refreshes expired image links quietly when an image fails', async () => {
    loadPublicComic.mockResolvedValue({ doc: makeSampleDoc(), urls });
    const { container } = render(<PublicComicReader projectId="proj_1" />);
    await screen.findByRole('heading', { name: 'The Saffron Thief' });
    fireEvent.error(container.querySelector('img[src^="https://signed.test/p1.png"]')!);
    await waitFor(() => expect(loadPublicComic).toHaveBeenCalledTimes(2));
    // Still reading — no loading screen flash.
    expect(screen.getByRole('heading', { name: 'The Saffron Thief' })).toBeInTheDocument();
  });
});
