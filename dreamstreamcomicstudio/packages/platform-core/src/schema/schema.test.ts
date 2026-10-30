// @vitest-environment node
//
// The schema DSL (plan §5.1, W1.1): every invalid fixture is rejected at its exact path and code, a schema without
// caps throws, unknown keys are rejected, and toJsonSchema's llm / strict / mcp outputs match their committed
// snapshots (fixtures/schema/kitchen.*.json — a fixture change is a contract change). The last block proves the
// frozen contract (src/contract/**) is expressible in the DSL exactly — Infer<schema> IS the contract type — and that
// every contract fixture passes.
import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CHECK_ERROR_CODES,
  DECK_LIMITS,
  EMAIL_LIMITS,
  HEX_COLOR_PATTERN,
  MODEL_LIMITS,
  RICHDOC_LIMITS,
  SCHEMA_LIMITS,
  SchemaDefinitionError,
  check,
  s,
  toJsonSchema,
  type AssetRef,
  type CheckResult,
  type DeckOp,
  type DeckSpec,
  type DocOp,
  type DocSuggestion,
  type EmailDoc,
  type EmailOp,
  type Infer,
  type JsonSchema,
  type RichDoc,
  type Schema,
} from '../index.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8'));

// ── The kitchen sink: every kind the DSL has ────────────────────────────────────────────────────────────────────

const unit = () => s.number({ min: 0, max: 1 });
const Run = s.object({
  text: s.text({ max: 20 }),
  marks: s.optional(s.array(s.enum(['b', 'i']), { max: 2 })),
  link: s.optional(s.object({ href: s.link() })),
});
const Kitchen = s.object(
  {
    title: s.text({ max: 10, min: 1, description: 'A short title.' }),
    code: s.text({ max: 8, pattern: '^[a-z]+$' }),
    line: s.text({ max: 50, singleLine: true }),
    tags: s.array(s.text({ max: 5 }), { max: 3, min: 1 }),
    level: s.enum([1, 2, 3]),
    mode: s.enum(['compose', 'reply']),
    v: s.literal(1),
    count: s.int({ min: 0, max: 10 }),
    ratio: s.number({ min: 0, max: 1 }),
    flag: s.bool(),
    email: s.email(),
    link: s.link({ description: 'Where the button goes.' }),
    asset: s.assetRef({ maxBytes: 100 }),
    rect: s.tuple([unit(), unit(), unit(), unit()]),
    block: s.union('type', [
      s.object({ type: s.literal('p'), runs: s.array(Run, { max: 3 }) }),
      s.object({ type: s.literal('hr'), weight: s.optional(s.int({ min: 1, max: 3 })) }),
    ]),
    note: s.optional(s.text({ max: 5 })),
  },
  { description: 'Every kind the DSL has.' },
);

type Kitchen = Infer<typeof Kitchen>;

interface Case {
  name: string;
  at?: (string | number)[];
  value?: unknown;
  delete?: boolean;
  root?: unknown;
  path: string;
  code: string;
  same?: boolean;
}
interface CaseFile {
  base: Record<string, unknown>;
  cases: Case[];
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The base with one change; `defineProperty` so an own `__proto__` key is a real key, as JSON.parse makes it. */
const mutate = (base: Record<string, unknown>, c: Case): unknown => {
  if ('root' in c) return c.root;
  const value = clone(base);
  if (!c.at || !c.at.length) return value;
  let target: Record<string | number, unknown> = value;
  for (const seg of c.at.slice(0, -1)) target = target[seg] as Record<string | number, unknown>;
  const last = c.at[c.at.length - 1];
  if (c.delete) delete target[last];
  else Object.defineProperty(target, last, { value: clone(c.value), enumerable: true, writable: true, configurable: true });
  return value;
};

describe('check(): invalid fixtures', () => {
  const file = fixture('schema/invalid.json') as CaseFile;

  it('holds at least 40 cases, each with a known code, covering every code a JSON value can trigger', () => {
    expect(file.cases.length).toBeGreaterThanOrEqual(40);
    const codes = new Set(file.cases.map((c) => c.code));
    for (const c of file.cases) expect(CHECK_ERROR_CODES as readonly string[]).toContain(c.code);
    // not-finite (NaN / Infinity) and too-many-nodes cannot be written as one JSON change; tested below.
    for (const code of CHECK_ERROR_CODES) if (code !== 'not-finite' && code !== 'too-many-nodes') expect(codes, code).toContain(code);
  });

  it('the base value itself passes', () => {
    expect(check(Kitchen, file.base).ok).toBe(true);
  });

  for (const c of file.cases) {
    it(`rejects ${c.name} at "${c.path}" with ${c.code}`, () => {
      const r = check(Kitchen, mutate(file.base, c));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.errors.map(({ path, code }) => ({ path, code }))).toEqual([{ path: c.path, code: c.code }]);
      expect(r.errors[0].message.length).toBeGreaterThan(3);
    });
  }
});

