// The live queue's pure helpers (agent-editor plan §3 A1, lead decision D1).

import { afterEach, describe, expect, it } from 'vitest';
import type { ComicDoc, Msg } from '../../shared/comic/doc';
import { makeSampleDoc } from './conversation/testing/fixtures';
import {
  add,
  batchesForDrain,
  combinedText,
  drainRequest,
  edit,
  focusKey,
  holdLine,
  holdReason,
  move,
  moveTo,
  noteFocusLabel,
  openQuestion,
  QUEUE_LIMITS,
  QUEUE_NOTE_MAX_CHARS,
  QUEUE_PREFIX,
  QUEUE_STORAGE_PREFIX,
  readStoredQueue,
  remove,
  requeue,
  sanitizeNote,
  sendOutcomeOf,
  writeStoredQueue,
  type QueuedNote
} from './messageQueue';

const note = (id: string, text: string, extra: Partial<QueuedNote> = {}): QueuedNote => ({ id, text, at: 1, ...extra });
const ids = (notes: QueuedNote[]) => notes.map((n) => n.id);
const three = [note('a', 'one'), note('b', 'two'), note('c', 'three')];

const reply = (cards: Msg['cards']): Msg => ({ id: 'm_a', role: 'assistant', text: 'Here you go', at: 2, cards });
const withConversation = (conversation: Msg[], over: Partial<ComicDoc> = {}): ComicDoc => makeSampleDoc({ conversation, ...over });

afterEach(() => window.sessionStorage.clear());

describe('add, edit, remove, move', () => {
  it('add appends a trimmed note and refuses empty, the 11th, over-long and too many photos — leaving the queue as it was', () => {
    const first = add([], note('a', '  make it rain  '));
    expect(first).toMatchObject({ added: true });
    expect(first.notes).toEqual([note('a', 'make it rain')]);

    expect(add(first.notes, note('b', '   '))).toMatchObject({ added: false, reason: 'empty', notes: first.notes });
    // Photos alone are a note.
    expect(add(first.notes, note('p', '', { inboxPaths: ['u/x/inbox/1.webp'] })).added).toBe(true);

    const full = Array.from({ length: QUEUE_LIMITS.notes }, (_, i) => note(`n${i}`, `note ${i}`));
    const refused = add(full, note('x', 'one more'));
    expect(refused).toMatchObject({ added: false, reason: 'full' });
    expect(ids(refused.notes)).toEqual(ids(full));

    expect(add([], note('l', 'x'.repeat(QUEUE_LIMITS.chars + 1)))).toMatchObject({ added: false, reason: 'too_long' });
    // A note must still fit one message once the prefix goes in front of it.
    expect(add([], note('l', 'x'.repeat(QUEUE_LIMITS.chars)))).toMatchObject({ added: false, reason: 'too_long' });
    expect(add([], note('l', 'x'.repeat(QUEUE_NOTE_MAX_CHARS + 1)))).toMatchObject({ added: false, reason: 'too_long' });
    expect(add([], note('l', 'x'.repeat(QUEUE_NOTE_MAX_CHARS)))).toMatchObject({ added: true });
    const paths = Array.from({ length: QUEUE_LIMITS.inboxPaths + 1 }, (_, i) => `u/x/inbox/${i}.webp`);
    expect(add([], note('ph', 'look', { inboxPaths: paths }))).toMatchObject({ added: false, reason: 'too_many_photos' });
  });

  it('edit replaces the text; an empty or over-long edit changes nothing', () => {
    expect(edit(three, 'b', '  two, but louder ').map((n) => n.text)).toEqual(['one', 'two, but louder', 'three']);
    expect(edit(three, 'b', '   ')).toEqual(three);
    expect(edit(three, 'b', 'y'.repeat(QUEUE_LIMITS.chars + 1))).toEqual(three);
    expect(edit(three, 'b', 'y'.repeat(QUEUE_NOTE_MAX_CHARS + 1))).toEqual(three);
    expect(edit(three, 'b', 'y'.repeat(QUEUE_NOTE_MAX_CHARS))[1].text).toHaveLength(QUEUE_NOTE_MAX_CHARS);
    expect(edit(three, 'missing', 'x')).toEqual(three);
  });

  it('remove drops one note', () => {
    expect(ids(remove(three, 'b'))).toEqual(['a', 'c']);
    expect(ids(remove(three, 'zz'))).toEqual(['a', 'b', 'c']);
  });

  it('move steps one place and stops at either end; moveTo clamps', () => {
    expect(ids(move(three, 'c', -1))).toEqual(['a', 'c', 'b']);
    expect(ids(move(three, 'a', 1))).toEqual(['b', 'a', 'c']);
    expect(ids(move(three, 'a', -1))).toEqual(['a', 'b', 'c']);
    expect(ids(move(three, 'c', 1))).toEqual(['a', 'b', 'c']);
    expect(ids(moveTo(three, 'c', 0))).toEqual(['c', 'a', 'b']);
    expect(ids(moveTo(three, 'a', 99))).toEqual(['b', 'c', 'a']);
    expect(ids(moveTo(three, 'a', -5))).toEqual(['a', 'b', 'c']);
  });

  it('requeue puts drained notes back at the head in order, a direct message at the tail, never duplicating', () => {
    const back = [note('x', 'went out'), note('y', 'also out')];
    expect(ids(requeue(three, back, 'head'))).toEqual(['x', 'y', 'a', 'b', 'c']);
    expect(ids(requeue(three, back, 'tail'))).toEqual(['a', 'b', 'c', 'x', 'y']);
    expect(ids(requeue(three, [three[1]], 'head'))).toEqual(['a', 'b', 'c']);
    // Never capped: putting back never loses a note.
    const full = Array.from({ length: QUEUE_LIMITS.notes }, (_, i) => note(`n${i}`, `${i}`));
    expect(requeue(full, back, 'head')).toHaveLength(QUEUE_LIMITS.notes + 2);
  });
});

