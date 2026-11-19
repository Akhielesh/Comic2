// Q-SETTLE: an option is live only while it is the newest ask and nobody has answered it. Every card kind, driven by
// stored message sequences: (a) the person taps one (what the server stores for that tap), (b) the person types a new
// message instead, (c) the turn moves on (a later assistant message: an action's result, a job's outcome), (d) the
// page reloads (the same stored doc, read again from JSON). Plus the guard that ties every card type to a rule.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyDoc, type Card, type ComicDoc, type Msg } from './doc';
import { makeSampleDoc } from '../../components/comicstudio/conversation/testing/fixtures';
import { costFormat } from '../../components/comicstudio/conversation/cost';
import {
  CARD_SETTLE_RULES,
  buildSettleIndex,
  cardSettle,
  gateClosedFor,
  isHiddenSettle,
  isOpenQuestion,
  movesOn,
  settleKey,
  summaryOf,
  type CardSettle
} from './settle';

const DOLLARS = costFormat({ governed: false });

const user = (id: string, text: string, at = 20): Msg => ({ id, role: 'user', text, at });
const reply = (id: string, cards: Card[] = [], at = 10, extra: Partial<Msg> = {}): Msg => ({ id, role: 'assistant', text: 'Here you go.', at, ...(cards.length ? { cards } : {}), ...extra });
/** A later assistant turn with no user message: what an action or a job posts (jobs.ts assistantMessage). */
const laterTurn = (id = 'a_later'): Msg => ({ id, role: 'assistant', text: 'Locked “Inky noir”. Every sheet and page now follows it.', at: 30, nextSteps: [{ label: 'Plan the pages' }] });
/** An info-only notice message (a history budget notice, an archive eviction): not an ask. */
const infoOnly = (id = 'a_info'): Msg => {
  const text = 'Version archive is full (40): removed 2 oldest unstarred versions that nothing uses.';
  return { id, role: 'assistant', text, at: 30, cards: [{ type: 'notice', id: `${id}_n`, tone: 'info', text }] };
};
const reload = (doc: ComicDoc): ComicDoc => JSON.parse(JSON.stringify(doc)) as ComicDoc;

const settleIn = (doc: ComicDoc, cardId: string): CardSettle => {
  for (const [i, m] of doc.conversation.entries()) {
    const card = (m.cards || []).find((c) => c.id === cardId);
    if (card) return cardSettle(doc, i, card);
  }
  throw new Error(`no card ${cardId}`);
};
const cardIn = (doc: ComicDoc, cardId: string): Card => doc.conversation.flatMap((m) => m.cards || []).find((c) => c.id === cardId)!;

const base = makeSampleDoc();
const [p1] = base.pages;
const look: Extract<Card, { type: 'options' }> = {
  type: 'options',
  id: 'k_q',
  question: 'Which look?',
  allowCustom: true,
  choices: [
    { id: 'c1', label: 'Noir ink' },
    { id: 'c2', label: 'Crayon' }
  ]
};
const openGate = { id: 'g1', action: { type: 'render_pages' as const }, title: 'Draw 2 pages', summary: '2 pages', estimateUsd: 0.12, imageCount: 2, model: 'Nano Banana', createdAt: 1, status: 'open' as const, reason: 'first_render' as const };

interface KindCase {
  type: Card['type'];
  card: Card;
  /** Doc overrides the card needs to render (and to read as not running). */
  doc?: Partial<ComicDoc>;
  /** (a) The stored result of a tap. `card` replaces the stored card; `after` follows its message; `doc` patches it. */
  tap?: { card?: Card; after?: Msg[]; doc?: Partial<ComicDoc>; expect: Partial<CardSettle> };
  /** The card is still the newest ask with nothing after it. */
  fresh: CardSettle['state'];
}