describe('check(): valid fixtures', () => {
  const file = fixture('schema/valid.json') as CaseFile;
  for (const c of file.cases) {
    it(`accepts ${c.name}, returning a fresh equal copy`, () => {
      const input = mutate(file.base, c);
      const r = check(Kitchen, input);
      expect(r).toEqual({ ok: true, value: input });
      if (r.ok) expect(r.value).not.toBe(input);
    });
  }
});

describe('check(): behaviour', () => {
  const base = (fixture('schema/valid.json') as CaseFile).base;

  it('drops an undefined optional and never returns the caller’s objects', () => {
    const input: Record<string, unknown> = { ...clone(base), note: undefined };
    const r = check(Kitchen, input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('note' in r.value).toBe(false);
    expect(r.value.block).not.toBe(input.block);
    expect(r.value.tags).not.toBe(input.tags);
  });

  it('rejects class instances and boxed values where an object belongs', () => {
    expect(check(Kitchen, new Date())).toMatchObject({ ok: false, errors: [{ path: '', code: 'type' }] });
    class Fake {
      title = 'x';
    }
    expect(check(Kitchen, new Fake())).toMatchObject({ ok: false, errors: [{ path: '', code: 'type' }] });
  });

  it('accepts null-prototype objects and refuses objects that inherit their fields', () => {
    expect(check(Kitchen, Object.assign(Object.create(null), clone(base))).ok).toBe(true);
    expect(check(Kitchen, Object.create(clone(base)))).toMatchObject({ ok: false, errors: [{ path: '', code: 'type' }] });
  });

  it('reads only own properties: a polluted Object.prototype supplies nothing', () => {
    const input = clone(base);
    delete input.title;
    Object.defineProperty(Object.prototype, 'title', { value: 'polluted', configurable: true, enumerable: false, writable: true });
    try {
      expect(check(Kitchen, input)).toMatchObject({ ok: false, errors: [{ path: 'title', code: 'required' }] });
    } finally {
      delete (Object.prototype as Record<string, unknown>).title;
    }
  });

  it('rejects NaN and Infinity (JavaScript callers)', () => {
    expect(check(Kitchen, { ...clone(base), ratio: Number.NaN })).toMatchObject({ ok: false, errors: [{ path: 'ratio', code: 'not-finite' }] });
    expect(check(Kitchen, { ...clone(base), count: Infinity })).toMatchObject({ ok: false, errors: [{ path: 'count', code: 'not-finite' }] });
  });

  it('bounds the work: too many nodes stops the check', () => {
    const many = s.array(s.int(), { max: 1000 });
    const value = Array.from({ length: 500 }, (_, i) => i);
    expect(check(many, value).ok).toBe(true);
    const r = check(many, value, { maxNodes: 100 });
    expect(r).toMatchObject({ ok: false, errors: [{ code: 'too-many-nodes' }] });
    if (!r.ok) expect(r.errors).toHaveLength(1);
  });

  it('stops after maxErrors errors and reports them in definition order', () => {
    const r = check(Kitchen, { extra1: 1, extra2: 2 }, { maxErrors: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.path)).toEqual(['title', 'code', 'line']);
  });

  it('does not read a list past its cap', () => {
    const tags = new Proxy(['a', 'b', 'c', 'd'], {
      get(target, key) {
        if (key === '3') throw new Error('read past the cap');
        return Reflect.get(target, key);
      },
    });
    const r = check(Kitchen, { ...clone(base), tags });
    expect(r).toMatchObject({ ok: false, errors: [{ path: 'tags', code: 'too-many' }] });
  });

  it('caps data: images at 5 MB decoded by default, and sniffs their bytes', () => {
    const Img = s.assetRef();
    const png = 'iVBORw0KGgo'; // PNG magic
    const at = (bytes: number) => `data:image/png;base64,${png}${'A'.repeat(Math.ceil((bytes - 8) / 3) * 4 - (png.length - 8))}`;
    const atCap = 'data:image/png;base64,' + png + 'A'.repeat(Math.floor(SCHEMA_LIMITS.assetDataMaxBytes / 3) * 4 - png.length);
    expect(check(Img, { kind: 'data', dataUri: atCap }).ok).toBe(true);
    expect(check(Img, { kind: 'data', dataUri: at(SCHEMA_LIMITS.assetDataMaxBytes + 3) })).toMatchObject({
      ok: false,
      errors: [{ path: 'dataUri', code: 'asset-too-large' }],
    });
    expect(SCHEMA_LIMITS.assetDataMaxBytes).toBe(5 * 1024 * 1024);
  });

  it('formats keys that are not identifiers with brackets', () => {
    const r = check(Kitchen, { ...clone(base), 'a b': 1 });
    expect(r).toMatchObject({ ok: false, errors: [{ path: '["a b"]', code: 'unknown-key' }] });
  });

  it('escapes and cuts hostile unknown keys in error paths (no log flooding or bidi spoofing)', () => {
    const long = check(Kitchen, { ...clone(base), ['k'.repeat(100_000)]: 1 });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.errors[0].path.length).toBeLessThan(80);
    const bidi = check(Kitchen, { ...clone(base), 'evil\u202Efdp.exe': 1 });
    expect(bidi).toMatchObject({ ok: false, errors: [{ path: '["evil\\u202efdp.exe"]', code: 'unknown-key' }] });
  });
});

