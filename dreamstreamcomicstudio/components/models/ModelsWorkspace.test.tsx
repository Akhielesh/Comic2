import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogModel } from '../../services/modelCatalog';
import type { ModelShowcaseExample, ModelShowcaseResponse, ModelShowcaseRow } from '../../shared/modelShowcase';
import { ImageModels } from './ImageModels';
import { LanguageModels } from './LanguageModels';
import { ModelLibrary, type ModelsWorkspaceData } from '../ModelLibrary';
import { addKey, recordKeyUsage, setKeyValidation, updateKey } from '../../services/apiKeys';
import { setProviderEnabled } from '../../services/sourceGovernance';
import { getSelectedTextModel } from '../../services/modelSelection';
import { FEATURED_MAKERS, focusedTextModels, knownTokenPrice, modelKey, modelMaker, modelPrice, recentModelsByMaker } from './workspaceData';

const session = vi.hoisted(() => ({ user: null as { id: string } | null }));
const modelServices = vi.hoisted(() => ({ catalog: vi.fn(), speed: vi.fn(), showcase: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: session.user }) }));
vi.mock('../../services/modelCatalog', async (original) => ({
  ...(await original<typeof import('../../services/modelCatalog')>()),
  fetchModelCatalog: modelServices.catalog,
  loadCachedCatalog: () => null
}));
vi.mock('../../services/modelSpeed', async (original) => ({
  ...(await original<typeof import('../../services/modelSpeed')>()),
  fetchModelSpeedReport: modelServices.speed
}));
vi.mock('../../services/modelShowcase', () => ({ fetchModelShowcase: modelServices.showcase }));

// Test-only records. No image fetches or provider requests are needed to exercise the workspace.
const model = (id: string, patch: Partial<CatalogModel> = {}): CatalogModel => ({
  id, name: id, source: 'openrouter', createdAt: 1,
  inputModalities: ['text'], outputModalities: ['text'], supportedParameters: ['tools'],
  pricing: { promptPerToken: 0.000001, completionPerToken: 0.000002, imagePerImage: 0, requestFlat: 0 },
  pricingKnown: true, pricingOrigin: 'provider', catalogOrigin: 'live',
  isFree: false, costClass: 'paid', supportsImageOutput: false, supportsImageInput: false,
  supportsJsonOutput: true, roles: ['text-brain'], costBand: 'low', drawbacks: [], possibilities: [],
  ...patch
});

const example = (modelId: string, patch: Partial<ModelShowcaseExample> = {}): ModelShowcaseExample => ({
  id: `fixture-${modelId}`, modelId, providerModelId: `vendor/${modelId}`,
  url: 'https://artwork.test/recorded-output.png', thumbnailUrl: 'https://artwork.test/recorded-output-thumb.png',
  alt: 'Test fixture: published comic page', width: 2048, height: 1536,
  generatedAt: Date.UTC(2026, 10, 1), resolution: '2K', source: 'platform_library',
  ...patch
});

const imageRow = (id: string, patch: Partial<ModelShowcaseRow> = {}): ModelShowcaseRow => ({
  modelId: id, providerModelId: `vendor/${id}`, name: `Fixture ${id}`, vendor: 'google',
  lifecycle: 'ga', studioSupported: true, catalogOnly: false, factsAsOf: '2026-11-01',
  capabilities: { references: 4, resolutions: ['1K', '2K'], aspects: ['4:3'], editing: 'good', lettering: 'good', pageComposition: 'good' },
  listPrices: [{ resolution: '2K', usd: 0.12, basis: 'per_image' }],
  examples: [], publishedExampleCount: 0, ownExampleCount: 0, sampleState: 'not_recorded',
  metrics: [], metricState: 'insufficient_data', ...patch
});

const showcase = (rows: ModelShowcaseRow[], patch: Partial<ModelShowcaseResponse> = {}): ModelShowcaseResponse => ({
  generatedAt: '2026-11-13T12:00:00.000Z', windowDays: 30, windowStart: '2026-10-14T12:00:00.000Z',
  scope: 'platform', sourceStatus: { samples: 'ready', metrics: 'ready', ownSamples: 'not_requested' }, rows, ...patch
});

