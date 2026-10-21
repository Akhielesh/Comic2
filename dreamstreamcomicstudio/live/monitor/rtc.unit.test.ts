// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { classifyPath } from './rtc';

describe('classifyPath', () => {
  it('home Wi-Fi: host candidates or private addresses on both ends', () => {
    expect(classifyPath({ candidateType: 'host', address: '192.168.1.20' }, { candidateType: 'host', address: '192.168.1.31' })).toBe('lan');
    // mDNS-hidden host candidate on the far end, learned as peer-reflexive with a private address.
    expect(classifyPath({ candidateType: 'host' }, { candidateType: 'prflx', address: '10.0.0.7' })).toBe('lan');
    expect(classifyPath({ candidateType: 'host', address: 'a1b2.local' }, { candidateType: 'host' })).toBe('lan');
    expect(classifyPath({ candidateType: 'host', address: 'fd12:3456::1' }, { candidateType: 'prflx', address: 'fe80::1' })).toBe('lan');
  });

  it('internet: a public (server-reflexive) address on either end', () => {
    expect(classifyPath({ candidateType: 'srflx', address: '81.2.3.4' }, { candidateType: 'srflx', address: '93.1.2.3' })).toBe('internet');
    expect(classifyPath({ candidateType: 'host', address: '192.168.1.20' }, { candidateType: 'prflx', address: '93.1.2.3' })).toBe('internet');
  });

  it('relay wins over everything', () => {
    expect(classifyPath({ candidateType: 'relay' }, { candidateType: 'host', address: '192.168.1.3' })).toBe('relay');
    expect(classifyPath({ candidateType: 'host' }, { candidateType: 'relay' })).toBe('relay');
  });
});