describe('a schema without caps (or otherwise malformed) throws', () => {
  const bad: [string, () => unknown][] = [
    ['s.text without max', () => s.text({} as never)],
    ['s.text with max 0', () => s.text({ max: 0 })],
    ['s.text with a fractional max', () => s.text({ max: 2.5 })],
    ['s.text with an absurd max', () => s.text({ max: SCHEMA_LIMITS.textCapMax + 1 })],
    ['s.text with min over max', () => s.text({ max: 3, min: 4 })],
    ['s.text with a broken pattern', () => s.text({ max: 3, pattern: '(' })],
    ['s.array without max', () => s.array(s.bool(), {} as never)],
    ['s.array without options', () => (s.array as (i: unknown) => unknown)(s.bool())],
    ['s.array of optionals', () => s.array(s.optional(s.bool()), { max: 2 })],
    ['s.array of something that is not a schema', () => s.array({ kind: 'date' } as never, { max: 2 })],
    ['s.object with an uncapped hand-written field', () => s.object({ name: { kind: 'text' } as never })],
    ['s.object with a __proto__-like field name', () => s.object({ constructor: s.bool() })],
    ['s.object with a non-identifier field name', () => s.object({ 'a-b': s.bool() })],
    ['s.enum with no values', () => s.enum([] as unknown as ['a'])],
    ['s.enum with duplicates', () => s.enum(['a', 'a'])],
    ['s.enum mixing strings and numbers', () => s.enum(['a', 1] as unknown as ['a'])],
    ['s.union without a tag literal', () => s.union('type', [s.object({ type: s.text({ max: 3 }) })])],
    ['s.union with a shared tag', () => s.union('type', [s.object({ type: s.literal('a') }), s.object({ type: s.literal('a') })])],
    ['s.union of a non-object', () => s.union('type', [s.bool() as never])],
    ['s.tuple of nothing', () => s.tuple([] as never)],
    ['s.int with min over max', () => s.int({ min: 3, max: 1 })],
    ['s.number with a NaN bound', () => s.number({ max: Number.NaN })],
    ['s.assetRef over the 5 MB cap', () => s.assetRef({ maxBytes: SCHEMA_LIMITS.assetDataMaxBytes + 1 })],
    ['s.optional of an optional', () => s.optional(s.optional(s.bool()))],
    ['check() with a hand-written uncapped schema', () => check({ kind: 'text' } as Schema<string>, 'x')],
    ['check() with a hand-written uncapped array', () => check({ kind: 'array', items: s.bool() } as Schema<boolean[]>, [])],
    ['check() at an optional root', () => check(s.optional(s.bool()), true)],
    ['toJsonSchema() with a hand-written uncapped schema', () => toJsonSchema({ kind: 'text' } as Schema<string>, { target: 'llm' })],
    ['toJsonSchema() with an unknown target', () => toJsonSchema(s.bool(), { target: 'openapi' as never })],
    ['toJsonSchema() for mcp with a non-object root', () => toJsonSchema(s.bool(), { target: 'mcp' })],
  ];
  for (const [name, make] of bad) {
    it(name, () => {
      expect(make).toThrow(SchemaDefinitionError);
    });
  }

  it('names the missing cap', () => {
    expect(() => s.text({} as never)).toThrow(/cap/);
    expect(() => s.array(s.bool(), {} as never)).toThrow(/cap/);
  });

  it('accepts a valid hand-written schema once validated (and still enforces it)', () => {
    const hand = { kind: 'text', max: 3 } as Schema<string>;
    expect(check(hand, 'abc')).toEqual({ ok: true, value: 'abc' });
    expect(check(hand, 'abcd')).toMatchObject({ ok: false, errors: [{ code: 'too-long' }] });
  });

  it('a hand-written schema edited after it passed stays capped (check uses a frozen copy)', () => {
    const hand = { kind: 'text', max: 3 } as { kind: 'text'; max?: number };
    expect(check(hand as Schema<string>, 'abc').ok).toBe(true);
    delete hand.max;
    expect(check(hand as Schema<string>, 'x'.repeat(10_000))).toMatchObject({ ok: false, errors: [{ code: 'too-long' }] });
    const nested = { kind: 'array', max: 2, items: { kind: 'text', max: 2 } } as unknown as { kind: 'array'; max: number; items: { max?: number } };
    expect(check(nested as unknown as Schema<string[]>, ['ab']).ok).toBe(true);
    delete nested.items.max;
    nested.max = 1e9;
    expect(check(nested as unknown as Schema<string[]>, ['abc', 'd', 'e'])).toMatchObject({ ok: false, errors: [{ path: '', code: 'too-many' }] });
  });

  it('s.id takes a smaller max but never a larger one', () => {
    expect(check(s.id({ max: 4 }), 'abcde')).toMatchObject({ ok: false, errors: [{ code: 'too-long' }] });
    expect(() => s.id({ max: SCHEMA_LIMITS.idMax + 1 })).toThrow(SchemaDefinitionError);
    expect(check(s.id(), 'op-1.a:b_c').ok).toBe(true);
    expect(check(s.id(), '-leading')).toMatchObject({ ok: false, errors: [{ code: 'pattern' }] });
  });

  it('freezes what it builds', () => {
    expect(Object.isFrozen(Kitchen)).toBe(true);
    expect(Object.isFrozen(Kitchen.fields)).toBe(true);
  });
});

