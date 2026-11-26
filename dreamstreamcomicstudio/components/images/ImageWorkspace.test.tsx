// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  renderStandalone: vi.fn(), loadStandaloneRoute: vi.fn(), loadImageHistory: vi.fn(), loadReference: vi.fn(), downloadStandalone: vi.fn(), reopenStandalone: vi.fn(), reuseStandalone: vi.fn()
}));
vi.mock('../../services/standaloneImages', () => api);
vi.mock('../account/AccountMenu', () => ({ AccountMenu: () => null }));
import { ImageWorkspace } from './ImageWorkspace';
import { priceSheetOf } from '../../shared/comic/priceBook';
import { __resetPriceSheetForTests, __seedPriceSheetForTests } from '../../services/priceSheet';

const result = { imageId: 'a', imageUrl: 'https://test.invalid/rendered', createdAt: '2026-11-20T12:00:00.000Z' };
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  localStorage.removeItem('dreamstream:freeOnly');
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

it.each([
  ['IMAGE_KEY_EXHAUSTED', 'Your OpenRouter key has no spending capacity available. Review its spending limit and available credits in Settings.'],
  ['IMAGE_KEY_INVALID', 'OpenRouter rejected the configured credential. Validate or replace the key in Settings.']
])('exposes same-tab recovery for %s during preflight and generation', async (code, detail) => {
  const issue = Object.assign(new Error(detail), {code, status:code === 'IMAGE_KEY_EXHAUSTED' ? 402 : 422});
  api.loadStandaloneRoute.mockRejectedValueOnce(issue);
  api.renderStandalone.mockRejectedValueOnce(issue);
  render(<ImageWorkspace userId="first" onBack={() => {}} />);
  expect(await screen.findByRole('link', {name:'Open API keys and usage'})).not.toHaveAttribute('target');
  expect(screen.getByText(detail, {exact:false})).toBeVisible();
  expect(api.renderStandalone).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText(/Describe your image/), {target:{value:'Keep my draft'}});
  fireEvent.click(screen.getByRole('button', {name:'Generate image'}));
  await waitFor(() => expect(api.renderStandalone).toHaveBeenCalledTimes(1));
  expect(await screen.findByRole('link', {name:'Open API keys and usage'})).toBeVisible();
  expect(screen.getByLabelText(/Describe your image/)).toHaveValue('Keep my draft');
  expect(screen.queryByRole('button', {name:'Generate this paid image'})).toBeNull();
});

it('refresh clears a prior settings action and checks a transient outage without starting a render', async () => {
  const issue = (code:string, message:string) => Object.assign(new Error(message), {code});
  api.loadStandaloneRoute.mockRejectedValueOnce(issue('IMAGE_KEY_INVALID', 'Validate your OpenRouter key in Settings.'))
    .mockRejectedValueOnce(issue('IMAGE_ROUTE_UNAVAILABLE', 'The image provider is temporarily unavailable.'))
    .mockRejectedValueOnce(issue('NO_FREE_MODEL_AVAILABLE','Approval required.'));
  render(<ImageWorkspace userId="first" onBack={() => {}} />);
  await screen.findByRole('link',{name:'Open API keys and usage'});
  act(() => { window.dispatchEvent(new Event('dreamstream:api-keys:changed')); });
  const retry = await screen.findByRole('button', {name:'Check provider again'});
  expect(screen.queryByRole('link', {name:'Open API keys and usage'})).toBeNull();
  fireEvent.click(retry);
  await screen.findByRole('button',{name:'Generate this paid image'});
  expect(screen.queryByRole('button',{name:'Check provider again'})).toBeNull();
  expect(screen.queryByRole('link',{name:'Open API keys and usage'})).toBeNull();
  expect(api.loadStandaloneRoute).toHaveBeenCalledTimes(3);
  expect(api.renderStandalone).not.toHaveBeenCalled();
});

const routerAlternate = { provider:'openrouter', payer:'personal', model:'google/gemini-2.5-flash-image' } as const;
const reselect = (alternate = routerAlternate) => Object.assign(new Error('The first provider declined before generating.'), {code:'IMAGE_ROUTE_RESELECT',status:409,details:alternate});

it('refreshes a changed funding source without resubmitting the generation', async () => {
  api.loadStandaloneRoute.mockResolvedValue(routerAlternate);
  api.renderStandalone.mockRejectedValue(Object.assign(new Error('The available funding source changed.'), {code:'IMAGE_ROUTE_CHANGED',status:409}));
  render(<ImageWorkspace userId="first" onBack={() => {}} />);
  await screen.findByText('Selected route · OpenRouter · your key');
  fireEvent.change(screen.getByLabelText(/Describe your image/), {target:{value:'My station'}});
  fireEvent.click(screen.getByRole('button',{name:'Generate image'}));
  fireEvent.click(await screen.findByRole('button',{name:'Check provider again'}));
  await screen.findByText('Selected route · OpenRouter · your key');
  expect(api.loadStandaloneRoute).toHaveBeenCalledTimes(2);
  expect(api.renderStandalone).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText(/Describe your image/)).toHaveValue('My station');
});