const workspacePreview = (models: CatalogModel[]): ModelsWorkspaceData => ({
  catalog: { models, count: models.length, total: models.length, fetchedAt: Date.UTC(2026, 10, 13), degraded: false },
  speed: { models: {}, measuredAt: null, windowDays: 7, sampleLimit: 8000, capped: false, status: 'empty', measurement: 'chat_turn_latency_without_tools', sourceScope: 'pooled' },
  showcase: showcase([])
});

beforeEach(() => {
  localStorage.clear();
  session.user = null;
  modelServices.catalog.mockReset().mockResolvedValue({ models: [], count: 0, total: 0, fetchedAt: null, degraded: false });
  modelServices.speed.mockReset().mockResolvedValue({ models: {}, measuredAt: null, windowDays: 7, sampleLimit: 8000, capped: false, status: 'empty', measurement: 'chat_turn_latency_without_tools', sourceScope: 'pooled' });
  modelServices.showcase.mockReset().mockResolvedValue(showcase([]));
});
afterEach(cleanup);

describe('Models workspace catalog scope and evidence', () => {
  it('focuses on ten distinct makers, excludes image and non-callable entries, and caps only the recent shortlist', () => {
    expect(FEATURED_MAKERS).toHaveLength(10);
    expect(new Set(FEATURED_MAKERS.map((maker) => maker.id)).size).toBe(10);
    const inputs = [
      ...Array.from({ length: 5 }, (_, i) => model(`openai/fixture-${i}`, { createdAt: i })),
      model('anthropic/fixture-text'),
      model('meta-llama/fixture-outside-focus'),
      model('google/fixture-image', { supportsImageOutput: true, outputModalities: ['image'] }),
      model('deepseek/fixture-download', { apiCallable: false })
    ];
    const focused = focusedTextModels(inputs);
    expect(focused).toHaveLength(6);
    const recent = recentModelsByMaker(focused);
    expect(recent.filter((entry) => modelMaker(entry).id === 'openai').map((entry) => entry.id)).toEqual([
      'openai/fixture-4', 'openai/fixture-3', 'openai/fixture-2'
    ]);
    // Expanding or searching uses the full focused list, not a destructive cap.
    expect(focused.some((entry) => entry.id === 'openai/fixture-0')).toBe(true);
  });

  it('keeps the maker distinct from the serving connection and preserves separate routes', () => {
    const viaGateway = model('anthropic/fixture', { source: 'openrouter' });
    const viaNvidia = model('anthropic/fixture', { source: 'nvidia' });
    const native = model('claude-fixture', { source: 'anthropic' });
    expect([viaGateway, viaNvidia, native].map((entry) => modelMaker(entry).id)).toEqual(['anthropic', 'anthropic', 'anthropic']);
    expect(modelKey(viaGateway)).not.toBe(modelKey(viaNvidia));
    expect(focusedTextModels([viaGateway, viaNvidia])).toHaveLength(2);
    expect(recentModelsByMaker([viaGateway, viaNvidia])).toHaveLength(1);
  });

  it('never turns absent prices or old zero-filled caches into free pricing', () => {
    const zero = { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0, requestFlat: 0 };
    for (const entry of [
      model('openai/unknown', { pricing: zero, pricingKnown: false }),
      model('openai/old-cache', { pricing: zero, pricingKnown: undefined }),
      model('openai/stale-free', { pricing: zero, pricingKnown: false, isFree: true }),
      model('openai/invalid-price', { pricing: { ...zero, promptPerToken: NaN } })
    ]) {
      expect(modelPrice(entry, 'input')).toBe('Not reported');
      expect(knownTokenPrice(entry, 'input')).toBeNull();
    }
    const free = model('openai/fixture:free', { pricing: zero, pricingKnown: true, isFree: true, costClass: 'free_verified' });
    expect(modelPrice(free, 'input')).toBe('$0');
    expect(knownTokenPrice(free, 'input')).toBe(0);
    expect(modelPrice(model('openai/priced'), 'output')).toBe('$2.00');
  });
});