describe('unknown keys are rejected everywhere', () => {
  const base = (fixture('schema/valid.json') as CaseFile).base;
  const at = (path: (string | number)[], key: string) => {
    const v = clone(base) as Record<string, unknown>;
    let t = v as Record<string | number, unknown>;
    for (const seg of path) t = t[seg] as Record<string | number, unknown>;
    t[key] = 'x';
    return v;
  };
  const cases: [(string | number)[], string, string][] = [
    [[], 'extra', 'extra'],
    [['block'], 'extra', 'block.extra'],
    [['block', 'runs', 0], 'extra', 'block.runs[0].extra'],
    [['block', 'runs', 0, 'link'], 'title', 'block.runs[0].link.title'],
    [['asset'], 'mime', 'asset.mime'],
  ];
  for (const [path, key, expected] of cases) {
    it(`at ${expected}`, () => {
      expect(check(Kitchen, at(path, key))).toMatchObject({ ok: false, errors: [{ path: expected, code: 'unknown-key' }] });
    });
  }
});

describe('toJsonSchema()', () => {
  for (const target of ['llm', 'strict', 'mcp'] as const) {
    it(`${target} matches fixtures/schema/kitchen.${target}.json`, () => {
      expect(toJsonSchema(Kitchen, { target })).toEqual(fixture(`schema/kitchen.${target}.json`));
    });
  }

  const walkJson = (v: unknown, visit: (o: JsonSchema) => void): void => {
    if (Array.isArray(v)) v.forEach((x) => walkJson(x, visit));
    else if (v && typeof v === 'object') {
      visit(v as JsonSchema);
      for (const x of Object.values(v)) walkJson(x, visit);
    }
  };

  it('llm is flat: no oneOf, anyOf, allOf, $ref, const, prefixItems, pattern, format or additionalProperties', () => {
    const banned = ['oneOf', 'anyOf', 'allOf', '$ref', '$schema', 'const', 'prefixItems', 'pattern', 'format', 'additionalProperties'];
    const found: string[] = [];
    walkJson(toJsonSchema(Kitchen, { target: 'llm' }), (o) => {
      for (const k of banned) if (k in o) found.push(k);
    });
    expect(found).toEqual([]);
  });

  it('strict closes every object and caps every string and array', () => {
    walkJson(toJsonSchema(Kitchen, { target: 'strict' }), (o) => {
      if (o.type === 'object') expect(o.additionalProperties).toBe(false);
      if (o.type === 'string' && !('const' in o) && !('enum' in o)) expect(typeof o.maxLength).toBe('number');
      if (o.type === 'array') expect(typeof o.maxItems).toBe('number');
    });
  });

  it('is deterministic', () => {
    expect(JSON.stringify(toJsonSchema(Kitchen, { target: 'llm' }))).toBe(JSON.stringify(toJsonSchema(Kitchen, { target: 'llm' })));
  });
});

