// @vitest-environment node
// K3 server contract (agent-editor plan §4 0b): the live-agent caps from env, the session stubs, the reserved dialogue
// tool, the conflict stubs and their registration, and the director's three call sites (startRev, the steer drain point
// after each tool round, the conflict card after the loop). Wave 1 replaces the stub bodies; these pin the seams.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { createEmptyDoc, type ConflictCard } from '../../../shared/comic/doc.js';
import { NON_SPEND_ACTION_TYPES } from '../../../shared/comic/ops.js';
import { __resetAccessCacheForTests, studioCapsFor } from './access.js';
import { ACTION_HANDLERS, CORE_ACTION_TYPES, actionHandlerFor } from './actions/index.js';
import { CONFLICT_NOT_AVAILABLE } from './actions/conflict.js';
import * as guard from './conflictGuard.js';
import { runDirectorTurn, steerNoteText } from './director.js';
import { startAction } from './jobs.js';
import { newSession, plannedDoc, scriptedLlm, testContext } from './orchestrator.fakes.js';
import { RECENT_COMMITS_MAX, recentCommitsOf, takeSteerOf, type SteerNote } from './session.js';
import {
  DIALOGUE_EDIT_NOT_AVAILABLE,
  OFFER_NEXT_NOT_AVAILABLE,
  RESERVED_CORE_TOOLS,
  buildDirectorTools,
  createDirectorTurn,
  dialogueEditTool,
  offerNextTool,
  type DirectorTurn
} from './tools.js';

vi.mock('./conflictGuard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./conflictGuard.js')>();
  return { ...actual, conflictCardFor: vi.fn(actual.conflictCardFor) };
});

const req = (userId?: string) => ({ user: userId ? { id: userId } : undefined }) as unknown as Request;
const capsDeps = (admin: boolean, env: Record<string, string | undefined> = {}) => ({
  billingEnabled: true,
  planFor: async () => 'free',
  isAdminFor: async () => admin,
  accountCeilingFor: async () => 'PG-13' as const,
  env
});

beforeEach(() => {
  __resetAccessCacheForTests();
  vi.mocked(guard.conflictCardFor).mockClear();
});

describe('access.ts: the agent-editor flags become caps (D9)', () => {
  it('unset env: queue, conflict guard and Pro editor v2 for admins; steering and the dialogue fast path off', async () => {
    expect(await studioCapsFor(req('u1'), { byok: false }, capsDeps(false))).toMatchObject({
      liveAgent: { queue: false, steer: false, conflicts: false },
      dialogueFast: false,
      proEditorV2: false
    });
    expect(await studioCapsFor(req('a1'), { byok: false }, capsDeps(true))).toMatchObject({
      liveAgent: { queue: true, steer: false, conflicts: true },
      dialogueFast: false,
      proEditorV2: true
    });
  });

  it('each env var is a stage: all opens it to everyone, off closes an admins default, on means admins only', async () => {
    const env = { COMIC_LIVE_QUEUE: 'all', COMIC_STEER: 'admins', COMIC_CONFLICT_GUARD: 'off', COMIC_DIALOGUE_FAST: 'on', COMIC_PRO_EDITOR_V2: 'everyone' };
    expect(await studioCapsFor(req('u2'), { byok: false }, capsDeps(false, env))).toMatchObject({
      liveAgent: { queue: true, steer: false, conflicts: false },
      dialogueFast: false,
      proEditorV2: true
    });
    expect(await studioCapsFor(req('a2'), { byok: false }, capsDeps(true, env))).toMatchObject({
      liveAgent: { queue: true, steer: true, conflicts: false },
      dialogueFast: true,
      proEditorV2: true
    });
  });

  it('a failed admin lookup fails closed: admins-only parts stay off', async () => {
    const caps = await studioCapsFor(req('u3'), { byok: false }, { ...capsDeps(false), isAdminFor: async () => { throw new Error('roles down'); } });
    expect(caps.admin).toBe(false);
    expect(caps.liveAgent).toEqual({ queue: false, steer: false, conflicts: false });
    expect(caps.proEditorV2).toBe(false);
  });
});

