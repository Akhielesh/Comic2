// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  renderStandalone: vi.fn(), loadStandaloneRoute: vi.fn(), loadImageHistory: vi.fn(), loadReference: vi.fn(), downloadStandalone: vi.fn(), reopenStandalone: vi.fn(), reuseStandalone: vi.fn()
}));
vi.mock('../../services/standaloneImages', () => api);
import { ImageWorkspace } from './ImageWorkspace';

const result = { imageId: 'a', imageUrl: 'https://test.invalid/rendered', createdAt: '2026-11-20T12:00:00.000Z' };
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  api.loadImageHistory.mockResolvedValue({ images: [], hasMore: false });
  api.loadStandaloneRoute.mockResolvedValue({ provider: 'openrouter', payer: 'personal', model: 'gemini-2.5-flash-image' });
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
  expect(api.renderStandalone.mock.calls[0]).toEqual(['first', 'An illustrated railway station', 'auto', ['data:image/png;base64,AAAA'], expect.any(String), 'native', expect.objectContaining({ allowPaidImage: false })]);
  expect(api.renderStandalone.mock.calls[1].slice(0, 6)).toEqual(api.renderStandalone.mock.calls[0].slice(0, 6));
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
  await waitFor(() => expect(api.renderStandalone).toHaveBeenCalledWith('first', 'Change the lighting', 'auto', ['data:image/webp;base64,AAAA'], expect.any(String), 'native', expect.any(Object)));
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
  expect(api.renderStandalone).toHaveBeenCalledWith('first', 'A phone wallpaper of an owl under a full moon', 'auto', [], expect.any(String), 'native', expect.any(Object));
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
  await waitFor(() => expect(api.renderStandalone).toHaveBeenCalledWith('first', 'A phone wallpaper', '1:1', [], expect.any(String), 'native', expect.any(Object)));
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
  await waitFor(() => expect(api.renderStandalone).toHaveBeenCalledWith('first', 'Make a variation', 'auto', ['data:image/png;base64,AQID'], expect.any(String), 'native', expect.any(Object)));
});

it('keeps the image draft visible and points a missing-key user to the account settings', async () => {
  api.renderStandalone.mockRejectedValueOnce(new Error('Gemini API key missing.'));
  render(<ImageWorkspace userId="first" onBack={() => {}} />);
  const prompt = screen.getByLabelText(/Describe your image/);
  fireEvent.change(prompt, { target: { value: 'Herons taking off from the lagoon' } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));
  expect(await screen.findByRole('link', { name: /Open API keys and usage/ })).not.toHaveAttribute('target');
  expect(prompt).toHaveValue('Herons taking off from the lagoon');
  expect(screen.queryByText('Gemini API key missing.')).toBeNull();
});

it('keeps earlier references and ten valid pictures when an unreadable file and an eleventh are picked', async () => {
  api.loadReference.mockImplementation(async (file: File) => {
    if (file.name === 'bad.txt') throw new Error('bad.txt is unsupported');
    return { name: file.name, data: 'data:image/png;base64,AAAA' };
  });
  render(<ImageWorkspace userId="first" onBack={() => {}} />);
  const pick = (names: string[]) => fireEvent.change(screen.getByLabelText('Reference image files'), {
    target: { files: names.map(name => new File(['file'], name, { type: 'image/png' })) }
  });
  pick(['first.png']);
  await screen.findByRole('button', { name: 'Remove first.png' });
  pick(['bad.txt', ...Array.from({length: 10}, (_,i) => `${i}.png`)]);
  await screen.findByRole('button', { name: 'Remove 8.png' });
  expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(10);
  expect(screen.getByRole('alert')).toHaveTextContent(/10 attachments/);
  expect(screen.queryByRole('button', { name: 'Remove 9.png' })).toBeNull();
  expect(screen.getByText(/numbered reference sheets/)).toBeVisible();
});

it('uses the automatic OpenRouter route, exposes native reference resolution and shows the saved original', async () => {
  api.renderStandalone.mockResolvedValue({...result, provider:'openrouter', byok:true});
  render(<ImageWorkspace userId="first" onBack={() => {}} />);
  expect(await screen.findByText('Selected route · OpenRouter · your key')).toBeVisible();
  fireEvent.change(screen.getByLabelText(/Describe your image/), {target:{value:'A full view of a railway bridge'}});
  fireEvent.click(screen.getByText('Image format').closest('summary')!);
  fireEvent.change(screen.getByLabelText('Rendering'), {target:{value:'2K'}});
  fireEvent.click(screen.getByRole('button', {name:'Generate image'}));
  await screen.findByAltText('Your generated image');
  expect(api.renderStandalone.mock.calls[0][5]).toBe('2K');
  fireEvent.click(screen.getByRole('button', {name:'View full size'}));
  expect(await screen.findByAltText('Full-resolution generated artwork')).toHaveAttribute('src', result.imageUrl);
  fireEvent.click(screen.getByRole('button', {name:'Actual pixels'}));
  expect(screen.getByRole('button', {name:'Fit image'})).toHaveAttribute('aria-pressed','true');
});

it('retries only local admission once with the same identity and never retries a provider throttle', async () => {
  const busy = Object.assign(new Error('Busy'), { status:429, code:'GENERATION_BUSY', retryAfterSeconds:1 });
  api.renderStandalone.mockRejectedValueOnce(busy).mockRejectedValueOnce(Object.assign(new Error('Rate limited by your provider'), { status:429, code:'RATE_LIMITED' }));
  render(<ImageWorkspace userId="first" onBack={() => {}} />);
  fireEvent.change(screen.getByLabelText(/Describe your image/), {target:{value:'A hillside'}});
  fireEvent.click(screen.getByRole('button',{name:'Generate image'}));
  expect(await screen.findByText('All image slots are busy. Your request will retry once.')).toBeVisible();
  await waitFor(() => expect(api.renderStandalone).toHaveBeenCalledTimes(2), {timeout:3500});
  expect(api.renderStandalone.mock.calls[1][4]).toBe(api.renderStandalone.mock.calls[0][4]);
  expect(await screen.findByRole('alert')).toHaveTextContent('Rate limited by your provider');
});

it('offers one-image paid consent in place and never submits merely by detecting a paid route', async () => {
  api.loadStandaloneRoute.mockRejectedValue(Object.assign(new Error('Free-only'), {code:'NO_FREE_MODEL_AVAILABLE'}));
  api.renderStandalone.mockResolvedValue(result);
  render(<ImageWorkspace userId="first" onBack={() => {}} />);
  const paid = await screen.findByRole('button', {name:'Generate this paid image'});
  fireEvent.change(screen.getByLabelText(/Describe your image/), {target:{value:'Make my image'}});
  expect(api.renderStandalone).not.toHaveBeenCalled();
  fireEvent.click(paid);
  await screen.findByAltText('Your generated image');
  expect(api.renderStandalone.mock.calls[0][6]).toMatchObject({allowPaidImage:true});
});