describe('Infer', () => {
  it('derives the TypeScript type of a schema', () => {
    expectTypeOf<Kitchen['level']>().toEqualTypeOf<1 | 2 | 3>();
    expectTypeOf<Kitchen['mode']>().toEqualTypeOf<'compose' | 'reply'>();
    expectTypeOf<Kitchen['v']>().toEqualTypeOf<1>();
    expectTypeOf<Kitchen['rect']>().toEqualTypeOf<[number, number, number, number]>();
    expectTypeOf<Kitchen['asset']>().toEqualTypeOf<AssetRef>();
    expectTypeOf<Kitchen['block']>().toEqualTypeOf<
      { type: 'p'; runs: { text: string; marks?: ('b' | 'i')[]; link?: { href: string } }[] } | { type: 'hr'; weight?: number }
    >();
    expectTypeOf<Kitchen>().toHaveProperty('note');
    expectTypeOf(check(Kitchen, null)).toEqualTypeOf<CheckResult<Kitchen>>();
  });
});

// ── The frozen contract, written in the DSL ─────────────────────────────────────────────────────────────────────

const id = s.id();
const hex = s.text({ max: 7, pattern: HEX_COLOR_PATTERN });
const runsOf = (max: number) =>
  s.array(
    s.object({
      text: s.text({ max: MODEL_LIMITS.runText }),
      marks: s.optional(s.array(s.enum(['b', 'i', 'u', 'code']), { max: MODEL_LIMITS.marks })),
      link: s.optional(s.object({ href: s.link() })),
    }),
    { max },
  );
const listItems = (items: number, runs: number) =>
  s.array(s.object({ runs: runsOf(runs), indent: s.optional(s.int({ min: 0, max: MODEL_LIMITS.listIndentMax })) }), { max: items });
const tableRows = (rows: number, cols: number, runs: number) =>
  s.array(s.object({ cells: s.array(s.object({ runs: runsOf(runs) }), { max: cols }) }), { max: rows });
const opBase = { id, baseRev: s.int({ min: 0 }) };
const index = s.optional(s.int({ min: 0 }));

