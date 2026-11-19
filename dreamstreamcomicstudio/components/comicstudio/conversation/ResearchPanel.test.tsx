import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { post } from '../../../services/apiClient';
import { RADIUS_CONTROL } from '../../chat/studioDesign';
import { ResearchPanel } from './ResearchPanel';
import type { ComicResearchResults } from '../../../shared/comic/research';

vi.mock('../../../services/apiClient', () => ({ post: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

const file = (name: string) => name.replace(/ /g, '_');
const thumb = (name: string) => `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${file(name)}.jpg/320px-${file(name)}.jpg`;
const picture = (name: string, license: string, credit?: string) => ({
  title: name, source: `https://commons.wikimedia.org/wiki/File:${file(name)}.jpg`, thumbnail: thumb(name), license, ...(credit ? { credit } : {})
});
const article = { title: 'Kyōto Station', source: 'https://en.wikipedia.org/wiki/Kyoto_Station', description: 'Railway station' };
const telugu = { title: 'రామాయణం', source: 'https://te.wikipedia.org/wiki/%E0%B0%B0%E0%B0%BE%E0%B0%AE%E0%B0%BE%E0%B0%AF%E0%B0%A3%E0%B0%82', extract: 'రామాయణం ఒక ఇతిహాసం.' };
const results = (over: Partial<ComicResearchResults> = {}): ComicResearchResults => ({
  articles: [article],
  images: [picture('Free', 'CC0', 'Painter'), picture('Old', 'Public domain'), picture('By', 'CC BY 4.0', 'Photographer'), picture('Share', 'CC BY-SA 4.0', 'Someone')],
  incomplete: false,
  ...over
});
const tile = (name: string) => screen.getByRole('listitem', { name });

it('adds sources explicitly and downloads only the selected image', async () => {
  const reference = picture('Station exterior', 'CC0 1.0', 'Photographer');
  vi.mocked(post).mockResolvedValue({ articles: [article], images: [reference], incomplete: false });
  const fetchImage = vi.fn(async () => new Response(new Uint8Array([255, 216, 255]), { headers: { 'content-type': 'image/jpeg' } }));
  vi.stubGlobal('fetch', fetchImage);
  const add = vi.fn();
  render(<ResearchPanel projectId="comic_1" onAdd={add} kidsSafe={false} />);
  fireEvent.change(screen.getByLabelText('Place, event, or topic'), { target: { value: 'Kyoto station' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Add context' }));
  expect(post).toHaveBeenCalledWith('/api/comic/projects/comic_1/research', { query: 'Kyoto station' }, expect.anything());
  expect(add).toHaveBeenCalledWith(article);
  expect(fetchImage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Add image' }));
  await waitFor(() => expect(add).toHaveBeenCalledWith(reference, expect.objectContaining({ name: 'Station exterior.jpg', type: 'image/jpeg' })));
});

describe('pictures that are safe to use', () => {
  it('offers "Add image" only for CC0 and public-domain pictures; CC BY and CC BY-SA are reference only', () => {
    render(<ResearchPanel projectId="comic_1" onAdd={vi.fn()} suppliedResults={results()} kidsSafe={false} />);
    for (const name of ['Free', 'Old']) {
      expect(within(tile(name)).getByRole('button', { name: 'Add image' })).toBeInTheDocument();
      expect(within(tile(name)).queryByText('Reference only')).toBeNull();
    }
    for (const name of ['By', 'Share']) {
      expect(within(tile(name)).queryByRole('button', { name: /Add image/ })).toBeNull();
      expect(within(tile(name)).getByText('Reference only')).toBeInTheDocument();
      expect(within(tile(name)).getByRole('link', { name: `Open source for ${name}` })).toHaveAttribute('href', `https://commons.wikimedia.org/wiki/File:${name}.jpg`);
    }
  });

  it('keeps pictures behind one "Show pictures" button unless the comic allows them (kidsSafe defaults on)', () => {
    const { container, rerender } = render(<ResearchPanel projectId="comic_1" onAdd={vi.fn()} suppliedResults={results()} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Image references' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Show pictures' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: /Kyōto Station/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show pictures' }));
    expect(container.querySelectorAll('img')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: 'Show pictures' })).toBeNull();
    rerender(<ResearchPanel projectId="comic_1" onAdd={vi.fn()} suppliedResults={results({ images: [picture('Other', 'CC0')] })} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show pictures' })).toBeInTheDocument();
    rerender(<ResearchPanel projectId="comic_1" onAdd={vi.fn()} suppliedResults={results({ images: [] })} />);
    expect(screen.queryByRole('button', { name: 'Show pictures' })).toBeNull();
  });

  it('a new search hides the pictures again in a kids comic', async () => {
    vi.mocked(post).mockResolvedValue(results());
    const { container } = render(<ResearchPanel projectId="comic_1" onAdd={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Place, event, or topic'), { target: { value: 'Kyoto' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show pictures' }));
    expect(container.querySelectorAll('img').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('button', { name: 'Show pictures' })).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows credits on one line at 12 px or more, the full credit in a title, and recipe radii on tiles and images', () => {
    const long = 'A very long photographer credit that goes on and on past the width of a tile';
    const { container } = render(<ResearchPanel projectId="comic_1" onAdd={vi.fn()} suppliedResults={results({ images: [picture('Free', 'CC0', long)] })} kidsSafe={false} />);
    const credit = within(tile('Free')).getByText(`${long} · CC0`);
    expect(credit).toHaveClass('truncate');
    expect(credit).toHaveAttribute('title', `${long} · CC0`);
    expect(credit.className).not.toMatch(/text-\[(?:[0-9]|1[01])px\]/);
    expect(credit.className).toMatch(/text-\[12px\]/);
    const title = within(tile('Free')).getByText('Free');
    expect(title).toHaveClass('truncate');
    expect(title).toHaveAttribute('title', 'Free');
    const img = container.querySelector('img')!;
    for (const el of [tile('Free'), img]) for (const c of RADIUS_CONTROL.split(' ')) expect(el).toHaveClass(c);
    expect(container.innerHTML).not.toMatch(/rounded-(?:md|sm)\b/);
  });

  it('a picture that cannot load becomes a calm empty tile, not a broken image', () => {
    const { container } = render(<ResearchPanel projectId="comic_1" onAdd={vi.fn()} suppliedResults={results({ images: [picture('Free', 'CC0'), picture('Old', 'Public domain')] })} kidsSafe={false} />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelectorAll('img')).toHaveLength(1);
    const placeholder = within(tile('Free')).getByTestId('research-picture-unavailable');
    for (const c of RADIUS_CONTROL.split(' ')) expect(placeholder).toHaveClass(c);
    expect(within(tile('Free')).getByRole('link', { name: 'Open source for Free' })).toBeInTheDocument();
  });
});

describe('articles', () => {
  it('shows the extract (not the description) clamped to two lines, with More when it overflows', () => {
    const heights = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.hasAttribute('data-research-clamp') ? 80 : 0; });
    const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.hasAttribute('data-research-clamp') ? 40 : 0; });
    try {
      const extract = 'Kyōto Station is a major railway station and transportation hub in Kyoto, Japan. '.repeat(4).trim();
      render(<ResearchPanel projectId="comic_1" onAdd={vi.fn()} suppliedResults={results({ articles: [{ ...article, extract }], images: [] })} />);
      const text = screen.getByText(extract);
      expect(text).toHaveClass('line-clamp-2');
      expect(screen.queryByText('Railway station')).toBeNull();
      const more = screen.getByRole('button', { name: 'More' });
      expect(more).toHaveAttribute('aria-expanded', 'false');
      expect(more).toHaveAttribute('aria-controls', text.id);
      fireEvent.click(more);
      expect(text).not.toHaveClass('line-clamp-2');
      expect(screen.getByRole('button', { name: 'Less' })).toHaveAttribute('aria-expanded', 'true');
    } finally { heights.mockRestore(); client.mockRestore(); }
  });

  it('offers no More for text that fits, and falls back to the description without an extract', () => {
    render(<ResearchPanel projectId="comic_1" onAdd={vi.fn()} suppliedResults={results({ images: [] })} />);
    expect(screen.getByText('Railway station')).toHaveClass('line-clamp-2');
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
  });

  it('names the language only when the source is not English, in the link text', () => {
    render(<ResearchPanel projectId="comic_1" onAdd={vi.fn()} suppliedResults={results({ articles: [article, telugu], images: [] })} />);
    const en = screen.getByRole('link', { name: 'Wikipedia: Kyōto Station' });
    expect(en).toHaveAttribute('href', article.source);
    expect(en.textContent).not.toMatch(/·/);
    const te = screen.getByRole('link', { name: 'Wikipedia · తెలుగు: రామాయణం' });
    expect(te).toHaveAttribute('href', telugu.source);
    expect(screen.getByText('రామాయణం')).toHaveAttribute('lang', 'te');
    expect(screen.queryByText(/English/)).toBeNull();
  });

  it('says "Pinned to this comic" for a pinned source instead of offering it again', () => {
    const isPinned = vi.fn((url: string) => url === article.source || url === picture('Free', 'CC0').source);
    render(<ResearchPanel projectId="comic_1" onAdd={vi.fn()} suppliedResults={results({ articles: [article, telugu] })} kidsSafe={false} isPinned={isPinned} />);
    expect(screen.getAllByText('Pinned to this comic')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Add context' })).toHaveLength(1);
    expect(within(tile('Free')).queryByRole('button', { name: 'Add image' })).toBeNull();
    expect(within(tile('Free')).getByText('Pinned to this comic')).toBeInTheDocument();
    expect(within(tile('Old')).getByRole('button', { name: 'Add image' })).toBeInTheDocument();
  });
});

describe('one status line', () => {
  it('says once that one source is unavailable and nothing matched', () => {
    render(<ResearchPanel projectId="comic_1" onAdd={vi.fn()} suppliedResults={{ articles: [], images: [], incomplete: true }} />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent(/No matches/);
    expect(screen.getByRole('status')).toHaveTextContent(/unavailable/);
  });

  it('a failed attach replaces the partial-results line instead of adding a second one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { headers: { 'content-type': 'text/html' } })));
    render(<ResearchPanel projectId="comic_1" onAdd={vi.fn()} suppliedResults={results({ incomplete: true })} kidsSafe={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('One source is unavailable. Showing the results we found.');
    fireEvent.click(within(tile('Free')).getByRole('button', { name: 'Add image' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This image couldn’t be attached.');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
