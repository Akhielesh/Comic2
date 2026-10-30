// @vitest-environment node
//
// The nine built-in templates (plan §7, W1.3): every template validates, with its example values, with every slot at
// its cap, and with only its required slots; slot values are typed and checked; a value is never spliced into a URL
// and never re-expanded; templates never name recipients.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { EMAIL_LIMITS, type EmailDoc } from '../contract/email.js';
import { MODEL_LIMITS, type Infer, type Schema } from '../contract/schema.js';
import { check } from '../schema/check.js';
import { toJsonSchema } from '../schema/jsonSchema.js';
import { s } from '../schema/s.js';
import {
  EMAIL_TEMPLATES,
  EMAIL_TEMPLATE_IDS,
  SLOT_PATTERN,
  TemplateDefinitionError,
  emailToPlainText,
  fillEmailTemplate,
  fillTemplate,
  type EmailTemplate,
  type EmailTemplateSlots,
} from './index.js';

// The EmailDoc schema (without attachments, which templates never carry), written against the frozen contract: its
// Infer type must equal the contract type, so it cannot drift. Once W1.2's models land, this is the models' schema.
const E = EMAIL_LIMITS;
const id = s.id();
const run = s.object({
  text: s.text({ max: MODEL_LIMITS.runText }),
  marks: s.optional(s.array(s.enum(['b', 'i', 'u', 'code']), { max: MODEL_LIMITS.marks })),
  link: s.optional(s.object({ href: s.link() })),
});
const runs = s.array(run, { max: E.runsPerBlock });
const leaf = [
  s.object({ type: s.literal('heading'), id, level: s.enum([1, 2, 3]), runs }),
  s.object({ type: s.literal('paragraph'), id, runs }),
  s.object({ type: s.literal('list'), id, ordered: s.bool(), items: s.array(s.object({ runs, indent: s.optional(s.int({ min: 0, max: MODEL_LIMITS.listIndentMax })) }), { max: E.listItems }) }),
  s.object({ type: s.literal('button'), id, label: s.text({ max: E.buttonLabel, singleLine: true }), href: s.link() }),
  s.object({ type: s.literal('quote'), id, runs, cite: s.optional(s.text({ max: E.cite })) }),
  s.object({ type: s.literal('divider'), id }),
  s.object({ type: s.literal('image'), id, ref: s.assetRef(), alt: s.text({ max: MODEL_LIMITS.alt }), width: s.optional(s.int({ min: E.imageWidthMin, max: E.imageWidthMax })) }),
] as const;
const block = s.union('type', [...leaf, s.object({ type: s.literal('columns'), id, columns: s.array(s.object({ blocks: s.array(s.union('type', leaf), { max: E.blocksPerColumn }) }), { max: E.columns }) })]);
const recipients = s.array(s.object({ address: s.email(), name: s.optional(s.text({ max: E.recipientName, singleLine: true })) }), { max: E.recipients });
const EmailDocS = s.object({
  v: s.literal(1),
  rev: s.optional(s.int({ min: 0 })),
  mode: s.enum(['compose', 'reply', 'reply-all', 'forward']),
  subject: s.text({ max: E.subject, singleLine: true }),
  preheader: s.optional(s.text({ max: E.preheader, singleLine: true })),
  to: recipients,
  cc: s.optional(recipients),
  bcc: s.optional(recipients),
  blocks: s.array(block, { max: E.blocks }),
  signature: s.optional(s.text({ max: E.field })),
  brand: s.optional(id),
});

const valid = (doc: EmailDoc): void => {
  const r = check(EmailDocS, doc);
  expect(r.errors).toBeUndefined();
  expect(emailToPlainText(doc).length).toBeLessThanOrEqual(E.field);
  expect(JSON.stringify(doc)).not.toMatch(/\{\{/);
};

const strings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) strings((v as Record<string, unknown>)[k], out);
  return out;
};
const slotsIn = (v: unknown): string[] => {
  const out: string[] = [];
  const re = new RegExp(SLOT_PATTERN.source, 'g');
  for (const str of strings(v)) {
    re.lastIndex = 0;
    for (let m = re.exec(str); m; m = re.exec(str)) if (out.indexOf(m[1]) === -1) out.push(m[1]);
  }
  return out;
};

