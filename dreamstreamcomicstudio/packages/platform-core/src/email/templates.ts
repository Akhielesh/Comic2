/**
 * Built-in email templates (plan §7): EmailDoc drafts with typed `{{slot}}` placeholders.
 *
 * - Each template's `slots` is an `s.object` schema, so one definition gives the TypeScript type
 *   (`EmailTemplateSlots[id]`), the validator (`fillTemplate` runs `check()` on the values) and the JSON Schema a
 *   model is shown (`toJsonSchema(template.slots, {target: 'llm'})`).
 * - Filling is one pass: a value that itself contains `{{…}}` stays literal text.
 * - Placeholders live only in text (subject, preheader, run text, labels, cite, alt, signature). An `href` is either a
 *   fixed `https:` link or EXACTLY one `{{slot}}` whose schema is `s.link()`: a value is never spliced into a URL.
 * - A template never names recipients (`to` is empty): people choose them.
 * - A block listed in `optionalBlocks` is dropped when its optional slot is empty.
 *
 * Templates are a compile-time registry reviewed in-repo (plan §6); a later wave adds its own here.
 */
import type { EmailBlock, EmailDoc, EmailMode } from '../contract/email.js';
import type { CheckError, Infer, ObjectSchema } from '../contract/schema.js';
import { check } from '../schema/check.js';
import { s } from '../schema/s.js';

export const EMAIL_TEMPLATE_IDS = [
  'reply',
  'follow_up',
  'intro',
  'meeting_recap',
  'quote_cover_note',
  'invoice_nudge',
  'comic_gift_reveal',
  'creator_pitch',
  'creator_launch',
] as const;

export type EmailTemplateId = (typeof EMAIL_TEMPLATE_IDS)[number];

/** Slot values: every slot is text (a link slot is an `https:`/`mailto:` string). */
export interface TemplateSlotValues {
  [slot: string]: string | undefined;
}

export interface EmailTemplate<V extends TemplateSlotValues = TemplateSlotValues> {
  id: EmailTemplateId;
  version: 1;
  /** For people choosing a template. */
  title: string;
  description: string;
  /** `general` suits any studio; `creator` is for comic creators. */
  audience: 'general' | 'creator';
  mode: EmailMode;
  slots: ObjectSchema<V>;
  /** Realistic values (demos, galleries, golden renders). */
  example: V;
  /** The draft with `{{slot}}` placeholders. */
  doc: EmailDoc;
  /** Block id → the optional slot whose absence drops that block. */
  optionalBlocks?: { readonly [blockId: string]: string };
}

/** A one-line name. */
const name = (description: string) => s.text({ max: 80, min: 1, singleLine: true, description });
/** A one-line phrase. */
const phrase = (max: number, description: string) => s.text({ max, min: 1, singleLine: true, description });
/** Free text, line breaks kept. */
const prose = (max: number, description: string) => s.text({ max, min: 1, description });
const url = (description: string) => s.link({ description });

const p = (id: string, text: string): EmailBlock => ({ type: 'paragraph', id, runs: [{ text }] });
const h = (id: string, level: 1 | 2 | 3, text: string): EmailBlock => ({ type: 'heading', id, level, runs: [{ text }] });
const btn = (id: string, label: string, href: string): EmailBlock => ({ type: 'button', id, label, href });

const doc = (mode: EmailMode, subject: string, blocks: EmailBlock[], extra: { preheader?: string } = {}): EmailDoc => {
  const d: EmailDoc = { v: 1, mode, subject, to: [], blocks, signature: '{{sender_name}}' };
  if (extra.preheader) d.preheader = extra.preheader;
  return d;
};

const sender = name("The sender's name, as it should appear under the email");

// ── General ─────────────────────────────────────────────────────────────────────────────────────────────────────

const REPLY_SLOTS = s.object({
  topic: phrase(200, 'What the thread is about (the subject after "Re:")'),
  greeting_name: name('Who the reply is to'),
  answer: prose(2000, 'The answer itself'),
  next_step: s.optional(prose(500, 'What happens next, if anything')),
  sender_name: sender,
});

const FOLLOW_UP_SLOTS = s.object({
  recipient_name: name('Who the email is to'),
  topic: phrase(150, 'What the conversation was about'),
  recap: prose(1500, 'The short recap of what was said'),
  ask: prose(500, 'What you would like from them'),
  deadline: s.optional(phrase(80, 'When you need an answer, for example "Friday"')),
  sender_name: sender,
});