describe('batchesForDrain and the combined message (D1)', () => {
  it('notes with the same focus drain as ONE numbered message', () => {
    const batches = batchesForDrain(three);
    expect(batches).toHaveLength(1);
    expect(combinedText(batches[0])).toBe(`${QUEUE_PREFIX}\n1. one\n2. two\n3. three`);
    expect(combinedText([note('a', 'only this')])).toBe(`${QUEUE_PREFIX} only this`);
    // A drained message that came back through "Try again" is never prefixed twice.
    expect(combinedText([note('a', `${QUEUE_PREFIX} only this`)])).toBe(`${QUEUE_PREFIX} only this`);
  });

  it('groups by focus: a different page or selection starts a new message, in order', () => {
    const p2 = { pageId: 'pg_2', surface: 'page_editor' as const };
    const sel = { pageId: 'pg_2', lineIds: ['ln_2', 'ln_1'] };
    const notes = [
      note('a', 'general'),
      note('b', 'also general'),
      note('c', 'page two', { focus: p2 }),
      note('d', 'page two again', { focus: { pageId: 'pg_2', surface: 'board' } }),
      note('e', 'those balloons', { focus: sel }),
      note('f', 'same balloons', { focus: { pageId: 'pg_2', lineIds: ['ln_1', 'ln_2'] } }),
      note('g', 'general again')
    ];
    expect(batchesForDrain(notes).map(ids)).toEqual([['a', 'b'], ['c', 'd'], ['e', 'f'], ['g']]);
    // The surface alone is not a different focus; the line order is not either.
    expect(focusKey(p2)).toBe(focusKey({ pageId: 'pg_2' }));
    expect(focusKey(sel)).toBe(focusKey({ pageId: 'pg_2', lineIds: ['ln_1', 'ln_2'] }));
    expect(focusKey(undefined)).toBe('');
  });

  it('a drained message never passes the server cap: a full note fits with its prefix, a full message goes without it', () => {
    const full = note('a', 'x'.repeat(QUEUE_NOTE_MAX_CHARS));
    expect(drainRequest([full]).text).toBe(`${QUEUE_PREFIX} ${full.text}`);
    expect(drainRequest([full]).text).toHaveLength(QUEUE_LIMITS.chars);
    // A 60,000-character message sent straight from the composer that met BUSY comes back as a note (requeue is never
    // capped): it drains without the prefix rather than past the cap the server refuses.
    const message = note('b', 'y'.repeat(QUEUE_LIMITS.chars));
    expect(drainRequest([message]).text).toBe(message.text);
    expect(batchesForDrain([full, message]).map(ids)).toEqual([['a'], ['b']]);
    // A stored note is cut to the same bound.
    expect(sanitizeNote({ id: 'n', text: 'z'.repeat(QUEUE_LIMITS.chars), at: 1 })?.text).toHaveLength(QUEUE_NOTE_MAX_CHARS);
  });

  it('splits where one message would pass the text or photo cap', () => {
    const big = 'x'.repeat(Math.floor(QUEUE_LIMITS.chars / 2));
    expect(batchesForDrain([note('a', big), note('b', big), note('c', 'small')]).map(ids)).toEqual([['a'], ['b', 'c']]);
    const photos = (n: number, from: number) => Array.from({ length: n }, (_, i) => `u/x/inbox/${from + i}.webp`);
    const notes = [note('a', 'these', { inboxPaths: photos(8, 0) }), note('b', 'and these', { inboxPaths: photos(8, 8) })];
    expect(batchesForDrain(notes).map(ids)).toEqual([['a'], ['b']]);
  });

  it('drainRequest carries every photo in order, the quick-assigns aligned, and the shared focus', () => {
    const focus = { pageId: 'pg_1' };
    const req = drainRequest([
      note('a', 'this is Maya', { inboxPaths: ['i/1', 'i/2'], attachmentTargets: [{ kind: 'character', id: 'c_maya' }, null], focus }),
      note('b', 'and a place', { inboxPaths: ['i/3'], focus }),
      note('c', 'no photos', { focus })
    ]);
    expect(req).toEqual({
      text: `${QUEUE_PREFIX}\n1. this is Maya\n2. and a place\n3. no photos`,
      inboxPaths: ['i/1', 'i/2', 'i/3'],
      attachmentTargets: [{ kind: 'character', id: 'c_maya' }, null, null],
      focus
    });
    expect(drainRequest([note('a', 'plain')])).toEqual({ text: `${QUEUE_PREFIX} plain` });
  });
});

