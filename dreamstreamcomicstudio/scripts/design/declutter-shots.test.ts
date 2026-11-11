// @vitest-environment node
// The refinement loop's screenshot script (declutter DC-0): its pure parts. The run itself (a QA build, `vite
// preview`, Chromium) is exercised by the integration owner's loop; docs/design/clean-and-smooth.md §4.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DECLUTTER_SCENES, DECLUTTER_VIEWS } from '../../tests/e2e/helpers/clutterProbe';
import { EYE_CHECKS, planOnly, planViews, renderIndexHtml, reviewRows, shotName, transcriptName, transcriptOffsets } from './declutter-shots.mjs';

const METRICS = ['primaries', 'maxBoxDepth', 'truncatedLabels', 'usagePhrases'];

describe('declutter-shots — names and the transcript walk', () => {
  it('a shot is named by its ratchet key, so the numbers and the picture share one name', () => {
    expect(shotName('studio-chat@phone-light')).toBe('studio-chat@phone-light.png');
    expect(transcriptName('desk', 'dark', 0)).toBe('transcript/desk-dark-00.png');
    expect(transcriptName('phone', 'light', 12)).toBe('transcript/phone-light-12.png');
  });

  it('walks a scroller screen by screen with a 10 % overlap and always ends on the newest message', () => {
    // 1500 px of messages in a 420 px scroller: steps of 378 px, the last frame pinned to the bottom (1080).
    expect(transcriptOffsets(1500, 420)).toEqual([0, 378, 756, 1080]);
    // Everything fits: one frame.
    expect(transcriptOffsets(420, 420)).toEqual([0]);
    expect(transcriptOffsets(0, 0)).toEqual([0]);
    expect(transcriptOffsets(800, 0)).toEqual([0]);
  });

  it('caps the frames and still shows the newest screen last', () => {
    const offsets = transcriptOffsets(100_000, 500, 5);
    expect(offsets).toHaveLength(5);
    expect(offsets[0]).toBe(0);
    expect(offsets[offsets.length - 1]).toBe(99_500);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
    expect(transcriptOffsets(100_000, 500, 1)).toEqual([99_500]);
  });
});

describe('declutter-shots — what a run shoots (--only, --view, --theme)', () => {
  const ids = DECLUTTER_SCENES.map((s) => s.id);

  it('--only transcript shoots the transcript alone (the docs offer it as a target)', () => {
    expect(planOnly(['transcript'], ids)).toEqual({ scenes: [], app: false, appIds: [], transcript: true });
  });

  it('--only mixes scene ids, app-<id> and transcript; empty means everything', () => {
    expect(planOnly(['reader', 'app-recipes', 'studio-chat'], ids)).toEqual({ scenes: ['studio-chat', 'reader'], app: true, appIds: ['recipes'], transcript: false });
    expect(planOnly([], ids)).toEqual({ scenes: ids, app: true, appIds: null, transcript: true });
    expect(planOnly([], ids, { app: false, transcript: false })).toEqual({ scenes: ids, app: false, appIds: null, transcript: false });
  });

  it('an unknown --only value, or nothing left to shoot, stops the run before anything is built', () => {
    expect(() => planOnly(['studio-chat', 'studio-chatt'], ids)).toThrow(/--only: no scene studio-chatt \(one of studio-chat, .*app-<id>, transcript\)/);
    expect(() => planOnly(['app-'], ids)).toThrow(/no scene app-/);
    expect(() => planOnly(['transcript'], ids, { transcript: false })).toThrow(/nothing left to shoot/);
    expect(() => planOnly(['app-recipes'], ids, { app: false })).toThrow(/nothing left to shoot/);
  });

  it('shoots the two shot sizes by default; the 320 px view only when asked, in light', () => {
    const pick = (o: { view?: string | null; theme?: string | null }) => planViews(DECLUTTER_VIEWS, o).map((p: { view: { id: string }; themes: string[] }) => `${p.view.id}:${p.themes.join('+')}`);
    expect(pick({})).toEqual(['phone:light+dark', 'desk:light+dark']);
    expect(pick({ theme: 'dark' })).toEqual(['phone:dark', 'desk:dark']);
    expect(pick({ view: 'narrow' })).toEqual(['narrow:light']);
    expect(() => pick({ view: 'narrow', theme: 'dark' })).toThrow(/narrow view is measured in light/);
    expect(() => pick({ view: 'tablet' })).toThrow(/--view is one of phone\|desk\|narrow/);
  });
});