const INTRO_SLOTS = s.object({
  person_a: name('The first person'),
  a_context: prose(300, 'Who the first person is, in a sentence'),
  person_b: name('The second person'),
  b_context: prose(300, 'Who the second person is, in a sentence'),
  reason: prose(600, 'Why they should talk'),
  sender_name: sender,
});

const MEETING_RECAP_SLOTS = s.object({
  meeting_name: phrase(120, 'The meeting'),
  date: phrase(60, 'When it was'),
  summary: prose(1500, 'What was discussed'),
  decisions: prose(1500, 'What was decided'),
  actions: prose(1500, 'Who does what, by when'),
  next_meeting: s.optional(phrase(120, 'When the next one is')),
  sender_name: sender,
});

const QUOTE_COVER_SLOTS = s.object({
  client_name: name('Who the quote is for'),
  project: phrase(120, 'The project being quoted'),
  total: phrase(60, 'The total, as written on the quote'),
  valid_until: phrase(60, 'How long the quote stands'),
  highlights: prose(1000, "What's included, in a few lines"),
  sender_name: sender,
});

const INVOICE_NUDGE_SLOTS = s.object({
  client_name: name('Who the invoice is for'),
  invoice_ref: phrase(60, 'The invoice number'),
  amount: phrase(60, 'The amount due, as written on the invoice'),
  due_date: phrase(60, 'When it was due'),
  pay_link: s.optional(url('Where to pay (https:), if there is a payment page')),
  sender_name: sender,
});

// ── Creators (Comic) ───────────────────────────────────────────────────────────────────────────────────────────

const GIFT_SLOTS = s.object({
  recipient_name: name('Who the comic is for'),
  comic_title: phrase(120, "The comic's title"),
  message: prose(1000, 'A personal note'),
  comic_link: url('The read-only share link to the comic (https:)'),
  sender_name: sender,
});

const PITCH_SLOTS = s.object({
  editor_name: name('The editor or publisher'),
  series_title: phrase(100, 'The series title'),
  genre_format: phrase(120, 'Genre, audience and format, for example "all-ages fantasy, 24 pages"'),
  logline: prose(300, 'The story in one or two sentences'),
  about_me: prose(600, 'Who you are as a creator'),
  samples_link: url('Where the sample pages are (https:)'),
  sender_name: sender,
});

const LAUNCH_SLOTS = s.object({
  series_title: phrase(120, 'The comic'),
  launch_date: phrase(60, 'When it comes out, for example "today" or "on 3 March"'),
  blurb: prose(1000, 'What it is about'),
  read_link: url('Where to read it (https:)'),
  extra: s.optional(prose(500, 'Anything else: a thank-you, a launch event')),
  sender_name: sender,
});

/** The slot values each template takes, by id (the "typed" in typed `{{slot}}`). */
export interface EmailTemplateSlots {
  reply: Infer<typeof REPLY_SLOTS>;
  follow_up: Infer<typeof FOLLOW_UP_SLOTS>;
  intro: Infer<typeof INTRO_SLOTS>;
  meeting_recap: Infer<typeof MEETING_RECAP_SLOTS>;
  quote_cover_note: Infer<typeof QUOTE_COVER_SLOTS>;
  invoice_nudge: Infer<typeof INVOICE_NUDGE_SLOTS>;
  comic_gift_reveal: Infer<typeof GIFT_SLOTS>;
  creator_pitch: Infer<typeof PITCH_SLOTS>;
  creator_launch: Infer<typeof LAUNCH_SLOTS>;
}

type Templates = { readonly [K in EmailTemplateId]: EmailTemplate<EmailTemplateSlots[K]> };