describe('holdReason', () => {
  const question = reply([{ type: 'options', id: 'card_q', question: 'Which cover?', choices: [{ id: 'c1', label: 'Moody' }] }]);

  it('holds for an unanswered options card on the last reply, and lets go once it is answered', () => {
    expect(openQuestion(withConversation([question]))).toBe(true);
    expect(holdReason({ doc: withConversation([question]) })).toBe('question');
    const answered = reply([{ type: 'options', id: 'card_q', question: 'Which cover?', choices: [{ id: 'c1', label: 'Moody' }], answered: ['c1'] }]);
    expect(holdReason({ doc: withConversation([answered]) })).toBeNull();
    // Only the LAST reply counts: an older unanswered card does not hold the queue.
    expect(holdReason({ doc: withConversation([question, { id: 'u2', role: 'user', text: 'something else', at: 3 }, reply([])]) })).toBeNull();
  });

  it('holds for a conflict card with an item not yet resolved', () => {
    const item = { id: 'i1', where: { pageId: 'pg_1' }, label: 'page 1 · panel 1', mine: 'a', theirs: 'b', proposed: [] };
    const conflict = reply([{ type: 'conflict', id: 'cf', items: [item] }] as unknown as Msg['cards']);
    expect(holdReason({ doc: withConversation([conflict]) })).toBe('question');
    const resolved = reply([{ type: 'conflict', id: 'cf', items: [{ ...item, resolved: 'mine' }] }] as unknown as Msg['cards']);
    expect(holdReason({ doc: withConversation([resolved]) })).toBeNull();
  });

  it('holds for an open spend gate', () => {
    const gate = { id: 'g1', action: { type: 'render_cover' }, title: 'Draw the cover', summary: '', estimateUsd: 0.07, imageCount: 1, model: 'm', createdAt: 1, status: 'open', reason: 'policy' };
    expect(holdReason({ doc: makeSampleDoc({ gate } as unknown as Partial<ComicDoc>) })).toBe('gate');
    expect(holdReason({ doc: makeSampleDoc({ gate: { ...gate, status: 'approved' } } as unknown as Partial<ComicDoc>) })).toBeNull();
  });

  it('holds after Stop and after a reload, before anything else', () => {
    expect(holdReason({ doc: withConversation([question]), held: 'stopped' })).toBe('stopped');
    expect(holdReason({ doc: withConversation([]), held: 'restored', planning: true })).toBe('restored');
    expect(holdReason({ doc: withConversation([]), held: 'stopped', failed: true })).toBe('stopped');
  });

  it('holds while the last message failed before the server took it — next after Stop and a reload', () => {
    expect(holdReason({ doc: withConversation([]), failed: true })).toBe('failed');
    expect(holdReason({ doc: withConversation([question]), failed: true, planning: true, held: 'elsewhere' })).toBe('failed');
    expect(holdReason({ doc: withConversation([]), failed: false })).toBeNull();
  });

  it('holds while plan_pages has the turn lock, and after BUSY from another tab', () => {
    expect(holdReason({ doc: withConversation([]), planning: true })).toBe('plan_pages');
    expect(holdReason({ doc: withConversation([]), held: 'elsewhere' })).toBe('elsewhere');
    expect(holdReason({ doc: withConversation([]) })).toBeNull();
    expect(holdReason({ doc: null })).toBeNull();
  });

  it('every hold has visible words, and the one tap out of it', () => {
    expect(holdLine(null, 2).text).toMatch(/finishes this step/);
    expect(holdLine('question', 2)).toEqual({ text: 'Answer the question above first, or', action: 'send_anyway' });
    // One string for an open spend gate and an unanswered question (plan §3 A1).
    expect(holdLine('gate', 1)).toEqual({ text: 'Answer the question above first, or', action: 'send_anyway' });
    expect(holdLine('failed', 2)).toEqual({ text: 'Your last message didn’t go. Try again or dismiss it first, or', action: 'send_anyway' });
    expect(holdLine('stopped', 2)).toEqual({ text: 'Stopped. 2 notes are waiting.', action: 'send', clear: true });
    expect(holdLine('restored', 1)).toMatchObject({ text: '1 note was waiting.', action: 'send', clear: true });
    expect(holdLine('elsewhere', 1).text).toMatch(/another tab/);
    expect(holdLine('elsewhere', 1, { retriesLeft: false })).toMatchObject({ text: 'Still busy in another tab or on another device.', action: 'retry' });
    expect(holdLine('plan_pages', 3).text).toMatch(/Planning the pages/);
  });
});

