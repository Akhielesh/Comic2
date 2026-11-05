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

  it("the host's mode decides: a draft that claims compose inside a reply still pre-fills nothing", () => {
    const r = reviewEmail({ ...doc, mode: 'compose' }, ctx('reply'));
    expect(r.prefill).toEqual({ to: [], cc: [], bcc: [] });
    expect(r.warnings.map((w) => w.code)).toEqual(['reply-recipients', 'mode-mismatch']);
  });

  for (const hostMode of ['compose', 'forward'] as const) {
    it(`a draft written as a reply while the person chose ${hostMode} fills in nothing, and the warning says so (not "your choice is used")`, () => {
      const r = reviewEmail({ ...doc, mode: 'reply' }, ctx(hostMode));
      expect(r.prefill).toEqual({ to: [], cc: [], bcc: [] });
      expect(r.flagged.map((f) => f.address)).toEqual(['attacker@evil.example', 'quoted@example.net', 'hidden@evil.example']);
      expect(r.warnings).toEqual([
        { code: 'mode-mismatch', message: 'The draft was written as a reply; to stay safe nothing was filled in. Choose recipients yourself.' },
      ]);
    });
  }

  it('a forward draft in a compose (or the reverse) keeps the choice and says so', () => {
    const r = reviewEmail({ ...doc, mode: 'forward' }, ctx('compose'));
    expect(r.prefill.to).toHaveLength(2);
    expect(r.warnings).toEqual([{ code: 'mode-mismatch', message: 'The draft was written as "forward" but you chose "compose"; your choice is used.' }]);
  });

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

  it('a participant display name with control or bidi characters is left out; the address is still pre-filled', () => {
    const d = draft('compose', [{ address: 'a@example.com' }, { address: 'b@example.com' }, { address: 'c@example.com' }, { address: 'd@example.com' }]);
    const r = reviewEmail(d, {
      mode: 'compose',
      participants: [
        { address: 'a@example.com', name: 'Pay \u202Efdp.exe' },
        { address: 'b@example.com', name: 'Null\u0000Byte' },
        { address: 'c@example.com', name: 'Esc\u001b[31m \u2066Isolate\u2069' },
        { address: 'd@example.com', name: '  Dana Clean  ' },
      ],
      userTyped: [],
    });
    expect(r.prefill.to).toEqual([{ address: 'a@example.com' }, { address: 'b@example.com' }, { address: 'c@example.com' }, { address: 'd@example.com', name: 'Dana Clean' }]);
    expect(JSON.stringify(r.prefill)).not.toMatch(/[\u0000-\u001f\u202a-\u202e\u2066-\u2069]/);
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
    expect(r.links.map((l) => l.href)).not.toContain('javascript:alert(2)');
    const unsafe = r.warnings.filter((w) => w.code === 'unsafe-link');
    expect(unsafe.map((w) => w.blockId)).toEqual(['p1', 'p1', 'p1', 'p1', 'p1', 'b1', 'b2', 'l1']);
    expect(unsafe[7].message).toBe('A link on "and a bad one" was not https: or mailto:, so it was removed.');
  });

  it('links in a heading, a quote, a list item and a list inside columns are listed exactly, in document order', () => {
    const r = reviewEmail(hostile, { mode: 'compose', participants: [], userTyped: [] });
    expect(r.links).toEqual([
      { href: 'https://docs.example.com/heading', text: 'heading link', blockId: 'h3', source: 'run' },
      { href: 'https://ok.example.com/path?a=1&b=2', text: ' fine', blockId: 'p1', source: 'run' },
      { href: 'mailto:quoted@example.org?subject=Re', text: ' quoted reply', blockId: 'q1', source: 'run' },
      { href: 'mailto:someone@evil.example?subject=hi', text: 'write to them', blockId: 'p2', source: 'run' },
      { href: 'mailto:list@example.org', text: 'column list mail', blockId: 'l2', source: 'run' },
      { href: 'https://list.example.com/item', text: 'the list link', blockId: 'l1', source: 'run' },
      { href: 'https://evil.example.net/login', text: 'https://bank.example.com', blockId: 'p3', source: 'run' },
    ]);
    // A mailto in a quote or a column list is checked like any other: nobody gave these addresses.
    const untrusted = r.warnings.filter((w) => w.code === 'mailto-untrusted').map((w) => w.blockId);
    expect(untrusted).toEqual(['q1', 'p2', 'l2']);
  });

  it('a link whose text names another site, and a mailto to an address nobody gave, are warnings', () => {
    const r = reviewEmail(hostile, { mode: 'compose', participants: [], userTyped: [] });
    expect(r.warnings).toContainEqual({ code: 'link-text-mismatch', message: '"https://bank.example.com" goes to https://evil.example.net/login.', blockId: 'p3' });
    expect(r.warnings).toContainEqual({ code: 'mailto-untrusted', message: '"write to them" starts a new email to someone@evil.example, an address you did not give.', blockId: 'p2' });
    const trusted = reviewEmail(hostile, { mode: 'compose', participants: [{ address: 'list@example.org' }], userTyped: ['someone@evil.example', 'quoted@example.org'] });
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

  it('addressesIn is linear: 100,000 characters without an address is quick', () => {
    const started = Date.now();
    expect(addressesIn('a'.repeat(100000))).toEqual([]);
    expect(addressesIn(`${'a.'.repeat(50000)}@`)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('addressesIn is linear on a long run of dots next to an @ (no /[.]+$/ backtracking)', () => {
    for (const text of [`@${'.'.repeat(99998)}x`, `a@b${'.'.repeat(99990)}x`, `${'.'.repeat(99980)}a@b.example${'.'.repeat(9)}`]) {
      const started = Date.now();
      const found = addressesIn(text);
      expect(Date.now() - started).toBeLessThan(100);
      expect(found).toEqual(text.charAt(0) === '.' ? ['a@b.example'] : []);
    }
    expect(addressesIn('Write to ...jane@example.com... today')).toEqual(['jane@example.com']);
  });
});

describe('nothing can send', () => {
  it('the email module exports no send, deliver, dispatch or post function', () => {
    const names = Object.keys(emailModule);
    expect(names.length).toBeGreaterThan(10);
    for (const n of names) expect(n).not.toMatch(/send|deliver|dispatch|post_?message|smtp|transport/i);
  });
});
