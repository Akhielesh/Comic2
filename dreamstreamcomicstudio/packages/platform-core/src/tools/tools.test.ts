// @vitest-environment node
//
// Agent tools (plan §5.5; W1.4, with W1.1 FIX waveNote 3):
// - EVERY tool schema projects with toJsonSchema(llm) — a field with two JSON types across variants throws there —
//   and every property of the projection has a JSON type;
// - model-facing email ops are AgentEmailOp, never EmailOp: no set_recipients, no `actor` in the schema; a model's
//   `actor` is deleted and the host stamps 'agent';
// - toChatSpec matches the chat registry's toToolSpec shape; toDirectorSpec carries the director's cost prefix;
// - every tool's capability exists; MCP never sees an external write; bindTools checks, gates, meters and audits.
import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Infer, JsonSchema } from '../contract/schema.js';
import type { AgentEmailOp, EmailDoc } from '../contract/email.js';
import type { DeckOp, DeckSpec } from '../contract/deck.js';
import type { DocOp, RichDoc } from '../contract/richdoc.js';
import { s, toJsonSchema } from '../schema/index.js';
import { SchemaDefinitionError } from '../errors.js';
import { CAPABILITIES, getCapability } from '../capabilities.js';
import { CHAT_PRODUCT, COMIC_PRODUCT, defineProduct } from '../products.js';
import { createFakeAudit, createFakeLedger, createIdSequence } from '../testing/fakePorts.js';
import {
  AgentDeckOpSchema,
  AgentEmailOpInputSchema,
  DATA_NOT_INSTRUCTIONS,
  DIRECTOR_COST_PREFIX,
  DeckSpecSchema,
  DocOpSchema,
  EmailDraftInputSchema,
  PLATFORM_TOOLS,
  PLATFORM_TOOL_NAMES,
  RichDocSchema,
  bindTools,
  checkToolInput,
  defineTool,
  emailDraftTool,
  emailReviseTool,
  getPlatformTool,
  mcpToolsFor,
  toChatSpec,
  toDirectorSpec,
  toMcpTool,
  toToolSpec,
  type ToolHandler,
} from './index.js';

