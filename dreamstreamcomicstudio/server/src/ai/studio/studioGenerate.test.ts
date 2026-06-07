import { describe, it, expect } from 'vitest';
import { buildGeneratePrompt, parseGeneratedApp, runGenerate, reviewCompleteness } from './studioGenerate.js';

const VALID_APP = JSON.stringify({
  title: 'X', template: 'react-ts', files: [{ path: '/App.tsx', content: 'export default () => null;' }],
});

// review:false isolates the parse/retry behavior from the new auto-repair + completeness review passes.
describe('runGenerate (retry)', () => {
  it('returns the app on a valid first answer without retrying', async () => {
    let calls = 0;
    const art = await runGenerate(async () => { calls++; return VALID_APP; }, { prompt: 'a todo app' }, { review: false });
    expect(art).not.toBeNull();
    expect(calls).toBe(1);
  });

  it('retries once with a stricter JSON reminder when the first answer is unparseable', async () => {
    const seen: string[] = [];
    const art = await runGenerate(async (p) => { seen.push(p); return seen.length === 1 ? 'sorry, I can not do that' : VALID_APP; }, { prompt: 'a todo app' }, { review: false });
    expect(art).not.toBeNull();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain('Output ONLY the JSON object');
  });

  it('returns null when both attempts fail', async () => {
    let calls = 0;
    const art = await runGenerate(async () => { calls++; return 'not json'; }, { prompt: 'x' }, { review: false });
    expect(art).toBeNull();
    expect(calls).toBe(2);
  });
});

describe('runGenerate (auto-repair + completeness review)', () => {
  const STUB = JSON.stringify({
    title: 'G', template: 'react-ts',
    files: [{ path: '/App.tsx', content: 'export default function App(){ return null; }\n// game loop, setInterval, etc.' }],
  });
  const FIXED = JSON.stringify({
    title: 'G', template: 'react-ts',
    files: [{ path: '/App.tsx', content: 'export default function App(){ setInterval(() => {}, 16); return null; }' }],
  });

  it('auto-repairs a static stub issue (comment-only game loop) before returning', async () => {
    let n = 0;
    const art = await runGenerate(async () => { n += 1; return n === 1 ? STUB : FIXED; }, { prompt: 'a game' }, { review: false });
    expect(n).toBe(2); // generate + one repair pass
    expect(art!.files[0].content).toContain('setInterval(');
  });

  it('runs a completeness review for NEW apps and adopts the improved result', async () => {
    const ONE = JSON.stringify({ title: 'X', template: 'react-ts', files: [{ path: '/App.tsx', content: 'export default () => null;' }] });
    const TWO = JSON.stringify({ title: 'X', template: 'react-ts', files: [
      { path: '/App.tsx', content: 'export default () => null;' },
      { path: '/src/engine.ts', content: 'export const tick = () => {};' },
    ] });
    let n = 0;
    const art = await runGenerate(async () => { n += 1; return n === 1 ? ONE : TWO; }, { prompt: 'a game' }); // review defaults on
    expect(n).toBe(2); // generate (clean) + completeness review
    expect(art!.files).toHaveLength(2);
  });

  it('skips the completeness review when refining an existing app', async () => {
    let n = 0;
    await runGenerate(async () => { n += 1; return VALID_APP; }, {
      prompt: 'tweak it', currentFiles: [{ path: '/App.tsx', content: 'export default () => null;' }],
    });
    expect(n).toBe(1); // refine → no review pass
  });

  it('reviewCompleteness keeps the original when the review is degraded (fewer files)', async () => {
    const original = parseGeneratedApp(JSON.stringify({ title: 'X', template: 'react-ts', files: [
      { path: '/App.tsx', content: 'export default () => null;' },
      { path: '/src/a.ts', content: 'export const a = 1;' },
    ] }))!;
    const worse = JSON.stringify({ title: 'X', template: 'react-ts', files: [{ path: '/App.tsx', content: 'export default () => null;' }] });
    const out = await reviewCompleteness(async () => worse, 'a game', original, 'react-ts');
    expect(out.files).toHaveLength(2); // kept the original, not the degraded review
  });
});

describe('buildGeneratePrompt', () => {
  it('builds a generate prompt from an idea', () => {
    const p = buildGeneratePrompt({ prompt: 'a todo app', template: 'react-ts' });
    expect(p).toContain('a todo app');
    expect(p).toContain('react-ts');
    expect(p).toContain('Return ONLY a single JSON object');
    // No "current app" block when not refining.
    expect(p).not.toContain('CURRENT APP');
  });

  it('builds a refine prompt that includes current files + the change', () => {
    const p = buildGeneratePrompt({
      prompt: 'add a dark mode toggle',
      currentFiles: [{ path: '/App.tsx', content: 'export default () => null;' }],
      currentTitle: 'Todo',
    });
    expect(p).toContain('CURRENT APP');
    expect(p).toContain('"Todo"');
    expect(p).toContain('/App.tsx');
    expect(p).toContain('add a dark mode toggle');
    expect(p).toContain('replace the current files');
  });

  it('defaults to react-ts for an unknown template', () => {
    const p = buildGeneratePrompt({ prompt: 'x', template: 'cobol' });
    expect(p).toContain('react-ts');
  });
});

describe('parseGeneratedApp', () => {
  it('parses a clean JSON object into an artifact', () => {
    const json = JSON.stringify({
      title: 'Todo App',
      description: 'A simple todo list',
      template: 'react-ts',
      files: [{ path: '/App.tsx', content: 'export default function App(){return null}' }],
    });
    const art = parseGeneratedApp(json);
    expect(art).not.toBeNull();
    expect(art!.title).toBe('Todo App');
    expect(art!.template).toBe('react-ts');
    expect(art!.files).toHaveLength(1);
    expect(art!.files[0].language).toBe('typescript');
  });

  it('extracts JSON from surrounding prose / fences', () => {
    const text = 'Sure! Here it is:\n```json\n' +
      JSON.stringify({ title: 'X', template: 'react', files: [{ path: 'main.js', content: 'console.log(1)' }] }) +
      '\n```\nEnjoy.';
    const art = parseGeneratedApp(text);
    expect(art).not.toBeNull();
    // Leading slash is added.
    expect(art!.files[0].path).toBe('/main.js');
    expect(art!.files[0].language).toBe('javascript');
  });

  it('falls back to a default template + title when missing/invalid', () => {
    const art = parseGeneratedApp(JSON.stringify({ template: 'nope', files: [{ path: '/index.html', content: '<h1>hi</h1>' }] }));
    expect(art).not.toBeNull();
    expect(art!.title).toBe('App');
    expect(art!.template).toBe('react-ts');
  });

  it('returns null when there are no valid files', () => {
    expect(parseGeneratedApp(JSON.stringify({ title: 'X', files: [] }))).toBeNull();
    expect(parseGeneratedApp('not json at all')).toBeNull();
    expect(parseGeneratedApp(JSON.stringify({ title: 'X', files: [{ path: 5, content: 'x' }] }))).toBeNull();
  });

  it('caps the file list at 50', () => {
    const files = Array.from({ length: 80 }, (_, i) => ({ path: `/f${i}.ts`, content: 'x' }));
    const art = parseGeneratedApp(JSON.stringify({ title: 'X', template: 'react-ts', files }));
    expect(art!.files).toHaveLength(50);
  });
});
