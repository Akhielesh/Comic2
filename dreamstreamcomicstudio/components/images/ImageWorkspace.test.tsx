// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  renderStandalone: vi.fn(), loadImageHistory: vi.fn(), loadReference: vi.fn(), downloadStandalone: vi.fn(), reopenStandalone: vi.fn(), reuseStandalone: vi.fn()
}));
vi.mock('../../services/standaloneImages', () => api);
import { ImageWorkspace } from './ImageWorkspace';

const result = { imageId: 'a', imageUrl: 'https://test.invalid/rendered', createdAt: '2026-11-20T12:00:00.000Z' };
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  api.loadImageHistory.mockResolvedValue({ images: [], hasMore: false });
});
afterEach(cleanup);

it('submits references and lets a failed submission retry without regenerating twice', async () => {
  api.loadReference.mockResolvedValue({ name: 'reference.png', data: 'data:image/png;base64,AAAA' });
  api.renderStandalone.mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce(result);
  render(<ImageWorkspace userId="first" onBack={() => {}} />);
  fireEvent.change(screen.getByLabelText(/Describe your image/), { target: { value: 'An illustrated railway station' } });
  fireEvent.change(screen.getByLabelText('Reference image files'), { target: { files: [new File(['test'], 'reference.png', { type: 'image/png' })] } });
  await screen.findByRole('button', { name: 'Remove reference.png' });
  fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost');
  fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));
  expect(await screen.findByAltText('Your generated image')).toHaveAttribute('src', result.imageUrl);
  expect(api.renderStandalone.mock.calls[0]).toEqual(['first', 'An illustrated railway station', 'auto', ['data:image/png;base64,AAAA'], expect.any(String)]);
  expect(api.renderStandalone.mock.calls[1]).toEqual(api.renderStandalone.mock.calls[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Download image' }));
  await waitFor(() => expect(api.downloadStandalone).toHaveBeenCalledWith(result));
});

it('isolates drafts and images when the account changes', async () => {
  api.loadImageHistory.mockResolvedValueOnce({ images: [result], hasMore: false });
  const view = render(<ImageWorkspace userId="first" onBack={() => {}} />);
  await screen.findByAltText('Your generated image');
  fireEvent.change(screen.getByLabelText(/Describe your image/), { target: { value: 'Private draft' } });
  await act(async () => view.rerender(<ImageWorkspace userId="second" onBack={() => {}} />));
  expect(screen.getByLabelText(/Describe your image/)).toHaveValue('');
  expect(screen.queryByAltText('Your generated image')).toBeNull();
  await act(async () => view.rerender(<ImageWorkspace userId="first" onBack={() => {}} />));
  expect(screen.getByLabelText(/Describe your image/)).toHaveValue('Private draft');
});

