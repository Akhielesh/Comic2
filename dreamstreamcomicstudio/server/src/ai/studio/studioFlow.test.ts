import { describe, it, expect } from 'vitest';
import { parseClarify, buildClarifyPrompt } from './studioClarify.js';
import { parsePlan, renderPlanForBuild, buildPlanPrompt } from './studioPlan.js';
import { buildGeneratePrompt } from './studioGenerate.js';
import type { StudioBuildPlan } from '../../../../apiTypes.js';

describe('studioClarify.parseClarify', () => {
  it('parses + hardens questions (caps, defaults allowCustom, validates kind)', () => {
    const res = parseClarify(JSON.stringify({
      questions: [
        { id: 'Scope!!', question: 'How big?', kind: 'single', options: [{ label: 'MVP', value: 'mvp', hint: 'small' }, { label: 'Full' }], allowCustom: true },
        { question: 'Which features?', kind: 'multi', options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'no options no custom', options: [], allowCustom: false } // dropped
      ],
      assumptions: ['Use React', 'Light theme']
    }));
    expect(res.questions).toHaveLength(2);
    expect(res.questions[0].id).toBe('scope');
    expect(res.questions[0].options[1].value).toBe('Full'); // value defaults to label
    expect(res.questions[1].kind).toBe('multi');
    expect(res.questions[1].allowCustom).toBe(true); // defaults to true
    expect(res.assumptions).toEqual(['Use React', 'Light theme']);
  });

  it('is resilient to garbage / empty', () => {
    expect(parseClarify('not json').questions).toEqual([]);
    expect(parseClarify(JSON.stringify({ questions: [], assumptions: [] })).questions).toEqual([]);
  });

  it('prompt includes the idea', () => {
    expect(buildClarifyPrompt('a finance tracker')).toContain('a finance tracker');
  });
});

describe('studioPlan.parsePlan', () => {
  it('parses a real plan and normalizes file paths', () => {
    const plan = parsePlan(JSON.stringify({
      title: 'FinTrack', summary: 'Track money', appType: 'React dashboard',
      stack: ['React', 'TypeScript', 'Recharts'],
      features: ['Add transactions', 'Category breakdown', 'Monthly chart'],
      files: [{ path: 'src/App.tsx', purpose: 'root' }, { path: '/src/components/Chart.tsx', purpose: 'chart' }],
      dataSources: ['exchangerate.host'], notes: ['localStorage persistence']
    }));
    expect(plan).not.toBeNull();
    expect(plan!.title).toBe('FinTrack');
    expect(plan!.files[0].path).toBe('/src/App.tsx'); // leading slash added
    expect(plan!.features).toHaveLength(3);
  });

  it('returns null when there is no substance', () => {
    expect(parsePlan('garbage')).toBeNull();
    expect(parsePlan(JSON.stringify({ title: 'X' }))).toBeNull(); // no features/files
  });

  it('renderPlanForBuild surfaces the file tree + features', () => {
    const plan: StudioBuildPlan = {
      title: 'FinTrack', summary: 'Track money', appType: 'React dashboard', stack: ['React'],
      features: ['Add transactions'], files: [{ path: '/src/App.tsx', purpose: 'root' }], dataSources: [], notes: []
    };
    const txt = renderPlanForBuild(plan);
    // The plan suggests structure, but the builder owns the final file layout — so it's framed
    // as advisory, not a binding "files to create" contract.
    expect(txt).toContain('SUGGESTED STRUCTURE');
    expect(txt.toLowerCase()).toContain('advisory');
    expect(txt).toContain('/src/App.tsx');
    expect(txt).toContain('Add transactions');
  });

  it('prompt includes the answers', () => {
    expect(buildPlanPrompt('idea', [{ question: 'Scope?', answer: 'MVP' }])).toContain('Scope? → MVP');
  });
});

describe('studioGenerate.buildGeneratePrompt — no longer one-shot single-file', () => {
  const plan: StudioBuildPlan = {
    title: 'FinTrack', summary: 'Track money', appType: 'React dashboard', stack: ['React', 'TS'],
    features: ['Add transactions', 'Charts'], files: [{ path: '/src/App.tsx', purpose: 'root' }, { path: '/src/components/Chart.tsx', purpose: 'chart' }],
    dataSources: [], notes: []
  };

  it('never instructs the model to prefer the smallest set of files', () => {
    const p = buildGeneratePrompt({ prompt: 'finance tracker' });
    expect(p.toLowerCase()).not.toContain('smallest set');
    expect(p).toContain('MULTI-FILE');
  });

  it('injects the approved plan when building a new app', () => {
    const p = buildGeneratePrompt({ prompt: 'finance tracker', plan, answers: [{ question: 'Scope?', answer: 'Full' }] });
    expect(p).toContain('APPROVED BUILD PLAN');
    expect(p).toContain('/src/components/Chart.tsx');
    expect(p).toContain('Scope? → Full');
  });

  it('refine mode (current files) ignores plan and updates in place', () => {
    const p = buildGeneratePrompt({ prompt: 'add dark mode', currentFiles: [{ path: '/App.tsx', content: 'x' }], plan });
    expect(p).toContain('iterating on an existing app');
    expect(p).not.toContain('APPROVED BUILD PLAN');
  });
});