const KINDS: KindCase[] = [
  { type: 'options', card: look, fresh: 'open', tap: { card: { ...look, answered: ['c1'] }, expect: { state: 'settled', outcome: 'picked', picked: ['c1'] } } },
  {
    type: 'conflict',
    card: { type: 'conflict', id: 'k_conf', items: [{ id: 'i1', where: { pageId: p1.id, label: 'page 1 · panel 1' }, mine: 'A', theirs: 'B', proposed: [] }] },
    fresh: 'open',
    tap: { card: { type: 'conflict', id: 'k_conf', items: [{ id: 'i1', where: { pageId: p1.id, label: 'page 1 · panel 1' }, mine: 'A', theirs: 'B', proposed: [], resolved: 'mine' }] }, expect: { state: 'settled', outcome: 'resolved' } }
  },
  {
    type: 'gate',
    card: { type: 'gate', id: 'k_gate', gateId: 'g1' },
    doc: { gate: { ...openGate, status: 'approved' } },
    fresh: 'settled',
    tap: { card: { type: 'gate', id: 'k_gate', gateId: 'g1', closed: gateClosedFor(openGate, 'approved', 'user', 5) } as Card, expect: { state: 'settled', outcome: 'closed' } }
  },
  { type: 'plan', card: { type: 'plan', id: 'k_plan' }, fresh: 'live', tap: { after: [reply('a_progress', [{ type: 'renders', id: 'k_plan_r', targets: [{ kind: 'page', id: p1.id }], label: 'Drawing 1 page' }], 30)], expect: { state: 'settled', outcome: 'passed' } } },
  { type: 'breakdown', card: { type: 'breakdown', id: 'k_bd', view: 'plan' }, fresh: 'live', tap: { after: [laterTurn()], expect: { state: 'settled', outcome: 'passed' } } },
  { type: 'style_choice', card: { type: 'style_choice', id: 'k_sc' }, fresh: 'live', tap: { after: [laterTurn()], doc: { style: { ...base.style, status: 'locked', name: 'Inky noir' } }, expect: { state: 'settled', outcome: 'passed' } } },
  {
    type: 'style_presets',
    card: { type: 'style_presets', id: 'k_sp', presetIds: ['noir-ink', 'watercolor'] },
    fresh: 'live',
    tap: { card: { type: 'style_presets', id: 'k_sp', presetIds: ['noir-ink', 'watercolor'], picked: 'noir-ink' }, after: [laterTurn()], expect: { state: 'settled', outcome: 'picked' } }
  },
  { type: 'cast', card: { type: 'cast', id: 'k_cast', characterIds: ['c_maya'] }, fresh: 'live', tap: { after: [laterTurn()], expect: { state: 'settled', outcome: 'passed' } } },
  { type: 'recap', card: { type: 'recap', id: 'k_recap' }, fresh: 'live', tap: { after: [user('u_tap', 'Make it 6 pages')], expect: { state: 'settled', outcome: 'passed' } } },
  { type: 'renders', card: { type: 'renders', id: 'k_r', targets: [{ kind: 'page', id: p1.id }], label: 'Drawing page 1' }, fresh: 'live', tap: { after: [reply('a_r2', [{ type: 'renders', id: 'k_r2', targets: [{ kind: 'page', id: p1.id }], label: 'Again' }], 30)], expect: { state: 'settled', outcome: 'newer' } } },
  { type: 'versions', card: { type: 'versions', id: 'k_v', target: { kind: 'page', id: p1.id } }, fresh: 'live', tap: { after: [laterTurn()], expect: { state: 'settled', outcome: 'passed' } } },
  { type: 'refs', card: { type: 'refs', id: 'k_refs', owner: { kind: 'character', id: 'c_maya' }, paths: ['u/x/r1.webp'] }, fresh: 'live', tap: { after: [laterTurn()], expect: { state: 'settled', outcome: 'passed' } } },
  { type: 'translation', card: { type: 'translation', id: 'k_tr', languages: ['te'] }, fresh: 'live', tap: { after: [laterTurn()], expect: { state: 'settled', outcome: 'passed' } } },
  { type: 'history', card: { type: 'history', id: 'k_h', view: 'list' } as Card, fresh: 'live', tap: { after: [laterTurn()], expect: { state: 'settled', outcome: 'passed' } } },
  { type: 'share', card: { type: 'share', id: 'k_share' }, fresh: 'live', tap: { after: [laterTurn()], expect: { state: 'settled', outcome: 'passed' } } },
  { type: 'publish', card: { type: 'publish', id: 'k_pub', mode: 'publish', status: 'pending' }, fresh: 'live', tap: { card: { type: 'publish', id: 'k_pub', mode: 'publish', status: 'done' }, expect: { state: 'settled', outcome: 'done' } } },
  {
    type: 'model_outage',
    card: { type: 'model_outage', id: 'k_out', modelId: 'nano-banana', options: [{ kind: 'wait_and_retry' }] as never },
    fresh: 'live',
    tap: { after: [laterTurn()], expect: { state: 'settled', outcome: 'passed' } }
  },
  {
    type: 'notice',
    card: { type: 'notice', id: 'k_n', tone: 'warn', text: 'Page 1 has more words than its panel holds.', fixes: [{ label: 'Use the layout that fits', free: true, action: { type: 'patch', ops: [] } }] },
    fresh: 'live',
    tap: { after: [laterTurn()], expect: { state: 'settled', outcome: 'passed' } }
  },
  { type: 'research', card: { type: 'research', id: 'k_res', query: 'Mumbai rooftops', results: { items: [] } as never }, fresh: 'live', tap: { after: [laterTurn()], expect: { state: 'settled', outcome: 'passed' } } }
];