describe('session.ts stubs (A2 TURN fills them)', () => {
  it('takeSteer drains nothing, recentCommits is empty, reserveTurn refuses only while a turn runs', async () => {
    const session = newSession(plannedDoc());
    expect(session.takeSteer()).toEqual([]);
    session.commit([{ op: 'brief', patch: { title: 'X' } }], { origin: 'user' });
    expect(session.recentCommits(0)).toEqual([]);
    expect(RECENT_COMMITS_MAX).toBe(300);
    const release = session.reserveTurn();
    expect(typeof release).toBe('function');
    release!();
    let during: unknown = 'unset';
    await session.runExclusive(async () => {
      during = session.reserveTurn();
    });
    expect(during).toBeNull();
    expect(session.turnRunning).toBe(false);
  });

  it('takeSteerOf / recentCommitsOf read a real session and answer [] for a session double', () => {
    const session = newSession(plannedDoc());
    const note: SteerNote = { msgId: 'm_1', text: 'Make it red', at: 1 };
    vi.spyOn(session, 'takeSteer').mockReturnValueOnce([note]);
    expect(takeSteerOf(session)).toEqual([note]);
    const double = { ...testContext(newSession(plannedDoc())).session };
    expect(takeSteerOf(double as never)).toEqual([]);
    expect(recentCommitsOf(double as never, 0)).toEqual([]);
  });
});

describe('tools.ts: the reserved dialogue tool and offer_next (B-TOOL fills them)', () => {
  it('dialogue_edit is a reserved core tool, not offered yet, and refuses honestly naming the tools that work today', async () => {
    const ctx = testContext(newSession(plannedDoc()));
    const turn = createDirectorTurn({ userText: 'make it a whisper' });
    expect(RESERVED_CORE_TOOLS).toEqual(['dialogue_edit']);
    expect(buildDirectorTools(ctx, turn).map((t) => t.spec.function.name)).not.toContain('dialogue_edit');
    const tool = dialogueEditTool(ctx, turn);
    expect(tool.spec.function.name).toBe('dialogue_edit');
    expect(tool.cost).toBe('free');
    expect(tool.spec.function.description.startsWith('FREE — ')).toBe(true);
    const rev = ctx.session.doc.rev;
    expect(await tool.execute({ action: 'set_kind', target: { selected: true }, kind: 'whisper' })).toBe(`Error: ${DIALOGUE_EDIT_NOT_AVAILABLE}`);
    expect(ctx.session.doc.rev).toBe(rev);
    const offer = offerNextTool(ctx, turn);
    expect(offer.spec.function.name).toBe('offer_next');
    expect(await offer.execute({ chips: [{ label: 'A bit higher', say: 'move it up a bit' }] })).toBe(`Error: ${OFFER_NEXT_NOT_AVAILABLE}`);
    expect(turn.nextSteps).toEqual([]);
  });
});

