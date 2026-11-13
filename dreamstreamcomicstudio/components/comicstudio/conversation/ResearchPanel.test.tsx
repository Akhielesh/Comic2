import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { post } from '../../../services/apiClient';
import { ResearchPanel } from './ResearchPanel';

vi.mock('../../../services/apiClient', () => ({ post: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

it('adds sources explicitly and downloads only the selected image', async () => {
  const article = { title: 'Kyōto Station', source: 'https://en.wikipedia.org/wiki/Kyoto_Station' };
  const reference = { title: 'Station exterior', source: 'https://commons.wikimedia.org/wiki/File:Station.jpg', thumbnail: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/9/99/Kyoto.jpg/320px-Kyoto.jpg', license: 'CC BY 4.0', credit: 'Photographer' };
  vi.mocked(post).mockResolvedValue({ articles: [article], images: [reference], incomplete: false });
  const fetchImage = vi.fn(async () => new Response(new Uint8Array([255, 216, 255]), { headers: { 'content-type': 'image/jpeg' } }));
  vi.stubGlobal('fetch', fetchImage);
  const add = vi.fn();
  render(<ResearchPanel projectId="comic_1" onAdd={add} />);
  fireEvent.change(screen.getByLabelText('Place, event, or topic'), { target: { value: 'Kyoto station' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Add context' }));
  expect(post).toHaveBeenCalledWith('/api/comic/projects/comic_1/research', { query: 'Kyoto station' }, expect.anything());
  expect(add).toHaveBeenCalledWith(article);
  expect(fetchImage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Add image' }));
  await waitFor(() => expect(add).toHaveBeenCalledWith(reference, expect.objectContaining({ name: 'Station exterior.jpg', type: 'image/jpeg' })));
});
