// @vitest-environment node
//
// The three models together (plan §5.2, W1.2):
// - the schemas' Infer<> types EQUAL the frozen src/contract types, DocRemoveSectionOp, EmailAttachOp.index and
//   AgentEmailOp included. expectTypeOf checks it under the app's typecheck; a strict in-process compile (the
//   package's own ES2017 / Node16 settings) checks it again at test time, with a planted mismatch proving the probe
//   can fail;
// - purity: frozen inputs, no Date, no Math.random, no performance.now (spies), the same output twice;
// - every hostile document in fixtures/models/invalid.json is refused at its exact path and code;
// - a data: image of 5,000,001 decoded bytes is refused everywhere an image goes, 5,000,000 passes;
// - every model schema projects to the llm and strict JSON Schemas (W1.4 projects them into tool inputs).
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type {
  AgentEmailOp,
  AttachmentSpec,
  CheckResult,
  DeckElement,
  DeckOp,
  DeckSpec,
  DeckTheme,
  DocBlock,
  DocMeta,
  DocOp,
  DocRemoveSectionOp,
  DocSection,
  DocSuggestion,
  EmailAttachOp,
  EmailBlock,
  EmailColumnBlock,
  EmailDoc,
  EmailOp,
  EmailRecipient,
  Infer,
  JsonSchema,
  RichDoc,
  Schema,
  Slide,
} from '../index.js';
import { toJsonSchema } from '../schema/index.js';
import {
  DeckElementSchema,
  DeckOpSchema,
  DeckSpecSchema,
  DeckThemeSchema,
  SlideSchema,
  applyDeckOps,
  checkDeckSpec,
  deckOverlaps,
  invertDeckOps,
  migrateDeckSpec,
  overlapCheck,
} from './deck/index.js';
import {
  AgentEmailOpSchema,
  AttachmentSpecSchema,
  EmailBlockSchema,
  EmailColumnBlockSchema,
  EmailDocSchema,
  EmailOpSchema,
  EmailRecipientSchema,
  applyEmailOps,
  checkEmailDoc,
  emailBodyTextLength,
  invertEmailOps,
  migrateEmailDoc,
  stampAgentEmailOp,
} from './email/index.js';
import {
  DocBlockSchema,
  DocMetaSchema,
  DocOpSchema,
  DocSectionSchema,
  DocSuggestionSchema,
  RichDocSchema,
  acceptDocSuggestion,
  applyDocOps,
  checkRichDoc,
  invertDocOps,
  migrateRichDoc,
} from './richdoc/index.js';

const PKG = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '');
const fixture = <T = unknown>(name: string): T => JSON.parse(readFileSync(join(PKG, 'fixtures', name), 'utf8')) as T;

// ── Infer<schema> IS the contract type ───────────────────────────────────────────────────────────────────────────

