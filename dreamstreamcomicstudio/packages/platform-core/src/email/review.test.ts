// @vitest-environment node
//
// reviewEmail (plan §7, §9, W1.3): a model-only address is flagged and absent from the prefill; the reply modes give
// an empty prefill; every href is listed in `links` with its full URL; pasted addresses are never trusted on that
// basis; names in the prefill come from the thread, never from the model; and nothing in the email module can send.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { EmailDoc, EmailMode, EmailReviewContext } from '../contract/email.js';
import * as emailModule from './index.js';
import { EMAIL_WARNING_CODES, addressesIn, mailtoRecipients, reviewEmail } from './index.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const load = (rel: string): EmailDoc => JSON.parse(readFileSync(FIXTURES + rel, 'utf8')) as EmailDoc;
const full = load('contract/email/full.json');
const hostile = load('email/hostile.json');

const draft = (mode: EmailMode, to: EmailDoc['to'], cc?: EmailDoc['cc'], bcc?: EmailDoc['bcc']): EmailDoc => {
  const d: EmailDoc = { v: 1, mode, subject: 'Hello', to, blocks: [{ type: 'paragraph', id: 'p1', runs: [{ text: 'Hi' }] }] };
  if (cc) d.cc = cc;
  if (bcc) d.bcc = bcc;
  return d;
};

const ctx = (mode: EmailMode, extra: Partial<EmailReviewContext> = {}): EmailReviewContext => ({
  mode,
  participants: [{ address: 'Sam@Example.com', name: 'Sam Editor' }],
  userTyped: ['typed@example.org'],
  ...extra,
});

describe('recipients', () => {
  const doc = draft(
    'compose',
    [{ address: 'sam@example.com', name: 'Totally Sam' }, { address: 'typed@example.org' }, { address: 'attacker@evil.example', name: 'IT Desk' }],
    [{ address: 'quoted@example.net' }],
    [{ address: 'hidden@evil.example' }]
  );

  it('a model-only address is flagged and absent from the prefill', () => {
    const r = reviewEmail(doc, ctx('compose', { pasted: ['quoted@example.net'] }));
    const prefilled = [...r.prefill.to, ...r.prefill.cc, ...r.prefill.bcc].map((x) => x.address.toLowerCase());
    expect(prefilled).not.toContain('attacker@evil.example');
    expect(prefilled).not.toContain('hidden@evil.example');
    expect(r.flagged).toEqual([
      { address: 'attacker@evil.example', name: 'IT Desk', field: 'to', reason: 'model-only' },
      { address: 'quoted@example.net', field: 'cc', reason: 'pasted' },
      { address: 'hidden@evil.example', field: 'bcc', reason: 'model-only' },
    ]);
  });

  it('participants and user-typed addresses are pre-filled, matched case-insensitively, named only by the thread', () => {
    const r = reviewEmail(doc, ctx('compose'));
    expect(r.prefill).toEqual({ to: [{ address: 'sam@example.com', name: 'Sam Editor' }, { address: 'typed@example.org' }], cc: [], bcc: [] });
    expect(JSON.stringify(r.prefill)).not.toContain('Totally Sam');
  });

  it('forward pre-fills like compose', () => {
    expect(reviewEmail({ ...doc, mode: 'forward' }, ctx('forward')).prefill.to).toHaveLength(2);
  });

  for (const mode of ['reply', 'reply-all'] as const) {
    it(`${mode} gives an empty prefill, still flags a model-only address, and says why`, () => {
      const r = reviewEmail({ ...doc, mode }, ctx(mode));
      expect(r.prefill).toEqual({ to: [], cc: [], bcc: [] });
      expect(r.flagged.map((f) => f.address)).toEqual(['attacker@evil.example', 'quoted@example.net', 'hidden@evil.example']);
      expect(r.warnings.map((w) => w.code)).toContain('reply-recipients');
    });
  }

  it('an address the user pasted from the thread is not trusted, even if also extracted as typed; a participant stays trusted', () => {
    const d = draft('compose', [{ address: 'quoted@example.net' }, { address: 'sam@example.com' }]);
    const r = reviewEmail(d, ctx('compose', { userTyped: ['quoted@example.net'], pasted: ['quoted@example.net', 'sam@example.com'] }));
    expect(r.prefill.to).toEqual([{ address: 'sam@example.com', name: 'Sam Editor' }]);
    expect(r.flagged).toEqual([{ address: 'quoted@example.net', field: 'to', reason: 'pasted' }]);
  });

  it('with no context at all, nothing is trusted', () => {
    const r = reviewEmail(draft('compose', [{ address: 'a@example.com' }]), { mode: 'compose', participants: [], userTyped: [] });
    expect(r.prefill.to).toEqual([]);
    expect(r.flagged).toEqual([{ address: 'a@example.com', field: 'to', reason: 'model-only' }]);
  });

  it('invalid and duplicate recipients are left out with a warning', () => {
    const d = draft('compose', [{ address: 'typed@example.org' }, { address: 'Typed@Example.org' }, { address: 'not an address' }, { address: 'x@y.z, evil@e.example' }]);
    const r = reviewEmail(d, ctx('compose'));
    expect(r.prefill.to).toEqual([{ address: 'typed@example.org' }]);
    expect(r.flagged).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toEqual(['duplicate-recipient', 'invalid-recipient', 'invalid-recipient']);
  });

  it('bad context entries are ignored, never trusted', () => {
    const r = reviewEmail(draft('compose', [{ address: 'a@example.com' }]), {
      mode: 'compose',
      participants: [{ address: 'a@example.com\nBcc: x@y.example' }, null as never, { address: 7 as never }],
      userTyped: ['a@example.com, b@example.com', 9 as never],
    });
    expect(r.prefill.to).toEqual([]);
  });
});

