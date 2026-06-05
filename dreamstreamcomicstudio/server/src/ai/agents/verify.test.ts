import { describe, it, expect } from 'vitest';
import { assessFinding, verifyFindings, verificationBlock, type AgentFinding } from './verify.js';

const finding = (over: Partial<AgentFinding>): AgentFinding => ({
  id: 'a',
  name: 'Agent',
  task: 't',
  text: 'A reasonably detailed finding that explains the topic clearly across a couple of sentences for weight.',
  citations: [],
  status: 'done',
  toolEvents: [],
  ...over
});

describe('assessFinding', () => {
  it('rewards a sourced, tool-backed finding with high confidence', () => {
    const a = assessFinding(
      finding({ citations: [{ url: 'https://reuters.com/x' }], toolEvents: [{ tool: 'web_search', ok: true }] })
    );
    expect(a.confidence).toBeGreaterThanOrEqual(0.85);
    expect(a.flags).not.toContain('no_sources');
  });

  it('flags a finding with no sources', () => {
    expect(assessFinding(finding({})).flags).toContain('no_sources');
  });

  it('collapses an errored agent to near-zero confidence', () => {
    const a = assessFinding(finding({ status: 'error', text: '' }));
    expect(a.confidence).toBeLessThan(0.1);
    expect(a.flags).toContain('errored');
  });

  it('treats an empty finding as worthless', () => {
    const a = assessFinding(finding({ text: '   ' }));
    expect(a.confidence).toBeLessThan(0.1);
    expect(a.flags).toContain('empty');
  });

  it('penalizes hedged language', () => {
    const hedged = assessFinding(finding({ text: 'I think it might be around there, as of my knowledge I cannot confirm the exact figure today.' }));
    expect(hedged.flags).toContain('hedged');
  });

  it('flags figures stated with no source or tool call as unverified', () => {
    const a = assessFinding(finding({ text: 'The stock is trading at $214.50 and the market cap is $3.1T right now today across the session.' }));
    expect(a.flags).toContain('unverified_figures');
  });

  it('does NOT flag figures when a tool ran', () => {
    const a = assessFinding(
      finding({
        text: 'The stock is trading at $214.50 and the market cap is $3.1T right now today across the session.',
        toolEvents: [{ tool: 'get_stock', ok: true }]
      })
    );
    expect(a.flags).not.toContain('unverified_figures');
  });
});

describe('verifyFindings', () => {
  it('computes an overall confidence and notes weak corroboration', () => {
    const r = verifyFindings([
      finding({ id: '1', text: 'No sources here, just an unsupported but lengthy assertion about the subject matter at hand.' }),
      finding({ id: '2', status: 'error', text: '' })
    ]);
    expect(r.overallConfidence).toBeGreaterThanOrEqual(0);
    expect(r.overallConfidence).toBeLessThanOrEqual(1);
    expect(r.notes.join(' ')).toMatch(/citation|corroboration/i);
    expect(r.notes.join(' ')).toMatch(/returned nothing/i);
  });

  it('handles an empty finding list', () => {
    const r = verifyFindings([]);
    expect(r.overallConfidence).toBe(0);
    expect(r.assessments).toEqual([]);
    expect(r.notes[0]).toMatch(/No agent findings/);
  });
});

describe('verificationBlock', () => {
  it('renders per-agent confidence and overall summary for the synthesizer', () => {
    const findings = [finding({ id: '1', name: 'News Analyst', citations: [{ url: 'https://x.com' }], toolEvents: [{ tool: 'get_news', ok: true }] })];
    const block = verificationBlock(findings, verifyFindings(findings));
    expect(block).toContain('Overall confidence');
    expect(block).toContain('News Analyst: confidence');
  });
});