const docOf = (k: KindCase, conversation: Msg[], extra: Partial<ComicDoc> = {}): ComicDoc => ({ ...base, ...(k.doc || {}), ...extra, conversation });

describe('every card kind, from stored message sequences (Q-SETTLE)', () => {
  it('the table covers every card type the doc can store', () => {
    expect(KINDS.map((k) => k.type).sort()).toEqual(Object.keys(CARD_SETTLE_RULES).sort());
  });

  for (const k of KINDS) {
    describe(k.type, () => {
      const asked = [user('u0', 'Start'), reply('a1', [k.card])];

      it('stays as it is while it is the newest ask', () => {
        expect(settleIn(docOf(k, asked), k.card.id).state).toBe(k.fresh);
      });

      if (k.tap) {
        const tap = k.tap;
        it('(a) settles once the tap is stored, and stays settled after a reload', () => {
          const conv = [user('u0', 'Start'), reply('a1', [tap.card ?? k.card]), ...(tap.after || [])];
          const doc = docOf(k, conv, tap.doc);
          expect(settleIn(doc, k.card.id)).toMatchObject(tap.expect);
          expect(settleIn(reload(doc), k.card.id)).toEqual(settleIn(doc, k.card.id));
        });
      }

      it('(b) settles when the person types a new message instead, and stays settled after a reload', () => {
        const doc = docOf(k, [...asked, user('u1', 'Actually, make it rain first')]);
        expect(settleIn(doc, k.card.id).state).toBe('settled');
        expect(settleIn(reload(doc), k.card.id)).toEqual(settleIn(doc, k.card.id));
      });

      it('(c) settles when a later assistant turn starts with no user message, and stays settled after a reload', () => {
        const doc = docOf(k, [...asked, laterTurn()]);
        expect(settleIn(doc, k.card.id).state).toBe('settled');
        // (d) The same stored doc read again agrees, and so does the index the pane builds.
        const again = reload(doc);
        expect(settleIn(again, k.card.id)).toEqual(settleIn(doc, k.card.id));
        expect(buildSettleIndex(again).get(settleKey('a1', k.card.id))).toEqual(settleIn(doc, k.card.id));
      });

      it('an info-only notice after it is not a new ask: nothing moves on', () => {
        expect(settleIn(docOf(k, [...asked, infoOnly()]), k.card.id).state).toBe(k.fresh);
      });
    });
  }
});

