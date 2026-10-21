import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDoc, emptyRender, type Msg } from '../../../shared/comic/doc.js';
import {
  DIRECTOR_SYSTEM_PROMPT,
  HISTORY_WINDOW,
  conversationForDirector,
  maybeFoldMemory,
  runDirectorTurn,
  summarizeDocForDirector
} from './director.js';
import { newSession, plannedDoc, scriptedLlm, testContext } from './orchestrator.fakes.js';
import { StudioError } from './types.js';

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const toolCall = (id: string, name: string, args: unknown) => ({ id, name, arguments: JSON.stringify(args) });

describe('runDirectorTurn', () => {
  it('captures a character, asks one question, and posts a single assistant message with the options card', async () => {
    const session = newSession(createEmptyDoc('proj-1'));
    const llm = scriptedLlm({
      director: [
        {
          text: 'Love it — Maya is in.',
          toolCalls: [
            toolCall('call_1', 'upsert_character', { name: 'Maya', tier: 'lead', look: { summary: 'Wiry courier with a red scarf' } }),
            toolCall('call_2', 'ask_user', { question: 'What tone?', options: [{ label: 'Funny' }, { label: 'Tense' }] })
          ]
        }
      ]
    });
    const ctx = testContext(session, { llm });
    await runDirectorTurn(ctx, { text: 'My hero is Maya, a courier with a red scarf.', attachments: [] });

    const doc = session.doc;
    expect(doc.cast.map((c) => [c.name, c.tier, c.look.summary])).toEqual([['Maya', 'lead', 'Wiry courier with a red scarf']]);
    expect(doc.conversation.map((m) => m.role)).toEqual(['user', 'assistant']);
    const reply = doc.conversation[1];
    expect(reply.text).toBe('Love it — Maya is in.');
    expect(reply.cards).toEqual([expect.objectContaining({ type: 'options', question: 'What tone?' })]);
    expect(reply.suggestions!.length).toBeGreaterThanOrEqual(2);
    // ask_user ended the turn: one model call only.
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].tools!.map((t) => t.function.name)).toContain('upsert_character');
    // Streaming text went to the pre-created message id.
    const deltas = ctx.events.filter((e) => e.type === 'delta');
    expect(deltas).toEqual([{ type: 'delta', msgId: reply.id, text: 'Love it — Maya is in.' }]);
    // Director spend is recorded as chat.
    expect(doc.spend.entries[0]).toMatchObject({ kind: 'chat', label: 'Director', estimated: false });
    expect(ctx.billingFake.reserves[0]).toMatchObject({ operation: 'comic.text.director', stage: 'chat' });
  });

  it('runs a multi-round tool loop with OpenRouter-native tool messages', async () => {
    const session = newSession(createEmptyDoc('proj-1'));
    const llm = scriptedLlm({
      director: [
        { text: '', toolCalls: [toolCall('c1', 'update_brief', { title: 'Spice Run', genre: 'adventure' }), toolCall('c2', 'add_notes', { notes: ['no gore'] })] },
        { text: 'Saved the basics. Want me to show you 3 styles?' }
      ]
    });
    const ctx = testContext(session, { llm });
    await runDirectorTurn(ctx, { text: 'Call it Spice Run, an adventure. No gore.', attachments: [] });

    expect(session.doc.brief).toMatchObject({ title: 'Spice Run', genre: 'adventure', notes: ['no gore'] });
    expect(llm.calls).toHaveLength(2);
    const second = llm.calls[1].messages;
    const assistant = second[second.length - 3];
    expect(assistant).toMatchObject({
      role: 'assistant',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'update_brief' } },
        { id: 'c2', type: 'function', function: { name: 'add_notes' } }
      ]
    });
    expect(second[second.length - 2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'Brief updated: title, genre.' });
    expect(second[second.length - 1]).toEqual({ role: 'tool', tool_call_id: 'c2', content: 'Noted (1 notes total).' });
    expect(session.doc.conversation[1].text).toBe('Saved the basics. Want me to show you 3 styles?');
    // Activities announced for each tool.
    expect(ctx.events.filter((e) => e.type === 'activity').map((e) => (e as { label: string }).label)).toContain('Updating the story');
  });

  it('feeds tool errors back to the model and handles malformed arguments', async () => {
    const session = newSession(createEmptyDoc('proj-1'));
    const llm = scriptedLlm({
      director: [
        { toolCalls: [{ id: 'x1', name: 'set_format', arguments: '{"kind": "novel"' }, toolCall('x2', 'no_such_tool', {})] },
        { text: 'Fixed.' }
      ]
    });
    const ctx = testContext(session, { llm });
    await runDirectorTurn(ctx, { text: 'make it a novel', attachments: [] });
    const toolMsgs = llm.calls[1].messages.filter((m) => m.role === 'tool');
    expect(toolMsgs[0].content).toMatch(/^Error: the arguments for set_format were not valid JSON/);
    expect(toolMsgs[1].content).toBe('Error: unknown tool "no_such_tool".');
  });

  it('stops offering tools after 8 rounds and forces a written answer', async () => {
    const session = newSession(createEmptyDoc('proj-1'));
    const looping = Array.from({ length: 8 }, (_, i) => ({ toolCalls: [toolCall(`n${i}`, 'add_notes', { notes: [`note ${i}`] })] }));
    const llm = scriptedLlm({ director: [...looping, { text: 'Done noting.' }] });
    const ctx = testContext(session, { llm });
    await runDirectorTurn(ctx, { text: 'lots of notes', attachments: [] });
    expect(llm.calls).toHaveLength(9);
    expect(llm.calls[8].tools).toBeUndefined();
    expect(session.doc.brief.notes).toHaveLength(8);
    expect(session.doc.conversation[1].text).toBe('Done noting.');
  });

  it('turns a model failure into an honest notice instead of throwing', async () => {
    const session = newSession(createEmptyDoc('proj-1'));
    const llm = scriptedLlm({ director: [new StudioError('NO_TEXT_KEY', 'Connect a Gemini or OpenRouter key in Settings → API keys.')] });
    const ctx = testContext(session, { llm });
    await expect(runDirectorTurn(ctx, { text: 'hello', attachments: [] })).resolves.toBeUndefined();
    const reply = session.doc.conversation[1];
    expect(reply.cards).toEqual([expect.objectContaining({ type: 'notice', tone: 'error', text: 'Connect a Gemini or OpenRouter key in Settings → API keys.' })]);
    expect(reply.suggestions).toBeUndefined();
  });

  it('a cancelled turn keeps the user message and adds nothing else', async () => {
    const session = newSession(createEmptyDoc('proj-1'));
    const controller = new AbortController();
    const llm = scriptedLlm({
      director: [
        () => {
          controller.abort();
          return new StudioError('CANCELLED', 'Cancelled.');
        }
      ]
    });
    const ctx = testContext(session, { llm, signal: controller.signal });
    await runDirectorTurn(ctx, { text: 'hello', attachments: [] });
    expect(session.doc.conversation.map((m) => m.role)).toEqual(['user']);
  });

  it('shows attached images to the model and lets tools attach them to a character', async () => {
    const session = newSession(createEmptyDoc('proj-1'));
    const attachment = { path: 'u/user-1/p/proj-1/img/up-1.webp', source: 'upload' as const, at: 1 };
    const llm = scriptedLlm({
      director: [{ toolCalls: [toolCall('a1', 'upsert_character', { name: 'Maya', look: { summary: 'from the photo' }, attachmentRefs: [1] })] }, { text: 'Maya now looks like your photo.' }]
    });
    const ctx = testContext(session, { llm });
    ctx.assetsFake.files.set(attachment.path, 'data:image/png;base64,UEhPVE8=');
    await runDirectorTurn(ctx, { text: 'This is Maya', attachments: [attachment] });
    const userTurn = llm.calls[0].messages[llm.calls[0].messages.length - 1];
    expect(userTurn.role).toBe('user');
    expect(userTurn.content).toEqual([
      { type: 'text', text: 'This is Maya' },
      { type: 'text', text: 'Attached image 1:' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,UEhPVE8=' } }
    ]);
    expect(session.doc.conversation[0].attachments).toEqual([attachment]);
    expect(session.doc.cast[0].refs).toEqual([attachment]);
  });

  it('builds the system prompt from the persona, doc summary and memory, and windows history', async () => {
    const doc = plannedDoc();
    doc.memory = '- The user hates purple.\n⟦through:m_old⟧';
    doc.conversation = Array.from({ length: 20 }, (_, i): Msg => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `message ${i}`, at: i }));
    const session = newSession(doc);
    const llm = scriptedLlm({ director: [{ text: 'Sure.' }] });
    await runDirectorTurn(testContext(session, { llm }), { text: 'next', attachments: [] });
    const [system, ...rest] = llm.calls[0].messages;
    expect(system.role).toBe('system');
    expect(system.content).toContain(DIRECTOR_SYSTEM_PROMPT.slice(0, 60));
    expect(system.content).toContain('DOC SUMMARY');
    expect(system.content).toContain('MAYA [c_maya] lead');
    expect(system.content).toContain('- The user hates purple.');
    expect(system.content).not.toContain('⟦through');
    expect(rest[0].role).toBe('user');
    expect(rest.length).toBeLessThanOrEqual(HISTORY_WINDOW);
    expect(rest[rest.length - 1]).toEqual({ role: 'user', content: 'next' });
    expect(JSON.stringify(rest)).not.toContain('message 5"');
  });
});