type Field = { kind: string; max?: number; singleLine?: boolean; inner?: Field };
const fieldsOf = (t: EmailTemplate): Record<string, Field> => t.slots.fields as unknown as Record<string, Field>;
const innerOf = (f: Field): Field => (f.kind === 'optional' && f.inner ? f.inner : f);
const atCap = (f: Field): string => {
  const inner = innerOf(f);
  if (inner.kind === 'link') return `https://example.com/${'a'.repeat(2048 - 'https://example.com/'.length)}`;
  return 'x'.repeat(inner.max ?? 1);
};

describe('the nine templates', () => {
  it('are exactly the ones plan §7 names', () => {
    expect([...EMAIL_TEMPLATE_IDS]).toEqual(['reply', 'follow_up', 'intro', 'meeting_recap', 'quote_cover_note', 'invoice_nudge', 'comic_gift_reveal', 'creator_pitch', 'creator_launch']);
    expect(Object.keys(EMAIL_TEMPLATES).sort()).toEqual([...EMAIL_TEMPLATE_IDS].sort());
  });

  for (const tid of EMAIL_TEMPLATE_IDS) {
    describe(tid, () => {
      const t = EMAIL_TEMPLATES[tid] as unknown as EmailTemplate;
      const fields = fieldsOf(t);

      it('validates with its example values', () => {
        expect(t.id).toBe(tid);
        expect(check(t.slots, t.example).ok).toBe(true);
        const r = fillTemplate(tid, t.example as never);
        expect(r.errors).toBeUndefined();
        valid(r.doc as EmailDoc);
        expect(r.doc?.mode).toBe(t.mode);
      });

      it('validates with every slot at its cap (caps cannot overflow a field)', () => {
        const values: Record<string, string> = {};
        for (const k of Object.keys(fields)) values[k] = atCap(fields[k]);
        const r = fillTemplate(tid, values);
        expect(r.errors).toBeUndefined();
        valid(r.doc as EmailDoc);
      });

      it('validates with only its required slots, dropping the optional blocks', () => {
        const values: Record<string, string> = {};
        for (const k of Object.keys(fields)) if (fields[k].kind !== 'optional') values[k] = (t.example as Record<string, string>)[k];
        const r = fillTemplate(tid, values);
        expect(r.errors).toBeUndefined();
        valid(r.doc as EmailDoc);
        for (const blockId of Object.keys(t.optionalBlocks ?? {})) expect(r.doc?.blocks.map((b) => b.id)).not.toContain(blockId);
      });

      it('names no recipients and uses exactly the slots it declares', () => {
        expect(t.doc.to).toEqual([]);
        expect(t.doc.cc).toBeUndefined();
        expect(t.doc.bcc).toBeUndefined();
        expect(slotsIn(t.doc).sort()).toEqual(Object.keys(fields).sort());
      });

      it('an optional slot appears only inside the blocks it drops; subject-like fields use single-line slots', () => {
        const opt = t.optionalBlocks ?? {};
        for (const k of Object.keys(fields).filter((x) => fields[x].kind === 'optional')) {
          expect(slotsIn({ subject: t.doc.subject, preheader: t.doc.preheader, signature: t.doc.signature })).not.toContain(k);
          for (const b of t.doc.blocks) if (slotsIn(b).indexOf(k) !== -1) expect(opt[b.id], `${k} in ${b.id}`).toBe(k);
        }
        for (const k of slotsIn([t.doc.subject, t.doc.preheader ?? ''])) expect(innerOf(fields[k]).singleLine, k).toBe(true);
        for (const k of Object.keys(opt)) expect(t.doc.blocks.map((b) => b.id)).toContain(k);
      });

      it('an href is a fixed https: link or exactly one s.link() slot', () => {
        for (const b of t.doc.blocks) {
          if (b.type !== 'button') continue;
          const m = /^\{\{([a-z][a-z0-9_]*)\}\}$/.exec(b.href);
          if (m) expect(innerOf(fields[m[1]]).kind).toBe('link');
          else expect(b.href).toMatch(/^https:\/\/[^{}]+$/);
        }
      });

      it('its slots project to the flattened llm JSON Schema', () => {
        const j = toJsonSchema(t.slots as Schema, { target: 'llm' }) as { properties: Record<string, unknown>; required: string[] };
        expect(Object.keys(j.properties).sort()).toEqual(Object.keys(fields).sort());
        expect(j.required.sort()).toEqual(Object.keys(fields).filter((k) => fields[k].kind !== 'optional').sort());
      });
    });
  }
});

