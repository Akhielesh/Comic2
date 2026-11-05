// @vitest-environment node
//
// Governance floors (plan §5.3, §5.5, §5.6; W1.4). These run in every host that vendors the package:
// - nothing can send: no capability or tool has mode `send`, and no registry name matches /send|deliver|dispatch|post_message/;
// - an external write resolves to `confirm`, and an edit of user content to `propose`, under all 7 policies;
// - a flow with maxModelCalls > 1 resolves to `propose` under every policy except an explicit `never` (Atlas `none`);
// - anything unknown is denied.
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, CAPABILITY_IDS, capabilityRegistryProblems } from '../src/capabilities.js';
import { ALL_POLICIES, decideGate, isExplicitNever, type GateDecision, type HostPolicy } from '../src/gates/gates.js';
import { DRAFT_ACTION_KINDS } from '../src/gates/consent.js';
import { PRODUCTS } from '../src/products.js';
import { FLOW_IDS } from '../src/flows/types.js';
import { PLATFORM_TOOLS, getPlatformTool, toolRegistryProblems } from '../src/tools/registry.js';
import { FORBIDDEN_NAME, PLATFORM_TOOL_NAMES, TOOL_MODES } from '../src/tools/types.js';

const label = (p: HostPolicy) => (p.app === 'dreamstream' ? `dreamstream:${p.confirm}` : `atlas:${p.approval}`);
const AMOUNTS = [undefined, 0, 0.001, 0.49, 0.5, 5, 9.99];

describe('nothing can send', () => {
  it('has no send mode, and no tool or capability is named like it sends', () => {
    expect(TOOL_MODES as readonly string[]).not.toContain('send');
    for (const t of PLATFORM_TOOLS) {
      expect(t.mode, t.name).not.toBe('send');
      expect(t.name, t.name).not.toMatch(FORBIDDEN_NAME);
      expect(t.mode, t.name).not.toMatch(FORBIDDEN_NAME);
    }
    for (const c of CAPABILITIES) {
      expect(c.id, c.id).not.toMatch(FORBIDDEN_NAME);
      expect(JSON.stringify(c), c.id).not.toMatch(/"mode":\s*"send"/);
      for (const e of c.engines) expect(e.id, c.id).not.toMatch(FORBIDDEN_NAME);
    }
    for (const n of [...PLATFORM_TOOL_NAMES, ...CAPABILITY_IDS, ...FLOW_IDS, ...DRAFT_ACTION_KINDS, ...PRODUCTS.map((p) => p.id)]) expect(n).not.toMatch(FORBIDDEN_NAME);
    expect(toolRegistryProblems()).toEqual([]);
    expect(capabilityRegistryProblems()).toEqual([]);
  });

  it('the forbidden-name rule really catches the words it bans', () => {
    for (const n of ['email_send', 'send', 'deliver_now', 'dispatch_job', 'post_message', 'SendMail']) expect(n).toMatch(FORBIDDEN_NAME);
    expect(toolRegistryProblems([{ ...PLATFORM_TOOLS[0], name: 'email_send' as never }])).toContain('email_send: a tool may never send');
    expect(toolRegistryProblems([{ ...PLATFORM_TOOLS[0], mode: 'send' as never }]).join()).toMatch(/send/);
    expect(capabilityRegistryProblems([{ ...CAPABILITIES[0], id: 'email.send' as never }]).join()).toMatch(/may never send/);
  });

  it('there is no email.send, connector.* or sheet.* capability', () => {
    for (const id of CAPABILITY_IDS) expect(id).not.toMatch(/^(email\.send|connector\.|sheet\.)/);
  });

  it('a send-like mode is denied by the gate, whatever the policy', () => {
    for (const policy of ALL_POLICIES) {
      expect(decideGate({ tool: { mode: 'send', gate: 'none' }, policy, target: 'own-draft' })).toBe('deny');
      expect(decideGate({ tool: { mode: 'deliver', gate: 'external-write' }, policy, target: 'external' })).toBe('deny');
    }
  });
});

