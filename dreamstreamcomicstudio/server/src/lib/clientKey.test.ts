// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { clientKey, ipv6Prefix64 } from './clientKey.js';

describe('clientKey (abuse-ops-8)', () => {
  it('keys IPv4 as-is, including an IPv4 address Node reports in its IPv6-mapped form', () => {
    expect(clientKey('203.0.113.9')).toBe('4:203.0.113.9');
    expect(clientKey('::ffff:203.0.113.9')).toBe('4:203.0.113.9');
    expect(clientKey('::FFFF:203.0.113.9')).toBe('4:203.0.113.9');
    expect(clientKey(' 198.51.100.20 ')).toBe('4:198.51.100.20');
  });

  it('keys IPv6 by its /64, whatever way the address is written', () => {
    const a = clientKey('2001:db8:5:6::1');
    expect(a).toBe('6:2001:0db8:0005:0006');
    for (const ip of [
      '2001:db8:5:6::ffff',
      '2001:0DB8:0005:0006:aaaa:bbbb:cccc:dddd',
      '2001:db8:5:6:1:2:3:4',
      '[2001:db8:5:6::9]',
      '2001:db8:5:6::2%eth0'
    ]) {
      expect([ip, clientKey(ip)]).toEqual([ip, a]);
    }
    // The next /64 over is someone else.
    expect(clientKey('2001:db8:5:7::1')).toBe('6:2001:0db8:0005:0007');
    expect(clientKey('::1')).toBe('6:0000:0000:0000:0000');
  });

  it('reads an embedded IPv4 tail as two groups', () => {
    expect(ipv6Prefix64('64:ff9b::192.0.2.33')).toBe('0064:ff9b:0000:0000');
    expect(ipv6Prefix64('2001:db8:1:2:3:4:192.0.2.33')).toBe('2001:0db8:0001:0002');
    expect(ipv6Prefix64('2001:db8::300.0.2.33')).toBeNull();
  });

  it('refuses malformed IPv6 and keeps junk bounded instead of trusting it', () => {
    for (const bad of ['2001:db8::1::2', '2001:db8:1:2:3:4:5', '2001:db8:1:2:3:4:5:6:7', '2001:zz8::1', '1:2:3:4:5:6:7::8:9']) {
      expect([bad, ipv6Prefix64(bad)]).toEqual([bad, null]);
    }
    expect(clientKey('999.1.1.1')).toBe('x:999.1.1.1');
    expect(clientKey('proxy.internal'.repeat(10))).toBe(`x:${'proxy.internal'.repeat(10).slice(0, 64)}`);
  });

  it('has no key without an address', () => {
    expect(clientKey(undefined)).toBeNull();
    expect(clientKey(null)).toBeNull();
    expect(clientKey('   ')).toBeNull();
  });
});