export const EMAIL_TEMPLATES: Templates = {
  reply: {
    id: 'reply',
    version: 1,
    title: 'Reply',
    description: 'A short, direct answer in a thread.',
    audience: 'general',
    mode: 'reply',
    slots: REPLY_SLOTS,
    example: {
      topic: 'Lighthouse sample pages',
      greeting_name: 'Sam',
      answer: 'Yes, the six sample pages are ready, and the lettering is final.',
      next_step: 'I can send the full script by Thursday if that helps.',
      sender_name: 'Alex Rivera',
    },
    doc: doc('reply', 'Re: {{topic}}', [p('p1', 'Hi {{greeting_name}},'), p('p2', '{{answer}}'), p('p3', '{{next_step}}'), p('p4', 'Thanks,')]),
    optionalBlocks: { p3: 'next_step' },
  },
  follow_up: {
    id: 'follow_up',
    version: 1,
    title: 'Follow-up',
    description: 'A recap of a conversation and one clear ask.',
    audience: 'general',
    mode: 'compose',
    slots: FOLLOW_UP_SLOTS,
    example: {
      recipient_name: 'Priya',
      topic: 'the spring catalogue',
      recap: 'We agreed on 12 titles, a two-week proofing window, and print files by 1 April.',
      ask: 'Could you confirm the final page counts so I can book the printer?',
      deadline: 'Friday',
      sender_name: 'Alex Rivera',
    },
    doc: doc('compose', 'Following up: {{topic}}', [
      p('p1', 'Hi {{recipient_name}},'),
      p('p2', 'Thanks again for talking through {{topic}}. A quick recap:'),
      p('p3', '{{recap}}'),
      p('p4', '{{ask}}'),
      p('p5', 'If possible, could you get back to me by {{deadline}}?'),
      p('p6', 'Thanks,'),
    ]),
    optionalBlocks: { p5: 'deadline' },
  },
  intro: {
    id: 'intro',
    version: 1,
    title: 'Introduction',
    description: 'Introduce two people who should talk.',
    audience: 'general',
    mode: 'compose',
    slots: INTRO_SLOTS,
    example: {
      person_a: 'Maya',
      a_context: 'Maya colours graphic novels and has worked on three middle-grade series.',
      person_b: 'Jon',
      b_context: 'Jon is writing a 24-page fantasy one-shot and is looking for a colourist.',
      reason: 'Your styles fit well, and Jon wants to start in May.',
      sender_name: 'Alex Rivera',
    },
    doc: doc('compose', 'Introduction: {{person_a}} and {{person_b}}', [
      p('p1', 'Hi {{person_a}} and {{person_b}},'),
      p('p2', "I'd like to introduce you two."),
      {
        type: 'list',
        id: 'l1',
        ordered: false,
        items: [{ runs: [{ text: '{{person_a}}', marks: ['b'] }, { text: ': {{a_context}}' }] }, { runs: [{ text: '{{person_b}}', marks: ['b'] }, { text: ': {{b_context}}' }] }],
      },
      p('p3', '{{reason}}'),
      p('p4', "I'll let you take it from here."),
    ]),
  },
  meeting_recap: {
    id: 'meeting_recap',
    version: 1,
    title: 'Meeting recap',
    description: 'What was discussed, decided and assigned.',
    audience: 'general',
    mode: 'compose',
    slots: MEETING_RECAP_SLOTS,
    example: {
      meeting_name: 'Issue 2 planning',
      date: '28 October',
      summary: 'We walked through the outline and the cover options.',
      decisions: 'Cover B, with the title moved to the top. Release stays on 3 March.',
      actions: 'Maya: colour flats by 10 November.\nJon: final script by 5 November.',
      next_meeting: '12 November, 10:00',
      sender_name: 'Alex Rivera',
    },
    doc: doc('compose', 'Recap: {{meeting_name}} ({{date}})', [
      h('h1', 2, 'Summary'),
      p('p1', '{{summary}}'),
      h('h2', 2, 'Decisions'),
      p('p2', '{{decisions}}'),
      h('h3', 2, 'Action items'),
      p('p3', '{{actions}}'),
      p('p4', 'Next meeting: {{next_meeting}}'),
    ]),
    optionalBlocks: { p4: 'next_meeting' },
  },
  quote_cover_note: {
    id: 'quote_cover_note',
    version: 1,
    title: 'Quote cover note',
    description: 'A short note to send with a quote.',
    audience: 'general',
    mode: 'compose',
    slots: QUOTE_COVER_SLOTS,
    example: {
      client_name: 'Dana',
      project: 'the museum comic',
      total: '$4,800',
      valid_until: '30 November',
      highlights: 'Eight pages, full colour, two rounds of changes, and print-ready files.',
      sender_name: 'Alex Rivera',
    },
    doc: doc('compose', 'Quote for {{project}}', [
      p('p1', 'Hi {{client_name}},'),
      p('p2', 'Here is the quote for {{project}}: {{total}} in total, valid until {{valid_until}}.'),
      p('p3', '{{highlights}}'),
      p('p4', "I'm happy to walk through it or adjust the scope; just reply to this email."),
      p('p5', 'Thanks,'),
    ]),
  },
  invoice_nudge: {
    id: 'invoice_nudge',
    version: 1,
    title: 'Invoice reminder',
    description: 'A polite nudge about an unpaid invoice.',
    audience: 'general',
    mode: 'compose',
    slots: INVOICE_NUDGE_SLOTS,
    example: {
      client_name: 'Dana',
      invoice_ref: 'INV-0042',
      amount: '$2,400',
      due_date: '15 October',
      pay_link: 'https://pay.example.com/inv-0042',
      sender_name: 'Alex Rivera',
    },
    doc: doc('compose', 'Reminder: invoice {{invoice_ref}}', [
      p('p1', 'Hi {{client_name}},'),
      p('p2', 'A friendly reminder that invoice {{invoice_ref}} for {{amount}} was due on {{due_date}}.'),
      btn('b1', 'Pay the invoice', '{{pay_link}}'),
      p('p3', "If it's already on its way, thank you, and please ignore this note."),
      p('p4', 'Thanks,'),
    ]),
    optionalBlocks: { b1: 'pay_link' },
  },
  comic_gift_reveal: {
    id: 'comic_gift_reveal',
    version: 1,
    title: 'Comic gift',
    description: 'Reveal a comic you made for someone.',
    audience: 'creator',
    mode: 'compose',
    slots: GIFT_SLOTS,
    example: {
      recipient_name: 'Grandma',
      comic_title: 'The Lighthouse Keeper',
      message: 'I turned your stories about the summer at the lighthouse into a comic.',
      comic_link: 'https://comics.example.com/s/lighthouse',
      sender_name: 'Alex',
    },
    doc: doc(
      'compose',
      'I made you a comic: {{comic_title}}',
      [
        h('h1', 1, '{{comic_title}}'),
        p('p1', 'Hi {{recipient_name}},'),
        p('p2', '{{message}}'),
        btn('b1', 'Read your comic', '{{comic_link}}'),
        p('p3', 'It is a one-of-a-kind story, made just for you.'),
      ],
      { preheader: 'A story made just for you' }
    ),
  },
  creator_pitch: {
    id: 'creator_pitch',
    version: 1,
    title: 'Pitch to an editor',
    description: 'Pitch a series to an editor or publisher.',
    audience: 'creator',
    mode: 'compose',
    slots: PITCH_SLOTS,
    example: {
      editor_name: 'Ms. Okafor',
      series_title: 'The Lighthouse Keeper',
      genre_format: 'an all-ages fantasy graphic novel, 96 pages',
      logline: 'A girl inherits a lighthouse that guides lost ships between worlds, and one night a ship arrives empty.',
      about_me: 'I write and draw comics; my webcomic has run weekly for two years.',
      samples_link: 'https://comics.example.com/s/lighthouse-samples',
      sender_name: 'Alex Rivera',
    },
    doc: doc('compose', 'Pitch: {{series_title}}', [
      p('p1', 'Dear {{editor_name}},'),
      p('p2', "I'd like to pitch {{series_title}}, {{genre_format}}."),
      h('h1', 2, 'Logline'),
      p('p3', '{{logline}}'),
      h('h2', 2, 'About me'),
      p('p4', '{{about_me}}'),
      btn('b1', 'Read the sample pages', '{{samples_link}}'),
      p('p5', 'Thank you for your time. I would be glad to send the full script or a pitch deck.'),
    ]),
  },
  creator_launch: {
    id: 'creator_launch',
    version: 1,
    title: 'Launch announcement',
    description: 'Tell readers a new comic is out.',
    audience: 'creator',
    mode: 'compose',
    slots: LAUNCH_SLOTS,
    example: {
      series_title: 'The Lighthouse Keeper',
      launch_date: 'today',
      blurb: 'A girl inherits a lighthouse that guides lost ships between worlds.',
      read_link: 'https://comics.example.com/s/lighthouse',
      extra: 'Thank you to everyone who read the early pages.',
      sender_name: 'Alex Rivera',
    },
    doc: doc(
      'compose',
      'New comic: {{series_title}}',
      [
        h('h1', 1, '{{series_title}}'),
        p('p1', '{{blurb}}'),
        btn('b1', 'Start reading', '{{read_link}}'),
        p('p2', '{{extra}}'),
        p('p3', "Thank you for reading, and for sharing it with a friend who'd enjoy it."),
      ],
      { preheader: 'Out {{launch_date}}' }
    ),
    optionalBlocks: { p2: 'extra' },
  },
};