describe('conflict stubs (A3 CONFLICT fills them)', () => {
  it('the guard allows every op; the tool note and the card stay silent until something is held back', () => {
    const ctx = testContext(newSession(plannedDoc()));
    const turn = createDirectorTurn();
    const ops = [{ op: 'brief' as const, patch: { title: 'Y' } }];
    expect(guard.guardUserEdits(ctx, turn, ops)).toEqual({ allowed: ops, blocked: [] });
    expect(guard.conflictToolNote([])).toBe('');
    expect(guard.conflictCardFor(turn)).toBeNull();
  });

  it('a held-back edit is never silent: the tool note names it and the card carries it', () => {
    const turn = createDirectorTurn();
    const blocked = [{ where: { pageId: 'pg_1', lineId: 'ln_1_2', label: 'page 1 · panel 2 · line 1' }, mine: 'We have to go', theirs: 'Run!', proposed: [{ op: 'line' as const, pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_1_2', patch: { text: 'Run!' } }] }];
    expect(guard.conflictToolNote(blocked)).toBe(
      'Conflict: you changed page 1 · panel 2 · line 1 ("We have to go") while I was working, so I left it. Do not redo it; the studio will ask.'
    );
    guard.recordConflicts(turn, blocked);
    const card = guard.conflictCardFor(turn)!;
    expect(card).toMatchObject({ type: 'conflict', items: [{ where: blocked[0].where, mine: 'We have to go', theirs: 'Run!', proposed: blocked[0].proposed }] });
  });

  it('resolve_conflict is a registered free action whose stub refuses NOT_AVAILABLE and changes nothing', async () => {
    expect(NON_SPEND_ACTION_TYPES.has('resolve_conflict')).toBe(true);
    expect(CORE_ACTION_TYPES.has('resolve_conflict')).toBe(false);
    expect(ACTION_HANDLERS.resolve_conflict).toMatchObject({ type: 'resolve_conflict', spend: false });
    expect(actionHandlerFor('resolve_conflict')!.unavailable?.(undefined as never, undefined as never)).toBe(CONFLICT_NOT_AVAILABLE);
    const session = newSession(plannedDoc());
    const pages = session.doc.pages;
    const started = await startAction(testContext(session), { type: 'resolve_conflict', cardId: 'card_cf', itemIds: ['cf_1'], choice: 'theirs' }, { confirmed: true });
    await started.done;
    expect(started.outcome).toMatchObject({ status: 'blocked', code: 'NOT_AVAILABLE', message: CONFLICT_NOT_AVAILABLE });
    expect(session.doc.pages).toBe(pages);
    expect(session.doc.conversation.at(-1)).toMatchObject({ role: 'assistant', text: CONFLICT_NOT_AVAILABLE });
  });
});

describe('director.ts call sites', () => {
  const toolThenReply = () =>
    scriptedLlm({
      director: [
        { text: '', toolCalls: [{ id: 'c1', name: 'update_brief', arguments: JSON.stringify({ title: 'Spice Run' }) }] },
        { text: 'Saved.' }
      ]
    });

  it('drains the steer inbox after each tool round, before the next model call (stub inbox: nothing changes)', async () => {
    const quiet = newSession(createEmptyDoc('proj-1'));
    const llmQuiet = toolThenReply();
    await runDirectorTurn(testContext(quiet, { llm: llmQuiet }), { text: 'Call it Spice Run', attachments: [] });
    const quietRound2 = llmQuiet.calls[1].messages;
    expect(quietRound2.some((m) => m.role === 'user' && String(m.content).includes('added while you were working'))).toBe(false);

    const session = newSession(createEmptyDoc('proj-1'));
    const llm = toolThenReply();
    vi.spyOn(session, 'takeSteer').mockReturnValueOnce([{ msgId: 'm_s', text: 'and make it a whisper', at: 1 }]);
    await runDirectorTurn(testContext(session, { llm }), { text: 'Call it Spice Run', attachments: [] });
    const round2 = llm.calls[1].messages;
    // The note sits after the tool result and before the model's next answer, as one user turn.
    expect(round2.at(-1)).toEqual({ role: 'user', content: '(The user added while you were working:) and make it a whisper' });
    expect(round2.at(-2)).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
    expect(round2.length).toBe(quietRound2.length + 1);
    expect(session.doc.brief.title).toBe('Spice Run');
  });

  it('steerNoteText: one note inline, several numbered in order', () => {
    expect(steerNoteText([{ msgId: 'a', text: '  red  ', at: 1 }])).toBe('(The user added while you were working:) red');
    expect(steerNoteText([{ msgId: 'a', text: 'red', at: 1 }, { msgId: 'b', text: 'bigger', at: 2 }])).toBe('(The user added while you were working:)\n1. red\n2. bigger');
  });

  it('stamps turn.startRev at the turn start and puts a conflict card on the reply when conflictCardFor returns one', async () => {
    const session = newSession(createEmptyDoc('proj-1'));
    const revBefore = session.doc.rev;
    const card: ConflictCard = { type: 'conflict', id: 'card_cf', items: [{ id: 'cf_1', where: { label: 'page 1' }, mine: 'a', theirs: 'b', proposed: [] }] };
    let seen: DirectorTurn | undefined;
    vi.mocked(guard.conflictCardFor).mockImplementationOnce((turn) => {
      seen = turn;
      return card;
    });
    await runDirectorTurn(testContext(session, { llm: toolThenReply() }), { text: 'Call it Spice Run', attachments: [] });
    expect(guard.conflictCardFor).toHaveBeenCalledTimes(1);
    // startRev = the doc as the turn read it (the user's message committed, nothing of the director's yet).
    expect(seen!.startRev).toBeGreaterThan(revBefore);
    expect(seen!.startRev).toBeLessThan(session.doc.rev);
    const reply = session.doc.conversation.at(-1)!;
    expect(reply.role).toBe('assistant');
    expect(reply.cards).toEqual(expect.arrayContaining([card]));
  });

  it('without held-back edits the reply carries no conflict card (today: always)', async () => {
    const session = newSession(createEmptyDoc('proj-1'));
    await runDirectorTurn(testContext(session, { llm: toolThenReply() }), { text: 'Call it Spice Run', attachments: [] });
    expect(guard.conflictCardFor).toHaveBeenCalledTimes(1);
    expect(session.doc.conversation.flatMap((m) => m.cards ?? []).some((c) => c.type === 'conflict')).toBe(false);
  });
});
