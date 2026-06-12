import { afterEach, describe, expect, it } from 'vitest';
import { EGRESS_HOSTS, egressBase, egressHeaders, egressUrlFor } from './egressProxy.js';

const reset = () => {
  delete process.env.DATA_EGRESS_URL;
  delete process.env.DATA_EGRESS_SECRET;
};
afterEach(reset);

describe('egressUrlFor', () => {
  it('relays only allowlisted https hosts', () => {
    expect(egressUrlFor('https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d')).toBe(
      'https://dreamstreamstudio.ai/egress/fetch?url=' +
        encodeURIComponent('https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d')
    );
    expect(egressUrlFor('https://stooq.com/q/l/?s=aapl.us')).toContain('/egress/fetch?url=');
    expect(egressUrlFor('https://api.coingecko.com/api/v3/ping')).toBeNull();
    expect(egressUrlFor('http://stooq.com/q/l/')).toBeNull(); // https only
    expect(egressUrlFor('not a url')).toBeNull();
  });

  it('honors DATA_EGRESS_URL override and the empty-string kill switch', () => {
    process.env.DATA_EGRESS_URL = 'https://relay.example.com/egress/';
    expect(egressBase()).toBe('https://relay.example.com/egress');
    expect(egressUrlFor('https://stooq.com/q/l/?s=spy.us')).toContain('relay.example.com');
    process.env.DATA_EGRESS_URL = '';
    expect(egressBase()).toBeNull();
    expect(egressUrlFor('https://stooq.com/q/l/?s=spy.us')).toBeNull();
  });

  it('never relays the relay itself', () => {
    process.env.DATA_EGRESS_URL = 'https://query1.finance.yahoo.com/egress';
    expect(egressUrlFor('https://query1.finance.yahoo.com/egress/fetch?url=x')).toBeNull();
  });

  it('keeps the allowlist in sync expectations', () => {
    expect(EGRESS_HOSTS.has('query2.finance.yahoo.com')).toBe(true);
    expect(EGRESS_HOSTS.has('api.fiscaldata.treasury.gov')).toBe(true);
    expect(EGRESS_HOSTS.size).toBe(5);
  });
});

describe('egressHeaders', () => {
  it('adds the shared-secret header only when configured', () => {
    expect(egressHeaders()).toEqual({});
    process.env.DATA_EGRESS_SECRET = ' s3cret ';
    expect(egressHeaders()).toEqual({ 'x-egress-key': 's3cret' });
  });
});