describe('what stays live on purpose', () => {
  it('an open gate stays the one live approval after a typed reply or a later turn; it settles once it closes', () => {
    const card: Card = { type: 'gate', id: 'k_gate', gateId: 'g1' };
    const open = { ...base, gate: openGate };
    for (const after of [user('u1', 'make it rain'), laterTurn()]) {
      expect(settleIn({ ...open, conversation: [reply('a1', [card]), after] }, 'k_gate')).toEqual({ state: 'open' });
    }
    const closed = { ...base, gate: { ...openGate, status: 'declined' as const }, conversation: [reply('a1', [card])] };
    expect(settleIn(closed, 'k_gate')).toEqual({ state: 'settled', outcome: 'closed' });
  });

  it('a running render and a running publish stay live under a later turn', () => {
    const drawing = { ...base, pages: base.pages.map((p, i) => (i === 0 ? { ...p, render: { ...p.render, status: 'rendering' as const } } : p)) };
    const r: Card = { type: 'renders', id: 'k_r', targets: [{ kind: 'page', id: p1.id }], label: 'Drawing page 1' };
    expect(settleIn({ ...drawing, conversation: [reply('a1', [r]), laterTurn()] }, 'k_r')).toEqual({ state: 'live' });
    const pub: Card = { type: 'publish', id: 'k_pub', mode: 'publish', status: 'running' };
    expect(settleIn({ ...base, conversation: [reply('a1', [pub]), laterTurn()] }, 'k_pub')).toEqual({ state: 'live' });
  });
});

describe('options the turn moved past', () => {
  it('a question an action answered past settles, and a later typed answer that matches still picks it', () => {
    const conv = [user('u0', 'Start'), reply('a1', [look]), laterTurn()];
    const doc = { ...base, conversation: conv };
    expect(settleIn(doc, 'k_q')).toEqual({ state: 'settled', outcome: 'skipped' });
    // The person types the answer anyway: it is the most recent unanswered question since their last message.
    const a = buildSettleIndex(doc, { pending: { text: 'Noir ink', status: 'sending' } }).get(settleKey('a1', 'k_q'));
    expect(a).toEqual({ state: 'settled', outcome: 'picked', pending: true, picked: ['c1'] });
  });

  it('nothing chosen: the question disappears entirely (no line); a choice keeps its one line', () => {
    const skipped = { ...base, conversation: [reply('a1', [look]), user('u1', 'never mind')] };
    const s = settleIn(skipped, 'k_q');
    expect(isHiddenSettle(look, s)).toBe(true);
    expect(summaryOf(look, skipped, s, DOLLARS)).toMatchObject({ text: '', folded: true });
    const picked = { ...base, conversation: [reply('a1', [{ ...look, answered: ['c2'] }]), user('u1', 'Crayon')] };
    const ps = settleIn(picked, 'k_q');
    expect(isHiddenSettle(cardIn(picked, 'k_q'), ps)).toBe(false);
    expect(summaryOf(cardIn(picked, 'k_q'), picked, ps, DOLLARS)).toEqual({ text: 'You picked Crayon', tone: 'done' });
  });

  it('suggested looks nobody picked disappear too; a picked look keeps its line', () => {
    const sp: Card = { type: 'style_presets', id: 'k_sp', presetIds: ['noir-ink', 'watercolor'] };
    const passed = { ...base, conversation: [reply('a1', [sp]), laterTurn()] };
    expect(isHiddenSettle(sp, settleIn(passed, 'k_sp'))).toBe(true);
    const picked = { ...base, conversation: [reply('a1', [{ ...sp, picked: 'noir-ink' } as Card]), laterTurn()] };
    expect(isHiddenSettle(cardIn(picked, 'k_sp'), settleIn(picked, 'k_sp'))).toBe(false);
  });

  it('only folded, unanswered questions and unpicked looks hide: every other settled card keeps its line', () => {
    const n: Card = { type: 'notice', id: 'k_n', tone: 'info', text: 'Saved.' };
    expect(isHiddenSettle(n, { state: 'settled', outcome: 'passed' })).toBe(false);
    expect(isHiddenSettle(look, { state: 'open' })).toBe(false);
    expect(isHiddenSettle({ type: 'breakdown', id: 'b', gateId: 'g' }, { state: 'settled', outcome: 'folded' })).toBe(true);
  });
});