describe('declutter-shots — the review sheet', () => {
  const shots = [
    { key: 'studio-chat@desk-light', file: 'studio-chat@desk-light.png', note: 'studio idle with the open render gate', error: null },
    { key: 'kit-breakdown@desk-light', file: null, note: 'kit', error: 'QA surface crashed: boom' }
  ];
  const report = {
    'studio-chat@desk-light': {
      counts: { primaries: 1, maxBoxDepth: 2, truncatedLabels: 0, usagePhrases: 20 },
      detail: { primaries: ['Approve'], truncated: [], pulses: ['ping on span.dot'], deepestBoxes: ['section', 'div'], duplicateNames: { 'change the': 5 } }
    }
  };
  const previous = { shots: [{ key: 'studio-chat@desk-light', file: 'studio-chat@desk-light.png', counts: { primaries: 2, maxBoxDepth: 2, truncatedLabels: 1, usagePhrases: 33 } }] };
  const baseline = { 'studio-chat@desk-light': { primaries: 2, maxBoxDepth: 2, truncatedLabels: 1, usagePhrases: 33 } };

  it('pairs each shot with the previous wave’s, its numbers, its baseline and what changed', () => {
    const rows = reviewRows({ shots, report, previous, baseline, metrics: METRICS });
    expect(rows[0].counts).toEqual(report['studio-chat@desk-light'].counts);
    expect(rows[0].baseline).toEqual(baseline['studio-chat@desk-light']);
    expect(rows[0].previousFile).toBe('studio-chat@desk-light.png');
    expect(rows[0].changes).toEqual([
      { metric: 'primaries', before: 2, now: 1 },
      { metric: 'truncatedLabels', before: 1, now: 0 },
      { metric: 'usagePhrases', before: 33, now: 20 }
    ]);
    // A scene that failed to open, with no numbers and no previous shot.
    expect(rows[1]).toMatchObject({ counts: null, detail: null, baseline: null, previousFile: null, changes: [] });
    // No previous wave: nothing "changed".
    expect(reviewRows({ shots, report, metrics: METRICS })[0].changes).toEqual([]);
  });

  it('renders a self-contained sheet: both waves side by side, the numbers, the eye-only checks, errors shown', () => {
    const outDir = path.join('/qa', 'declutter', 's2');
    const previousDir = path.join('/qa', 'declutter', 's1');
    const rows = reviewRows({ shots, report, previous, baseline, metrics: METRICS });
    const html = renderIndexHtml({ wave: 's2', commit: 'abc1234', rows, previousDir, outDir, metrics: METRICS, transcripts: [{ key: 'transcript@desk-light', files: ['transcript/desk-light-00.png'] }], hints: { primaries: 'C1: one primary per view' } });
    expect(html).toContain('<title>Clean and smooth · s2</title>');
    expect(html).toContain('src="../s1/studio-chat@desk-light.png"');
    expect(html).toContain('src="studio-chat@desk-light.png"');
    expect(html).toMatch(/<code>primaries<\/code> 1 <span class="muted">\(baseline 2\)<\/span> <b class="down">2 → 1<\/b>/);
    expect(html).toContain('title="C1: one primary per view"');
    expect(html).toContain('Primaries: Approve');
    expect(html).toContain('QA surface crashed: boom');
    expect(html).toContain('transcript/desk-light-00.png');
    for (const [id] of EYE_CHECKS) expect(html).toContain(`<b>${id} `);
    expect(EYE_CHECKS.map(([id]) => id)).toEqual(['C2', 'C4', 'C5', 'C10']);
    // Offline: no script and no remote URL in the sheet.
    expect(html).not.toMatch(/<script|https?:\/\//);
  });

  it('escapes what the page wrote: a control label never becomes markup in the sheet', () => {
    const hostile = {
      'studio-chat@desk-light': {
        counts: { primaries: 1 },
        detail: { primaries: ['<img src=x onerror=alert(1)>'], truncated: ['"><script>alert(1)</script>'], pulses: [], deepestBoxes: [], duplicateNames: {} }
      }
    };
    const rows = reviewRows({ shots: [shots[0]], report: hostile, metrics: METRICS });
    const html = renderIndexHtml({ wave: '<b>w</b>', commit: null, rows, outDir: '/qa', metrics: METRICS });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;b&gt;w&lt;/b&gt;');
  });

  it('says so when the ratchet has not run (no clutter-report.json yet)', () => {
    const rows = reviewRows({ shots: [shots[0]], report: {}, metrics: METRICS });
    expect(renderIndexHtml({ wave: 's2', commit: null, rows, outDir: '/qa', metrics: METRICS })).toContain('No numbers: run the ratchet first');
  });

  it('a scene the ratchet could not measure shows its error and no numbers, never an older run\u2019s', () => {
    const failed = { 'studio-chat@desk-light': { url: '/qa/comic-qa.html?surface=studio', error: 'QA surface crashed: <boom>' } };
    const rows = reviewRows({ shots: [shots[0]], report: failed, previous, baseline, metrics: METRICS });
    expect(rows[0]).toMatchObject({ counts: null, reportError: 'QA surface crashed: <boom>', changes: [] });
    const html = renderIndexHtml({ wave: 's2', commit: null, rows, outDir: '/qa', metrics: METRICS, reportRuns: { 'desk-light': '2026-11-11T10:00:00.000Z' } });
    expect(html).toContain('No numbers: the ratchet could not measure this scene in its last run (QA surface crashed: &lt;boom&gt;)');
    expect(html).not.toContain('<code>primaries</code>');
    expect(html).toContain('measured desk-light 2026-11-11T10:00:00.000Z');
    // A measured scene carries no error.
    expect(reviewRows({ shots: [shots[0]], report, metrics: METRICS })[0].reportError).toBeNull();
  });
});
