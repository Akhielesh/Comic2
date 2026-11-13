import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createEmptyDoc, normalizeDoc, type Card } from '../../../../shared/comic/doc';
import { post } from '../../../../services/apiClient';
import { CardRenderer } from './CardRenderer';
import { COMPOSE_EVENT } from '../composerBus';
import { makeFakeStudio } from '../testing/fixtures';

vi.mock('../../../../services/apiClient', async (original) => ({ ...(await original<typeof import('../../../../services/apiClient')>()), post: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

const article = { title: 'Kyōto Station', source: 'https://en.wikipedia.org/wiki/Kyoto_Station', description: 'Railway station in Kyoto, Japan.' };
const reference = { title: 'Station exterior', source: 'https://commons.wikimedia.org/wiki/File:Station.jpg', thumbnail: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/9/99/Station.jpg/320px-Station.jpg', license: 'CC BY 4.0', credit: 'Photographer' };
const card: Extract<Card, { type: 'research' }> = { type: 'research', id: 'research_1', query: 'Kyoto station', results: { articles: [article], images: [reference], incomplete: false } };

it('renders persisted sources, with explicit context and image selection through the shared panel', async () => {
  const studio = makeFakeStudio();
  const fetchImage = vi.fn(async () => new Response(new Uint8Array([255, 216, 255]), { headers: { 'content-type': 'image/jpeg' } }));
  vi.stubGlobal('fetch', fetchImage);
  const compose = vi.fn();
  window.addEventListener(COMPOSE_EVENT, compose);
  try {
    render(<CardRenderer card={card} studio={studio} />);
    expect(screen.getByRole('region', { name: 'Research sources' })).toHaveTextContent('Kyoto station');
    expect(screen.getByRole('link', { name: 'Source for Station exterior' })).toHaveAttribute('href', reference.source);
    expect(screen.getByText('Photographer · CC BY 4.0')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Search' })).not.toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
    expect(fetchImage).not.toHaveBeenCalled();
    expect(compose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }));
    expect(compose.mock.calls[0][0].detail).toEqual({ research: { projectId: studio.doc!.id, result: article } });
    fireEvent.click(screen.getByRole('button', { name: 'Add image' }));
    await waitFor(() => expect(compose).toHaveBeenCalledTimes(2));
    expect(fetchImage).toHaveBeenCalledWith(reference.thumbnail, expect.objectContaining({ credentials: 'omit', referrerPolicy: 'no-referrer' }));
    expect(compose.mock.calls[1][0].detail.research).toEqual({ projectId: studio.doc!.id, result: reference, file: expect.objectContaining({ name: 'Station exterior.jpg', type: 'image/jpeg' }) });
    expect(studio.send).not.toHaveBeenCalled();
  } finally { window.removeEventListener(COMPOSE_EVENT, compose); }
});

it('preserves safe research across reload and rejects stored external image URLs before rendering', () => {
  const doc = createEmptyDoc('research_doc', 'Test', 1);
  doc.conversation = [{ id: 'msg_1', role: 'assistant', text: 'Here are the sources.', at: 1, cards: [card, { ...card, id: 'research_unsafe', results: { articles: [{ ...article, source: 'javascript:alert(1)' }], images: [{ ...reference, thumbnail: 'https://example.com/private?story=secret' }], incomplete: false } }] }];
  const restored = normalizeDoc(JSON.parse(JSON.stringify(doc)));
  expect(restored.conversation[0].cards![0]).toEqual(card);
  expect(restored.conversation[0].cards![1]).toEqual({ ...card, id: 'research_unsafe', results: { articles: [], images: [], incomplete: false } });
  const { container } = render(<CardRenderer card={doc.conversation[0].cards![1]} studio={makeFakeStudio()} />);
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('a')).toBeNull();
  expect(screen.getByText(/No matches/)).toBeInTheDocument();
});

it('settles earlier research to its query without mounting remote images or controls', () => {
  const { container } = render(<CardRenderer card={card} studio={makeFakeStudio()} settle={{ state: 'settled', outcome: 'passed' }} />);
  expect(screen.getByText('Research · Kyoto station')).toBeInTheDocument();
  expect(container.querySelector('img')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add image' })).toBeNull();
});

it('keeps source links available after an image download fails without attaching a file', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not an image', { headers: { 'content-type': 'text/html' } })));
  const compose = vi.fn();
  window.addEventListener(COMPOSE_EVENT, compose);
  try {
    render(<CardRenderer card={card} studio={makeFakeStudio()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add image' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This image couldn’t be attached.');
    expect(screen.getByRole('link', { name: 'Source for Station exterior' })).toBeInTheDocument();
    expect(compose).not.toHaveBeenCalled();
  } finally { window.removeEventListener(COMPOSE_EVENT, compose); }
});