describe('links', () => {
  it('every href is listed in links, in document order, with its text, block and source (columns included)', () => {
    const r = reviewEmail(full, { mode: 'compose', participants: [{ address: 'creator@example.com' }], userTyped: [] });
    expect(r.links).toEqual([
      { href: 'https://example.com/samples?issue=1', text: 'sample pages', blockId: 'p1', source: 'run' },
      { href: 'https://example.com/samples', text: 'Open the samples', blockId: 'b1', source: 'button' },
      { href: 'mailto:creator@example.com', text: 'me', blockId: 'p2', source: 'run' },
      { href: 'mailto:creator@example.com?subject=Lighthouse', text: 'Reply', blockId: 'b2', source: 'button' },
    ]);
    expect(r.warnings.map((w) => w.code)).toEqual(['attachments-separate']);
  });

  it('a javascript: (or otherwise unsafe) href is not listed and is reported as removed', () => {
    const r = reviewEmail(hostile, { mode: 'compose', participants: [], userTyped: [] });
    expect(r.links.map((l) => l.href)).toEqual(['https://ok.example.com/path?a=1&b=2', 'mailto:someone@evil.example?subject=hi', 'https://evil.example.net/login']);
    const unsafe = r.warnings.filter((w) => w.code === 'unsafe-link');
    expect(unsafe.map((w) => w.blockId)).toEqual(['p1', 'p1', 'p1', 'p1', 'p1', 'b1', 'b2']);
  });

  it('a link whose text names another site, and a mailto to an address nobody gave, are warnings', () => {
    const r = reviewEmail(hostile, { mode: 'compose', participants: [], userTyped: [] });
    expect(r.warnings).toContainEqual({ code: 'link-text-mismatch', message: '"https://bank.example.com" goes to https://evil.example.net/login.', blockId: 'p3' });
    expect(r.warnings).toContainEqual({ code: 'mailto-untrusted', message: '"write to them" starts a new email to someone@evil.example, an address you did not give.', blockId: 'p2' });
    const trusted = reviewEmail(hostile, { mode: 'compose', participants: [], userTyped: ['someone@evil.example'] });
    expect(trusted.warnings.map((w) => w.code)).not.toContain('mailto-untrusted');
  });

  it('link text that is an address but points elsewhere is a mismatch', () => {
    const d: EmailDoc = {
      ...draft('compose', []),
      blocks: [
        { type: 'paragraph', id: 'p1', runs: [{ text: 'boss@corp.example', link: { href: 'mailto:attacker@evil.example' } }] },
        { type: 'paragraph', id: 'p2', runs: [{ text: 'help@corp.example', link: { href: 'https://evil.example/' } }] },
        { type: 'paragraph', id: 'p3', runs: [{ text: 'example.com/docs', link: { href: 'https://www.example.com/docs' } }] },
      ],
    };
    const codes = reviewEmail(d, ctx('compose')).warnings.map((w) => `${w.code}@${w.blockId}`);
    expect(codes).toEqual(['link-text-mismatch@p1', 'mailto-untrusted@p1', 'link-text-mismatch@p2']);
  });
});

describe('the body', () => {
  it('warns when the plain text would not fit a 10,000-character composer', () => {
    const big = 'x'.repeat(3999);
    const d: EmailDoc = { ...draft('compose', []), blocks: [0, 1, 2].map((i) => ({ type: 'paragraph' as const, id: `p${i}`, runs: [{ text: big }] })) };
    expect(reviewEmail(d, ctx('compose')).warnings.map((w) => w.code)).toEqual(['body-too-long']);
    expect(EMAIL_WARNING_CODES['body-too-long']).toContain('10000');
  });

  it('never throws on garbage', () => {
    for (const d of [null, 3, {}, { to: 'x', blocks: [{ type: 'button' }] }]) {
      for (const c of [null, {}, { participants: 'x', userTyped: 3, pasted: {} }]) {
        expect(() => reviewEmail(d as unknown as EmailDoc, c as unknown as EmailReviewContext)).not.toThrow();
      }
    }
  });
});

describe('helpers', () => {
  it('mailtoRecipients reads the path only (check() allows just subject and body after the ?)', () => {
    expect(mailtoRecipients('mailto:a@example.com,b@example.org?subject=Hi&body=x')).toEqual(['a@example.com', 'b@example.org']);
    expect(mailtoRecipients('mailto:a@example.com?cc=evil@x.example')).toEqual([]);
    expect(mailtoRecipients('https://example.com')).toEqual([]);
    expect(mailtoRecipients('mailto:')).toEqual([]);
  });

  it("addressesIn finds plain addresses in the user's own text", () => {
    expect(addressesIn('Send it to Jane@Example.com and bob@team.example.org. Not "evil"@x or a@b.')).toEqual(['jane@example.com', 'bob@team.example.org']);
    expect(addressesIn('')).toEqual([]);
  });
});

describe('nothing can send', () => {
  it('the email module exports no send, deliver, dispatch or post function', () => {
    const names = Object.keys(emailModule);
    expect(names.length).toBeGreaterThan(10);
    for (const n of names) expect(n).not.toMatch(/send|deliver|dispatch|post_?message|smtp|transport/i);
  });
});