/** The template with this id, if any. */
export const emailTemplate = (id: string): EmailTemplate | undefined =>
  Object.prototype.hasOwnProperty.call(EMAIL_TEMPLATES, id) ? (EMAIL_TEMPLATES[id as EmailTemplateId] as unknown as EmailTemplate) : undefined;

/** `{{slot}}`: a lower-case slot name. */
export const SLOT_PATTERN = /\{\{([a-z][a-z0-9_]*)\}\}/g;

export type FillTemplateResult = { ok: true; doc: EmailDoc; errors?: undefined } | { ok: false; errors: CheckError[]; doc?: undefined };

/** Thrown only for a malformed TEMPLATE (a registry bug the tests catch), never for bad values. */
export class TemplateDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateDefinitionError';
  }
}

const fillText = (text: string, values: TemplateSlotValues): string => text.replace(SLOT_PATTERN, (_m, slot: string) => values[slot] ?? '');

const isEmpty = (v: string | undefined): boolean => v === undefined || v.trim() === '';

/** An optional slot given as `''` (or only spaces) counts as absent; everything else goes to `check()` untouched. */
const withoutEmptyOptionals = (slots: ObjectSchema<unknown>, values: unknown): unknown => {
  if (typeof values !== 'object' || values === null || Array.isArray(values) || Object.getPrototypeOf(values) !== Object.prototype) return values;
  const out: { [k: string]: unknown } = Object.create(null); // an own `__proto__` key stays a key, so check() still refuses it
  for (const k of Object.keys(values)) {
    const v = (values as { [k: string]: unknown })[k];
    const field = Object.prototype.hasOwnProperty.call(slots.fields, k) ? slots.fields[k] : undefined;
    if (field && field.kind === 'optional' && typeof v === 'string' && v.trim() === '') continue;
    out[k] = v;
  }
  return out;
};

