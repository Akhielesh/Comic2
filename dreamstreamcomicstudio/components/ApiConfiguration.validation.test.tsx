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
const { addKey, listKeys, setKeyValidation, PROVIDER_META } = await import('../services/apiKeys');

const HOUR = 60 * 60 * 1000;
const T0 = new Date('2026-11-05T12:00:00Z').getTime();

const seedKey = (
  provider: 'openrouter' | 'nvidia',
  key: string,
  checkedAgoMs: number,
  verdict: { state: 'valid' | 'invalid'; message: string } = { state: 'valid', message: 'Valid key.' }
) => {
  vi.setSystemTime(T0 - checkedAgoMs);
  const k = addKey({ provider, label: `${provider} mine`, key });
  setKeyValidation(k.id, verdict.state, verdict.message);
  vi.setSystemTime(T0);
  return k;
};

const UNAVAILABLE = { provider: 'openrouter', status: 'unavailable' as const, valid: false, message: 'Sign in again to check this key.' };

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

  it('a check that could not run shows no Invalid badge, stores nothing, and the next open re-checks', async () => {
    seedKey('openrouter', 'sk-or-mine', 25 * HOUR);
    validateApiKey.mockResolvedValueOnce(UNAVAILABLE as never);
    render(<ApiConfiguration />);
    await act(async () => { openProvider('openrouter'); });
    expect(validateApiKey).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Sign in again to check this key.');
    expect(screen.queryByText('Invalid')).not.toBeInTheDocument();
    // The previous verdict and its time are kept — nothing was recorded.
    expect(listKeys()[0]).toMatchObject({ validation: 'valid', validatedAt: T0 - 25 * HOUR, validationMessage: 'Valid key.' });
    // Close and reopen the card: the stale verdict is checked again.
    await act(async () => { openProvider('openrouter'); });
    await act(async () => { openProvider('openrouter'); });
    expect(validateApiKey).toHaveBeenCalledTimes(2);
  });

  it('a new key whose first check could not run reads Unchecked, not Invalid', async () => {
    validateApiKey.mockResolvedValueOnce({ ...UNAVAILABLE, message: 'Couldn’t check this key right now — try Verify.' } as never);
    render(<ApiConfiguration />);
    if (!screen.queryByPlaceholderText(/Paste OpenRouter API key/)) await act(async () => { openProvider('openrouter'); });
    fireEvent.change(screen.getByPlaceholderText(/Paste OpenRouter API key/), { target: { value: 'sk-or-new' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Add$/ })); });
    expect(screen.getByText('Unchecked')).toBeInTheDocument();
    expect(screen.queryByText('Invalid')).not.toBeInTheDocument();
    expect(listKeys()[0].validatedAt).toBeUndefined();
  });

  it.each([
    'Validation failed (HTTP 401).',
    'Could not validate: Failed to fetch.',
    'Could not reach NVIDIA Build: connect ECONNREFUSED 10.0.0.7:443.',
    'NVIDIA returned 503.',
    'OpenRouter rejected this key (or it could not be reached).'
  ])('an old non-verdict stored as Invalid (%s) under 24 h old is not shown, and is re-checked on open', async (message) => {
    seedKey('openrouter', 'sk-or-mine', HOUR, { state: 'invalid', message });
    render(<ApiConfiguration />);
    await act(async () => { openProvider('openrouter'); });
    expect(validateApiKey).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Invalid')).not.toBeInTheDocument();
    expect(screen.queryByText(message)).not.toBeInTheDocument();
    expect(screen.getByText('Valid')).toBeInTheDocument();
  });

  it('a real Invalid verdict under 24 h old stays, with its reason, and is not re-checked', async () => {
    seedKey('openrouter', 'sk-or-mine', HOUR, { state: 'invalid', message: 'OpenRouter rejected this key.' });
    render(<ApiConfiguration />);
    await act(async () => { openProvider('openrouter'); });
    expect(validateApiKey).not.toHaveBeenCalled();
    expect(screen.getByText('Invalid')).toBeInTheDocument();
    expect(screen.getByText('OpenRouter rejected this key.')).toBeInTheDocument();
  });
});
