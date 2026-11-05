import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDoc, emptyRender, type Card, type Msg, type Page } from '../../../shared/comic/doc.js';
import {
  DIRECTOR_SYSTEM_PROMPT,
  HISTORY_WINDOW,
  conversationForDirector,
  maybeFoldMemory,
  recordOptionAnswer,
  runDirectorTurn,
  summarizeDocForDirector
} from './director.js';
import { lakeBriefDoc, lakeDrawnDoc } from './golden/fixtures.js';
import { JOB_TIMINGS, planPagesQuoteText } from './jobs.js';
import { fakeBilling, fakeImages, newSession, plannedDoc, scriptedLlm, testContext } from './orchestrator.fakes.js';
import { StudioError } from './types.js';
import { costFormatter, costViewFor } from './costText.js';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities.js';
import { unitPrice } from '../../../shared/comic/plan.js';
import { getImageModel, tierPagePrice } from '../../../shared/comic/models.js';

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
    // Early turn that learned something: a live recap card leads, then the question.
    expect(reply.cards).toEqual([expect.objectContaining({ type: 'recap' }), expect.objectContaining({ type: 'options', question: 'What tone?' })]);
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

  it('a tapped option is recorded on its card (reload-safe) and the model history reads "answered: …"', async () => {
    const session = newSession(createEmptyDoc('q-1'));
    const llm = scriptedLlm({
      director: [
        { text: 'What tone?', toolCalls: [toolCall('q1', 'ask_user', { question: 'What tone?', options: [{ label: 'Funny', reply: 'Make it funny' }, { label: 'Tense' }] })] },
        { text: 'Funny it is.' }
      ]
    });
    const ctx = testContext(session, { llm });
    await runDirectorTurn(ctx, { text: 'A story about a cat.', attachments: [] });
    const asked = session.doc.conversation.at(-1)!;
    const card = asked.cards!.find((c) => c.type === 'options') as Extract<Card, { type: 'options' }>;
    expect(card.answered).toBeUndefined();
    // The OptionsCard sends the choice's reply as the user's next message.
    await runDirectorTurn(ctx, { text: 'Make it funny', attachments: [] });
    const after = session.doc.conversation.find((m) => m.id === asked.id)!.cards!.find((c) => c.type === 'options') as Extract<Card, { type: 'options' }>;
    // Without the fix nothing ever wrote `answered`: after a reload the chips were live again.
    expect(after.answered).toEqual([card.choices[0].id]);
    expect(session.doc.conversation.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    // The model's history carries the answer by label, not by id.
    expect(JSON.stringify(llm.calls[1].messages)).toContain('[asked: What tone? — options: Funny / Tense; answered: Funny]');
  });

  it('option answers: free text that matches no choice leaves the card open; a multi-select "A and B" records both', async () => {
    const session = newSession(createEmptyDoc('q-2'));
    const llm = scriptedLlm({
      director: [
        { text: 'Which pets?', toolCalls: [toolCall('q1', 'ask_user', { question: 'Which pets?', options: [{ label: 'Cats' }, { label: 'Dogs' }, { label: 'Birds' }], multi: true })] },
        { text: 'Noted.' },
        { text: 'Both then.' }
      ]
    });
    const ctx = testContext(session, { llm });
    await runDirectorTurn(ctx, { text: 'pets?', attachments: [] });
    const asked = session.doc.conversation.at(-1)!;
    const cardOf = () => session.doc.conversation.find((m) => m.id === asked.id)!.cards!.find((c) => c.type === 'options') as Extract<Card, { type: 'options' }>;
    await runDirectorTurn(ctx, { text: 'Something else entirely', attachments: [] });
    expect(cardOf().answered).toBeUndefined();
    await runDirectorTurn(ctx, { text: 'Cats and Birds', attachments: [] });
    expect(cardOf().answered).toEqual([cardOf().choices[0].id, cardOf().choices[2].id]);
  });

  it('option answers named by the card: a typed answer, the right card among same labels, and no guessing past a named card', () => {
    const doc = createEmptyDoc('q-3');
    const yesNo = (id: string): Card => ({
      type: 'options',
      id,
      question: 'Keep it?',
      choices: [
        { id: `${id}_y`, label: 'Yes' },
        { id: `${id}_n`, label: 'No' }
      ],
      allowCustom: true
    });
    doc.conversation = [
      { id: 'a0', role: 'assistant', text: 'First?', at: 1, cards: [yesNo('c_old')] },
      { id: 'a1', role: 'assistant', text: 'Second?', at: 2, cards: [yesNo('c_new')] }
    ];
    const session = newSession(doc);
    const answeredOf = (cardId: string) =>
      (session.doc.conversation.flatMap((m) => m.cards || []).find((c) => c.id === cardId) as Extract<Card, { type: 'options' }>).answered;
    // Two live cards share "Yes": the text alone answers the newest; the named card is the one tapped.
    expect(recordOptionAnswer(session, 'Yes', { id: 'c_old', choiceIds: ['c_old_y'] })).toBe(true);
    expect(answeredOf('c_old')).toEqual(['c_old_y']);
    expect(answeredOf('c_new')).toBeUndefined();
    // Named but already answered (or an id the card does not have): nothing is written, no other card is guessed.
    expect(recordOptionAnswer(session, 'Yes', { id: 'c_old', choiceIds: ['c_old_n'] })).toBe(false);
    expect(recordOptionAnswer(session, 'Yes', { id: 'c_new', choiceIds: ['nope'] })).toBe(false);
    expect(answeredOf('c_new')).toBeUndefined();
    // A typed answer in the card's own field: recorded when it is what was sent.
    expect(recordOptionAnswer(session, 'Only  the first half', { id: 'c_new', custom: 'something else' })).toBe(false);
    expect(recordOptionAnswer(session, 'Only  the first half', { id: 'c_new', custom: 'only the first half' })).toBe(true);
    expect(answeredOf('c_new')).toEqual(['Only the first half']);
    // An unknown card id falls back to the text.
    const s2 = newSession({ ...doc, id: 'q-4', conversation: [{ id: 'a2', role: 'assistant', text: 'Third?', at: 3, cards: [yesNo('c_3')] }] });
    expect(recordOptionAnswer(s2, 'No', { id: 'c_gone', choiceIds: ['x'] })).toBe(true);
    expect((s2.doc.conversation[0].cards![0] as Extract<Card, { type: 'options' }>).answered).toEqual(['c_3_n']);
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
    // First turn, two facts learned, and the model's line names neither: the recap leads (never a duplicate).
    expect(session.doc.conversation[1].text).toBe('Got it — “Spice Run”, an adventure comic. Saved the basics. Want me to show you 3 styles?');
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

  it('stops honoring tools after 8 rounds and forces a written answer (tools still sent)', async () => {
    const session = newSession(createEmptyDoc('proj-1'));
    const looping = Array.from({ length: 8 }, (_, i) => ({ toolCalls: [toolCall(`n${i}`, 'add_notes', { notes: [`note ${i}`] })] }));
    const llm = scriptedLlm({ director: [...looping, { text: 'Done noting.' }] });
    const ctx = testContext(session, { llm });
    await runDirectorTurn(ctx, { text: 'lots of notes', attachments: [] });
    expect(llm.calls).toHaveLength(9);
    // The forced final round KEEPS sending the tool specs (so providers that require `tools`
    // alongside the tool_call history don't 400), and nudges a written reply instead.
    expect(llm.calls[8].tools).toBeDefined();
    const nudged = llm.calls[8].messages.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('Tool limit reached'));
    expect(nudged).toBe(true);
    expect(session.doc.brief.notes).toHaveLength(8);
    expect(session.doc.conversation[1].text).toBe('Done noting.');
  });

  it('checks for a cancel before each tool in a round, so a Stop mid-round runs no further tools', async () => {
    const session = newSession(createEmptyDoc('proj-1'));
    const controller = new AbortController();
    // One round returns two tools, but the user cancels while the model is still responding.
    const llm = scriptedLlm({
      director: [
        () => {
          controller.abort();
          return { toolCalls: [toolCall('n1', 'add_notes', { notes: ['first'] }), toolCall('n2', 'add_notes', { notes: ['second'] })] };
        }
      ]
    });
    const ctx = testContext(session, { llm, signal: controller.signal });
    await runDirectorTurn(ctx, { text: 'note two things', attachments: [] });
    // Neither note is committed: the abort check fires before the first tool executes.
    expect(session.doc.brief.notes).toHaveLength(0);
    expect(session.doc.conversation.map((m) => m.role)).toEqual(['user']);
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
    // The refs package's software hint rides the user turn (refIntentHint WITH the doc: Maya isn't cast yet → "new").
    expect(userTurn.content).toEqual([
      { type: 'text', text: 'This is Maya\n\nREF HINT: (software, may be wrong) image 1 → MAYA (new).' },
      { type: 'text', text: 'Attached image 1:' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,UEhPVE8=' } }
    ]);
    expect(session.doc.conversation[0].attachments).toEqual([attachment]);
    expect(session.doc.cast[0].refs).toEqual([{ ...attachment, addedBy: 'user' }]);
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

  it('an extra reads "text only" until its sheet is ready, then "sheet ready" (the sheet rides on every page it is on)', () => {
    const doc = plannedDoc();
    doc.cast.push(
      { id: 'c_guard', name: 'Guard', tier: 'extra', look: { summary: 'Market guard in a khaki cap' }, refs: [], sheet: emptyRender() },
      {
        id: 'c_cat',
        name: 'Cat',
        tier: 'extra',
        kind: 'animal',
        look: { summary: 'A ginger market cat' },
        refs: [],
        sheet: { ...emptyRender(), status: 'ready', asset: { path: 'cat.webp', source: 'generated', at: 1 } }
      },
      { id: 'c_boy', name: 'Boy', tier: 'extra', look: { summary: 'A boy with a kite' }, refs: [], sheet: { ...emptyRender(), status: 'queued' } }
    );
    const s = summarizeDocForDirector(doc);
    expect(s).toContain('- GUARD [c_guard] extra — Market guard in a khaki cap; text only');
    expect(s).toContain('- CAT [c_cat] extra, animal — A ginger market cat; sheet ready');
    // A sheet still being drawn is not attached yet: the extra is still described in words.
    expect(s).toContain('- BOY [c_boy] extra — A boy with a kite; text only');
    // Leads and supports are unchanged.
    expect(s).toContain('- ARJUN [c_arjun] support — Bearded spice vendor in a green kurta; sheet not drawn');
  });

  it('an unlocked comic with a model override is quoted on that model: the Settings line prices what it names', () => {
    // change_image_model on a comic with nothing drawn only sets the override (no lock yet): the line named the
    // override's model but priced the tier preset (about 2.5x too little per page on Nano Banana Pro).
    const doc = plannedDoc();
    doc.settings = { ...doc.settings, imageModelOverride: 'nano-banana-pro' };
    expect(doc.imageModel).toBeUndefined();
    expect(getImageModel('nano-banana-pro')).toBeTruthy();
    const c = costFormatter();
    const page = unitPrice(doc, 'page', { byok: false });
    const cover = unitPrice(doc, 'cover', { byok: false });
    expect(page.model).toBe('Nano Banana Pro');
    // The override really prices differently from the tier preset, so the assertion below can tell them apart.
    expect(c.approx(page.usd)).not.toBe(c.approx(tierPagePrice(doc.settings.quality, false)));
    const s = summarizeDocForDirector(doc);
    const settings = s.split('\n').find((l) => l.startsWith('Settings:'))!;
    expect(settings).toContain('Nano Banana Pro');
    expect(settings).not.toContain('(locked)');
    expect(settings).toContain(`${c.approx(page.usd)}/page`);
    expect(settings).toContain(`cover ${c.approx(cover.usd)}`);
    // BYOK: the provider price of the same model.
    const byok = summarizeDocForDirector(doc, true).split('\n').find((l) => l.startsWith('Settings:'))!;
    expect(byok).toContain(`${c.approx(unitPrice(doc, 'page', { byok: true }).usd)}/page`);
  });

  it('before a plan exists, the summary quotes planning with its honest "up to" bound, in usage words for governed users', () => {
    const doc = plannedDoc();
    doc.pages = [];
    doc.planStatus = 'none';
    doc.format = { ...doc.format, pageCount: 6 };
    const dollars = summarizeDocForDirector(doc);
    expect(dollars).toContain(`Planning the pages: ${planPagesQuoteText(doc, costFormatter(), false)}`);
    expect(dollars).toMatch(/Planning the pages: ≈ \$\d+\.\d\d for 6 pages \(up to ≈ \$\d+\.\d\d if the plan needs its one writer repair\)/);
    // The exact figures the docs quote (comic-studio-v4.md §6.10): 0.012 × 6 × 1.3 = $0.0936, bound 2 × that.
    expect(dollars).toContain('Planning the pages: ≈ $0.09 for 6 pages (up to ≈ $0.19 if the plan needs its one writer repair)');
    // The tail is never clipped: the line sits with the money lines, after the body.
    expect(dollars.indexOf('Planning the pages:')).toBeGreaterThan(dollars.indexOf('Settings:'));
    // BYOK quotes the provider price (no platform markup).
    expect(summarizeDocForDirector(doc, true)).toContain(`Planning the pages: ${planPagesQuoteText(doc, costFormatter(), true)}`);
    const governed = summarizeDocForDirector(doc, false, [], { cost: costFormatter(costViewFor({ ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 50, exhausted: false, pctPerStandardPage: 1 } })) });
    expect(governed).toMatch(/Planning the pages: (≈[\d.]+|<0\.1)% of your usage for 6 pages \(up to (≈[\d.]+|<0\.1)% of your usage if the plan needs its one writer repair\)/);
    expect(governed).not.toMatch(/\$/);
    // Once planned, the line goes away (the "Plan" body line and the draw quotes take over).
    expect(summarizeDocForDirector(plannedDoc())).not.toContain('Planning the pages:');
  });

  it('a big book clips the body, never the tail: settings, spend, the open approval, the focus and the feature lines survive', () => {
    // At DOC_LIMITS (40 pages × 4 panels, 24 cast with full looks, 14 long notes, 8 places) the full
    // summary is ~17k chars; without compaction the end — exactly the money/gate/focus lines — was cut.
    const doc = createEmptyDoc('big-1', 'The Long Voyage');
    doc.brief = { ...doc.brief, logline: 'A crew of friends sails across a sea of islands to find a lost lighthouse.', premise: 'Lorem ipsum '.repeat(50), notes: Array.from({ length: 14 }, (_, i) => `Note ${i + 1}: ${'keep the tone warm and the jokes gentle, '.repeat(4)}`) };
    doc.cast = Array.from({ length: 24 }, (_, i) => ({
      id: `c_${i}`, name: `Crew Member ${i + 1}`, tier: i < 2 ? ('lead' as const) : ('support' as const), role: 'deckhand with a secret past and a loud laugh',
      look: { summary: `A ${['tall', 'short', 'wiry', 'round'][i % 4]} sailor with ${['braided', 'cropped', 'curly', 'long'][i % 4]} hair, a weathered coat, brass buttons, a scar on the left cheek and bright eyes` },
      refs: [], sheet: emptyRender()
    }));
    doc.places = Array.from({ length: 8 }, (_, i) => ({ id: `pl_${i}`, name: `Island ${i + 1}`, look: 'Rocky shore, a crooked pier, fishing huts and gulls everywhere', refs: [], sheet: emptyRender() }));
    const page = (n: number): Page => ({
      id: `pg_${n}`, n, summary: `Page ${n}: the crew lands on island ${n} and meets someone new who changes the plan in a surprising way`, layout: '', balloons: [], render: emptyRender(),
      panels: [1, 2, 3, 4].map((k) => ({ id: `pn_${n}_${k}`, n: k, size: 'medium' as const, shot: 'medium' as const, action: `Action ${n}.${k}`, castIds: ['c_0'], lines: [{ id: `ln_${n}_${k}`, kind: 'speech' as const, speakerId: 'c_0', text: `Line ${n}.${k}` }] }))
    });
    doc.pages = Array.from({ length: 40 }, (_, i) => page(i + 1));
    doc.planStatus = 'approved';
    doc.gate = { id: 'gate_1', action: { type: 'render_pages' }, title: 'Draw pages 1–40?', summary: '', estimateUsd: 2.4, imageCount: 40, model: 'Nano Banana 2.1', createdAt: Date.now(), status: 'open', reason: 'policy' };
    const governed = costFormatter(costViewFor({ ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 50, exhausted: false, pctPerStandardPage: 1 } }));
    const out = summarizeDocForDirector(doc, false, ['Undo available: restyle 3 balloons'], {
      userText: 'make these red',
      focus: { pageId: 'pg_40', lineIds: ['ln_40_1', 'ln_40_2'], surface: 'page_editor' },
      cost: governed
    });
    expect(out.length).toBeLessThanOrEqual(12_000);
    // Without the fix these four (and the governed instruction) were sliced off the end.
    expect(out).toContain('Settings:');
    expect(out).toContain('Spend so far');
    expect(out).toContain('never in dollars');
    expect(out).toContain('Waiting on approval: Draw pages 1–40?');
    expect(out).toContain('Focus: the user is looking at page 40; selected balloons — p40 panel 1: “Line 40.1” (speech); p40 panel 2: “Line 40.2” (speech)');
    expect(out).toContain('Undo available: restyle 3 balloons');
    // The tail is last, and the body was compacted rather than cut mid-line: every page and cast id is still there.
    expect(out.indexOf('Settings:')).toBeGreaterThan(out.indexOf('- p40 '));
    expect(out).toContain('- p40 [not drawn]');
    expect(out).not.toContain('- p40 [not drawn] Page 40');
    expect(out).toContain('- CREW MEMBER 24 [c_23] support');
    expect(out).not.toContain('- Note 1:');
    expect(out).toContain('- Note 14:');
    // A small book is untouched by the compaction.
    expect(summarizeDocForDirector(plannedDoc())).toContain('- p1 [not drawn] Page 1 beat (3 panels)');
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

  it('runs after the turn, outside the turn lock: the next message is not refused while the fold is out', async () => {
    const doc = plannedDoc();
    doc.conversation = Array.from({ length: 45 }, (_, i): Msg => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `msg ${i}`, at: i }));
    const session = newSession(doc);
    let releaseFold!: () => void;
    const foldHeld = new Promise<void>((r) => (releaseFold = r));
    let folds = 0;
    const llm = scriptedLlm({
      director: [
        { text: 'Noted.' },
        async () => {
          folds += 1;
          await foldHeld;
          return { text: '- Prefers short pages.' };
        },
        { text: 'Still here.' }
      ]
    });
    const ctx = testContext(session, { llm });
    // The route runs the turn under the session lock (routes/comic.ts runMessage).
    const turn = session.runExclusive(() => runDirectorTurn(ctx, { text: 'keep pages short', attachments: [] }));
    const first = await Promise.race([turn.then(() => 'released'), new Promise((r) => setTimeout(() => r('held'), 200))]);
    // Before: the fold's model call ran inside the lock, so the turn (and the lock) waited for it.
    expect(first).toBe('released');
    expect(folds).toBe(1);
    expect(session.turnRunning).toBe(false);
    expect(session.doc.conversation[session.doc.conversation.length - 1].text).toBe('Noted.');
    // A second turn ends while the first fold is still out: no second fold (one per session at a time).
    await session.runExclusive(() => runDirectorTurn(ctx, { text: 'and bright colors', attachments: [] }));
    expect(folds).toBe(1);
    expect(llm.calls).toHaveLength(3);
    releaseFold();
    // The request's stream stays open for the fold (ctx.track), and the memory lands.
    await ctx.settled();
    expect(session.doc.memory).toMatch(/^- Prefers short pages\.\n⟦through:m\d+⟧$/);
    expect(session.doc.spend.entries.some((e) => e.label === 'Conversation memory')).toBe(true);
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

// ── v5 (P1-DIRECTOR): never silent, honest, understands non-human cast ───────

const lakePlanJson = {
  pages: [
    {
      n: 1,
      summary: 'The baby splashes at the lake with ducklings, a frog and a bunny.',
      layout: 'Row 1: one wide panel. Row 2: two equal panels.',
      turnHook: '',
      panels: [1, 2, 3].map((n) => ({
        n,
        size: n === 1 ? 'wide' : 'medium',
        shot: n === 1 ? 'establishing' : 'medium',
        angle: '',
        action: ['The Baby splashes while three Ducklings paddle close.', 'Frog hops onto a lily pad by the Baby.', 'Bunny peeks from the reeds; everyone waves.'][n - 1],
        castIds: [['The Baby', 'Ducklings'], ['The Baby', 'Frog'], ['The Baby', 'Bunny']][n - 1],
        placeId: '',
        mood: '',
        lines: []
      }))
    }
  ],
  newCast: []
};

describe('runDirectorTurn — never silent (contract §12.2)', () => {
  beforeEach(() => {
    JOB_TIMINGS.retryBackoffMs = 0;
    JOB_TIMINGS.turnLockWaitMs = 20;
  });

  it('#1 ask_user only, no text: "Got it — recap." ending with the question, one model call', async () => {
    const session = newSession(createEmptyDoc('proj-1'));
    const llm = scriptedLlm({
      director: [
        {
          text: '',
          toolCalls: [
            toolCall('a', 'update_brief', { premise: 'A baby plays near a lake with friendly animals.', audience: 'kids 2–6', setting: 'a sunny lake shore' }),
            toolCall('b', 'set_format', { kind: 'storybook', pageCount: 1, pageAspect: '4:5' }),
            toolCall('c', 'upsert_character', { name: 'The Baby', tier: 'lead', look: { summary: 'Chubby toddler in a yellow sunhat' } }),
            toolCall('d', 'upsert_character', { name: 'Ducklings', kind: 'animal', count: 3, look: { summary: 'Fluffy yellow ducklings', species: 'duckling' } }),
            toolCall('e', 'upsert_character', { name: 'Frog', kind: 'animal', look: { summary: 'Round green frog', species: 'frog' } }),
            toolCall('f', 'upsert_character', { name: 'Bunny', kind: 'animal', look: { summary: 'Small grey bunny', species: 'rabbit' } }),
            toolCall('g', 'ask_user', { question: 'Which art style?', options: [{ label: 'Watercolor storybook' }, { label: 'Bright cartoon' }] })
          ]
        }
      ]
    });
    await runDirectorTurn(testContext(session, { llm }), { text: 'baby playing near a lake with other naimals a kids commic single page.', attachments: [] });
    const reply = session.doc.conversation[1];
    expect(llm.calls).toHaveLength(1);
    expect(reply.text.startsWith('Got it — a 1-page storybook for kids 2–6, set at a sunny lake shore — The Baby with three Ducklings, a Frog and a Bunny.')).toBe(true);
    expect(reply.text.endsWith('Which art style?')).toBe(true);
    expect(reply.cards!.map((c) => c.type)).toEqual(['recap', 'options']);
    expect(session.doc.cast.map((c) => [c.name, c.kind ?? 'person', c.count ?? 1])).toEqual([
      ['The Baby', 'person', 1],
      ['Ducklings', 'animal', 3],
      ['Frog', 'animal', 1],
      ['Bunny', 'animal', 1]
    ]);
  });

  it('#2 plan + options, no text: the plan in one line and the question', async () => {
    const doc = lakeBriefDoc();
    doc.conversation = [{ id: 'u0', role: 'user', text: 'a lake story', at: 1 }, { id: 'a0', role: 'assistant', text: 'Got it.', at: 2 }];
    const session = newSession(doc);
    const llm = scriptedLlm({
      director: [
        { toolCalls: [toolCall('s', 'set_style', { presetId: 'watercolor-storybook' }), toolCall('p', 'plan_pages', {})] },
        { toolCalls: [toolCall('q', 'ask_user', { question: 'Ready to draw?', options: [{ label: 'Draw it', reply: 'Draw it' }, { label: 'Change something' }] })] }
      ],
      writer: [{ json: lakePlanJson }]
    });
    await runDirectorTurn(testContext(session, { llm }), { text: 'Use watercolor storybook style', attachments: [] });
    const reply = session.doc.conversation[session.doc.conversation.length - 1];
    expect(reply.role).toBe('assistant');
    expect(reply.text).toContain("Here's the plan — 1 page, 3 panels");
    expect(reply.text.endsWith('Ready to draw?')).toBe(true);
  });

  it('#3 a gate only: the price and "Approve"', async () => {
    const doc = plannedDoc();
    doc.settings.confirm = 'always';
    for (const p of doc.pages) p.render = { ...emptyRender(), status: 'ready', asset: { path: `${p.id}.webp`, source: 'generated', at: 1 } };
    const session = newSession(doc);
    const llm = scriptedLlm({ director: [{ toolCalls: [toolCall('c', 'render_cover', {})] }, { text: '' }] });
    await runDirectorTurn(testContext(session, { llm }), { text: 'make the cover', attachments: [] });
    const reply = session.doc.conversation[session.doc.conversation.length - 1];
    expect(reply.text).toMatch(/≈ \$\d+\.\d\d/);
    expect(reply.text).toContain('Approve');
    expect(reply.cards!.map((c) => c.type)).toContain('gate');
  });

  it('#5 recap card on turn 1 when the brief gained 2+ fields; not on turn 5 when only a note changed', async () => {
    const session = newSession(createEmptyDoc('proj-1'));
    const llm = scriptedLlm({ director: [{ text: 'Lovely.', toolCalls: [toolCall('a', 'update_brief', { title: 'Splash Day', audience: 'kids 2–6' })] }, { text: 'Saved.' }] });
    await runDirectorTurn(testContext(session, { llm }), { text: 'Splash Day, for little kids', attachments: [] });
    expect(session.doc.conversation[1].cards?.[0]).toMatchObject({ type: 'recap' });
    const later = plannedDoc();
    later.conversation = Array.from({ length: 8 }, (_, i): Msg => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `m${i}`, at: i }));
    const s2 = newSession(later);
    const l2 = scriptedLlm({ director: [{ text: 'Noted.', toolCalls: [toolCall('n', 'add_notes', { notes: ['no gore'] })] }, { text: '' }] });
    await runDirectorTurn(testContext(s2, { llm: l2 }), { text: 'no gore please', attachments: [] });
    const reply = s2.doc.conversation[s2.doc.conversation.length - 1];
    expect(reply.cards?.some((c) => c.type === 'recap')).toBeFalsy();
    expect(reply.text).toBe('Noted.');
  });

  it('#6 spend guard: "the cover is bad" + render_cover → quoted (gate), never started, even at $0.07', async () => {
    const doc = plannedDoc();
    doc.settings = { ...doc.settings, confirm: 'big', bigSpendUsd: 0.5 };
    doc.cover.render = { ...emptyRender(), status: 'ready', asset: { path: 'cover.webp', source: 'generated', at: 1 } };
    const session = newSession(doc);
    const llm = scriptedLlm({ director: [{ toolCalls: [toolCall('c', 'render_cover', { direction: 'show the baby from the photo' })] }, { text: '' }] });
    const ctx = testContext(session, { llm });
    await runDirectorTurn(ctx, { text: "the cover is bad it doesn't represent the baby picture", attachments: [] });
    await ctx.settled();
    expect(ctx.imagesFake.calls).toHaveLength(0);
    expect(session.doc.gate).toMatchObject({ status: 'open' });
    expect(['no_intent', 'redraw']).toContain(session.doc.gate!.reason);
    const toolMsg = llm.calls[1].messages.find((m) => m.role === 'tool');
    expect(String(toolMsg?.content)).toMatch(/^Quoted ≈? ?\$\d+\.\d\d/);
    expect(session.doc.conversation[session.doc.conversation.length - 1].text).toContain('tap Approve');
  });

  it('#7 a plan written this turn is never drawn in the same turn (unless "just draw it now")', async () => {
    const run = async (text: string) => {
      const session = newSession(lakeBriefDoc());
      const llm = scriptedLlm({
        director: [{ toolCalls: [toolCall('p', 'plan_pages', {})] }, { toolCalls: [toolCall('r', 'render_pages', {})] }, { text: '' }],
        writer: [{ json: lakePlanJson }]
      });
      const ctx = testContext(session, { llm });
      await runDirectorTurn(ctx, { text, attachments: [] });
      await ctx.settled();
      return { llm, ctx, session };
    };
    const lastToolResult = (llm: ReturnType<typeof scriptedLlm>) =>
      String(llm.calls.filter((c) => c.role === 'director')[2].messages.filter((m) => m.role === 'tool').pop()?.content);
    const refused = await run('plan it and draw it');
    expect(lastToolResult(refused.llm)).toMatch(/^Refused: the user hasn't seen this plan yet/);
    expect(refused.ctx.imagesFake.calls).toHaveLength(0);
    expect(refused.session.doc.conversation[refused.session.doc.conversation.length - 1].text).toMatch(/^Here's the plan — 1 page, 3 panels/);
    const skipped = await run('plan it and just draw it now');
    expect(lastToolResult(skipped.llm)).not.toMatch(/^Refused/);
  });

  it('a bare "yes" to the studio\'s own "draw page 2?" draws (no extra Approve tap); a non-answer only quotes', async () => {
    const run = async (answer: string) => {
      const doc = plannedDoc();
      doc.planStatus = 'approved';
      doc.settings = { ...doc.settings, confirm: 'big', bigSpendUsd: 0.5 };
      doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'p1.webp', source: 'generated', at: 1 } };
      doc.conversation = [
        { id: 'u0', role: 'user', text: 'draw page 1', at: 1 },
        { id: 'a0', role: 'assistant', text: 'Page 1 is ready. Want me to draw page 2 next (≈ $0.07)?', at: 2 }
      ];
      const session = newSession(doc);
      const llm = scriptedLlm({ director: [{ text: 'On it.', toolCalls: [toolCall('r', 'render_pages', { pages: [2] })] }, { text: '' }] });
      const ctx = testContext(session, { llm });
      await runDirectorTurn(ctx, { text: answer, attachments: [] });
      await ctx.settled();
      return { session, ctx };
    };
    const yes = await run('yes');
    expect(yes.session.doc.gate?.status === 'open').toBe(false);
    expect(yes.ctx.imagesFake.calls.length).toBeGreaterThan(0);
    const unrelated = await run('nice colours');
    expect(unrelated.session.doc.gate).toMatchObject({ status: 'open', reason: 'no_intent' });
    expect(unrelated.ctx.imagesFake.calls).toHaveLength(0);
  });

  it('never silent even when the turn breaks outside the model loop', async () => {
    const doc = plannedDoc();
    (doc.pages[0].render as { qc?: unknown }).qc = { issues: [] }; // a malformed qc (no score) no longer breaks the summary…
    const session = newSession(doc);
    const llm = scriptedLlm({ director: [{ text: 'never reached' }] });
    const ctx = testContext(session, { llm });
    // …but anything else that throws before the model loop still gets an honest reply.
    Object.defineProperty(ctx, 'rating', { get: () => { throw new Error('boom'); } });
    await expect(runDirectorTurn(ctx, { text: 'hello there', attachments: [] })).resolves.toBeUndefined();
    const reply = session.doc.conversation[session.doc.conversation.length - 1];
    expect(reply.role).toBe('assistant');
    expect(reply.text).toBe("Sorry — I couldn't finish that just now. Try again in a moment.");
    expect(reply.nextSteps).toEqual([{ label: 'Try again', say: 'hello there' }]);
    const s2 = newSession(doc);
    await runDirectorTurn(testContext(s2, { llm: scriptedLlm({ director: [{ text: 'Hi!' }] }) }), { text: 'hello', attachments: [] });
    expect(s2.doc.conversation[s2.doc.conversation.length - 1].text).toBe('Hi!');
  });

  it('a stop after a tool card says "Stopped." once (never "Stopped. (stopped)")', async () => {
    const session = newSession(plannedDoc());
    const controller = new AbortController();
    const llm = scriptedLlm({
      director: [{ text: '', toolCalls: [toolCall('q', 'ask_user', { question: 'Which?', options: ['A', 'B'] }), toolCall('n', 'add_notes', { notes: ['x'] })] }]
    });
    const ctx = testContext(session, { llm, signal: controller.signal });
    // The user taps Stop right after the first tool (ask_user) finishes.
    const off = session.subscribe((e) => {
      if (e.type === 'activity' && e.phase === 'end') controller.abort();
    });
    await runDirectorTurn(ctx, { text: 'hm', attachments: [] });
    off();
    expect(session.doc.brief.notes).toHaveLength(0);
    const reply = session.doc.conversation[session.doc.conversation.length - 1];
    expect(reply.role).toBe('assistant');
    expect(reply.text).toBe('Stopped.');
    expect(reply.cards?.map((c) => c.type)).toEqual(['options']);
  });

  it('production bug (b4b5774f): the reply never claims runs that already failed are under way', async () => {
    const session = newSession(createEmptyDoc('proj-1'));
    const images = fakeImages(() => new StudioError('PROVIDER_ERROR', 'The image service had a problem.', { status: 502, retryable: false }));
    let ctxRef: ReturnType<typeof testContext>;
    const allFailed = async () => {
      for (let i = 0; i < 200; i += 1) {
        const opts = ctxRef.session.doc.style.options;
        if (opts.length === 3 && opts.every((o) => o.render.status === 'failed')) return;
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    const llm = scriptedLlm({
      director: [
        {
          toolCalls: [
            toolCall('s', 'propose_styles', {
              directions: [
                { name: 'Ink', spec: 'Bold ink outlines, flat colors, strong blacks, comic halftone dots.' },
                { name: 'Watercolor', spec: 'Soft watercolor washes, pencil lines, warm pastel palette.' },
                { name: 'Pop', spec: 'Retro pop art, thick outlines, Ben-Day dots, primary colors.' }
              ]
            })
          ]
        },
        async () => {
          await allFailed(); // the renders fail before the model writes its line (7 s in production)
          return { text: "I've kicked off 3 style tests — tap one when they land!" };
        }
      ]
    });
    ctxRef = testContext(session, { llm, images });
    await runDirectorTurn(ctxRef, { text: 'show me some styles', attachments: [] });
    const assistant = session.doc.conversation.filter((m) => m.role === 'assistant');
    expect(assistant.some((m) => /kicked off/.test(m.text))).toBe(false);
    const reply = assistant.find((m) => /^3 style tests didn't come through/.test(m.text))!;
    expect(reply.text).toBe("3 style tests didn't come through — the image service had a problem. Nothing new was drawn — tap Try again or ask me to retry.");
    expect(reply.nextSteps?.[0]).toMatchObject({ label: 'Try again', action: { type: 'render_style_options' } });
    await ctxRef.settled();
  });

  it('a provider refusal gets the warm deterministic redirect (options, no error wall, no strike)', async () => {
    for (const step of [new StudioError('SAFETY_BLOCKED', "The AI provider's safety filter blocked this request."), { text: "I'm sorry, but I can't help with that." }]) {
      const session = newSession(plannedDoc());
      await runDirectorTurn(testContext(session, { llm: scriptedLlm({ director: [step] }) }), { text: 'a zombie bites the hero', attachments: [] });
      const reply = session.doc.conversation[session.doc.conversation.length - 1];
      expect(reply.text).toBe("That one tripped the AI's filter — I can try a toned-down version that keeps the idea.");
      expect(reply.cards!.map((c) => c.type)).toEqual(['options']);
      expect(reply.cards!.some((c) => c.type === 'notice')).toBe(false);
    }
  });

  it('a model failure is honest text + an error notice + a Try again chip', async () => {
    const session = newSession(plannedDoc());
    await runDirectorTurn(testContext(session, { llm: scriptedLlm({ director: [new StudioError('TIMEOUT', 'The director took too long to answer.')] }) }), { text: 'hello', attachments: [] });
    const reply = session.doc.conversation[1];
    expect(reply.text).toMatch(/^Sorry — I couldn't finish that just now\./);
    expect(reply.nextSteps).toEqual([{ label: 'Try again', say: 'hello' }]);
  });

  it('a used-up allowance is said in the reply itself, with no "try again in a moment" and no Try-again chip', async () => {
    // billing denies the director's text call (included usage exhausted): waiting changes nothing,
    // so the honest reason is the message the user reads, not only a card under a generic apology.
    const session = newSession(plannedDoc());
    const llm = scriptedLlm({ director: [{ text: 'never reached' }] });
    await runDirectorTurn(testContext(session, { llm, billing: fakeBilling(0) }), { text: 'make page 1 funnier', attachments: [] });
    const reply = session.doc.conversation.at(-1)!;
    expect(reply.role).toBe('assistant');
    expect(reply.text).toBe("You've used this month's included generation allowance.");
    expect(reply.text).not.toMatch(/try again in a moment/i);
    expect(reply.nextSteps ?? []).not.toContainEqual(expect.objectContaining({ label: 'Try again' }));
    expect(reply.cards).toBeUndefined(); // said once, not duplicated as a notice
    expect(reply.suggestions).toBeUndefined();

    // When the model already spoke before the denial, its words stay and the reason rides as the notice.
    const spoke = newSession(plannedDoc());
    const llm2 = scriptedLlm({ director: [{ text: 'Noting that.', toolCalls: [toolCall('n', 'add_notes', { notes: ['funnier'] })] }, { text: 'never reached' }] });
    await runDirectorTurn(testContext(spoke, { llm: llm2, billing: fakeBilling(1) }), { text: 'make page 1 funnier', attachments: [] });
    const partial = spoke.doc.conversation.at(-1)!;
    expect(partial.text).toContain('Noting that.');
    expect(partial.cards).toEqual([expect.objectContaining({ type: 'notice', tone: 'error', text: "You've used this month's included generation allowance." })]);
    expect(partial.nextSteps ?? []).not.toContainEqual(expect.objectContaining({ label: 'Try again' }));
  });

  it('named IP: an IP NOTE steers to an original homage, said once', async () => {
    const session = newSession(createEmptyDoc('proj-1'));
    const llm = scriptedLlm({
      director: [{ toolCalls: [toolCall('c', 'upsert_character', { name: 'Chintu', tier: 'lead', look: { summary: 'Cheeky 5-year-old in a red tee and yellow shorts' } })] }, { text: '' }, { text: 'Sure.' }]
    });
    const ctx = testContext(session, { llm });
    await runDirectorTurn(ctx, { text: 'make a comic of Shin-chan pranking his dad', attachments: [] });
    const user = llm.calls[0].messages[llm.calls[0].messages.length - 1];
    expect(String(user.content)).toContain('IP NOTE: Shin-chan is trademarked — make an original homage');
    expect(session.doc.conversation[1].text).toContain("Shin-chan is trademarked, so I'm making an original homage — Chintu with the same spirit.");
    expect(session.doc.safety?.ipNoted).toEqual(['Shin-chan']);
    await runDirectorTurn(ctx, { text: 'more Shin-chan pranks', attachments: [] });
    const second = llm.calls[2].messages[llm.calls[2].messages.length - 1];
    expect(String(second.content)).not.toContain('IP NOTE');
  });

  it('shows up to 8 images as 768 px previews', async () => {
    const session = newSession(createEmptyDoc('proj-1'));
    const llm = scriptedLlm({ director: [{ text: 'Nice photos — who are they?' }] });
    const ctx = testContext(session, { llm });
    const atts = Array.from({ length: 9 }, (_, i) => ({ path: `u/user-1/p/proj-1/ref/r${i}.webp`, source: 'upload' as const, at: i }));
    for (const a of atts) ctx.assetsFake.files.set(a.path, 'data:image/webp;base64,QQ==');
    const preview = vi.spyOn(ctx.assetsFake, 'previewDataUrl');
    await runDirectorTurn(ctx, { text: '', attachments: atts });
    const content = llm.calls[0].messages[llm.calls[0].messages.length - 1].content as Array<{ type: string; text?: string }>;
    expect(content.filter((p) => p.type === 'image_url')).toHaveLength(8);
    expect(content[0].text).toContain('(9 images available; the first 8 are shown.)');
    expect(preview).toHaveBeenCalledWith(atts[0].path, 768);
  });

  it('the doc summary shows non-human cast, off-shape drawings and the open question', () => {
    const doc = lakeDrawnDoc();
    doc.pages[0].render.asset = { ...doc.pages[0].render.asset!, w: 2048, h: 2048 };
    const s = summarizeDocForDirector(doc, false, [], { userText: 'add other animals' });
    expect(s).toContain('- DUCKLINGS [c_ducks] support, animal ×3 — Three identical fluffy yellow ducklings');
    expect(s).toContain('drawn 1:1');
    expect(s).not.toContain('OPEN QUESTIONS'); // the cast already has animals
    expect(summarizeDocForDirector(createEmptyDoc('x'), false, [], { userText: 'a baby with other animals' })).toContain('OPEN QUESTIONS: the user mentioned a vague group');
    const focused = summarizeDocForDirector(lakeDrawnDoc(), false, [], { focus: { pageId: 'pg_lake_1', panelN: 3, lineIds: ['ln_l3'] } });
    expect(focused).toContain('Focus: the user is looking at page 1, panel 3; selected balloons — p1 panel 3: “Bye-bye, friends!” (speech)');
  });
});

describe('never silent across 30 fake turns', () => {
  beforeEach(() => {
    JOB_TIMINGS.retryBackoffMs = 0;
    JOB_TIMINGS.turnLockWaitMs = 20;
  });

  const scripts: Array<{ text: string; steps: Parameters<typeof scriptedLlm>[0]['director'] }> = [
    { text: 'hi', steps: [{ text: '' }] },
    { text: 'a heist in Mumbai', steps: [{ toolCalls: [toolCall('a', 'update_brief', { premise: 'A heist in Mumbai', genre: 'heist' })] }, { text: '' }] },
    { text: 'my hero is Maya', steps: [{ toolCalls: [toolCall('a', 'upsert_character', { name: 'Maya', look: { summary: 'courier' } })] }, { text: '' }] },
    { text: 'add a dog', steps: [{ toolCalls: [toolCall('a', 'upsert_character', { name: 'Biscuit', kind: 'animal', look: { summary: 'scruffy dog', species: 'terrier' } })] }, { text: '' }] },
    { text: 'what style?', steps: [{ toolCalls: [toolCall('a', 'ask_user', { question: 'Which style?', options: ['Ink', 'Watercolor'] })] }] },
    { text: 'noir please', steps: [{ toolCalls: [toolCall('a', 'set_style', { presetId: 'noir-ink' })] }, { text: '' }] },
    { text: 'six pages', steps: [{ toolCalls: [toolCall('a', 'set_format', { pageCount: 6 })] }, { text: '' }] },
    { text: 'no gore', steps: [{ toolCalls: [toolCall('a', 'add_notes', { notes: ['no gore'] })] }, { text: '' }] },
    { text: 'bad args', steps: [{ toolCalls: [toolCall('a', 'update_brief', {})] }, { text: '' }] },
    { text: 'unknown tool', steps: [{ toolCalls: [toolCall('a', 'nope', {})] }, { text: '' }] },
    { text: 'malformed', steps: [{ toolCalls: [{ id: 'm', name: 'set_format', arguments: '{"kind": ' }] }, { text: '' }] },
    { text: 'read page 1', steps: [{ toolCalls: [toolCall('a', 'read_pages', { pages: [1] })] }, { text: '' }] },
    { text: 'change the line', steps: [{ toolCalls: [toolCall('a', 'edit_panel_text', { page: 1, panel: 2, lines: [{ kind: 'speech', speaker: 'Maya', text: 'Run!' }] })] }, { text: '' }] },
    { text: 'make it a thought', steps: [{ toolCalls: [toolCall('a', 'set_line', { page: 1, panel: 2, line: 1, kind: 'thought' })] }, { text: '' }] },
    { text: 'draw everything', steps: [{ toolCalls: [toolCall('a', 'render_pages', {})] }, { text: '' }] },
    { text: 'generate all pages', steps: [{ toolCalls: [toolCall('a', 'render_pages', { pages: [1, 2, 3] })] }, { text: '' }] },
    { text: 'redraw page 1', steps: [{ toolCalls: [toolCall('a', 'render_pages', { pages: [1], redraw: true })] }, { text: '' }] },
    { text: 'make the cover', steps: [{ toolCalls: [toolCall('a', 'render_cover', { title: 'Spice Run' })] }, { text: '' }] },
    { text: 'the cover is bad', steps: [{ toolCalls: [toolCall('a', 'ask_user', { question: 'Which fix?', options: [{ label: 'Fix the face', description: '≈ $0.07' }, { label: 'Keep it' }] })] }] },
    { text: 'tighten money', steps: [{ toolCalls: [toolCall('a', 'set_settings', { budgetUsd: 3 })] }, { text: '' }] },
    { text: 'loosen money', steps: [{ toolCalls: [toolCall('a', 'set_settings', { quality: 'pro' })] }, { text: '' }] },
    { text: 'remove Arjun', steps: [{ toolCalls: [toolCall('a', 'remove_character', { name: 'Arjun' })] }, { text: '' }] },
    { text: 'add the rooftops', steps: [{ toolCalls: [toolCall('a', 'upsert_place', { name: 'Rooftops', look: 'tin roofs' })] }, { text: '' }] },
    { text: 'square pages', steps: [{ toolCalls: [toolCall('a', 'set_format', { pageAspect: '1:1' })] }, { text: '' }] },
    { text: 'a refusal', steps: [new StudioError('SAFETY_BLOCKED', 'blocked')] },
    { text: 'a timeout', steps: [new StudioError('TIMEOUT', 'The director took too long to answer.')] },
    { text: 'a crash', steps: [new Error('boom')] },
    { text: 'tool limit', steps: [...Array.from({ length: 8 }, (_, i) => ({ toolCalls: [toolCall(`n${i}`, 'add_notes', { notes: [`n${i}`] })] })), { text: '' }] },
    { text: 'edit page art', steps: [{ toolCalls: [toolCall('a', 'edit_page', { page: 1, instruction: 'night' })] }, { text: '' }] },
    { text: 'save my script', steps: [{ toolCalls: [toolCall('a', 'save_source', { text: 'A short premise about a heist.' })] }, { text: '' }] }
  ];

  it('has 30 scripted turns', () => expect(scripts).toHaveLength(30));

  it('every committed assistant message has non-empty text', async () => {
    const doc = plannedDoc();
    doc.settings.confirm = 'big';
    const session = newSession(doc);
    for (const script of scripts) {
      const llm = scriptedLlm({ director: [...(script.steps || [])] });
      const ctx = testContext(session, { llm });
      await runDirectorTurn(ctx, { text: script.text, attachments: [] });
      await ctx.settled();
      const reply = session.doc.conversation[session.doc.conversation.length - 1];
      expect(reply.role, script.text).toBe('assistant');
      expect(reply.text.trim().length, script.text).toBeGreaterThan(0);
    }
    const empty = session.doc.conversation.filter((m) => m.role === 'assistant' && !m.text.trim() && !m.cards?.some((c) => c.type === 'renders'));
    expect(empty).toEqual([]);
  });
});

describe('P2-SERVER director wiring', () => {
  it('photos the turn left unassigned get "Who is in this photo?" (free taps), never silence', async () => {
    const session = newSession(plannedDoc());
    const attachment = { path: 'u/user-1/p/proj-1/ref/up-9.webp', source: 'upload' as const, at: 1 };
    const llm = scriptedLlm({ director: [{ text: 'Nice photo!' }] });
    const ctx = testContext(session, { llm });
    ctx.assetsFake.files.set(attachment.path, 'data:image/png;base64,UEhPVE8=');
    await runDirectorTurn(ctx, { text: 'look at this', attachments: [attachment] });
    const reply = session.doc.conversation.at(-1)!;
    expect(reply.text).toBe('Nice photo!');
    const who = reply.cards?.find((c) => c.type === 'options');
    expect(who).toMatchObject({ type: 'options', question: 'Who or what is in this photo?' });
    expect((who as { choices: { label: string }[] }).choices.map((c) => c.label)).toEqual(expect.arrayContaining(['MAYA', 'ARJUN', 'Someone new']));
  });

  it('a breakdown card in the history reads as its page and panel count; the summary words prices as usage for governed users', () => {
    const doc = plannedDoc();
    const history: Msg[] = [
      { id: 'u1', role: 'user', text: 'show me', at: 1 },
      { id: 'a1', role: 'assistant', text: 'Here.', at: 2, cards: [{ type: 'breakdown', id: 'b1', view: 'plan', cover: true }] }
    ];
    expect(JSON.stringify(conversationForDirector(history, HISTORY_WINDOW, doc))).toContain('[showed the page breakdown: 3 pages, 9 panels]');
    const governed = summarizeDocForDirector(doc, false, [], { cost: costFormatter(costViewFor({ ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 50, exhausted: false, pctPerStandardPage: 1 } })) });
    expect(governed).not.toMatch(/\$/);
    expect(governed).toMatch(/% of your usage\/page/);
    expect(governed).toContain("never in dollars");
    // Admins (or no caps at all) read prices.
    expect(summarizeDocForDirector(doc, false)).toMatch(/≈ \$\d+\.\d\d\/page/);
  });

  it('a governed user never reads a dollar amount in the reply, even when the model writes one', async () => {
    const session = newSession(plannedDoc());
    const llm = scriptedLlm({ director: [{ text: 'A new page costs about $0.08.' }] });
    const caps = { ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 50, exhausted: false, pctPerStandardPage: 1 } };
    await runDirectorTurn(testContext(session, { llm, caps }), { text: 'how much is a page?', attachments: [] });
    const reply = session.doc.conversation.at(-1)!;
    expect(reply.text).not.toMatch(/\$/);
    expect(reply.text).toMatch(/^A new page costs about ≈?<?[\d.]+% of your usage\.$/);
  });

  it('…nor in the live stream: the deltas are governed too, even when an amount is split across chunks', async () => {
    const session = newSession(plannedDoc());
    const caps = { ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 50, exhausted: false, pctPerStandardPage: 1 } };
    const llm = scriptedLlm({
      director: [
        (req) => {
          // The provider streams "$0." and "12" in separate chunks (the fake then re-emits the full text).
          req.onDelta?.('The cover would be about $0.');
          req.onDelta?.('12 — want it?');
          return { text: 'The cover would be about $0.12 — want it?' };
        }
      ]
    });
    const ctx = testContext(session, { llm, caps });
    await runDirectorTurn(ctx, { text: 'how much is the cover?', attachments: [] });
    const deltas = ctx.events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text);
    // Without the fix the stream carried the raw "$0.12" until the final message replaced the draft.
    expect(deltas.join('')).not.toMatch(/\$/);
    expect(deltas.join('')).toContain('% of your usage — want it?');
    expect(deltas[0]).toBe('The cover would be about '); // the growing "$0." was held back, not shown
    const final = session.doc.conversation.at(-1)!.text;
    expect(final).not.toMatch(/\$/);
    expect(final).toMatch(/^The cover would be about ≈?<?[\d.]+% of your usage — want it\?$/);
    // An admin's stream passes through as is, chunk by chunk.
    const admin = newSession(plannedDoc());
    const actx = testContext(admin, { llm: scriptedLlm({ director: [{ text: 'About $0.12.' }] }), caps: { ...DEFAULT_CAPS, admin: true } });
    await runDirectorTurn(actx, { text: 'how much?', attachments: [] });
    expect(actx.events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text)).toEqual(['About $0.12.']);
  });

  it('…nor on the cards: an ask_user question with prices in its options reads in usage', async () => {
    const session = newSession(plannedDoc());
    const llm = scriptedLlm({
      director: [
        {
          toolCalls: [
            toolCall('q1', 'ask_user', {
              question: 'Draw page 1 now ($0.08)?',
              options: [{ label: 'Yes ($0.08)', description: 'One page ≈ $0.08', reply: 'Yes, draw page 1 for $0.08' }, { label: 'Not yet' }]
            })
          ]
        },
        { text: 'Shall I draw it?' }
      ]
    });
    const caps = { ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 50, exhausted: false, pctPerStandardPage: 1 } };
    await runDirectorTurn(testContext(session, { llm, caps }), { text: 'what next?', attachments: [] });
    const reply = session.doc.conversation.at(-1)!;
    const options = reply.cards?.find((c) => c.type === 'options');
    expect(options).toBeDefined();
    expect(JSON.stringify(options)).not.toMatch(/\$/);
    expect(JSON.stringify(options)).toMatch(/% of your usage/);
    // An admin asking the same reads the prices as written.
    const admin = newSession(plannedDoc());
    const llm2 = scriptedLlm({
      director: [
        { toolCalls: [toolCall('q1', 'ask_user', { question: 'Draw page 1 now ($0.08)?', options: [{ label: 'Yes ($0.08)' }, { label: 'Not yet' }] })] },
        { text: 'Shall I draw it?' }
      ]
    });
    await runDirectorTurn(testContext(admin, { llm: llm2, caps: { ...DEFAULT_CAPS, admin: true } }), { text: 'what next?', attachments: [] });
    expect(JSON.stringify(admin.doc.conversation.at(-1)!.cards?.find((c) => c.type === 'options'))).toContain('Yes ($0.08)');
  });
});

