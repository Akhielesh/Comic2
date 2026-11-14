import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { attachKeys } from './keys.js';
import { checkLimits } from './limits.js';

const { getBillingSummary } = vi.hoisted(() => ({ getBillingSummary: vi.fn() }));
vi.mock('../services/billingLedger.js', () => ({ getBillingSummary }));

const providers = ['gemini', 'pixazo', 'ideogram'] as const;
type Provider = typeof providers[number];

const request = (headers: Record<string, string> = {}): Request => {
  const entries = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const req = {
    user: { id: 'owner' },
    header: (name: string) => entries[name.toLowerCase()]
  } as unknown as Request;
  attachKeys(req, {} as Response, () => {});
  return req;
};

// Account middleware attaches the selected owner credential to the resolved fields;
// it deliberately never inserts a secret into the request headers.
const accountKey = (req: Request, provider: Provider, key = 'owner-test-key') => {
  req.apiKeys![`${provider}Key`] = key;
  req.apiKeys![`${provider}Byok`] = true;
};

const run = async (provider: Provider, req: Request) => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const next = vi.fn();
  await checkLimits(provider)(req, { status } as unknown as Response, next);
  return { json, status, next };
};

beforeEach(() => {
  vi.clearAllMocks();
  getBillingSummary.mockResolvedValue({
    plan: { id: 'free' },
    usage: { dailyRemainingCt: 0 },
    wallet: { availableCt: 0 }
  });
});

describe('legacy image limits with resolved provider credentials', () => {
  it.each(providers)('allows an account-only %s key when platform credits are exhausted', async (provider) => {
    const req = request();
    accountKey(req, provider);
    const { next, status } = await run(provider, req);
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
    expect(getBillingSummary).not.toHaveBeenCalled();
  });

  it.each(providers)('does not let a platform %s key bypass exhausted credits', async (provider) => {
    const req = request();
    req.apiKeys![`${provider}Key`] = 'platform-test-key';
    req.apiKeys![`${provider}Byok`] = false;
    const { next, status } = await run(provider, req);
    expect(status).toHaveBeenCalledWith(402);
    expect(next).not.toHaveBeenCalled();
  });

  it.each(providers)('cannot use another provider key to bypass the %s limit', async (provider) => {
    const req = request();
    accountKey(req, provider === 'gemini' ? 'pixazo' : 'gemini');
    const { next, status } = await run(provider, req);
    expect(status).toHaveBeenCalledWith(402);
    expect(next).not.toHaveBeenCalled();
  });

  it.each(providers)('keeps a disabled %s account key behind the limit', async (provider) => {
    const req = request({ 'X-Allowed-Sources': '' });
    accountKey(req, provider);
    const { next, status } = await run(provider, req);
    expect(status).toHaveBeenCalledWith(402);
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    ['gemini', 'X-Gemini-Key'],
    ['pixazo', 'X-Pixazo-Key'],
    ['pixazo', 'X-Flux-Key'],
    ['ideogram', 'X-Ideogram-Key']
  ] as const)('retains enabled %s header BYOK through %s', async (provider, header) => {
    const { next, status } = await run(provider, request({ [header]: 'owner-test-key', 'X-Allowed-Sources': provider }));
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
    expect(getBillingSummary).not.toHaveBeenCalled();
  });

  it('does not accept a raw header for a disabled source', async () => {
    const { next, status } = await run('gemini', request({ 'X-Gemini-Key': 'owner-test-key', 'X-Allowed-Sources': 'openrouter' }));
    expect(status).toHaveBeenCalledWith(402);
    expect(next).not.toHaveBeenCalled();
  });

  it('requires a nonempty resolved credential as well as the BYOK flag', async () => {
    const req = request();
    accountKey(req, 'gemini', '   ');
    const { next, status } = await run('gemini', req);
    expect(status).toHaveBeenCalledWith(402);
    expect(next).not.toHaveBeenCalled();
  });

  it('requires a signed-in owner even when an explicit key is supplied', async () => {
    const req = request({ 'X-Gemini-Key': 'owner-test-key' });
    delete req.user;
    const { next, status } = await run('gemini', req);
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(getBillingSummary).not.toHaveBeenCalled();
  });
});