/** Deep copy with placeholders filled; `href` takes exactly one link slot or none. */
const fillValue = (v: unknown, key: string, values: TemplateSlotValues, slots: ObjectSchema<unknown>): unknown => {
  if (typeof v === 'string') {
    if (key !== 'href') return fillText(v, values);
    const m = /^\{\{([a-z][a-z0-9_]*)\}\}$/.exec(v);
    if (m) {
      const field = slots.fields[m[1]];
      const inner = field && field.kind === 'optional' ? (field as unknown as { inner: { kind: string } }).inner : field;
      if (!inner || inner.kind !== 'link') throw new TemplateDefinitionError(`href {{${m[1]}}} must name an s.link() slot`);
      return values[m[1]] ?? '';
    }
    if (v.indexOf('{{') !== -1) throw new TemplateDefinitionError('a placeholder may never be spliced into a URL');
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => fillValue(x, '', values, slots));
  if (v && typeof v === 'object') {
    const out: { [k: string]: unknown } = {};
    for (const k of Object.keys(v)) out[k] = fillValue((v as { [k: string]: unknown })[k], k, values, slots);
    return out;
  }
  return v;
};

/**
 * Fill a template: the values are checked against its `slots` (unknown slots, missing required ones, over-long or
 * multi-line values and non-`https:`/`mailto:` links are errors, at the slot's path); then every placeholder is
 * replaced in one pass, and blocks whose optional slot is empty are dropped. The result is a fresh EmailDoc.
 */
export function fillTemplate<K extends EmailTemplateId>(id: K, values: EmailTemplateSlots[K]): FillTemplateResult;
export function fillTemplate(id: string, values: unknown): FillTemplateResult;
export function fillTemplate(id: string, values: unknown): FillTemplateResult {
  const t = emailTemplate(id);
  if (!t) return { ok: false, errors: [{ path: '', code: 'enum', message: `unknown template; one of ${EMAIL_TEMPLATE_IDS.join(', ')}` }] };
  return fillEmailTemplate(t, values);
}

/**
 * `fillTemplate` for a template object (one of `EMAIL_TEMPLATES`, or a host's own reviewed in-repo). Throws
 * `TemplateDefinitionError` only for a malformed template (a placeholder spliced into an `href`, or an `href` slot
 * that is not `s.link()`); bad VALUES are always returned as errors.
 */
export const fillEmailTemplate = (t: EmailTemplate, values: unknown): FillTemplateResult => {
  const r = check(t.slots, withoutEmptyOptionals(t.slots as ObjectSchema<unknown>, values));
  if (r.ok === false) return { ok: false, errors: r.errors };
  const v = r.value as TemplateSlotValues;
  const optional = t.optionalBlocks ?? {};
  const filled = fillValue(t.doc, '', v, t.slots as ObjectSchema<unknown>) as EmailDoc;
  filled.blocks = filled.blocks.filter((b) => !(Object.prototype.hasOwnProperty.call(optional, b.id) && isEmpty(v[optional[b.id]])));
  return { ok: true, doc: filled };
};