describe('floors no policy can lower (all 7 policies)', () => {
  it('runs under exactly 7 distinct policies', () => {
    expect(ALL_POLICIES).toHaveLength(7);
    expect(new Set(ALL_POLICIES.map(label)).size).toBe(7);
  });

  it('an external write resolves to confirm under every policy and amount', () => {
    for (const policy of ALL_POLICIES) {
      for (const estimateUsd of AMOUNTS) {
        for (const turnSpendUsd of [undefined, 0, 3]) {
          expect(decideGate({ tool: { mode: 'external-write', gate: 'external-write' }, policy, estimateUsd, turnSpendUsd, target: 'external' }), label(policy)).toBe('confirm');
          // the target alone is enough, and so is the gate alone
          expect(decideGate({ tool: { mode: 'draft', gate: 'none' }, policy, estimateUsd, turnSpendUsd, target: 'external' }), label(policy)).toBe('confirm');
          expect(decideGate({ tool: { mode: 'export', gate: 'external-write' }, policy, estimateUsd, turnSpendUsd, target: 'own-draft' }), label(policy)).toBe('confirm');
        }
      }
      const handoff = getPlatformTool('email_handoff')!;
      expect(decideGate({ tool: handoff, policy, target: handoff.target }), label(policy)).toBe('confirm');
    }
  });

  it('an edit of user content resolves to propose under every policy and amount', () => {
    for (const policy of ALL_POLICIES) {
      for (const estimateUsd of AMOUNTS) {
        for (const mode of ['draft', 'revise', 'propose', 'export'] as const) {
          for (const gate of ['none', 'quota', 'spend'] as const) {
            expect(decideGate({ tool: { mode, gate }, policy, estimateUsd, target: 'user-content' }), `${label(policy)} ${mode}/${gate}`).toBe('propose');
          }
        }
      }
      for (const name of ['pdf_fill', 'pdf_redact', 'pdf_organize', 'doc_propose_changes'] as const) {
        const tool = getPlatformTool(name)!;
        expect(decideGate({ tool, policy, target: tool.target }), `${label(policy)} ${name}`).toBe('propose');
      }
    }
  });

  it('reading the user’s content is not an edit (no propose floor), and the policy still governs its spend', () => {
    const inspect = getPlatformTool('pdf_inspect')!;
    expect(decideGate({ tool: inspect, policy: { app: 'dreamstream', confirm: 'never' }, target: inspect.target })).toBe('quota-check');
    expect(decideGate({ tool: inspect, policy: { app: 'dreamstream', confirm: 'always' }, estimateUsd: 0.002, target: inspect.target })).toBe('spend-confirm');
  });

  it('a flow with maxModelCalls > 1 resolves to propose under every policy except an explicit never', () => {
    const never = ALL_POLICIES.filter(isExplicitNever).map(label);
    expect(never.sort()).toEqual(['atlas:none', 'dreamstream:never']);
    for (const policy of ALL_POLICIES) {
      for (const maxModelCalls of [2, 3, 6]) {
        for (const estimateUsd of AMOUNTS) {
          const d = decideGate({ flow: { maxModelCalls }, policy, estimateUsd, target: 'own-draft' });
          if (isExplicitNever(policy)) expect(d, label(policy)).not.toBe('propose');
          else expect(d, `${label(policy)} ${maxModelCalls} calls at ${estimateUsd}`).toBe('propose');
        }
      }
    }
  });

  it('without the flow floor, Comic’s big policy would run a 6-call flow under $0.50 with no approval', () => {
    const big: HostPolicy = { app: 'dreamstream', confirm: 'big', bigSpendUsd: 0.5 };
    expect(decideGate({ flow: { maxModelCalls: 6 }, policy: big, estimateUsd: 0.3, target: 'own-draft' })).toBe('propose');
    expect(decideGate({ flow: { maxModelCalls: 1 }, policy: big, estimateUsd: 0.3, target: 'own-draft' })).toBe('run');
    expect(decideGate({ flow: { maxModelCalls: 1 }, policy: big, estimateUsd: 0.6, target: 'own-draft' })).toBe('spend-confirm');
    expect(decideGate({ flow: { maxModelCalls: 6 }, policy: { app: 'dreamstream', confirm: 'never' }, estimateUsd: 0.3, target: 'own-draft' })).toBe('run');
  });
});