describe('movesOn', () => {
  it('a user message and a new assistant turn move on; an info-only notice and an empty message do not', () => {
    expect(movesOn(user('u', 'hi'))).toBe(true);
    expect(movesOn(laterTurn())).toBe(true);
    expect(movesOn(reply('a', [{ type: 'renders', id: 'r', targets: [], label: 'x' }]))).toBe(true);
    expect(movesOn(reply('a', [{ type: 'notice', id: 'n', tone: 'warn', text: 'x', fixes: [{ label: 'Fix', free: true, action: { type: 'patch', ops: [] } }] }]))).toBe(true);
    expect(movesOn(infoOnly())).toBe(false);
    expect(movesOn({ id: 'e', role: 'assistant', text: '', at: 1 })).toBe(false);
    expect(movesOn(undefined)).toBe(false);
  });
});

describe('the queue holds on the newest question', () => {
  it('an info-only notice after an open question still holds the queue', () => {
    const doc = { ...base, conversation: [user('u0', 'Start'), reply('a1', [look]), infoOnly()] };
    expect(isOpenQuestion(doc)).toBe(true);
    expect(isOpenQuestion({ ...doc, conversation: [...doc.conversation, laterTurn()] })).toBe(false);
  });
});

describe('guard: every card type has a settle rule', () => {
  it('the Card union in doc.ts and CARD_SETTLE_RULES name the same types', () => {
    const src = readFileSync(resolve(process.cwd(), 'shared/comic/doc.ts'), 'utf8');
    const union = src.slice(src.indexOf('export type Card ='), src.indexOf(';', src.indexOf('| ConflictCard')));
    const inline = [...union.matchAll(/type:\s*'([a-z_]+)'/g)].map((m) => m[1]);
    // Cards declared as interfaces are named in the union by interface (ConflictCard here, HistoryCard in history/types.ts).
    const files = [src, readFileSync(resolve(process.cwd(), 'shared/comic/history/types.ts'), 'utf8')];
    const iface = (name: string) => {
      for (const file of files) {
        const at = file.indexOf(`export interface ${name}`);
        if (at >= 0) return /type:\s*'([a-z_]+)'/.exec(file.slice(at, at + 400))?.[1];
      }
      return undefined;
    };
    const names = [...union.matchAll(/\|\s*([A-Z][A-Za-z]+Card)\b/g)].map((m) => m[1]);
    expect(names.sort()).toEqual(['ConflictCard', 'HistoryCard']);
    const named = names.map(iface).filter((t): t is string => !!t);
    expect(named).toHaveLength(names.length);
    expect([...new Set([...inline, ...named])].sort()).toEqual(Object.keys(CARD_SETTLE_RULES).sort());
  });

  it('every rule says what the card offers and, where it stays live, why', () => {
    for (const [type, rule] of Object.entries(CARD_SETTLE_RULES)) {
      expect(['question', 'approval', 'view', 'status'], type).toContain(rule.kind);
      expect(rule.settles.length, type).toBeGreaterThan(5);
      if (rule.staysLive !== undefined) expect(rule.staysLive.length, type).toBeGreaterThan(10);
    }
  });

  it('an empty doc never throws', () => {
    expect(buildSettleIndex(createEmptyDoc('p', 'T', 1)).size).toBe(0);
  });
});
