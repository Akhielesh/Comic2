// @vitest-environment node
//
// EmailDoc v1 (plan §5.2, §7, W1.2): 101 recipients, 10,001-character fields and a plain-text body over 10,000
// characters are refused; an agent can never change recipients (an agent-stamped or unstamped set_recipients is
// forbidden, and stampAgentEmailOp cannot produce one); set_recipients replaces to/cc/bcc together (absent clears);
// block ops reach top-level blocks only; attach honours index and detach inverts to attach at the old index; every
// batch has an exact inverse.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toJsonSchema } from '../../schema/index.js';
import type { AttachmentSpec, EmailBlock, EmailDoc, EmailOp, EmailParagraph, EmailRecipient } from './index.js';
import {
  AgentEmailOpSchema,
  EMAIL_LIMITS,
  EMAIL_TEXT_ALLOWANCE,
  applyEmailOps,
  checkEmailDoc,
  checkEmailOp,
  emailBodyTextLength,
  invertEmailOp,
  invertEmailOps,
  listPrefixWidth,
  migrateEmailDoc,
  stampAgentEmailOp,
} from './index.js';

const fixture = <T = unknown>(name: string): T => JSON.parse(readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), 'utf8')) as T;

const minimal = (): EmailDoc => fixture<EmailDoc>('contract/email/minimal.json');
const full = (): EmailDoc => fixture<EmailDoc>('contract/email/full.json');
const reply = (): EmailDoc => fixture<EmailDoc>('contract/email/reply.json');
const contractOps = (): EmailOp[] => fixture<EmailOp[]>('contract/email/ops.json');

const content = (doc: EmailDoc): Omit<EmailDoc, 'rev'> => {
  const out = { ...doc };
  delete out.rev;
  return out;
};

const undoIds = (op: EmailOp, i: number) => `undo-${i}-${op.id}`.slice(0, 64);

const roundTrip = (doc: EmailDoc, ops: EmailOp[]) => {
  const forward = applyEmailOps(doc, ops);
  const undo = invertEmailOps(doc, forward.applied, { baseRev: forward.doc.rev ?? 0, id: undoIds });
  expect(undo).not.toBeNull();
  const back = applyEmailOps(forward.doc, undo!);
  expect(back.rejected).toEqual([]);
  expect(content(back.doc)).toEqual(content(doc));
  return forward;
};

const people = (n: number, domain = 'example.com'): EmailRecipient[] => {
  const out: EmailRecipient[] = [];
  for (let i = 0; i < n; i++) out.push({ address: `person${i}@${domain}` });
  return out;
};

const para = (id: string, text: string): EmailParagraph => ({ type: 'paragraph', id, runs: [{ text }] });

const attachment = (id: string, kind: 'docx' | 'pdf' | 'pptx' = 'pdf'): AttachmentSpec =>
  kind === 'pptx'
    ? { id, name: `Deck ${id}`, kind, spec: { type: 'deck', deck: { v: 1, title: id, size: '16:9', theme: { preset: 'light' }, slides: [] } } }
    : { id, name: `Doc ${id}`, kind, spec: { type: 'doc', doc: { v: 1, title: id, sections: [] } } };