describe('Language model discovery and comparison', () => {
  it.each(['catalog removal', 'provider disabled', 'no longer callable'] as const)('frees comparison slots after %s', async (change) => {
    const models = [
      model('openai/fixture-a', { name: 'Fixture A' }),
      model('anthropic/fixture-b', { name: 'Fixture B', source: 'nvidia' }),
      model('google/fixture-c', { name: 'Fixture C', source: 'gemini' }),
      model('deepseek/fixture-d', { name: 'Fixture D' })
    ];
    modelServices.catalog.mockResolvedValue(workspacePreview(models).catalog);
    render(<ModelLibrary onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Language models' }));
    const table = within(await screen.findByRole('table'));
    for (const name of ['Fixture A', 'Fixture B', 'Fixture C']) fireEvent.click(table.getByLabelText(new RegExp(`Compare ${name} via`)));
    const remainingChoice = () => table.getByLabelText(/Compare Fixture D via/);
    expect(remainingChoice()).toBeDisabled();
    if (change === 'provider disabled') {
      // The source toggle must free its slot before a refresh can answer.
      modelServices.catalog.mockImplementationOnce(() => new Promise(() => undefined));
      act(() => setProviderEnabled('nvidia', false));
    } else {
      const refreshed = change === 'catalog removal' ? models.filter((entry) => entry.name !== 'Fixture B')
        : models.map((entry) => entry.name === 'Fixture B' ? { ...entry, apiCallable: false } : entry);
      modelServices.catalog.mockResolvedValueOnce(workspacePreview(refreshed).catalog);
      fireEvent.click(screen.getByText('Refresh'));
    }
    await waitFor(() => expect(remainingChoice()).toBeEnabled());
    expect(screen.queryByLabelText('Remove Fixture B from comparison')).not.toBeInTheDocument();
    fireEvent.click(remainingChoice());
    expect(screen.getByRole('button', { name: 'Compare 3 models' })).toBeEnabled();
    if (change === 'provider disabled') {
      act(() => setProviderEnabled('nvidia', true));
      const restored = table.getByLabelText(/Compare Fixture B via/);
      expect(restored).not.toBeChecked();
      expect(restored).toBeDisabled();
    }
  }, 10_000);

  it.each(['invalid', 'limit reached'] as const)('platform support does not bypass an active personal key that is %s', async (state) => {
    const entry = model('openai/fixture-routing', { name: 'Routing fixture', source: 'openrouter' });
    const key = addKey({ provider: 'openrouter', key: 'test-only-routing-key', limitUsd: 1 });
    if (state === 'invalid') setKeyValidation(key.id, 'invalid', 'OpenRouter rejected this key.');
    else recordKeyUsage('openrouter', 1);
    const openChat = vi.fn();
    modelServices.catalog.mockResolvedValue(workspacePreview([entry]).catalog);
    render(<ModelLibrary onBack={vi.fn()} onStartChat={openChat} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Language models' }));
    fireEvent.click(within(await screen.findByRole('table')).getByRole('button', { name: 'Details for Routing fixture' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Routing fixture' }));
    expect(dialog.getByRole('button', { name: 'Set text default' })).toBeDisabled();
    expect(dialog.getByRole('button', { name: 'Open in Chat' })).toBeDisabled();
    expect(dialog.getByText(state === 'invalid' ? /active key failed its last authentication check/i : /active key has reached its local monthly limit/i)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Open in Chat' }));
    expect(openChat).not.toHaveBeenCalled();
    expect(getSelectedTextModel()).toBeNull();
    await act(async () => {
      if (state === 'invalid') setKeyValidation(key.id, 'valid', 'Valid key.');
      else updateKey(key.id, { limitUsd: 2 });
    });
    expect(dialog.getByRole('button', { name: 'Set text default' })).toBeEnabled();
    expect(dialog.getByRole('button', { name: 'Open in Chat' })).toBeEnabled();
    fireEvent.click(dialog.getByRole('button', { name: 'Set text default' }));
    expect(getSelectedTextModel()).toBe(entry.id);
  });

  it('the complete workspace starts on images and manages a three-model language comparison', () => {
    const models = Array.from({ length: 4 }, (_, i) => model(`openai/fixture-${i}`, { name: `Workspace fixture ${i}`, createdAt: i }));
    const data: ModelsWorkspaceData = {
      catalog: { models, count: 4, total: 4, fetchedAt: Date.UTC(2026, 10, 13), degraded: false },
      speed: { models: {}, measuredAt: null, windowDays: 7, sampleLimit: 8000, capped: false, status: 'empty', measurement: 'chat_turn_latency_without_tools', sourceScope: 'pooled' },
      showcase: showcase([imageRow('preview')])
    };
    render(<ModelLibrary onBack={vi.fn()} previewData={data} />);
    expect(screen.getByRole('tab', { name: 'Image models' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('article', { name: 'Fixture preview' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Language models' }));
    expect(screen.queryByRole('article', { name: 'Fixture preview' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all from these providers' }));
    const boxes = within(screen.getByRole('table')).getAllByRole('checkbox');
    boxes.slice(0, 3).forEach((box) => fireEvent.click(box));
    expect(boxes[3]).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Compare 3 models' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Compare language models' }));
    expect(dialog.getAllByRole('article')).toHaveLength(3);
    expect(dialog.getByText('Price and observed response time')).toBeInTheDocument();
    expect(dialog.getAllByText('Not recorded')).toHaveLength(3);
  });

  it('searches serving connections independently of maker filters and can reveal older shortlisted models', () => {
    const models = [
      model('anthropic/fixture-a', { name: 'Fixture A', source: 'openrouter' }),
      model('anthropic/fixture-b', { name: 'Fixture B', source: 'nvidia' }),
      ...Array.from({ length: 5 }, (_, i) => model(`openai/fixture-${i}`, { name: `OpenAI fixture ${i}`, createdAt: i + 1 }))
    ];
    render(<LanguageModels models={models} speeds={{}} loading={false} selected={[]} onToggle={vi.fn()} onOpen={vi.fn()} />);
    const table = within(screen.getByRole('table'));
    expect(table.queryByText('OpenAI fixture 0')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search language models' }), { target: { value: 'OpenAI fixture 0' } });
    expect(table.getByText('OpenAI fixture 0')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search language models' }), { target: { value: 'NVIDIA' } });
    expect(table.getByText('Fixture B')).toBeInTheDocument();
    expect(table.queryByText('Fixture A')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search language models' }), { target: { value: '' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Model provider' }), { target: { value: 'anthropic' } });
    expect(table.getByText('Fixture A')).toBeInTheDocument();
    expect(table.getByText('Fixture B')).toBeInTheDocument();
    expect(table.queryByText('OpenAI fixture 4')).not.toBeInTheDocument();
  });

  it('disables additional choices at three while preserving deselection', () => {
    const models = Array.from({ length: 4 }, (_, i) => model(`openai/fixture-${i}`, { name: `Fixture ${i}`, createdAt: i }));
    function Controlled() {
      const [selected, setSelected] = useState<string[]>([]);
      return <LanguageModels models={models} speeds={{}} loading={false} selected={selected} onOpen={vi.fn()} onToggle={(entry) => setSelected((previous) => previous.includes(modelKey(entry)) ? previous.filter((id) => id !== modelKey(entry)) : [...previous, modelKey(entry)])} />;
    }
    render(<Controlled />);
    fireEvent.click(screen.getByRole('button', { name: 'Show all from these providers' }));
    const table = within(screen.getByRole('table'));
    const boxes = table.getAllByRole('checkbox');
    boxes.slice(0, 3).forEach((box) => fireEvent.click(box));
    expect(boxes[3]).toBeDisabled();
    expect(boxes[0]).toBeEnabled();
    fireEvent.click(boxes[0]);
    expect(boxes[3]).toBeEnabled();
  });
});

describe('Image model outputs use recorded evidence', () => {
  it('clears owner-only images and an open inspection dialog immediately when the account changes', async () => {
    session.user = { id: 'owner-a' };
    const own = example('owner-fixture', { source: 'your_comic', projectId: 'project-a', alt: 'Owner A private page' });
    const ownerData = showcase([imageRow('owner-fixture', { examples: [own], ownExampleCount: 1, sampleState: 'available' })], { scope: 'platform_and_yours' });
    let finishNext!: (data: ModelShowcaseResponse) => void;
    modelServices.showcase.mockResolvedValueOnce(ownerData).mockImplementationOnce(() => new Promise((resolve) => { finishNext = resolve; }));
    const view = render(<ModelLibrary onBack={vi.fn()} />);
    await screen.findByRole('img', { name: own.alt });
    fireEvent.click(screen.getByRole('button', { name: /Inspect Fixture owner-fixture/ }));
    expect(screen.getByRole('dialog', { name: 'Generated in Comic Studio' })).toBeInTheDocument();
    session.user = { id: 'owner-b' };
    view.rerender(<ModelLibrary onBack={vi.fn()} />);
    expect(screen.queryByRole('img', { name: own.alt })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => { finishNext(showcase([imageRow('new-owner')])); });
    expect(screen.getByRole('article', { name: 'Fixture new-owner' })).toBeInTheDocument();
    expect(screen.queryByText(/Owner A private page/)).not.toBeInTheDocument();
  });

  it('caps the gallery at five, limits comparisons to three and opens a genuine side-by-side dialog', () => {
    render(<ImageModels data={showcase(Array.from({ length: 6 }, (_, i) => imageRow(String(i))))} loading={false} error={null} onRetry={vi.fn()} />);
    expect(screen.getAllByRole('article')).toHaveLength(5);
    const boxes = screen.getAllByRole('checkbox');
    boxes.slice(0, 3).forEach((box) => fireEvent.click(box));
    expect(boxes[3]).toBeDisabled();
    expect(boxes[4]).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Compare outputs' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Compare image outputs' }));
    expect(dialog.getAllByRole('article')).toHaveLength(3);
    expect(dialog.queryByRole('article', { name: 'Fixture 3' })).not.toBeInTheDocument();
  });

  it('uses the recorded image and exposes its real model identity and resolution when inspected', () => {
    const sample = example('fixture-model');
    render(<ImageModels data={showcase([imageRow('fixture-model', { examples: [sample], publishedExampleCount: 1, sampleState: 'available' })])} loading={false} error={null} onRetry={vi.fn()} />);
    expect(screen.getByRole('img', { name: sample.alt })).toHaveAttribute('src', sample.thumbnailUrl);
    fireEvent.click(screen.getByRole('button', { name: /Inspect Fixture fixture-model .*output/ }));
    const dialog = within(screen.getByRole('dialog', { name: 'Generated in Comic Studio' }));
    expect(dialog.getByText(/fixture-model.*2K/)).toBeInTheDocument();
    expect(dialog.getByRole('img', { name: sample.alt })).toHaveAttribute('src', sample.url);
  });

  it('compares recorded page costs at the selected resolution, separately from reference prices', () => {
    const data = showcase([imageRow('priced', {
      listPrices: [{ resolution: '1K', usd: 0.05, basis: 'per_image' }, { resolution: '2K', usd: 0.24, basis: 'per_image' }],
      metrics: [
        { kind: 'page', resolution: '1K', calls: 9, successfulCalls: 9, failedCalls: 0, medianCostUsd: 0.025, costSamples: 9, costFrom: '2026-11-01', costTo: '2026-11-13', medianLatencyMs: null, latencySamples: 0 },
        { kind: 'page', resolution: '2K', calls: 11, successfulCalls: 11, failedCalls: 0, medianCostUsd: 0.18, costSamples: 11, costFrom: '2026-11-01', costTo: '2026-11-13', medianLatencyMs: null, latencySamples: 0 },
        { kind: 'character', resolution: '2K', calls: 2, successfulCalls: 2, failedCalls: 0, medianCostUsd: 0.001, costSamples: 2, costFrom: '2026-11-01', costTo: '2026-11-13', medianLatencyMs: null, latencySamples: 0 }
      ], metricState: 'available'
    })]);
    render(<ImageModels data={data} loading={false} error={null} onRetry={vi.fn()} />);
    const card = within(screen.getByRole('article', { name: 'Fixture priced' }));
    expect(card.getByText('$0.05')).toBeInTheDocument();
    expect(card.getByText('$0.025')).toBeInTheDocument();
    expect(card.getByText(/Median of 9 priced 1K page calls/)).toBeInTheDocument();
    expect(card.queryByText('$0.18')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Image price resolution' }), { target: { value: '2K' } });
    expect(card.getByText('$0.24')).toBeInTheDocument();
    expect(card.getByText('$0.18')).toBeInTheDocument();
    expect(card.getByText(/Median of 11 priced 2K page calls/)).toBeInTheDocument();
    expect(card.queryByText('$0.001')).not.toBeInTheDocument();
  });

  it('does not mislabel the signed-in owner’s private output as a published platform example', () => {
    const sample = example('owned-fixture', { source: 'your_comic', projectId: 'private-test-project', alt: 'Test fixture: your private comic' });
    render(<ImageModels data={showcase([imageRow('owned-fixture', { examples: [sample], ownExampleCount: 1, sampleState: 'available' })], { scope: 'platform_and_yours' })} loading={false} error={null} onRetry={vi.fn()} />);
    const card = within(screen.getByRole('article', { name: 'Fixture owned-fixture' }));
    expect(card.getByText(/your comic|your output/i)).toBeInTheDocument();
    expect(card.queryByText(/platform output/i)).not.toBeInTheDocument();
    expect(card.getByRole('button', { name: /Inspect/ })).not.toHaveAccessibleName(/platform/i);
  });

  it('distinguishes missing observations from a failed sample/metric read', () => {
    render(<ImageModels data={showcase([
      imageRow('empty', { listPrices: [] }),
      imageRow('unavailable', { sampleState: 'source_unavailable', metricState: 'source_unavailable' })
    ])} loading={false} error={null} onRetry={vi.fn()} />);
    const empty = within(screen.getByRole('article', { name: 'Fixture empty' }));
    expect(empty.getByText('No attributed output yet')).toBeInTheDocument();
    expect(empty.getAllByText('Not reported').length).toBeGreaterThanOrEqual(2);
    expect(empty.queryByText(/\$0(?:\.00)?\b/)).not.toBeInTheDocument();
    const failed = within(screen.getByRole('article', { name: 'Fixture unavailable' }));
    expect(failed.getAllByText(/couldn.t load|unavailable/i).length).toBeGreaterThan(0);
    expect(failed.queryByText('No attributed output yet')).not.toBeInTheDocument();
    expect(failed.queryByText(/No comparable observed price yet/)).not.toBeInTheDocument();
  });

  it('shows a retryable service error without fabricating examples or prices', () => {
    const retry = vi.fn();
    render(<ImageModels data={null} loading={false} error="The model service is unavailable." onRetry={retry} />);
    expect(screen.getByText('Image comparison couldn’t load')).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('keeps a last-loaded gallery visible with a refresh failure notice', () => {
    render(<ImageModels data={showcase([imageRow('cached')])} loading={false} error="Refresh failed." onRetry={vi.fn()} />);
    expect(screen.getByRole('article', { name: 'Fixture cached' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Refresh failed. Showing the last loaded comparison.');
  });
});