const R = RICHDOC_LIMITS;
const DocBlockS = s.union('type', [
  s.object({ type: s.literal('heading'), id, level: s.enum([1, 2, 3]), runs: runsOf(R.runsPerBlock) }),
  s.object({ type: s.literal('paragraph'), id, style: s.optional(s.enum(['body', 'lead', 'quote', 'caption'])), runs: runsOf(R.runsPerBlock) }),
  s.object({ type: s.literal('list'), id, ordered: s.bool(), items: listItems(R.listItems, R.runsPerBlock) }),
  s.object({ type: s.literal('table'), id, header: s.optional(s.bool()), rows: tableRows(R.tableRows, R.tableCols, R.runsPerCell) }),
  s.object({
    type: s.literal('image'),
    id,
    ref: s.assetRef(),
    alt: s.text({ max: MODEL_LIMITS.alt }),
    caption: s.optional(s.text({ max: R.caption })),
    width: s.optional(s.number({ min: R.imageWidthMin, max: 1 })),
  }),
  s.object({ type: s.literal('divider'), id }),
  s.object({
    type: s.literal('script'),
    id,
    kind: s.enum(['scene', 'panel', 'dialogue', 'caption', 'sfx']),
    speaker: s.optional(s.text({ max: R.speaker, singleLine: true })),
    runs: runsOf(R.runsPerBlock),
  }),
]);
const SectionS = s.object({ id, pageBreakBefore: s.bool(), blocks: s.array(DocBlockS, { max: R.blocksPerSection }) });
const RichDocS = s.object({
  v: s.literal(1),
  rev: s.optional(s.int({ min: 0 })),
  title: s.text({ max: R.title, singleLine: true }),
  meta: s.optional(
    s.object({
      author: s.optional(s.text({ max: R.metaText })),
      subject: s.optional(s.text({ max: R.metaText })),
      keywords: s.optional(s.array(s.text({ max: R.keyword }), { max: R.keywords })),
      lang: s.optional(s.text({ max: R.lang })),
    }),
  ),
  sections: s.array(SectionS, { max: R.sections }),
});
const DocOpS = s.union('op', [
  s.object({ op: s.literal('insert_block'), ...opBase, sectionId: id, index, block: DocBlockS }),
  s.object({ op: s.literal('update_block'), ...opBase, blockId: id, block: DocBlockS }),
  s.object({ op: s.literal('remove_block'), ...opBase, blockId: id }),
  s.object({ op: s.literal('insert_section'), ...opBase, index, section: SectionS }),
  s.object({ op: s.literal('set_title'), ...opBase, title: s.text({ max: R.title }) }),
]);
const SuggestionS = s.object({ id, op: DocOpS, author: s.literal('agent'), at: s.int({ min: 0 }) });

const D = DECK_LIMITS;
const elementBase = { id, rect: s.tuple([unit(), unit(), unit(), unit()]), layer: s.enum(['background', 'content']) };
const DeckElementS = s.union('kind', [
  s.object({
    kind: s.literal('text'),
    ...elementBase,
    role: s.optional(s.enum(['title', 'subtitle', 'body', 'caption', 'quote'])),
    align: s.optional(s.enum(['left', 'center', 'right'])),
    fontSize: s.optional(s.number({ min: D.fontSizeMin, max: D.fontSizeMax })),
    paragraphs: s.array(
      s.object({ runs: runsOf(D.runsPerParagraph), bullet: s.optional(s.bool()), indent: s.optional(s.int({ min: 0, max: MODEL_LIMITS.listIndentMax })) }),
      { max: D.paragraphs },
    ),
  }),
  s.object({ kind: s.literal('image'), ...elementBase, ref: s.assetRef(), alt: s.text({ max: MODEL_LIMITS.alt }), fit: s.optional(s.enum(['contain', 'cover'])) }),
  s.object({ kind: s.literal('shape'), ...elementBase, shape: s.enum(['rect', 'roundRect', 'ellipse', 'line']), fill: s.optional(hex), stroke: s.optional(hex) }),
  s.object({ kind: s.literal('table'), ...elementBase, header: s.optional(s.bool()), rows: tableRows(D.tableRows, D.tableCols, D.runsPerCell) }),
  s.object({
    kind: s.literal('chart'),
    ...elementBase,
    chart: s.enum(['bar', 'line', 'pie']),
    title: s.optional(s.text({ max: D.chartTitle })),
    categories: s.array(s.text({ max: D.label }), { max: D.chartCategories }),
    series: s.array(s.object({ name: s.text({ max: D.label }), values: s.array(s.number(), { max: D.chartCategories }) }), { max: D.chartSeries }),
  }),
]);
const SlideS = s.object({
  id,
  layout: s.enum(['title', 'section', 'content', 'image-full', 'two-col', 'end']),
  notes: s.optional(s.text({ max: D.notes })),
  elements: s.array(DeckElementS, { max: D.elementsPerSlide }),
});
const ThemeS = s.object({ preset: s.enum(['light', 'dark', 'brand']), background: s.optional(hex), text: s.optional(hex), accent: s.optional(hex) });
const DeckS = s.object({
  v: s.literal(1),
  rev: s.optional(s.int({ min: 0 })),
  title: s.text({ max: D.title, singleLine: true }),
  size: s.enum(['16:9', '4:3']),
  theme: ThemeS,
  slides: s.array(SlideS, { max: D.slides }),
});
const DeckOpS = s.union('op', [
  s.object({ op: s.literal('add_slide'), ...opBase, index, slide: SlideS }),
  s.object({ op: s.literal('update_slide'), ...opBase, slideId: id, slide: SlideS }),
  s.object({ op: s.literal('remove_slide'), ...opBase, slideId: id }),
  s.object({ op: s.literal('move_slide'), ...opBase, slideId: id, index: s.int({ min: 0 }) }),
  s.object({ op: s.literal('set_theme'), ...opBase, theme: ThemeS }),
]);