describe('the schemas are the frozen contract', () => {
  it('Infer<schema> equals the contract type (checked by the app typecheck)', () => {
    expectTypeOf<Infer<typeof RichDocSchema>>().toEqualTypeOf<RichDoc>();
    expectTypeOf<Infer<typeof DocSectionSchema>>().toEqualTypeOf<DocSection>();
    expectTypeOf<Infer<typeof DocBlockSchema>>().toEqualTypeOf<DocBlock>();
    expectTypeOf<Infer<typeof DocMetaSchema>>().toEqualTypeOf<DocMeta>();
    expectTypeOf<Infer<typeof DocOpSchema>>().toEqualTypeOf<DocOp>();
    expectTypeOf<Extract<Infer<typeof DocOpSchema>, { op: 'remove_section' }>>().toEqualTypeOf<DocRemoveSectionOp>();
    expectTypeOf<Infer<typeof DocSuggestionSchema>>().toEqualTypeOf<DocSuggestion>();
    expectTypeOf<Infer<typeof DeckSpecSchema>>().toEqualTypeOf<DeckSpec>();
    expectTypeOf<Infer<typeof SlideSchema>>().toEqualTypeOf<Slide>();
    expectTypeOf<Infer<typeof DeckElementSchema>>().toEqualTypeOf<DeckElement>();
    expectTypeOf<Infer<typeof DeckThemeSchema>>().toEqualTypeOf<DeckTheme>();
    expectTypeOf<Infer<typeof DeckOpSchema>>().toEqualTypeOf<DeckOp>();
    expectTypeOf<Infer<typeof EmailDocSchema>>().toEqualTypeOf<EmailDoc>();
    expectTypeOf<Infer<typeof EmailBlockSchema>>().toEqualTypeOf<EmailBlock>();
    expectTypeOf<Infer<typeof EmailColumnBlockSchema>>().toEqualTypeOf<EmailColumnBlock>();
    expectTypeOf<Infer<typeof EmailRecipientSchema>>().toEqualTypeOf<EmailRecipient>();
    expectTypeOf<Infer<typeof AttachmentSpecSchema>>().toEqualTypeOf<AttachmentSpec>();
    expectTypeOf<Infer<typeof EmailOpSchema>>().toEqualTypeOf<EmailOp>();
    expectTypeOf<Extract<Infer<typeof EmailOpSchema>, { op: 'attach' }>>().toEqualTypeOf<EmailAttachOp>();
    expectTypeOf<Extract<Infer<typeof EmailOpSchema>, { op: 'attach' }>['index']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<Infer<typeof AgentEmailOpSchema>>().toEqualTypeOf<AgentEmailOp>();
    expectTypeOf<Extract<Infer<typeof AgentEmailOpSchema>, { op: 'set_recipients' }>>().toBeNever();
    expectTypeOf(checkRichDoc).returns.toEqualTypeOf<CheckResult<RichDoc>>();
    expectTypeOf(checkDeckSpec).returns.toEqualTypeOf<CheckResult<DeckSpec>>();
    expectTypeOf(checkEmailDoc).returns.toEqualTypeOf<CheckResult<EmailDoc>>();
  });

  /** Compile `body` as src/models/__type_probe__.ts with the package's own strict ES2017 / Node16 settings. */
  const compileProbe = (body: string): string[] => {
    const file = join(PKG, 'src', 'models', '__type_probe__.ts');
    const options: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2017,
      lib: ['lib.es2017.d.ts'],
      types: [],
      module: ts.ModuleKind.Node16,
      moduleResolution: ts.ModuleResolutionKind.Node16,
      skipLibCheck: true,
      isolatedModules: true,
    };
    const host = ts.createCompilerHost(options);
    const { getSourceFile, fileExists, readFile } = host;
    host.getSourceFile = (name, lang, onError, create) =>
      name === file ? ts.createSourceFile(name, body, lang) : getSourceFile.call(host, name, lang, onError, create);
    host.fileExists = (name) => name === file || fileExists.call(host, name);
    host.readFile = (name) => (name === file ? body : readFile.call(host, name));
    const program = ts.createProgram([file], options, host);
    return ts.getPreEmitDiagnostics(program).map((d) => {
      const where = d.file && d.start !== undefined ? `${relative(PKG, d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}` : '';
      return `${where} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
    });
  };

  const PROBE_HEAD = [
    "import type { Infer } from '../contract/schema.js';",
    "import type { DocBlock, DocMeta, DocOp, DocRemoveSectionOp, DocSection, DocSuggestion, RichDoc } from '../contract/richdoc.js';",
    "import type { DeckElement, DeckOp, DeckSpec, DeckTheme, Slide } from '../contract/deck.js';",
    "import type { AgentEmailOp, AttachmentSpec, EmailAttachOp, EmailBlock, EmailColumnBlock, EmailDoc, EmailOp, EmailRecipient } from '../contract/email.js';",
    "import { DocBlockSchema, DocMetaSchema, DocOpSchema, DocSectionSchema, DocSuggestionSchema, RichDocSchema } from './richdoc/index.js';",
    "import { DeckElementSchema, DeckOpSchema, DeckSpecSchema, DeckThemeSchema, SlideSchema } from './deck/index.js';",
    "import { AgentEmailOpSchema, AttachmentSpecSchema, EmailBlockSchema, EmailColumnBlockSchema, EmailDocSchema, EmailOpSchema, EmailRecipientSchema } from './email/index.js';",
    'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;',
    'type Expect<T extends true> = T;',
  ].join('\n');

  it(
    'holds under a strict compile with the package settings, and the probe fails on a planted mismatch',
    () => {
      const checks = [
        'Expect<Equal<Infer<typeof RichDocSchema>, RichDoc>>',
        'Expect<Equal<Infer<typeof DocSectionSchema>, DocSection>>',
        'Expect<Equal<Infer<typeof DocBlockSchema>, DocBlock>>',
        'Expect<Equal<Infer<typeof DocMetaSchema>, DocMeta>>',
        'Expect<Equal<Infer<typeof DocOpSchema>, DocOp>>',
        "Expect<Equal<Extract<Infer<typeof DocOpSchema>, { op: 'remove_section' }>, DocRemoveSectionOp>>",
        'Expect<Equal<Infer<typeof DocSuggestionSchema>, DocSuggestion>>',
        'Expect<Equal<Infer<typeof DeckSpecSchema>, DeckSpec>>',
        'Expect<Equal<Infer<typeof SlideSchema>, Slide>>',
        'Expect<Equal<Infer<typeof DeckElementSchema>, DeckElement>>',
        'Expect<Equal<Infer<typeof DeckThemeSchema>, DeckTheme>>',
        'Expect<Equal<Infer<typeof DeckOpSchema>, DeckOp>>',
        'Expect<Equal<Infer<typeof EmailDocSchema>, EmailDoc>>',
        'Expect<Equal<Infer<typeof EmailBlockSchema>, EmailBlock>>',
        'Expect<Equal<Infer<typeof EmailColumnBlockSchema>, EmailColumnBlock>>',
        'Expect<Equal<Infer<typeof EmailRecipientSchema>, EmailRecipient>>',
        'Expect<Equal<Infer<typeof AttachmentSpecSchema>, AttachmentSpec>>',
        'Expect<Equal<Infer<typeof EmailOpSchema>, EmailOp>>',
        "Expect<Equal<Extract<Infer<typeof EmailOpSchema>, { op: 'attach' }>, EmailAttachOp>>",
        "Expect<Equal<Extract<Infer<typeof EmailOpSchema>, { op: 'attach' }>['index'], number | undefined>>",
        'Expect<Equal<Infer<typeof AgentEmailOpSchema>, AgentEmailOp>>',
        "Expect<Equal<Extract<Infer<typeof AgentEmailOpSchema>, { op: 'set_recipients' }>, never>>",
      ];
      const good = `${PROBE_HEAD}\nexport type Checks = [\n  ${checks.join(',\n  ')},\n];\n`;
      expect(compileProbe(good)).toEqual([]);
      // The probe is live: each of these lines is wrong and must be reported.
      const planted = [
        "Expect<Equal<Infer<typeof DocOpSchema>, Exclude<DocOp, DocRemoveSectionOp>>>",
        "Expect<Equal<Extract<Infer<typeof EmailOpSchema>, { op: 'attach' }>, Omit<EmailAttachOp, 'index'>>>",
        'Expect<Equal<Infer<typeof AgentEmailOpSchema>, EmailOp>>',
      ];
      for (const line of planted) expect(compileProbe(`${PROBE_HEAD}\nexport type Bad = ${line};\n`).length, line).toBeGreaterThan(0);
    },
    60_000,
  );
});

// ── Purity ───────────────────────────────────────────────────────────────────────────────────────────────────────

const deepFreeze = <T,>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
};

describe('purity', () => {
  /** Everything the models export that computes, run once over frozen inputs. */
  const runAll = (): unknown[] => {
    const doc = deepFreeze(fixture<RichDoc>('contract/richdoc/full.json'));
    const docOps = deepFreeze<DocOp[]>([
      { op: 'insert_block', id: 'a1', baseRev: 3, sectionId: 's-intro', index: 1, block: { type: 'divider', id: 'dx' } },
      { op: 'update_block', id: 'a2', baseRev: 3, blockId: 'p-quote', block: { type: 'paragraph', id: 'p-quote', style: 'quote', runs: [{ text: 'New' }] } },
      { op: 'remove_section', id: 'a3', baseRev: 3, sectionId: 's-script' },
      { op: 'set_title', id: 'a4', baseRev: 3, title: 'Frozen' },
    ]);
    const deck = deepFreeze(fixture<DeckSpec>('contract/deck/full.json'));
    const deckOps = deepFreeze<DeckOp[]>([
      { op: 'move_slide', id: 'b1', baseRev: 2, slideId: 'sl-end', index: 0 },
      { op: 'remove_slide', id: 'b2', baseRev: 2, slideId: 'sl-two' },
      { op: 'set_theme', id: 'b3', baseRev: 2, theme: { preset: 'light' } },
    ]);
    const email = deepFreeze(fixture<EmailDoc>('contract/email/full.json'));
    const emailOps = deepFreeze<EmailOp[]>([
      { op: 'detach', id: 'c1', baseRev: 1, attachmentId: 'a1' },
      { op: 'set_recipients', id: 'c2', baseRev: 1, actor: 'user', to: [{ address: 'x@example.com' }] },
      { op: 'insert_block', id: 'c3', baseRev: 1, index: 0, block: { type: 'paragraph', id: 'pz', runs: [{ text: 'Hi' }] } },
    ]);
    const suggestion = deepFreeze(fixture<DocSuggestion>('contract/richdoc/suggestion.json'));
    const smart = deepFreeze(fixture<{ slide: Slide }>('models/deck/smartart-over-chart.json'));
    const before = JSON.stringify([doc, docOps, deck, deckOps, email, emailOps, suggestion, smart]);

    const d = applyDocOps(doc, docOps);
    const k = applyDeckOps(deck, deckOps);
    const e = applyEmailOps(email, emailOps);
    expect([d.rejected, k.rejected, e.rejected]).toEqual([[], [], []]); // a write to a frozen input would have been refused
    const minimalDoc = deepFreeze(fixture<RichDoc>('contract/richdoc/minimal.json'));
    const out: unknown[] = [
      d,
      invertDocOps(doc, d.applied, { baseRev: 4, id: (op) => `u-${op.id}` }),
      acceptDocSuggestion(minimalDoc, suggestion),
      checkRichDoc(doc),
      migrateRichDoc(doc),
      k,
      invertDeckOps(deck, k.applied, { baseRev: 3, id: (op) => `u-${op.id}` }),
      overlapCheck(smart.slide),
      deckOverlaps(deck),
      checkDeckSpec(deck),
      migrateDeckSpec(deck),
      e,
      invertEmailOps(email, e.applied, { baseRev: 2, id: (op) => `u-${op.id}` }),
      stampAgentEmailOp(emailOps[2]),
      emailBodyTextLength(email),
      checkEmailDoc(email),
      migrateEmailDoc(email),
    ];
    expect(JSON.stringify([doc, docOps, deck, deckOps, email, emailOps, suggestion, smart])).toBe(before);
    return out;
  };

  it('never reads a clock or a random source, never writes to its (frozen) input, and gives the same output twice', () => {
    const RealDate = Date;
    let dateCalls = 0;
    const now = vi.spyOn(Date, 'now');
    const random = vi.spyOn(Math, 'random');
    const perf = vi.spyOn(performance, 'now');
    globalThis.Date = new Proxy(RealDate, {
      construct(target, args, newTarget) {
        dateCalls++;
        return Reflect.construct(target, args, newTarget) as object;
      },
      apply(target, self, args) {
        dateCalls++;
        return Reflect.apply(target, self, args);
      },
    });
    let first: unknown[];
    let second: unknown[];
    let counts: number[];
    try {
      now.mockClear();
      random.mockClear();
      perf.mockClear();
      first = runAll();
      second = runAll();
      counts = [dateCalls, now.mock.calls.length, random.mock.calls.length, perf.mock.calls.length];
    } finally {
      globalThis.Date = RealDate;
      now.mockRestore();
      random.mockRestore();
      perf.mockRestore();
    }
    expect(counts).toEqual([0, 0, 0, 0]);
    expect(second).toEqual(first);
  });
});

// ── Hostile documents ────────────────────────────────────────────────────────────────────────────────────────────

interface InvalidCase {
  name: string;
  model: 'richdoc' | 'deck' | 'email';
  at: (string | number)[];
  value: unknown;
  path: string;
  code: string;
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The base with one change; defineProperty so the change is an own data property (as JSON.parse would make it). */
const mutate = (base: unknown, at: (string | number)[], value: unknown): unknown => {
  const out = clone(base) as Record<string | number, unknown>;
  let target = out;
  for (const seg of at.slice(0, -1)) target = target[seg] as Record<string | number, unknown>;
  Object.defineProperty(target, at[at.length - 1], { value: clone(value), enumerable: true, writable: true, configurable: true });
  return out;
};

const CHECKS: { [K in InvalidCase['model']]: (value: unknown) => CheckResult<unknown> } = {
  richdoc: checkRichDoc,
  deck: checkDeckSpec,
  email: checkEmailDoc,
};

describe('hostile documents (fixtures/models/invalid.json)', () => {
  const file = fixture<{ bases: { [K in InvalidCase['model']]: string }; cases: InvalidCase[] }>('models/invalid.json');

  it('covers every model with links, image URLs, recipients and caps', () => {
    expect(file.cases.length).toBeGreaterThanOrEqual(35);
    for (const model of ['richdoc', 'deck', 'email'] as const) {
      expect(CHECKS[model](fixture(file.bases[model])).ok, model).toBe(true);
      const codes = file.cases.filter((c) => c.model === model).map((c) => c.code);
      expect(codes, model).toContain('link');
      expect(codes, model).toContain('tag');
      expect(codes, model).toContain('unknown-key');
    }
  });

  for (const c of fixture<{ cases: InvalidCase[] }>('models/invalid.json').cases) {
    it(`${c.model}: ${c.name} → ${c.path} ${c.code}`, () => {
      const r = CHECKS[c.model](mutate(fixture(file.bases[c.model]), c.at, c.value));
      expect(r.ok).toBe(false);
      expect((r.errors || []).map(({ path, code }) => ({ path, code }))).toEqual([{ path: c.path, code: c.code }]);
    });
  }
});

// ── The 5 MB data: image cap ─────────────────────────────────────────────────────────────────────────────────────

/** A PNG `data:` URI of exactly `bytes` decoded bytes (PNG magic, then zeros). */
const pngOf = (bytes: number): string => {
  const rest = bytes - 9; // 'iVBORw0KGgoA' is the 8 magic bytes and one zero
  return `data:image/png;base64,iVBORw0KGgoA${'AAAA'.repeat(Math.floor(rest / 3))}${['', 'AA==', 'AAA='][rest % 3]}`;
};

describe('data: images', () => {
  const OVER = pngOf(5_000_001);
  const AT_CAP = pngOf(5_000_000);
  const slots: { model: InvalidCase['model']; base: string; at: (string | number)[]; path: string }[] = [
    { model: 'richdoc', base: 'contract/richdoc/full.json', at: ['sections', 0, 'blocks', 7, 'ref', 'dataUri'], path: 'sections[0].blocks[7].ref.dataUri' },
    { model: 'deck', base: 'contract/deck/full.json', at: ['slides', 3, 'elements', 0, 'ref', 'dataUri'], path: 'slides[3].elements[0].ref.dataUri' },
    { model: 'email', base: 'contract/email/full.json', at: ['blocks', 7, 'columns', 0, 'blocks', 0, 'ref', 'dataUri'], path: 'blocks[7].columns[0].blocks[0].ref.dataUri' },
  ];

  it('the probe images are exactly the sizes they claim', () => {
    const decoded = (uri: string) => Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64');
    expect(decoded(OVER).length).toBe(5_000_001);
    expect(decoded(AT_CAP).length).toBe(5_000_000);
    expect(decoded(AT_CAP).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  for (const slot of slots) {
    it(`${slot.model}: 5,000,001 decoded bytes are refused, 5,000,000 pass`, () => {
      const base = fixture(slot.base);
      expect(CHECKS[slot.model](mutate(base, slot.at, OVER))).toMatchObject({ ok: false, errors: [{ path: slot.path, code: 'asset-too-large' }] });
      expect(CHECKS[slot.model](mutate(base, slot.at, AT_CAP)).ok).toBe(true);
    });
  }

  it('an op carrying an image over 5 MB is refused and changes nothing', () => {
    const doc = fixture<RichDoc>('contract/richdoc/minimal.json');
    const op = { op: 'insert_block', id: 'big', baseRev: 0, sectionId: 's1', block: { type: 'image', id: 'i', alt: 'big', ref: { kind: 'data', dataUri: OVER } } };
    const r = applyDocOps(doc, [op as DocOp]);
    expect(r.doc).toBe(doc);
    expect(r.rejected).toMatchObject([{ code: 'invalid', message: expect.stringContaining('block.ref.dataUri') }]);
    const email = fixture<EmailDoc>('contract/email/minimal.json');
    const emailOp = { op: 'insert_block', id: 'big', baseRev: 0, block: { type: 'image', id: 'i', alt: 'big', ref: { kind: 'data', dataUri: OVER } } };
    expect(applyEmailOps(email, [emailOp as EmailOp]).rejected).toMatchObject([{ code: 'invalid' }]);
  });
});

// ── JSON Schema projections (W1.4 projects these into tool inputs) ───────────────────────────────────────────────

describe('JSON Schema projections', () => {
  const schemas: [string, Schema<unknown>][] = [
    ['RichDoc', RichDocSchema],
    ['DocOp', DocOpSchema],
    ['DocSuggestion', DocSuggestionSchema],
    ['DeckSpec', DeckSpecSchema],
    ['DeckOp', DeckOpSchema],
    ['EmailDoc', EmailDocSchema],
    ['EmailOp', EmailOpSchema],
    ['AgentEmailOp', AgentEmailOpSchema],
  ];

  it('every model schema projects to llm (every property typed) and strict', () => {
    const untyped: string[] = [];
    const visit = (node: JsonSchema, path: string): void => {
      if (typeof node.type !== 'string') untyped.push(path || '(root)');
      if (node.properties && typeof node.properties === 'object') {
        for (const key of Object.keys(node.properties as object)) visit((node.properties as Record<string, JsonSchema>)[key], `${path}.${key}`);
      }
      if (node.items && typeof node.items === 'object' && !Array.isArray(node.items)) visit(node.items as JsonSchema, `${path}[]`);
    };
    for (const [name, schema] of schemas) {
      visit(toJsonSchema(schema, { target: 'llm' }), name);
      expect(() => toJsonSchema(schema, { target: 'strict' }), name).not.toThrow();
    }
    expect(untyped).toEqual([]);
    expect(JSON.stringify(toJsonSchema(EmailOpSchema, { target: 'llm' }))).toContain('set_recipients');
    expect(JSON.stringify(toJsonSchema(AgentEmailOpSchema, { target: 'llm' }))).not.toContain('set_recipients');
  });
});