describe('EmailDoc schema', () => {
  it('accepts every contract fixture as it is, and migrate() reads v1 into the same email', () => {
    for (const doc of [minimal(), full(), reply()]) {
      expect(checkEmailDoc(doc)).toEqual({ ok: true, value: doc });
      expect(migrateEmailDoc(doc)).toEqual({ ok: true, value: doc });
    }
    for (const op of contractOps()) expect(checkEmailOp(op)).toEqual({ ok: true, value: op });
    expect(migrateEmailDoc({ ...minimal(), v: 0 })).toMatchObject({ ok: false, errors: [{ path: 'v', code: 'literal' }] });
  });

  it('refuses 101 recipients in to, cc or bcc (100 is fine)', () => {
    for (const field of ['to', 'cc', 'bcc'] as const) {
      expect(checkEmailDoc({ ...minimal(), [field]: people(100) }).ok).toBe(true);
      expect(checkEmailDoc({ ...minimal(), [field]: people(101) })).toMatchObject({ ok: false, errors: [{ path: field, code: 'too-many' }] });
    }
    const op = { op: 'set_recipients', id: 'op-r', baseRev: 0, actor: 'user', to: people(101) };
    const r = applyEmailOps(minimal(), [op as EmailOp]);
    expect(r.rejected).toMatchObject([{ code: 'invalid', message: expect.stringContaining('to') }]);
  });

  it('refuses 10,001-character fields', () => {
    const long = 'x'.repeat(EMAIL_LIMITS.field + 1);
    expect(checkEmailDoc({ ...minimal(), signature: long })).toMatchObject({ ok: false, errors: [{ path: 'signature', code: 'too-long' }] });
    expect(checkEmailDoc({ ...minimal(), blocks: [para('p1', long)] })).toMatchObject({ ok: false, errors: [{ path: 'blocks[0].runs[0].text', code: 'too-long' }] });
    expect(checkEmailDoc({ ...minimal(), subject: 'x'.repeat(EMAIL_LIMITS.subject + 1) })).toMatchObject({ ok: false, errors: [{ path: 'subject', code: 'too-long' }] });
  });

  it('caps the WHOLE plain-text body at 10,000 characters (a refinement: no single field is over its own cap)', () => {
    const P = EMAIL_TEXT_ALLOWANCE.block;
    // Three paragraphs (4,000 + 4,000 + n characters, each with its blank line) measure exactly 10,000 when n = 1,994.
    const body = (n: number): EmailBlock[] => [para('a', 'a'.repeat(4000)), para('b', 'b'.repeat(4000)), para('c', 'c'.repeat(n))];
    const atCap = { ...minimal(), blocks: body(EMAIL_LIMITS.field - 8000 - 3 * P) };
    expect(emailBodyTextLength(atCap)).toBe(EMAIL_LIMITS.field);
    expect(checkEmailDoc(atCap).ok).toBe(true);
    const over = { ...minimal(), blocks: body(EMAIL_LIMITS.field - 8000 - 3 * P + 1) };
    expect(checkEmailDoc(over)).toMatchObject({ ok: false, errors: [{ path: 'blocks', code: 'too-long' }] });
    // The signature counts too.
    expect(checkEmailDoc({ ...atCap, signature: 'S' })).toMatchObject({ ok: false, errors: [{ path: 'blocks', code: 'too-long' }] });
  });

  it('measures the body as an upper bound on its plain-text rendering: text, hrefs, labels, alts and their layout', () => {
    const A = EMAIL_TEXT_ALLOWANCE;
    // The allowances follow emailToPlainText's layout (see EMAIL_TEXT_ALLOWANCE): pinned, so a change is deliberate.
    expect(A).toEqual({ block: 2, listItem: 10, link: 3, button: 4, image: 9, divider: 4, quote: 2, cite: 5, lineBreak: 2, signature: 4 });
    const doc: EmailDoc = {
      ...minimal(),
      blocks: [
        { type: 'paragraph', id: 'p', runs: [{ text: 'Hi ' }, { text: 'there', link: { href: 'https://example.com/a' } }] },
        { type: 'list', id: 'l', ordered: true, items: [{ runs: [{ text: 'one' }] }, { runs: [{ text: 'two\nlines' }] }] },
        { type: 'button', id: 'b', label: 'Open', href: 'https://example.com/b' },
        { type: 'quote', id: 'q', runs: [{ text: 'quoted' }], cite: 'Sam' },
        { type: 'divider', id: 'd' },
        { type: 'image', id: 'i', ref: { kind: 'asset', id: 'img/1.png' }, alt: 'A cover' },
        { type: 'columns', id: 'c', columns: [{ blocks: [para('cp', 'col')] }] },
      ],
      signature: 'Me',
    };
    const expected =
      3 + 5 + 21 + A.link + A.block + // paragraph
      (3 + A.listItem) + (9 + 3 + A.listItem) + A.block + // list: the line break in item 2 is padded to its `2. `
      4 + 21 + A.button + A.block + // button
      A.quote + 6 + 3 + A.cite + A.block + // quote
      A.divider + A.block + // divider
      7 + A.image + A.block + // image
      (3 + A.block) + A.block + // columns
      2 + A.signature; // signature
    expect(emailBodyTextLength(doc)).toBe(expected);
    expect(emailBodyTextLength({ blocks: [] })).toBe(0);
  });

  // Each case is hand-computed against the layout emailToPlainText (W1.3, src/email/plainText.ts) writes; the
  // comments give its real length, which the bound must never be under.
  it('follows the plain-text layout: list line breaks pay their item prefix, quotes their `> `, images `[Image: ]`', () => {
    expect([listPrefixWidth(false, 0, 1), listPrefixWidth(true, 0, 1), listPrefixWidth(true, 2, 9), listPrefixWidth(true, 2, 10), listPrefixWidth(true, 2, 100)]).toEqual([2, 3, 7, 8, 9]);

    // An ordered list of 100 items at indent 2, each `ab\ncd`: items 1–9 have a 7-wide prefix (`    1. `), 10–99
    // 8, item 100 9. Bound: 2 + Σ(5 + prefix + 10) = 2 + 1,500 + (9·7 + 90·8 + 9) = 2,294.
    // emailToPlainText: Σ(2·prefix + 5) + 99 line breaks = 2·792 + 500 + 99 = 2,183.
    const items = [];
    for (let i = 0; i < 100; i++) items.push({ indent: 2, runs: [{ text: 'ab\ncd' }] });
    const list: EmailDoc = { ...minimal(), blocks: [{ type: 'list', id: 'l', ordered: true, items }] };
    expect(checkEmailDoc(list).ok).toBe(true);
    expect(emailBodyTextLength(list)).toBe(2294);

    // One item `    1. ` holding 1,250 line breaks: emailToPlainText writes 7 + 1,250·8 = 10,007 characters, so the
    // bound (2 + 10 + 1,250 + 1,250·7 = 10,012) refuses it, and an agent cannot insert it either.
    const tall: EmailBlock = { type: 'list', id: 'tall', ordered: true, items: [{ indent: 2, runs: [{ text: '\n'.repeat(1250) }] }] };
    expect(emailBodyTextLength({ blocks: [tall] })).toBe(10012);
    expect(checkEmailDoc({ ...minimal(), blocks: [tall] })).toMatchObject({ ok: false, errors: [{ path: 'blocks', code: 'too-long' }] });
    const agent = stampAgentEmailOp({ op: 'insert_block', id: 'ins', baseRev: 0, block: tall });
    expect(agent.ok).toBe(true);
    expect(applyEmailOps(minimal(), [agent.value!]).rejected).toMatchObject([{ code: 'limit' }]);

    // 80 images, 40 with an empty alt and 40 with a 118-character one: bound 40·(0 + 9 + 2) + 40·(118 + 9 + 2) = 5,600.
    // emailToPlainText: 40·7 (`[Image]`) + 40·127 (`[Image: …]`) + 79·2 = 5,518.
    const images = (alt: (i: number) => string): EmailBlock[] => {
      const out: EmailBlock[] = [];
      for (let i = 0; i < 80; i++) out.push({ type: 'image', id: `i${i}`, ref: { kind: 'asset', id: 'img/1.png' }, alt: alt(i) });
      return out;
    };
    expect(emailBodyTextLength({ blocks: images((i) => (i % 2 ? 'a'.repeat(118) : '')) })).toBe(5600);
    // 80 alts of 114 measure exactly 10,000 (emailToPlainText: 80·123 + 158 = 9,998) and pass; 80 of 118 measure
    // 10,320 and are refused (emailToPlainText: 10,318, over the composer's 10,000).
    expect(emailBodyTextLength({ blocks: images(() => 'a'.repeat(114)) })).toBe(10000);
    expect(checkEmailDoc({ ...minimal(), blocks: images(() => 'a'.repeat(114)) }).ok).toBe(true);
    expect(emailBodyTextLength({ blocks: images(() => 'a'.repeat(118)) })).toBe(10320);
    expect(checkEmailDoc({ ...minimal(), blocks: images(() => 'a'.repeat(118)) })).toMatchObject({ ok: false, errors: [{ path: 'blocks', code: 'too-long' }] });

    // A multi-line quote with a cite: `> one\n> two\n>\n> three\n> — Sam` is 29 characters; the bound is
    // 2 (`> `) + 14 + 3·2 (line breaks) + 3 + 5 (`\n> — `) + 2 = 32. A cite's own line break counts like the quote's.
    const quote = (runs: string, cite?: string): EmailBlock =>
      cite === undefined ? { type: 'quote', id: 'q', runs: [{ text: runs }] } : { type: 'quote', id: 'q', runs: [{ text: runs }], cite };
    expect(emailBodyTextLength({ blocks: [quote('one\ntwo\n\nthree', 'Sam')] })).toBe(32);
    expect(emailBodyTextLength({ blocks: [quote('one\ntwo', 'Sam\nLee')] })).toBe(2 + 7 + 2 + 7 + 2 + 5 + 2);
    // 80 cited quotes of 115 characters measure exactly 10,000 (emailToPlainText: 80·123 + 158 = 9,998); at 116 they
    // are refused (emailToPlainText: 10,078).
    const quotes = (n: number): EmailBlock[] => {
      const out: EmailBlock[] = [];
      for (let i = 0; i < 80; i++) out.push({ type: 'quote', id: `q${i}`, runs: [{ text: 'q'.repeat(n) }], cite: 'c' });
      return out;
    };
    expect(emailBodyTextLength({ blocks: quotes(115) })).toBe(10000);
    expect(checkEmailDoc({ ...minimal(), blocks: quotes(115) }).ok).toBe(true);
    expect(checkEmailDoc({ ...minimal(), blocks: quotes(116) })).toMatchObject({ ok: false, errors: [{ path: 'blocks', code: 'too-long' }] });

    // Line breaks in a heading, a paragraph or the signature add nothing (they are written as they are).
    expect(emailBodyTextLength({ blocks: [para('p', 'a\nb\r\nc')], signature: 'x\ny' })).toBe(6 + 2 + 3 + 4);
  });

  it('a docx attachment needs a doc and a pptx one a deck; a pdf takes either', () => {
    const wrong = { ...attachment('a1', 'docx'), kind: 'pptx' as const };
    expect(checkEmailDoc({ ...minimal(), attachments: [wrong] })).toMatchObject({ ok: false, errors: [{ path: 'attachments[0].spec.type', code: 'tag' }] });
    expect(checkEmailDoc({ ...minimal(), attachments: [attachment('a1', 'pdf'), attachment('a2', 'pptx'), attachment('a3', 'docx')] }).ok).toBe(true);
    const op = { op: 'attach', id: 'op-a', baseRev: 0, attachment: wrong };
    expect(checkEmailOp(op)).toMatchObject({ ok: false, errors: [{ path: 'attachment.spec.type', code: 'tag' }] });
  });
});