describe('summaries', () => {
  it('summarizeDocForDirector covers the doc compactly', () => {
    const doc = plannedDoc();
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'p.webp', source: 'generated', at: 1 }, specHash: 'stale-hash', qc: { score: 0.82, issues: [], checkedAt: 1 } };
    doc.gate = { id: 'g', action: { type: 'render_cover' }, title: 'Draw the cover?', summary: '', estimateUsd: 0.07, imageCount: 1, model: 'NB', createdAt: 1, status: 'open', reason: 'policy' };
    const s = summarizeDocForDirector(doc);
    expect(s).toContain('Title: Spice Run | Logline: A courier races through a spice market.');
    expect(s).toContain('Format: comic, 6 pages, 2:3');
    expect(s).toContain('Style: drafted “Ligne claire”');
    expect(s).toContain('- ARJUN [c_arjun] support — Bearded spice vendor in a green kurta; sheet not drawn');
    expect(s).toContain('Places: SPICE MARKET [pl_market]');
    expect(s).toContain('- p1 [out of date, qc 0.82] Page 1 beat (3 panels)');
    expect(s).toContain('Waiting on approval: Draw the cover? ≈ $0.07 (policy)');
    expect(s.length).toBeLessThan(12_000);
  });

  it('conversationForDirector merges same-role turns, summarizes cards and starts with the user', () => {
    const conv: Msg[] = [
      { id: 'a0', role: 'assistant', text: 'Welcome!', at: 0 },
      { id: 'u1', role: 'user', text: 'Hi', at: 1 },
      { id: 'u2', role: 'user', text: '', at: 2, attachments: [{ path: 'x', source: 'upload', at: 2 }] },
      { id: 'a1', role: 'assistant', text: 'Pick one', at: 3, cards: [{ type: 'options', id: 'o', question: 'Tone?', choices: [{ id: '1', label: 'Funny' }, { id: '2', label: 'Dark' }] }, { type: 'style_choice', id: 's' }] }
    ];
    expect(conversationForDirector(conv)).toEqual([
      { role: 'user', content: 'Hi\n\n[1 image(s) attached]' },
      { role: 'assistant', content: 'Pick one [asked: Tone? — options: Funny / Dark] [showed style options to pick from]' }
    ]);
  });
});