const E = EMAIL_LIMITS;
const recipients = s.array(s.object({ address: s.email(), name: s.optional(s.text({ max: E.recipientName, singleLine: true })) }), { max: E.recipients });
const leafBlocks = [
  s.object({ type: s.literal('heading'), id, level: s.enum([1, 2, 3]), runs: runsOf(E.runsPerBlock) }),
  s.object({ type: s.literal('paragraph'), id, runs: runsOf(E.runsPerBlock) }),
  s.object({ type: s.literal('list'), id, ordered: s.bool(), items: listItems(E.listItems, E.runsPerBlock) }),
  s.object({ type: s.literal('button'), id, label: s.text({ max: E.buttonLabel, singleLine: true }), href: s.link() }),
  s.object({ type: s.literal('quote'), id, runs: runsOf(E.runsPerBlock), cite: s.optional(s.text({ max: E.cite })) }),
  s.object({ type: s.literal('divider'), id }),
  s.object({
    type: s.literal('image'),
    id,
    ref: s.assetRef(),
    alt: s.text({ max: MODEL_LIMITS.alt }),
    width: s.optional(s.int({ min: E.imageWidthMin, max: E.imageWidthMax })),
  }),
] as const;
const EmailBlockS = s.union('type', [
  ...leafBlocks,
  s.object({ type: s.literal('columns'), id, columns: s.array(s.object({ blocks: s.array(s.union('type', leafBlocks), { max: E.blocksPerColumn }) }), { max: E.columns }) }),
]);
const AttachmentS = s.object({
  id,
  name: s.text({ max: E.attachmentName, singleLine: true }),
  kind: s.enum(['docx', 'pdf', 'pptx']),
  spec: s.union('type', [s.object({ type: s.literal('doc'), doc: RichDocS }), s.object({ type: s.literal('deck'), deck: DeckS })]),
});
const EmailDocS = s.object({
  v: s.literal(1),
  rev: s.optional(s.int({ min: 0 })),
  mode: s.enum(['compose', 'reply', 'reply-all', 'forward']),
  subject: s.text({ max: E.subject, singleLine: true }),
  preheader: s.optional(s.text({ max: E.preheader, singleLine: true })),
  to: recipients,
  cc: s.optional(recipients),
  bcc: s.optional(recipients),
  blocks: s.array(EmailBlockS, { max: E.blocks }),
  signature: s.optional(s.text({ max: E.field })),
  attachments: s.optional(s.array(AttachmentS, { max: E.attachments })),
  brand: s.optional(id),
});
const actor = s.optional(s.enum(['user', 'agent']));
const EmailOpS = s.union('op', [
  s.object({ op: s.literal('set_subject'), ...opBase, actor, subject: s.text({ max: E.subject, singleLine: true }) }),
  s.object({ op: s.literal('insert_block'), ...opBase, actor, index, block: EmailBlockS }),
  s.object({ op: s.literal('update_block'), ...opBase, actor, blockId: id, block: EmailBlockS }),
  s.object({ op: s.literal('remove_block'), ...opBase, actor, blockId: id }),
  s.object({ op: s.literal('attach'), ...opBase, actor, attachment: AttachmentS }),
  s.object({ op: s.literal('detach'), ...opBase, actor, attachmentId: id }),
  s.object({ op: s.literal('set_recipients'), ...opBase, actor: s.literal('user'), to: recipients, cc: s.optional(recipients), bcc: s.optional(recipients) }),
]);