it('resubmits a definitively refused render once using the identical request ID, prompt and references, pinned to its payer', async () => {
  localStorage.setItem('dreamstream:freeOnly', '0');
  api.loadStandaloneRoute.mockResolvedValue({provider:'gemini',payer:'personal',model:'gemini-2.5-flash-image'});
  api.loadReference.mockResolvedValue({name:'original.webp',data:'data:image/webp;base64,AAAA'});
  api.renderStandalone.mockRejectedValueOnce(reselect()).mockResolvedValueOnce({...result,provider:'openrouter',byok:true});
  render(<ImageWorkspace userId="first" onBack={() => {}} />);
  await screen.findByText('Selected route · Gemini · your key');
  fireEvent.change(screen.getByLabelText(/Describe your image/), {target:{value:'My station'}});
  fireEvent.change(screen.getByLabelText('Reference image files'), {target:{files:[new File(['file'],'original.webp',{type:'image/webp'})]}});
  await screen.findByRole('button',{name:'Remove original.webp'});
  fireEvent.click(screen.getByRole('button',{name:'Generate image'}));
  await screen.findByAltText('Your generated image');
  const [first, second] = api.renderStandalone.mock.calls;
  expect(api.renderStandalone).toHaveBeenCalledTimes(2);
  expect(first.slice(0,6)).toEqual(second.slice(0,6));
  expect(first[6].expectedRoute).toBeUndefined();
  expect(second[6]).toMatchObject({allowPaidImage:false,expectedRoute:routerAlternate});
  expect(screen.getByText('Selected route · OpenRouter · your key')).toBeVisible();
});

it('waits for explicit paid approval on a free-only rejection and retries under the original id', async () => {
  api.loadStandaloneRoute.mockResolvedValue({provider:'gemini',payer:'personal',model:'gemini-2.5-flash-image'});
  api.renderStandalone.mockRejectedValueOnce(reselect()).mockResolvedValueOnce(result);
  render(<ImageWorkspace userId="first" onBack={() => {}} />);
  await screen.findByText('Selected route · Gemini · your key');
  fireEvent.change(screen.getByLabelText(/Describe your image/), {target:{value:'My station'}});
  fireEvent.click(screen.getByRole('button',{name:'Generate image'}));
  const approve = await screen.findByRole('button',{name:'Generate this paid image'});
  expect(api.renderStandalone).toHaveBeenCalledTimes(1);
  fireEvent.click(approve);
  await screen.findByAltText('Your generated image');
  expect(api.renderStandalone.mock.calls[1][4]).toBe(api.renderStandalone.mock.calls[0][4]);
  expect(api.renderStandalone.mock.calls[1][6]).toMatchObject({allowPaidImage:true,expectedRoute:routerAlternate});
  expect(localStorage.getItem('dreamstream:freeOnly')).toBeNull();
});

it.each(['ambiguous','different payer','second rejection'] as const)('never automatically changes payer or loops after %s', async kind => {
  localStorage.setItem('dreamstream:freeOnly', '0');
  api.loadStandaloneRoute.mockResolvedValue({provider:'gemini',payer:'personal',model:'gemini-2.5-flash-image'});
  api.renderStandalone.mockRejectedValue(kind === 'ambiguous' ? Object.assign(new Error('No confirmed result'),{code:'IMAGE_RESULT_UNCONFIRMED',status:409}) :
    kind === 'different payer' ? Object.assign(reselect(),{details:{...routerAlternate,payer:'platform'}}) : reselect());
  render(<ImageWorkspace userId="first" onBack={() => {}} />);
  await screen.findByText('Selected route · Gemini · your key');
  fireEvent.change(screen.getByLabelText(/Describe your image/), {target:{value:'My station'}});
  fireEvent.click(screen.getByRole('button',{name:'Generate image'}));
  await screen.findByRole('alert');
  expect(api.renderStandalone).toHaveBeenCalledTimes(kind === 'second rejection' ? 2 : 1);
  expect(screen.getByLabelText(/Describe your image/)).toHaveValue('My station');
});

it('Generate is described by its price only while the price line is there (never a dangling reference)', async () => {
  __resetPriceSheetForTests();
  __seedPriceSheetForTests('first', priceSheetOf({ rows: [], observed: [], qc: null }, Date.now()));
  let answer!: (route: unknown) => void;
  api.loadStandaloneRoute.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
  render(<ImageWorkspace userId="first" onBack={() => {}} />);
  const generate = screen.getByRole('button', { name: 'Generate image' });
  // The route is not known yet: no price line, so nothing to point at.
  expect(document.getElementById('image-price')).toBeNull();
  expect(generate).not.toHaveAttribute('aria-describedby');
  await act(async () => answer({ provider: 'openrouter', payer: 'personal', model: 'google/gemini-2.5-flash-image' }));
  await waitFor(() => expect(generate).toHaveAttribute('aria-describedby', 'image-price'));
  expect(document.getElementById('image-price')).toHaveTextContent(/an image on your OpenRouter key/);
  __resetPriceSheetForTests();
});

it('on the comics host it sits in the frame and side panel of My comics: one main, no second Back, Images marked current', async () => {
  const onBack = vi.fn();
  const panel = { projects: [], onNewComic: vi.fn(), onLibrary: vi.fn(), onOpenProject: vi.fn(), onChat: vi.fn(), onImages: vi.fn() };
  render(<ImageWorkspace userId="first" onBack={onBack} panel={panel} />);
  // The frame is its own lazy chunk; the first import in a test run takes a moment.
  const nav = await screen.findByRole('navigation', { name: 'Project navigation' }, { timeout: 10_000 });
  expect(screen.getAllByRole('main')).toHaveLength(1);
  expect(screen.getByRole('main').contains(screen.getByRole('heading', { level: 1, name: 'Create an image' }))).toBe(true);
  expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe('Images');
  fireEvent.click(screen.getByRole('button', { name: 'Back to My comics' }));
  expect(onBack).toHaveBeenCalledTimes(1);
});