describe('labels and outcomes', () => {
  it('names what a note is about like the focus chip', () => {
    const doc = makeSampleDoc();
    expect(noteFocusLabel(doc, { pageId: 'pg_2', lineIds: ['a', 'b'] })).toBe('Page 2 · 2 balloons');
    expect(noteFocusLabel(doc, { pageId: 'pg_1', panelN: 3 })).toBe('Page 1 · panel 3');
    expect(noteFocusLabel(doc, { pageId: 'pg_gone' })).toBe('A page that was removed');
    expect(noteFocusLabel(doc, undefined)).toBeNull();
  });

  it('reads a void send() as sent', () => {
    expect(sendOutcomeOf(undefined)).toBe('sent');
    expect(sendOutcomeOf('queued')).toBe('queued');
    expect(sendOutcomeOf('refused')).toBe('refused');
  });
});

describe('saved per project in sessionStorage', () => {
  it('round-trips the queue and forgets it once empty', () => {
    const notes = [note('a', 'one', { focus: { pageId: 'pg_1', lineIds: ['ln_1'] } }), note('b', 'two', { inboxPaths: ['i/1'], attachmentTargets: [{ kind: 'style' }] })];
    writeStoredQueue('proj_1', notes);
    expect(readStoredQueue('proj_1')).toEqual(notes);
    expect(readStoredQueue('proj_2')).toEqual([]);
    writeStoredQueue('proj_1', []);
    expect(window.sessionStorage.getItem(QUEUE_STORAGE_PREFIX + 'proj_1')).toBeNull();
  });

  it('drops anything malformed, keeps at most 10, and never throws on junk', () => {
    window.sessionStorage.setItem(QUEUE_STORAGE_PREFIX + 'p', 'not json');
    expect(readStoredQueue('p')).toEqual([]);
    const junk = [null, 7, { id: 'x' }, { id: '', text: 'no id' }, { id: 'ok', text: ' fine ', inboxPaths: [1, 'i/2'], focus: { pageId: 5, lineIds: ['l'] } }];
    window.sessionStorage.setItem(QUEUE_STORAGE_PREFIX + 'p', JSON.stringify({ v: 1, notes: junk }));
    expect(readStoredQueue('p')).toEqual([{ id: 'ok', text: 'fine', inboxPaths: ['i/2'], focus: { lineIds: ['l'] }, at: 0 }]);
    const many = Array.from({ length: 14 }, (_, i) => note(`n${i}`, `n${i}`));
    window.sessionStorage.setItem(QUEUE_STORAGE_PREFIX + 'p', JSON.stringify({ v: 1, notes: many }));
    expect(readStoredQueue('p')).toHaveLength(QUEUE_LIMITS.notes);
    window.sessionStorage.setItem(QUEUE_STORAGE_PREFIX + 'p', JSON.stringify({ v: 2, notes: many }));
    expect(readStoredQueue('p')).toEqual([]);
    expect(sanitizeNote({ id: 'q', text: 'x', attachmentTargets: [{ kind: 'new_character', name: 'Rex', castKind: 'dragon' }], inboxPaths: ['i/1'] })).toEqual({
      id: 'q',
      text: 'x',
      inboxPaths: ['i/1'],
      attachmentTargets: [{ kind: 'new_character', name: 'Rex' }],
      at: 0
    });
  });

  it('a blocked storage never breaks the queue', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      }
    });
    try {
      expect(() => writeStoredQueue('p', three)).not.toThrow();
      expect(readStoredQueue('p')).toEqual([]);
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original);
    }
  });
});