describe('memory folding', () => {
  it('folds out-of-window messages once enough accumulate, marking what was covered', async () => {
    const doc = plannedDoc();
    doc.conversation = Array.from({ length: 45 }, (_, i): Msg => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `msg ${i}`, at: i }));
    const session = newSession(doc);
    const llm = scriptedLlm({ director: [{ text: '- Prefers short pages.' }] });
    const ctx = testContext(session, { llm });
    expect(await maybeFoldMemory(ctx)).toBe(true);
    expect(session.doc.memory).toBe(`- Prefers short pages.\n⟦through:m${45 - HISTORY_WINDOW - 1}⟧`);
    expect(llm.calls[0].tools).toBeUndefined();
    // Nothing new since the marker → no second call.
    expect(await maybeFoldMemory(ctx)).toBe(false);
    expect(llm.calls).toHaveLength(1);
    expect(session.doc.spend.entries[0]).toMatchObject({ kind: 'chat', label: 'Conversation memory' });
  });

  it('is fail-soft', async () => {
    const doc = plannedDoc();
    doc.conversation = Array.from({ length: 45 }, (_, i): Msg => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `msg ${i}`, at: i }));
    const session = newSession(doc);
    const ctx = testContext(session, { llm: scriptedLlm({ director: [new Error('down')] }) });
    await expect(maybeFoldMemory(ctx)).resolves.toBe(false);
    expect(session.doc.memory).toBeUndefined();
  });
});
