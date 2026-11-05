// API Configuration never re-validates keys on a timer (a timed /api call keeps the sleepable
// backend awake, and the old 10-minute setInterval re-sent every stored key). Keys are checked
// on add, on the explicit Verify button, and — when a row is shown — only if the stored verdict
// is over 24 hours old (BK-0).
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const validateApiKey = vi.hoisted(() =>
  vi.fn(async (provider: string) => ({ provider, status: 'valid' as const, valid: true, message: 'Valid key.' }))
);
vi.mock('../services/keyValidation', () => ({ validateApiKey }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'user-1' } }) }));
vi.mock('../services/modelCatalog', () => ({ fetchModelCatalog: vi.fn(async () => ({ models: [] })) }));
vi.mock('./ModelSelectionPanel', () => ({ ModelSelectionPanel: () => null }));
vi.mock('../services/byokSync', () => ({ reconcileProviderMirror: vi.fn(async () => undefined), syncByokKeyToServer: vi.fn(async () => undefined) }));
vi.mock('../services/usageAllowance', () => ({
  USAGE_EXHAUSTED_COPY: '',
  fetchAllowanceStatus: vi.fn(async () => null),
  formatPctLeft: () => '',
  getLastAllowanceStatus: () => null,
  patchBillingPrefs: vi.fn(async () => null),
  publishAllowanceStatus: vi.fn(),
  refreshAllowanceStatus: vi.fn(async () => null),
  resetsLabel: () => null,
  subscribeAllowanceStatus: () => () => undefined
}));

const { ApiConfiguration } = await import('./ApiConfiguration');
const { addKey, setKeyValidation, PROVIDER_META } = await import('../services/apiKeys');

const HOUR = 60 * 60 * 1000;
const T0 = new Date('2026-11-05T12:00:00Z').getTime();

const seedKey = (provider: 'openrouter' | 'nvidia', key: string, checkedAgoMs: number) => {
  vi.setSystemTime(T0 - checkedAgoMs);
  const k = addKey({ provider, label: `${provider} mine`, key });
  setKeyValidation(k.id, 'valid', 'Valid key.');
  vi.setSystemTime(T0);
  return k;
};

const openProvider = (provider: 'openrouter' | 'nvidia') => {
  fireEvent.click(screen.getAllByText(PROVIDER_META[provider].label)[0]);
};

beforeEach(() => {
  window.localStorage.clear();
  validateApiKey.mockClear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('API Configuration key validation', () => {
  it('registers no interval: an hour (and a day) open validates nothing', async () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    seedKey('openrouter', 'sk-or-mine', 0);
    seedKey('nvidia', 'nvapi-mine', 0);
    render(<ApiConfiguration />);
    await act(async () => { await vi.advanceTimersByTimeAsync(HOUR); });
    expect(validateApiKey).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(24 * HOUR); });
    expect(validateApiKey).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('opening a provider re-checks nothing when the verdict is under 24 h old', async () => {
    seedKey('openrouter', 'sk-or-mine', 2 * HOUR);
    render(<ApiConfiguration />);
    await act(async () => { openProvider('openrouter'); });
    expect(screen.getByText('openrouter mine')).toBeInTheDocument();
    expect(validateApiKey).not.toHaveBeenCalled();
  });

  it('opening a provider re-checks once when the verdict is over 24 h old', async () => {
    seedKey('openrouter', 'sk-or-mine', 25 * HOUR);
    render(<ApiConfiguration />);
    await act(async () => { openProvider('openrouter'); });
    expect(validateApiKey).toHaveBeenCalledTimes(1);
    expect(validateApiKey).toHaveBeenCalledWith('openrouter', 'sk-or-mine');
  });

  it('the Verify button checks that key, on demand', async () => {
    seedKey('openrouter', 'sk-or-mine', 0);
    render(<ApiConfiguration />);
    await act(async () => { openProvider('openrouter'); });
    expect(validateApiKey).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByTitle('Verify key is valid')); });
    expect(validateApiKey).toHaveBeenCalledTimes(1);
    expect(validateApiKey).toHaveBeenCalledWith('openrouter', 'sk-or-mine');
  });

  it('a newly added key is checked once, on add', async () => {
    render(<ApiConfiguration />);
    // With no keys yet, the first provider (OpenRouter) opens by itself.
    if (!screen.queryByPlaceholderText(/Paste OpenRouter API key/)) await act(async () => { openProvider('openrouter'); });
    fireEvent.change(screen.getByPlaceholderText(/Paste OpenRouter API key/), { target: { value: 'sk-or-new' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Add$/ })); });
    expect(validateApiKey).toHaveBeenCalledTimes(1);
    expect(validateApiKey).toHaveBeenCalledWith('openrouter', 'sk-or-new');
  });
});
