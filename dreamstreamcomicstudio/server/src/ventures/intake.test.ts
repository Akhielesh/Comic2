import { describe, it, expect } from 'vitest';
import { buildIntakePrompt, parseRoadmap, runIntake } from './intake.js';

const goodJson = JSON.stringify({
  name: 'Habit Tracker',
  summary: 'A simple habit tracker with reminders.',
  scope: 'Web app: track habits, daily check-ins, email reminders. No mobile app in v1.',
  goals: [
    { title: 'Scaffold React + Vite app', detail: 'base project', kind: 'task', priority: 10 },
    { title: 'Habit data model', kind: 'feature', priority: 20 },
    { title: 'Bogus', kind: 'nope', priority: 'high' } // kind/priority get normalized
  ]
});

describe('buildIntakePrompt', () => {
  it('embeds the idea and asks for JSON only', () => {
    const p = buildIntakePrompt('a budgeting app');
    expect(p).toContain('a budgeting app');
    expect(p).toMatch(/Return ONLY a JSON object/);
  });
});

describe('parseRoadmap', () => {
  it('parses a valid roadmap and normalizes goals', () => {
    const r = parseRoadmap(goodJson)!;
    expect(r).not.toBeNull();
    expect(r.name).toBe('Habit Tracker');
    expect(r.goals).toHaveLength(3);
    expect(r.goals[2].kind).toBe('feature'); // unknown kind → default
    expect(r.goals[2].priority).toBe(30); // non-numeric priority → (index+1)*10
  });

  it('extracts JSON even with surrounding prose/markdown fences', () => {
    const wrapped = 'Here you go:\n```json\n' + goodJson + '\n```';
    expect(parseRoadmap(wrapped)?.name).toBe('Habit Tracker');
  });

  it('returns null without a name', () => {
    expect(parseRoadmap(JSON.stringify({ goals: [{ title: 'x' }] }))).toBeNull();
  });

  it('returns null with no usable goals', () => {
    expect(parseRoadmap(JSON.stringify({ name: 'X', goals: [{ detail: 'no title' }] }))).toBeNull();
  });

  it('returns null on non-JSON', () => {
    expect(parseRoadmap('the model refused to answer')).toBeNull();
  });
});

describe('runIntake', () => {
  it('returns a roadmap from the first good completion', async () => {
    let calls = 0;
    const r = await runIntake('idea', async () => {
      calls += 1;
      return goodJson;
    });
    expect(calls).toBe(1);
    expect(r?.name).toBe('Habit Tracker');
  });

  it('retries once with a stricter prompt when the first output is unusable', async () => {
    const outputs = ['garbage, no json', goodJson];
    let i = 0;
    const r = await runIntake('idea', async () => outputs[i++]);
    expect(i).toBe(2);
    expect(r?.goals.length).toBe(3);
  });

  it('gives up (null) after the retry also fails', async () => {
    const r = await runIntake('idea', async () => 'still no json');
    expect(r).toBeNull();
  });
});