// The chat registry and the director's cost prefixes, loaded at run time only: a static import would pull the whole
// backend graph into the app's root typecheck (and past its heap). Their shapes are asserted below instead.
const server = (rel: string): Promise<Record<string, unknown>> => import(/* @vite-ignore */ new URL(`../../../../server/src/${rel}`, import.meta.url).href);
const chatRegistry = (await server('ai/tools/registry.ts')) as {
  toToolSpec: (tool: { name: string; description: string; parameters: Record<string, unknown>; execute: () => Promise<unknown> }) => unknown;
  KNOWN_TOOL_NAMES: readonly string[];
};
const { TOOL_COST_PREFIX } = (await server('comic/extensions.ts')) as { TOOL_COST_PREFIX: Record<string, string> };
const chatRegistryToToolSpec = chatRegistry.toToolSpec;
const KNOWN_TOOL_NAMES = chatRegistry.KNOWN_TOOL_NAMES;

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../fixtures/contract/${name}`, import.meta.url), 'utf8'));

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

describe('every tool schema projects to the llm target (W1.1 waveNote 3)', () => {
  it('projects every input and output with llm, mcp and strict, and every llm property has a JSON type', () => {
    const untyped: string[] = [];
    const visit = (node: JsonSchema, path: string): void => {
      if (typeof node.type !== 'string') untyped.push(path || '(root)');
      if (node.properties && typeof node.properties === 'object') for (const [k, v] of Object.entries(node.properties as Record<string, JsonSchema>)) visit(v, `${path}.${k}`);
      if (node.items && typeof node.items === 'object') visit(node.items as JsonSchema, `${path}[]`);
    };
    expect(PLATFORM_TOOLS).toHaveLength(PLATFORM_TOOL_NAMES.length);
    for (const tool of PLATFORM_TOOLS) {
      visit(toJsonSchema(tool.input, { target: 'llm' }), `${tool.name}.input`);
      visit(toJsonSchema(tool.output, { target: 'llm' }), `${tool.name}.output`);
      expect(() => toJsonSchema(tool.input, { target: 'strict' }), tool.name).not.toThrow();
      expect(() => toJsonSchema(tool.output, { target: 'mcp' }), tool.name).not.toThrow();
      expect(toChatSpec(tool).parameters).toEqual(toJsonSchema(tool.input, { target: 'llm' }));
    }
    expect(untyped).toEqual([]);
  });

  it('a tool whose input gives one field two JSON types fails at definition, not in a model call', () => {
    const clash = s.object({
      step: s.union('kind', [s.object({ kind: s.literal('a'), at: s.int() }), s.object({ kind: s.literal('b'), at: s.text({ max: 10 }) })]),
    });
    expect(() => defineTool({ ...emailDraftTool, input: clash as never, refine: undefined })).toThrow(SchemaDefinitionError);
  });

  it('model-facing email ops are AgentEmailOp without actor: no set_recipients, no actor field', () => {
    const llm = JSON.stringify(toChatSpec(emailReviseTool).parameters);
    expect(llm).not.toContain('set_recipients');
    expect(llm).not.toContain('"actor"');
    const ops = (toChatSpec(emailReviseTool).parameters as { properties: { ops: { items: { properties: { op: { enum: string[] } } } } } }).properties.ops.items.properties.op.enum;
    expect(ops.sort()).toEqual(['attach', 'detach', 'insert_block', 'remove_block', 'set_subject', 'update_block']);
    for (const tool of PLATFORM_TOOLS) expect(JSON.stringify(toChatSpec(tool).parameters), tool.name).not.toContain('set_recipients');
  });

  it('deletes a model-written actor and stamps actor: agent host-side; set_recipients never gets through', () => {
    const op = { op: 'set_subject', id: 'op-1', baseRev: 0, subject: 'Hi', actor: 'user' };
    const r = checkToolInput(emailReviseTool, { draftId: 'd1', ops: [op] });
    expect(r).toEqual({ ok: true, value: { draftId: 'd1', ops: [{ op: 'set_subject', id: 'op-1', baseRev: 0, subject: 'Hi', actor: 'agent' }] } });
    expect(op.actor).toBe('user'); // the model's object is untouched
    const recipients = checkToolInput(emailReviseTool, { draftId: 'd1', ops: [{ op: 'set_recipients', id: 'op-2', baseRev: 0, actor: 'user', to: [{ address: 'x@example.com' }] }] });
    expect(recipients).toMatchObject({ ok: false, errors: [{ path: 'ops[0].op', code: 'tag' }] });
    // From a JSON string too (what a model returns).
    expect(checkToolInput(emailReviseTool, JSON.stringify({ draftId: 'd1', ops: [op] })).value).toMatchObject({ ops: [{ actor: 'agent' }] });
    expect(checkToolInput(emailReviseTool, '{not json')).toMatchObject({ ok: false, errors: [{ code: 'type' }] });
  });
});

describe('the tool schemas are pinned to the frozen contract', () => {
  it('Infer<schema> equals the contract types', () => {
    expectTypeOf<Infer<typeof RichDocSchema>>().toEqualTypeOf<RichDoc>();
    expectTypeOf<Infer<typeof DeckSpecSchema>>().toEqualTypeOf<DeckSpec>();
    expectTypeOf<Infer<typeof DocOpSchema>>().toEqualTypeOf<DocOp>();
    expectTypeOf<Infer<typeof EmailDraftInputSchema>>().toEqualTypeOf<Omit<EmailDoc, 'v' | 'rev' | 'attachments'>>();
    expectTypeOf<Infer<typeof AgentEmailOpInputSchema>>().toEqualTypeOf<DistributiveOmit<AgentEmailOp, 'actor'>>();
    // Agent decks hold every element but images; their ops are the contract's deck ops over those slides.
    expectTypeOf<Infer<typeof AgentDeckOpSchema>['op']>().toEqualTypeOf<DeckOp['op']>();
    expectTypeOf<Extract<Infer<typeof AgentDeckOpSchema>, { op: 'add_slide' }>['slide']['elements'][number]['kind']>().toEqualTypeOf<'text' | 'shape' | 'table' | 'chart'>();
  });

  it('every contract fixture passes the tool schemas (and the email/deck bodies as a model writes them)', () => {
    const strip = <T extends Record<string, unknown>>(o: T, ...keys: string[]) => {
      const out: Record<string, unknown> = { ...o };
      for (const k of keys) delete out[k];
      return out;
    };
    for (const name of ['richdoc/minimal.json', 'richdoc/full.json']) expect(checkToolInput(getPlatformTool('doc_create')!, strip(fixture(name) as Record<string, unknown>, 'v', 'rev')).errors).toBeUndefined();
    for (const name of ['email/minimal.json', 'email/full.json', 'email/reply.json']) {
      expect(checkToolInput(emailDraftTool, strip(fixture(name) as Record<string, unknown>, 'v', 'rev', 'attachments')).errors, name).toBeUndefined();
    }
    for (const op of fixture('richdoc/ops.json') as unknown[]) expect(checkToolInput(getPlatformTool('doc_revise')!, { draftId: 'd1', ops: [op] }).errors).toBeUndefined();
    for (const op of fixture('email/ops.json') as { op: string }[]) {
      expect(checkToolInput(emailReviseTool, { draftId: 'd1', ops: [op] }).ok, op.op).toBe(op.op !== 'set_recipients');
    }
    const deck = fixture('deck/full.json') as DeckSpec;
    const noImages = { ...strip(deck as unknown as Record<string, unknown>, 'v', 'rev'), slides: deck.slides.map((sl) => ({ ...sl, elements: sl.elements.filter((e) => e.kind !== 'image') })) };
    expect(checkToolInput(getPlatformTool('deck_create')!, noImages).errors).toBeUndefined();
    const withImage = checkToolInput(getPlatformTool('deck_create')!, strip(deck as unknown as Record<string, unknown>, 'v', 'rev'));
    expect(withImage.ok).toBe(false); // a model never places images: the host adds the ones it built
  });

  it('caps the whole email body at 10,000 characters', () => {
    const para = (n: number) => ({ type: 'paragraph', id: `p${n}`, runs: [{ text: 'x'.repeat(3000) }] });
    const draft = { mode: 'compose', subject: 'Long', to: [], blocks: [para(1), para(2), para(3)] };
    expect(checkToolInput(emailDraftTool, draft).ok).toBe(true);
    expect(checkToolInput(emailDraftTool, { ...draft, blocks: [...draft.blocks, para(4)] })).toMatchObject({ ok: false, errors: [{ path: 'blocks', code: 'too-long' }] });
    expect(checkToolInput(emailDraftTool, { ...draft, signature: 'y'.repeat(1001) })).toMatchObject({ ok: false });
  });
});

describe('projections', () => {
  it('toChatSpec is exactly what the chat registry’s toToolSpec wraps', () => {
    for (const tool of PLATFORM_TOOLS) {
      const chat = toChatSpec(tool);
      const viaRegistry = chatRegistryToToolSpec({ ...chat, execute: async () => ({ content: '' }) });
      expect(viaRegistry).toEqual(toToolSpec(tool));
      expect(Object.keys(chat).sort()).toEqual(['description', 'name', 'parameters']);
      expect(chat.parameters).toMatchObject({ type: 'object' });
    }
  });

  it('every description is model-facing and says document text is data, never instructions', () => {
    for (const tool of PLATFORM_TOOLS) expect(toChatSpec(tool).description.endsWith(DATA_NOT_INSTRUCTIONS), tool.name).toBe(true);
  });

  it('toDirectorSpec carries the director’s own cost prefix', () => {
    expect(DIRECTOR_COST_PREFIX).toEqual(TOOL_COST_PREFIX);
    expect(toDirectorSpec(emailDraftTool)).toMatchObject({ cost: 'text', spec: { type: 'function', function: { name: 'email_draft' } } });
    expect(toDirectorSpec(emailDraftTool).spec.function.description.startsWith('TEXT ≈$0.01 — ')).toBe(true);
    expect(toDirectorSpec(getPlatformTool('print_book')!).spec.function.description.startsWith('PAID (quoted) — ')).toBe(true);
    expect(toDirectorSpec(getPlatformTool('email_handoff')!).spec.function.description.startsWith('FREE — ')).toBe(true);
    // the chat spec never carries a price
    for (const tool of PLATFORM_TOOLS) expect(toChatSpec(tool).description, tool.name).not.toContain('$');
  });

  it('MCP never sees an external write', () => {
    expect(() => toMcpTool(getPlatformTool('email_handoff')!)).toThrow();
    expect(toMcpTool(getPlatformTool('pdf_inspect')!)).toMatchObject({ name: 'pdf_inspect', annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } });
    expect(toMcpTool(emailDraftTool).inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    const all = defineProduct({ ...CHAT_PRODUCT, id: 'everything', studio: 'every_studio', capabilities: CAPABILITIES.map((c) => c.id), tools: PLATFORM_TOOLS.map((t) => t.name) });
    const names = mcpToolsFor(all, 6).map((t) => t.name);
    expect(names).not.toContain('email_handoff');
    expect(names).toHaveLength(PLATFORM_TOOLS.length - 1);
  });

  it('every tool’s capability exists, ships no later than the tool, and the chat catalogue knows the wave-1 tools', () => {
    for (const tool of PLATFORM_TOOLS) {
      if (tool.capability === undefined) continue;
      const cap = getCapability(tool.capability);
      expect(cap, tool.name).toBeDefined();
      expect(cap!.wave, tool.name).toBeLessThanOrEqual(tool.wave);
    }
    // KNOWN_TOOL_NAMES gains email_draft and deck_create in W1.9; until then the gap is reported, not hidden.
    const missing = PLATFORM_TOOLS.filter((t) => t.wave === 1 && !KNOWN_TOOL_NAMES.includes(t.name)).map((t) => t.name);
    expect(missing.every((n) => n === 'email_draft' || n === 'deck_create')).toBe(true);
  });
});

describe('bindTools', () => {
  const setup = (over: { governed?: boolean; handlers?: Record<string, ToolHandler>; policy?: Parameters<typeof bindTools>[1]['policy'] } = {}) => {
    const audit = createFakeAudit();
    const ledger = createFakeLedger({ governed: over.governed });
    const calls: unknown[] = [];
    const handlers: Record<string, ToolHandler> = over.handlers || {
      email_draft: async (input) => {
        calls.push(input);
        return { draftId: 'd1', blocks: 1, recipients: 0, flagged: 0, links: 0, warnings: [] };
      },
    };
    const tools = bindTools(CHAT_PRODUCT, { handlers, policy: over.policy, meter: ledger, audit, now: () => 1000, newId: createIdSequence('evt') });
    return { tools, audit, ledger, calls };
  };
  const draft = { mode: 'compose', subject: 'Launch', to: [{ address: 'ana@example.com' }], blocks: [{ type: 'paragraph', id: 'p1', runs: [{ text: 'Secret launch plan.' }] }] };

  it('binds only the product’s shipped tools that have a handler, with the chat spec', () => {
    const { tools } = setup();
    expect(tools.map((t) => t.name)).toEqual(['email_draft']);
    expect(tools[0].spec).toEqual(toChatSpec(emailDraftTool));
    expect(() => bindTools(COMIC_PRODUCT, { handlers: { pdf_fill: async () => ({}) }, now: () => 0, newId: () => 'x' })).toThrow(/does not list/);
  });

  it('checks the arguments, runs the handler and audits without content', async () => {
    const { tools, audit, calls } = setup();
    const r = await tools[0].run(JSON.stringify(draft), { userId: 'user-1' });
    expect(r).toMatchObject({ status: 'ok', decision: 'run', output: { draftId: 'd1' } });
    expect(calls).toEqual([draft]);
    expect(audit.events).toEqual([expect.objectContaining({ tool: 'email_draft', decision: 'auto', outcome: 'ok', actor: { kind: 'agent', id: 'user-1' } })]);
    expect(JSON.stringify(audit.events)).not.toMatch(/Secret|Launch|ana@example/);
    expect(await tools[0].run({ ...draft, extra: 1 })).toMatchObject({ status: 'invalid', errors: [{ path: 'extra', code: 'unknown-key' }] });
    expect(calls).toHaveLength(1);
  });

  it('enforces maxPerTurn', async () => {
    const { tools, audit } = setup();
    expect(await tools[0].run(draft, { callsThisTurn: 3 })).toMatchObject({ status: 'refused', reason: 'max-per-turn' });
    expect(audit.events[0]).toMatchObject({ decision: 'blocked', errorCode: 'max-per-turn' });
  });

  it('a proposal on user content runs only after the person approves that exact input', async () => {
    const filled: unknown[] = [];
    const { tools } = setup({
      handlers: {
        pdf_fill: async (input, ctx) => {
          filled.push(input);
          ctx.reportCostUsd(0.0025);
          return { fileRef: 'f-copy', bytes: 10 };
        },
      },
    });
    const fill = tools.find((t) => t.name === 'pdf_fill');
    expect(fill).toBeUndefined(); // wave 2: not bound in wave 1
    const later = bindTools(CHAT_PRODUCT, { handlers: { pdf_fill: async (input, ctx) => (filled.push(input), ctx.reportCostUsd(0.0025), { fileRef: 'f-copy', bytes: 10 }) }, meter: createFakeLedger(), now: () => 0, newId: createIdSequence('e') }, { wave: 2 });
    const tool = later.find((t) => t.name === 'pdf_fill')!;
    const input = { fileRef: 'f-1', fields: [{ name: 'Name', value: 'Ada' }] };
    const first = await tool.run(input);
    expect(first).toMatchObject({ status: 'needs-approval', decision: 'propose' });
    expect(filled).toHaveLength(0);
    if (first.status !== 'needs-approval') throw new Error('expected approval');
    expect(await tool.run(input, { approved: { decision: 'propose', inputHash: 'sha256:' + '0'.repeat(64) } })).toMatchObject({ status: 'needs-approval' });
    expect(await tool.run(input, { approved: { decision: 'propose', inputHash: first.inputHash } })).toMatchObject({ status: 'ok' });
    expect(filled).toHaveLength(1);
  });

  it('a quota tool reserves the job floor, settles what it cost, and fails closed with the ledger down', async () => {
    const ledger = createFakeLedger({ governed: true });
    const tools = bindTools(CHAT_PRODUCT, {
      handlers: { pdf_inspect: async (_i, ctx) => (ctx.reportCostUsd(0.0011), { pageCount: 2, formFields: 0, hasText: true, encrypted: false }) },
      policy: { app: 'dreamstream', confirm: 'never' },
      meter: ledger,
      now: () => 0,
      newId: createIdSequence('e'),
    }, { wave: 2 });
    const inspect = tools.find((t) => t.name === 'pdf_inspect')!;
    expect(await inspect.run({ fileRef: 'f-1' })).toMatchObject({ status: 'ok', decision: 'quota-check' });
    expect(ledger.reservations[0]).toMatchObject({ operation: 'platform_pdf_inspect', estimateUsd: 0.002, status: 'settled', actualUsd: 0.0011 });
    ledger.setDown(true);
    expect(await inspect.run({ fileRef: 'f-2' })).toMatchObject({ status: 'refused', code: 'disabled', reason: 'ledger-down' });
    expect(ledger.reservations).toHaveLength(1);
  });

  it('an external write only PREPARES its draft action, under every policy', async () => {
    const all = defineProduct({ ...CHAT_PRODUCT, id: 'handoff', studio: 'handoff_studio', tools: [...CHAT_PRODUCT.tools, 'email_handoff'] });
    const writes: unknown[] = [];
    for (const policy of [{ app: 'dreamstream', confirm: 'never' }, { app: 'dreamstream', confirm: 'always' }] as const) {
      const [handoff] = bindTools(all, {
        handlers: {
          email_handoff: async (input) => {
            writes.push(input);
            return { draftActionId: 'da-1', kind: 'provider-draft', summary: 'Save to Gmail', payloadHash: 'sha256:' + 'a'.repeat(64), target: 'gmail' };
          },
        },
        policy,
        now: () => 0,
        newId: createIdSequence('e'),
      }, { wave: 6 });
      const r = await handoff.run({ draftId: 'd1', kind: 'provider-draft' });
      expect(r).toMatchObject({ status: 'needs-approval', decision: 'confirm', output: { draftActionId: 'da-1' } });
      // Not even an "approved" context unlocks it: only a consent record in the host's click route does.
      expect(await handoff.run({ draftId: 'd1', kind: 'provider-draft' }, { approved: { decision: 'propose', inputHash: (r as { inputHash: string }).inputHash } })).toMatchObject({ status: 'needs-approval' });
    }
    expect(writes).toHaveLength(4); // prepared four times, written zero times (the handler's only job is to prepare)
  });

  it('a handler that returns the wrong shape is a failure, not an output', async () => {
    const { tools } = setup({ handlers: { email_draft: async () => ({ draftId: 'd1', subject: 'leaks content' }) } });
    expect(await tools[0].run(draft)).toMatchObject({ status: 'failed', code: 'invalid' });
  });
});