describe('agents never change recipients', () => {
  const setTo = (actor?: string): Record<string, unknown> => {
    const op: Record<string, unknown> = { op: 'set_recipients', id: 'op-r', baseRev: 0, to: [{ address: 'evil@example.net' }] };
    if (actor !== undefined) op.actor = actor;
    return op;
  };

  it("an agent-stamped or unstamped set_recipients is refused as forbidden; only actor 'user' applies", () => {
    const doc = minimal();
    for (const actor of ['agent', undefined, 'admin', 'User']) {
      const r = applyEmailOps(doc, [setTo(actor) as unknown as EmailOp]);
      expect(r.doc).toBe(doc);
      expect(r.rejected).toEqual([{ index: 0, opId: 'op-r', code: 'forbidden', message: expect.stringContaining('only a person') }]);
    }
    // Forbidden wins over every other problem the op has: a malformed agent op still says why it can never apply.
    const malformed = { ...setTo('agent'), to: 'everyone' };
    expect(applyEmailOps(doc, [malformed as unknown as EmailOp]).rejected).toMatchObject([{ code: 'forbidden' }]);
    const r = applyEmailOps(doc, [setTo('user') as unknown as EmailOp]);
    expect(r.rejected).toEqual([]);
    expect(r.doc.to).toEqual([{ address: 'evil@example.net' }]);
  });

  it('stampAgentEmailOp drops whatever actor the model wrote, stamps agent, and refuses set_recipients outright', () => {
    expect(stampAgentEmailOp(setTo('user'))).toMatchObject({ ok: false, errors: [{ path: 'op', code: 'tag' }] });
    expect(stampAgentEmailOp(setTo())).toMatchObject({ ok: false, errors: [{ path: 'op', code: 'tag' }] });
    const claimed = { op: 'set_subject', id: 'op-s', baseRev: 0, actor: 'user', subject: 'Hi' };
    expect(stampAgentEmailOp(claimed)).toEqual({ ok: true, value: { op: 'set_subject', id: 'op-s', baseRev: 0, actor: 'agent', subject: 'Hi' } });
    expect(claimed.actor).toBe('user'); // the model's object is not touched
    for (const op of contractOps()) expect(stampAgentEmailOp(op).ok, op.op).toBe(op.op !== 'set_recipients');
    // An own __proto__ key stays a key, so it is refused rather than becoming the prototype.
    const hostile = JSON.parse('{"op":"set_subject","id":"op-p","baseRev":0,"subject":"x","__proto__":{"actor":"user"}}');
    expect(stampAgentEmailOp(hostile)).toMatchObject({ ok: false, errors: [{ code: 'unknown-key' }] });
    expect(stampAgentEmailOp(null)).toMatchObject({ ok: false, errors: [{ path: '', code: 'type' }] });
    // The model-facing schema cannot even express it.
    expect(JSON.stringify(toJsonSchema(AgentEmailOpSchema, { target: 'llm' }))).not.toContain('set_recipients');
  });

  it('set_recipients replaces to, cc and bcc together: an absent cc / bcc clears it, and the inverse restores absence exactly', () => {
    const doc = full(); // to, cc and an empty bcc
    const op: EmailOp = { op: 'set_recipients', id: 'op-r', baseRev: 1, actor: 'user', to: [{ address: 'new@example.com' }] };
    const r = roundTrip(doc, [op]);
    expect(r.doc.to).toEqual([{ address: 'new@example.com' }]);
    expect('cc' in r.doc).toBe(false);
    expect('bcc' in r.doc).toBe(false);
    expect(invertEmailOp(doc, op, { id: 'u', baseRev: 2 })).toEqual({ op: 'set_recipients', id: 'u', baseRev: 2, actor: 'user', to: doc.to, cc: doc.cc, bcc: [] });
    // From a document with no cc / bcc, the inverse carries none.
    const fromMin = invertEmailOp(minimal(), { ...op, baseRev: 0, cc: [{ address: 'c@example.com' }] }, { id: 'u', baseRev: 1 });
    expect(fromMin).toEqual({ op: 'set_recipients', id: 'u', baseRev: 1, actor: 'user', to: [] });
    roundTrip(minimal(), [{ ...op, baseRev: 0, cc: [{ address: 'c@example.com' }], bcc: [] }]);
  });
});