describe('the frozen contract (src/contract/**) is exactly expressible in the DSL', () => {
  it('Infer<schema> is the contract type', () => {
    expectTypeOf<Infer<typeof RichDocS>>().toEqualTypeOf<RichDoc>();
    expectTypeOf<Infer<typeof DocOpS>>().toEqualTypeOf<DocOp>();
    expectTypeOf<Infer<typeof SuggestionS>>().toEqualTypeOf<DocSuggestion>();
    expectTypeOf<Infer<typeof DeckS>>().toEqualTypeOf<DeckSpec>();
    expectTypeOf<Infer<typeof DeckOpS>>().toEqualTypeOf<DeckOp>();
    expectTypeOf<Infer<typeof EmailDocS>>().toEqualTypeOf<EmailDoc>();
    expectTypeOf<Infer<typeof EmailOpS>>().toEqualTypeOf<EmailOp>();
  });

  const pass = (schema: Schema<unknown>, name: string) => {
    const r = check(schema, fixture(`contract/${name}`));
    expect(r.ok ? [] : r.errors).toEqual([]);
  };
  const passAll = (schema: Schema<unknown>, name: string) => {
    for (const op of fixture(`contract/${name}`) as unknown[]) {
      const r = check(schema, op);
      expect(r.ok ? [] : r.errors).toEqual([]);
    }
  };

  it('every contract fixture passes', () => {
    pass(RichDocS, 'richdoc/minimal.json');
    pass(RichDocS, 'richdoc/full.json');
    passAll(DocOpS, 'richdoc/ops.json');
    pass(SuggestionS, 'richdoc/suggestion.json');
    pass(DeckS, 'deck/minimal.json');
    pass(DeckS, 'deck/full.json');
    passAll(DeckOpS, 'deck/ops.json');
    pass(EmailDocS, 'email/minimal.json');
    pass(EmailDocS, 'email/full.json');
    pass(EmailDocS, 'email/reply.json');
    passAll(EmailOpS, 'email/ops.json');
  });

  it('the fixtures cover every block, element, layout and op', () => {
    const text = (name: string) => readFileSync(new URL(`../../fixtures/contract/${name}`, import.meta.url), 'utf8');
    for (const t of ['heading', 'paragraph', 'list', 'table', 'image', 'divider', 'script']) expect(text('richdoc/full.json')).toContain(`"type": "${t}"`);
    for (const k of ['scene', 'panel', 'dialogue', 'caption', 'sfx']) expect(text('richdoc/full.json')).toContain(`"kind": "${k}"`);
    for (const k of ['text', 'image', 'shape', 'table', 'chart']) expect(text('deck/full.json')).toContain(`"kind": "${k}"`);
    for (const l of ['title', 'section', 'content', 'image-full', 'two-col', 'end']) expect(text('deck/full.json')).toContain(`"layout": "${l}"`);
    for (const c of ['bar', 'line', 'pie']) expect(text('deck/full.json')).toContain(`"chart": "${c}"`);
    for (const t of ['heading', 'paragraph', 'list', 'button', 'quote', 'divider', 'image', 'columns']) expect(text('email/full.json')).toContain(`"type": "${t}"`);
    const ops = (name: string) => (fixture(`contract/${name}`) as { op: string }[]).map((o) => o.op);
    expect(new Set(ops('richdoc/ops.json'))).toEqual(new Set(['insert_block', 'update_block', 'remove_block', 'insert_section', 'set_title']));
    expect(new Set(ops('deck/ops.json'))).toEqual(new Set(['add_slide', 'update_slide', 'remove_slide', 'move_slide', 'set_theme']));
    expect(new Set(ops('email/ops.json'))).toEqual(
      new Set(['set_subject', 'insert_block', 'update_block', 'remove_block', 'attach', 'detach', 'set_recipients']),
    );
  });

  it('holds the caps the plan names (§5.2)', () => {
    expect(MODEL_LIMITS.runText).toBe(4000);
    expect(SCHEMA_LIMITS.assetDataMaxBytes).toBe(5 * 1024 * 1024);
    expect([R.sections, R.blocksPerSection, R.tableRows, R.tableCols]).toEqual([200, 2000, 50, 12]);
    expect([D.slides, D.elementsPerSlide]).toEqual([60, 40]);
    expect([E.subject, E.preheader, E.recipients, E.blocks, E.field, E.attachments, E.columns]).toEqual([250, 150, 100, 80, 10000, 5, 2]);
  });

  it('an agent set_recipients does not fit the contract (only a user changes recipients)', () => {
    const op = { op: 'set_recipients', id: 'op-x', baseRev: 0, actor: 'agent', to: [{ address: 'evil@example.com' }] };
    expect(check(EmailOpS, op)).toMatchObject({ ok: false, errors: [{ path: 'actor', code: 'literal' }] });
  });

  it('the email contract has no way to send', () => {
    expect(text()).not.toMatch(/'send'|"send"|send_|deliver|dispatch/i);
    function text() {
      return readFileSync(new URL('../contract/email.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    }
  });
});