describe('slot values are typed and checked', () => {
  const gift = EMAIL_TEMPLATES.comic_gift_reveal.example;

  it('the slot types come from the schemas', () => {
    expectTypeOf<EmailTemplateSlots['intro']>().toEqualTypeOf<{ person_a: string; a_context: string; person_b: string; b_context: string; reason: string; sender_name: string }>();
    expectTypeOf<EmailTemplateSlots['invoice_nudge']['pay_link']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Infer<typeof EmailDocS>>().toEqualTypeOf<Omit<EmailDoc, 'attachments'>>();
  });

  it('a javascript:, http: or data: link value is refused at its slot', () => {
    for (const bad of ['javascript:alert(1)', 'http://comics.example.com/s/x', 'data:text/html,hi', 'https://user@evil.example/']) {
      expect(fillTemplate('comic_gift_reveal', { ...gift, comic_link: bad })).toMatchObject({ ok: false, errors: [{ path: 'comic_link', code: 'link' }] });
    }
  });

  it('missing, unknown, multi-line and over-long values are errors at their path', () => {
    const { comic_link: _drop, ...noLink } = gift;
    expect(fillTemplate('comic_gift_reveal', noLink as never)).toMatchObject({ ok: false, errors: [{ path: 'comic_link', code: 'required' }] });
    expect(fillTemplate('comic_gift_reveal', { ...gift, to: 'x@evil.example' } as never)).toMatchObject({ ok: false, errors: [{ path: 'to', code: 'unknown-key' }] });
    expect(fillTemplate('comic_gift_reveal', { ...gift, comic_title: 'a\nBcc: x@evil.example' })).toMatchObject({ ok: false, errors: [{ path: 'comic_title', code: 'single-line' }] });
    expect(fillTemplate('comic_gift_reveal', { ...gift, message: 'x'.repeat(1001) })).toMatchObject({ ok: false, errors: [{ path: 'message', code: 'too-long' }] });
    expect(fillTemplate('comic_gift_reveal', { ...gift, recipient_name: '' })).toMatchObject({ ok: false, errors: [{ path: 'recipient_name', code: 'too-short' }] });
    expect(fillTemplate('nope', {})).toMatchObject({ ok: false, errors: [{ path: '', code: 'enum' }] });
    expect(fillTemplate('comic_gift_reveal', JSON.parse(`{"__proto__": "x", "recipient_name": "A"}`))).toMatchObject({ ok: false });
  });

  it('an empty optional value counts as absent and drops its block', () => {
    const r = fillTemplate('invoice_nudge', { ...EMAIL_TEMPLATES.invoice_nudge.example, pay_link: '  ' } as never);
    expect(r.errors).toBeUndefined();
    expect(r.doc?.blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph', 'paragraph', 'paragraph']);
  });

  it('filling is one pass: a value that looks like a placeholder stays literal', () => {
    const r = fillTemplate('intro', { ...EMAIL_TEMPLATES.intro.example, reason: '{{sender_name}} says {{nope}}' });
    expect(JSON.stringify(r.doc)).toContain('{{sender_name}} says {{nope}}');
  });

  it('values are copied, never shared with the template', () => {
    const r = fillTemplate('reply', EMAIL_TEMPLATES.reply.example);
    (r.doc as EmailDoc).blocks.length = 0;
    expect(EMAIL_TEMPLATES.reply.doc.blocks.length).toBeGreaterThan(0);
    expect(EMAIL_TEMPLATES.reply.doc.subject).toBe('Re: {{topic}}');
  });
});

describe('a malformed template is refused', () => {
  const base = EMAIL_TEMPLATES.comic_gift_reveal as unknown as EmailTemplate;
  const withHref = (href: string): EmailTemplate => ({ ...base, doc: { ...base.doc, blocks: [{ type: 'button', id: 'b1', label: 'Go', href }] } });

  it('a placeholder spliced into a URL throws', () => {
    expect(() => fillEmailTemplate(withHref('https://comics.example.com/{{recipient_name}}'), base.example)).toThrow(TemplateDefinitionError);
  });

  it('an href slot that is not s.link() throws', () => {
    expect(() => fillEmailTemplate(withHref('{{message}}'), base.example)).toThrow(TemplateDefinitionError);
  });

  it('a fixed https: href passes through', () => {
    expect(fillEmailTemplate(withHref('https://comics.example.com/'), base.example).doc?.blocks[0]).toMatchObject({ href: 'https://comics.example.com/' });
  });
});