describe('applyEmailOps', () => {
  it('applies every contract op, and undoes each one exactly', () => {
    let doc = minimal();
    for (const op of contractOps()) {
      const r = roundTrip(doc, [{ ...op, baseRev: doc.rev ?? 0 }]);
      expect(r.rejected).toEqual([]);
      doc = r.doc;
    }
    roundTrip(minimal(), contractOps());
    roundTrip(full(), [
      { op: 'remove_block', id: 'r1', baseRev: 1, blockId: 'c1' },
      { op: 'detach', id: 'r2', baseRev: 1, attachmentId: 'a1' },
      { op: 'set_subject', id: 'r3', baseRev: 1, actor: 'agent', subject: 'Shorter subject' },
      { op: 'insert_block', id: 'r4', baseRev: 1, index: 0, block: para('p0', 'First') },
    ]);
  });

  it('a malformed op returns the SAME email object; stale and duplicate ids are refused', () => {
    const doc = full(); // rev 1
    const bad: unknown[] = [
      { op: 'insert_block', id: 'o1', baseRev: 1, block: { type: 'button', id: 'b9', label: 'Go', href: 'javascript:alert(1)' } },
      { op: 'insert_block', id: 'o2', baseRev: 1, block: { type: 'image', id: 'i9', alt: 'x', ref: { kind: 'url', url: 'https://tracker.example.net/p.gif' } } },
      { op: 'set_subject', id: 'o3', baseRev: 1, subject: 'Hi\r\nBcc: spy@example.net' },
      { op: 'send', id: 'o4', baseRev: 1 },
      { op: 'set_subject', id: 'o5', baseRev: 0, subject: 'stale' },
    ];
    const r = applyEmailOps(doc, bad as EmailOp[]);
    expect(r.doc).toBe(doc);
    expect(r.rejected.map((x) => x.code)).toEqual(['invalid', 'invalid', 'invalid', 'invalid', 'stale']);
    const twice = applyEmailOps(doc, [
      { op: 'set_subject', id: 'same', baseRev: 1, subject: 'One' },
      { op: 'set_subject', id: 'same', baseRev: 1, subject: 'Two' },
    ]);
    expect(twice.doc.subject).toBe('One');
    expect(twice.rejected).toMatchObject([{ index: 1, code: 'duplicate' }]);
    expect(applyEmailOps(twice.doc, [{ op: 'set_subject', id: 'same', baseRev: 2, subject: 'Three' }], { seenOpIds: ['same'] }).rejected).toMatchObject([{ code: 'duplicate' }]);
  });

  it('block ops reach TOP-LEVEL blocks only; a block inside columns changes through its columns block', () => {
    const doc = full();
    const inner: EmailOp[] = [
      { op: 'update_block', id: 'u1', baseRev: 1, blockId: 'p2', block: para('p2', 'changed') },
      { op: 'remove_block', id: 'u2', baseRev: 1, blockId: 'img1' },
    ];
    const r = applyEmailOps(doc, inner);
    expect(r.doc).toBe(doc);
    expect(r.rejected.map((x) => x.code)).toEqual(['not-found', 'not-found']);
    expect(r.rejected[0].message).toContain('top-level');
    // An id used inside columns is taken: a new top-level block cannot reuse it.
    expect(applyEmailOps(doc, [{ op: 'insert_block', id: 'u3', baseRev: 1, block: para('h3', 'clash') }]).rejected).toMatchObject([{ code: 'invalid' }]);
    // The columns block itself is updated whole, and undone exactly.
    const columns = doc.blocks.find((b) => b.id === 'c1')!;
    if (columns.type !== 'columns') throw new Error('fixture changed');
    const next: EmailBlock = { ...columns, columns: [columns.columns[1], { blocks: [para('p9', 'new column')] }] };
    const ok = roundTrip(doc, [{ op: 'update_block', id: 'u4', baseRev: 1, blockId: 'c1', block: next }]);
    expect(ok.doc.blocks[7]).toEqual(next);
    // Ids inside the replaced block may be reused by its replacement, never by two blocks at once.
    const twice: EmailBlock = { type: 'columns', id: 'c1', columns: [{ blocks: [para('dup', 'a')] }, { blocks: [para('dup', 'b')] }] };
    expect(applyEmailOps(doc, [{ op: 'update_block', id: 'u5', baseRev: 1, blockId: 'c1', block: twice }]).rejected).toMatchObject([{ code: 'invalid' }]);
  });

  it('attach honours index and detach inverts to attach at the OLD index; the cap and reused ids are refused', () => {
    const doc = full(); // attachments [a1, a2]
    const at0: EmailOp = { op: 'attach', id: 'x1', baseRev: 1, index: 0, attachment: attachment('a0') };
    const r = applyEmailOps(doc, [at0]);
    expect(r.doc.attachments!.map((a) => a.id)).toEqual(['a0', 'a1', 'a2']);
    const appended = applyEmailOps(doc, [{ op: 'attach', id: 'x2', baseRev: 1, attachment: attachment('a3') }]);
    expect(appended.doc.attachments!.map((a) => a.id)).toEqual(['a1', 'a2', 'a3']);
    const detachFirst: EmailOp = { op: 'detach', id: 'x3', baseRev: 1, actor: 'agent', attachmentId: 'a1' };
    expect(invertEmailOp(doc, detachFirst, { id: 'u', baseRev: 2 })).toEqual({ op: 'attach', id: 'u', baseRev: 2, actor: 'agent', index: 0, attachment: doc.attachments![0] });
    roundTrip(doc, [detachFirst]);
    roundTrip(doc, [at0, { op: 'detach', id: 'x4', baseRev: 1, attachmentId: 'a2' }]);

    const refused = applyEmailOps(doc, [
      { op: 'attach', id: 'y1', baseRev: 1, attachment: attachment('a1') },
      { op: 'attach', id: 'y2', baseRev: 1, index: 3, attachment: attachment('a9') },
      { op: 'detach', id: 'y3', baseRev: 1, attachmentId: 'nope' },
    ]);
    expect(refused.rejected.map((x) => x.code)).toEqual(['invalid', 'invalid', 'not-found']);
    const five = { ...minimal(), attachments: ['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => attachment(id)) };
    expect(applyEmailOps(five, [{ op: 'attach', id: 'z', baseRev: 0, attachment: attachment('a6') }]).rejected).toMatchObject([{ code: 'limit' }]);
  });

  it('no attachments is no field: an empty list is refused, so attach / detach and their undo are exact for every valid email', () => {
    expect(checkEmailDoc({ ...minimal(), attachments: [] })).toMatchObject({ ok: false, errors: [{ path: 'attachments', code: 'too-few' }] });
    const doc = minimal();
    const r = roundTrip(doc, [{ op: 'attach', id: 'x', baseRev: 0, attachment: attachment('a1', 'docx') }]);
    expect(r.doc.attachments).toHaveLength(1);
    const back = applyEmailOps(r.doc, [{ op: 'detach', id: 'y', baseRev: 1, attachmentId: 'a1' }]).doc;
    expect('attachments' in back).toBe(false);
    expect(checkEmailDoc(back).ok).toBe(true);

    // Every valid starting point (no field, then 1–4 attachments): attach at every position and appended, and detach
    // each attachment; every result is valid and its undo gives back the very same email, key for key.
    const exact = (before: EmailDoc, op: EmailOp) => {
      const forward = applyEmailOps(before, [op]);
      expect(forward.rejected).toEqual([]);
      expect(checkEmailDoc(forward.doc).ok).toBe(true);
      const undo = invertEmailOps(before, forward.applied, { baseRev: forward.doc.rev ?? 0, id: undoIds });
      const restored = applyEmailOps(forward.doc, undo!).doc;
      expect(content(restored)).toStrictEqual(content(before));
      expect('attachments' in restored).toBe('attachments' in before);
    };
    for (let n = 0; n <= EMAIL_LIMITS.attachments - 1; n++) {
      const list: AttachmentSpec[] = [];
      for (let i = 0; i < n; i++) list.push(attachment(`a${i}`, (['docx', 'pdf', 'pptx'] as const)[i % 3]));
      const before: EmailDoc = n ? { ...minimal(), attachments: list } : minimal();
      expect(checkEmailDoc(before).ok).toBe(true);
      for (let index = 0; index <= n; index++) exact(before, { op: 'attach', id: `at-${index}`, baseRev: 0, index, attachment: attachment('new') });
      exact(before, { op: 'attach', id: 'at-end', baseRev: 0, attachment: attachment('new', 'pptx') });
      for (const a of list) exact(before, { op: 'detach', id: `de-${a.id}`, baseRev: 0, attachmentId: a.id });
    }
  });

  it('a block op may not take the plain-text body past 10,000 characters, but may shrink an over-long one', () => {
    let doc = minimal();
    const big = 'w'.repeat(3990);
    let refused = 0;
    for (let i = 0; i < 4; i++) {
      const r = applyEmailOps(doc, [{ op: 'insert_block', id: `b${i}`, baseRev: doc.rev ?? 0, block: para(`big${i}`, big) }]);
      if (r.rejected.length) {
        refused++;
        expect(r.rejected).toMatchObject([{ code: 'limit', message: expect.stringContaining(String(EMAIL_LIMITS.field)) }]);
        expect(r.doc).toBe(doc);
      }
      doc = r.doc;
    }
    expect(refused).toBe(2);
    expect(emailBodyTextLength(doc)).toBeLessThanOrEqual(EMAIL_LIMITS.field);
    // A stored email that is already over the cap (it skipped checkEmailDoc) can still be cut down.
    const over: EmailDoc = { ...minimal(), blocks: [para('a', 'a'.repeat(4000)), para('b', 'b'.repeat(4000)), para('c', 'c'.repeat(4000))] };
    expect(applyEmailOps(over, [{ op: 'update_block', id: 'cut', baseRev: 0, blockId: 'c', block: para('c', 'short') }]).rejected).toEqual([]);
    expect(applyEmailOps(over, [{ op: 'insert_block', id: 'more', baseRev: 0, block: para('d', 'more') }]).rejected).toMatchObject([{ code: 'limit' }]);
  });

  it('random batches (seeded) always apply in full and always come back exactly', () => {
    let seed = 0xe3a11;
    const rnd = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)];
    let n = 0;
    const fresh = () => `z${++n}`;
    const block = (id: string): EmailBlock =>
      pick<EmailBlock>([
        para(id, `text ${id}`),
        { type: 'button', id, label: `Go ${id}`, href: 'https://example.com/go' },
        { type: 'divider', id },
        { type: 'columns', id, columns: [{ blocks: [para(fresh(), 'left')] }, { blocks: [{ type: 'quote', id: fresh(), runs: [{ text: 'right' }] }] }] },
      ]);
    const recipients = () => people(Math.floor(rnd() * 3), pick(['example.com', 'example.org']));
    const nextOp = (doc: EmailDoc): EmailOp => {
      const base = { id: fresh(), baseRev: doc.rev ?? 0, ...(rnd() < 0.5 ? { actor: pick(['user', 'agent'] as const) } : {}) };
      const list = doc.attachments || [];
      const kinds = ['set_subject', 'set_recipients', 'insert_block', 'insert_block'];
      if (doc.blocks.length) kinds.push('update_block', 'remove_block');
      if (list.length < EMAIL_LIMITS.attachments) kinds.push('attach');
      if (list.length) kinds.push('detach');
      switch (pick(kinds)) {
        case 'set_subject':
          return { op: 'set_subject', ...base, subject: `Subject ${fresh()}` };
        case 'set_recipients': {
          const op: EmailOp = { op: 'set_recipients', id: base.id, baseRev: base.baseRev, actor: 'user', to: recipients() };
          if (rnd() < 0.5) op.cc = recipients();
          if (rnd() < 0.5) op.bcc = recipients();
          return op;
        }
        case 'insert_block':
          return { op: 'insert_block', ...base, index: Math.floor(rnd() * (doc.blocks.length + 1)), block: block(fresh()) };
        case 'update_block': {
          const id = pick(doc.blocks).id;
          return { op: 'update_block', ...base, blockId: id, block: block(id) };
        }
        case 'remove_block':
          return { op: 'remove_block', ...base, blockId: pick(doc.blocks).id };
        case 'attach':
          return { op: 'attach', ...base, ...(rnd() < 0.7 ? { index: Math.floor(rnd() * (list.length + 1)) } : {}), attachment: attachment(fresh(), pick(['docx', 'pdf', 'pptx'] as const)) };
        default:
          return { op: 'detach', ...base, attachmentId: pick(list).id };
      }
    };
    let doc = full();
    for (let round = 0; round < 150; round++) {
      const batch: EmailOp[] = [];
      let scratch = doc;
      for (let k = 0, size = 1 + Math.floor(rnd() * 5); k < size; k++) {
        const op = nextOp(scratch);
        scratch = applyEmailOps(scratch, [op]).doc;
        batch.push({ ...op, baseRev: doc.rev ?? 0 });
      }
      const r = roundTrip(doc, batch);
      expect(r.rejected).toEqual([]);
      expect(content(r.doc)).toEqual(content(scratch));
      expect(checkEmailDoc(r.doc).ok).toBe(true);
      doc = r.doc;
    }
  });
});
