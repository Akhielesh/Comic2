// @vitest-environment node
//
// Fingerprints and audit events (plan §5.10; W1.4): the pure SHA-256 / HMAC / base64url agree with node:crypto on
// random and golden inputs; canonical JSON makes a hash independent of key order; an audit event keeps ids, the
// decision and a hash — never content — and DreamStream files security decisions in audit_log only.
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AuditEventError,
  auditEvent,
  base64urlDecode,
  base64urlEncode,
  canonicalJson,
  dreamstreamAuditSink,
  hmacSha256Hex,
  inputHash,
  sha256Hex,
  timingSafeEqual,
  utf8Bytes,
  utf8Decode,
} from './index.js';
import { seededRandom } from '../testing/conformance.js';

const randomText = (rnd: () => number, n: number): string => {
  let out = '';
  for (let i = 0; i < n; i++) {
    const r = rnd();
    // ASCII, Latin-1, BMP (Telugu), astral (emoji) and the odd lone surrogate
    out += r < 0.5 ? String.fromCharCode(32 + Math.floor(rnd() * 95)) : r < 0.7 ? 'é' : r < 0.85 ? 'తె' : r < 0.97 ? '😀' : '\ud800';
  }
  return out;
};

describe('digests', () => {
  it('SHA-256 matches FIPS 180-2 vectors and node:crypto on 300 random inputs (block boundaries included)', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    const rnd = seededRandom(7);
    for (let i = 0; i < 300; i++) {
      const text = randomText(rnd, i < 130 ? i : Math.floor(rnd() * 5000));
      expect(sha256Hex(text), JSON.stringify(text.slice(0, 20))).toBe(createHash('sha256').update(Buffer.from(new TextEncoder().encode(text))).digest('hex'));
    }
  });

  it('HMAC-SHA256 matches RFC 4231 and node:crypto, including keys longer than a block', () => {
    expect(hmacSha256Hex('\u000b'.repeat(20), 'Hi There')).toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
    const rnd = seededRandom(11);
    for (let i = 0; i < 100; i++) {
      const key = randomText(rnd, Math.floor(rnd() * 150));
      const msg = randomText(rnd, Math.floor(rnd() * 300));
      expect(hmacSha256Hex(key, msg)).toBe(createHmac('sha256', Buffer.from(new TextEncoder().encode(key))).update(Buffer.from(new TextEncoder().encode(msg))).digest('hex'));
    }
  });

  it('UTF-8 and base64url round-trip and agree with the platform encoders; malformed input is refused', () => {
    const rnd = seededRandom(3);
    for (let i = 0; i < 200; i++) {
      const text = randomText(rnd, Math.floor(rnd() * 60));
      const bytes = utf8Bytes(text);
      expect(Array.from(bytes)).toEqual(Array.from(new TextEncoder().encode(text)));
      expect(utf8Decode(bytes)).toBe(new TextDecoder().decode(bytes));
      expect(base64urlEncode(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
      expect(Array.from(base64urlDecode(base64urlEncode(bytes))!)).toEqual(Array.from(bytes));
    }
    for (const bad of ['a', 'ab=', 'a+b/', 'abc!', 'AB']) expect(base64urlDecode(bad), bad).toBeNull(); // 'AB' has non-zero trailing bits
    expect(utf8Decode(new Uint8Array([0xc0, 0x80]))).toBeNull(); // overlong
    expect(utf8Decode(new Uint8Array([0xed, 0xa0, 0x80]))).toBeNull(); // a surrogate
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('canonicalJson and inputHash', () => {
  it('does not depend on key order, follows JSON value rules, and refuses cycles', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, undefined, () => 1], c: 'x' }, u: undefined })).toBe('{"a":{"c":"x","d":[1,null,null]},"b":1}');
    expect(inputHash({ b: 1, a: 2 })).toBe(inputHash({ a: 2, b: 1 }));
    expect(inputHash({ a: 2, b: 1 })).not.toBe(inputHash({ a: 2, b: 2 }));
    expect(inputHash({ x: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(canonicalJson(NaN)).toBe('null');
    expect(canonicalJson(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"');
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(TypeError);
    let deep: unknown = 1;
    for (let i = 0; i < 300; i++) deep = [deep];
    expect(() => canonicalJson(deep)).toThrow(TypeError);
  });
});

describe('audit events are content-free', () => {
  const base = {
    id: 'evt-1',
    at: 1793610000000,
    app: 'dreamstream',
    product: 'chat',
    actor: { kind: 'agent' as const, id: 'user-1' },
    tool: 'email_draft',
    decision: 'auto' as const,
    inputHash: inputHash({ subject: 'Secret' }),
    opIds: ['op-1', 'not an id!', 'op-2'],
    outcome: 'ok' as const,
  };

  it('keeps ids, the decision and a hash; drops everything else', () => {
    const e = auditEvent({ ...base, subject: 'Secret plans', body: 'text', to: ['ana@example.com'] } as never);
    expect(e).toEqual({ ...base, kind: 'call', opIds: ['op-1', 'op-2'] });
    expect(JSON.stringify(e)).not.toMatch(/Secret|ana@example/);
  });

  it('drops a malformed optional field and throws on a malformed required one', () => {
    const e = auditEvent({ ...base, tool: 'a tool with spaces and content', costMicros: -5, errorCode: 'x'.repeat(200), engine: 'pdfcraft@0.15.0' });
    expect(e.tool).toBeUndefined();
    expect(e.costMicros).toBeUndefined();
    expect(e.errorCode).toBeUndefined();
    expect(e.engine).toBe('pdfcraft@0.15.0');
    expect(() => auditEvent({ ...base, inputHash: 'the whole input' })).toThrow(AuditEventError);
    expect(() => auditEvent({ ...base, decision: 'maybe' as never })).toThrow(AuditEventError);
    expect(() => auditEvent({ ...base, id: 'has spaces' })).toThrow(AuditEventError);
  });

  it('files DreamStream events: security decisions to audit_log, paid calls to cost metadata, the rest to a log line', () => {
    expect(dreamstreamAuditSink(auditEvent({ ...base, decision: 'blocked', outcome: 'refused' }))).toEqual({ sink: 'audit_log', action: 'platform.guard.blocked' });
    expect(dreamstreamAuditSink(auditEvent({ ...base, kind: 'consent', decision: 'confirmed' }))).toEqual({ sink: 'audit_log', action: 'platform.consent.recorded' });
    expect(dreamstreamAuditSink(auditEvent({ ...base, kind: 'toggle', actor: { kind: 'user' } }))).toEqual({ sink: 'audit_log', action: 'platform.capability.toggled' });
    expect(dreamstreamAuditSink(auditEvent({ ...base, costMicros: 2000 }))).toEqual({ sink: 'cost_metadata' });
    expect(dreamstreamAuditSink(auditEvent(base))).toEqual({ sink: 'log' });
  });
});