describe('the policy map (spend)', () => {
  const draft = { mode: 'draft', gate: 'spend' };
  const decide = (policy: HostPolicy, estimateUsd?: number, turnSpendUsd?: number): GateDecision => decideGate({ tool: draft, policy, estimateUsd, turnSpendUsd, target: 'own-draft' });

  it('never / none run; always confirms any spend; big and before_execute confirm from the threshold, summed per turn', () => {
    expect(decide({ app: 'dreamstream', confirm: 'never' }, 5)).toBe('run');
    expect(decide({ app: 'atlas', approval: 'none' }, 5)).toBe('run');
    expect(decide({ app: 'atlas', approval: 'before_write' }, 5)).toBe('run');
    expect(decide({ app: 'dreamstream', confirm: 'always' }, 0.001)).toBe('spend-confirm');
    expect(decide({ app: 'atlas', approval: 'always' }, 0.001)).toBe('spend-confirm');
    expect(decide({ app: 'dreamstream', confirm: 'big', bigSpendUsd: 0.5 }, 0.49)).toBe('run');
    expect(decide({ app: 'dreamstream', confirm: 'big', bigSpendUsd: 0.5 }, 0.3, 0.3)).toBe('spend-confirm');
    expect(decide({ app: 'dreamstream', confirm: 'big' }, 0.5)).toBe('spend-confirm');
    expect(decide({ app: 'atlas', approval: 'before_execute' }, 0.49)).toBe('run');
    expect(decide({ app: 'atlas', approval: 'before_execute' }, 0.2, 0.3)).toBe('spend-confirm');
  });

  it('a spend tool with no estimate is unknown cost: confirmed wherever spend is confirmed', () => {
    expect(decide({ app: 'dreamstream', confirm: 'big' })).toBe('spend-confirm');
    expect(decide({ app: 'dreamstream', confirm: 'never' })).toBe('run');
  });

  it('a free draft runs under every policy; a quota tool needs the quota check', () => {
    for (const policy of ALL_POLICIES) {
      expect(decideGate({ tool: getPlatformTool('email_draft')!, policy, target: 'own-draft' })).toBe('run');
      expect(decideGate({ tool: { mode: 'export', gate: 'quota' }, policy, target: 'own-draft' })).toBe('quota-check');
    }
  });
});

describe('anything malformed is denied', () => {
  const policy = ALL_POLICIES[0];
  it.each([
    ['an unknown mode', { tool: { mode: 'execute', gate: 'none' }, policy, target: 'own-draft' }],
    ['an unknown gate', { tool: { mode: 'draft', gate: 'maybe' }, policy, target: 'own-draft' }],
    ['an unknown target', { tool: { mode: 'draft', gate: 'none' }, policy, target: 'somewhere' }],
    ['an unknown policy', { tool: { mode: 'draft', gate: 'none' }, policy: { app: 'dreamstream', confirm: 'sometimes' }, target: 'own-draft' }],
    ['another app’s policy shape', { tool: { mode: 'draft', gate: 'none' }, policy: { app: 'atlas', confirm: 'never' }, target: 'own-draft' }],
    ['a negative estimate', { tool: { mode: 'draft', gate: 'spend' }, policy, estimateUsd: -1, target: 'own-draft' }],
    ['a NaN estimate', { tool: { mode: 'draft', gate: 'spend' }, policy, estimateUsd: NaN, target: 'own-draft' }],
    ['an infinite turn spend', { tool: { mode: 'draft', gate: 'spend' }, policy, turnSpendUsd: Infinity, target: 'own-draft' }],
    ['a negative bigSpendUsd', { tool: { mode: 'draft', gate: 'spend' }, policy: { app: 'dreamstream', confirm: 'big', bigSpendUsd: -1 }, target: 'own-draft' }],
    ['neither a tool nor a flow', { policy, target: 'own-draft' }],
    ['a fractional maxModelCalls', { flow: { maxModelCalls: 1.5 }, policy, target: 'own-draft' }],
    ['nothing at all', null],
  ])('%s', (_name, input) => {
    expect(decideGate(input as never)).toBe('deny');
  });
});