it('refreshes the selected image directly when a signed preview has expired', async () => {
  api.loadImageHistory.mockResolvedValue({ images: [result], hasMore: false });
  api.reopenStandalone.mockResolvedValue({ ...result, imageUrl: 'https://test.invalid/renewed' });
  render(<ImageWorkspace userId="first" onBack={() => {}} />);
  fireEvent.error(await screen.findByAltText('Your generated image'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh preview' }));
  expect(await screen.findByAltText('Your generated image')).toHaveAttribute('src', 'https://test.invalid/renewed');
  expect(api.reopenStandalone).toHaveBeenCalledWith(result);
});

it('lets the creator use a saved image as a reference for another generation', async () => {
  api.loadImageHistory.mockResolvedValue({ images: [result], hasMore: false });
  api.reuseStandalone.mockResolvedValue({ name: 'Generated image.webp', data: 'data:image/webp;base64,AAAA' });
  api.renderStandalone.mockResolvedValue(result);
  render(<ImageWorkspace userId="first" onBack={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Use as reference' }));
  await screen.findByRole('button', { name: 'Remove Generated image.webp' });
  fireEvent.change(screen.getByLabelText(/Describe your image/), { target: { value: 'Change the lighting' } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));
  await waitFor(() => expect(api.renderStandalone).toHaveBeenCalledWith('first', 'Change the lighting', 'auto', ['data:image/webp;base64,AAAA'], expect.any(String)));
});

it('creates from a single brief and shows the automatic format before spending', async () => {
  let complete!: (image: typeof result) => void;
  api.renderStandalone.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  render(<ImageWorkspace userId="first" onBack={() => {}} />);
  const prompt = screen.getByLabelText(/Describe your image/);
  fireEvent.change(prompt, { target: { value: 'A phone wallpaper of an owl under a full moon' } });
  expect(screen.getByText('Automatic · 9:16')).toBeVisible();
  expect(api.renderStandalone).not.toHaveBeenCalled();
  fireEvent.keyDown(prompt, { key: 'Enter' });
  expect(api.renderStandalone).not.toHaveBeenCalled();
  fireEvent.keyDown(prompt, { key: 'Enter', ctrlKey: true });
  fireEvent.keyDown(prompt, { key: 'Enter', ctrlKey: true, repeat: true });
  expect(api.renderStandalone).toHaveBeenCalledTimes(1);
  expect(api.renderStandalone).toHaveBeenCalledWith('first', 'A phone wallpaper of an owl under a full moon', 'auto', [], expect.any(String));
  await act(async () => complete(result));
});

it('preserves the previous explicit format, including square, when restoring an existing draft', async () => {
  sessionStorage.setItem('dreamstream.image-draft.first', JSON.stringify({ prompt: 'A phone wallpaper', ratio: '1:1' }));
  api.renderStandalone.mockResolvedValue(result);
  render(<ImageWorkspace userId="first" onBack={() => {}} />);
  expect(screen.getByLabelText(/Describe your image/)).toHaveValue('A phone wallpaper');
  fireEvent.click(screen.getByText('Image format').closest('summary')!);
  expect(screen.getByLabelText('Aspect ratio')).toHaveValue('1:1');
  fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));
  await waitFor(() => expect(api.renderStandalone).toHaveBeenCalledWith('first', 'A phone wallpaper', '1:1', [], expect.any(String)));
});

it('keeps attached reference bytes while switching formats and waits for an explicit generation', async () => {
  api.loadReference.mockResolvedValue({ name: 'reference.png', data: 'data:image/png;base64,AQID' });
  api.renderStandalone.mockResolvedValue(result);
  render(<ImageWorkspace userId="first" onBack={() => {}} />);
  fireEvent.change(screen.getByLabelText(/Describe your image/), { target: { value: 'Make a variation' } });
  fireEvent.change(screen.getByLabelText('Reference image files'), { target: { files: [new File(['test'], 'reference.png', { type: 'image/png' })] } });
  await screen.findByRole('button', { name: 'Remove reference.png' });
  fireEvent.click(screen.getByText('Image format').closest('summary')!);
  fireEvent.change(screen.getByLabelText('Aspect ratio'), { target: { value: '16:9' } });
  fireEvent.change(screen.getByLabelText('Aspect ratio'), { target: { value: 'auto' } });
  expect(api.renderStandalone).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));
  await waitFor(() => expect(api.renderStandalone).toHaveBeenCalledWith('first', 'Make a variation', 'auto', ['data:image/png;base64,AQID'], expect.any(String)));
});

it('keeps the image draft visible and points a missing-key user to the account settings', async () => {
  api.renderStandalone.mockRejectedValueOnce(new Error('Gemini API key missing.'));
  render(<ImageWorkspace userId="first" onBack={() => {}} />);
  const prompt = screen.getByLabelText(/Describe your image/);
  fireEvent.change(prompt, { target: { value: 'Herons taking off from the lagoon' } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));
  expect(await screen.findByRole('link', { name: /Open API keys and usage/ })).toHaveAttribute('target', '_blank');
  expect(prompt).toHaveValue('Herons taking off from the lagoon');
  expect(screen.queryByText('Gemini API key missing.')).toBeNull();
});
