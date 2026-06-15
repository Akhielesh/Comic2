import { describe, it, expect } from 'vitest';
import { verifyToolOutput } from './verifyToolOutput.js';
import type { ToolExecResult } from './types.js';

// Build a render_chart result the way registry.ts does: non-finite y → 0, empty-x points
// dropped, empty series dropped. We pass RAW args + the RENDERED artifact so the verifier
// can diff them.
const chartResult = (renderedSeries: unknown[]): ToolExecResult => ({
  content: 'Rendered a bar chart.',
  artifacts: [{ type: 'chart', data: { variant: 'bar', series: renderedSeries } }]
});

describe('verifyToolOutput — render_chart', () => {
  it('does not fire on a clean chart (all finite y, all x kept)', () => {
    const args = { series: [{ points: [{ x: 'Q1', y: 10 }, { x: 'Q2', y: 20 }] }] };
    const out = chartResult([{ points: [{ x: 'Q1', y: 10 }, { x: 'Q2', y: 20 }] }]);
    expect(verifyToolOutput('render_chart', args, out)).toBeNull();
  });

  it('does not fire on genuine zero values (0 is finite, not a coercion)', () => {
    const args = { series: [{ points: [{ x: 'Q1', y: 0 }, { x: 'Q2', y: 0 }] }] };
    const out = chartResult([{ points: [{ x: 'Q1', y: 0 }, { x: 'Q2', y: 0 }] }]);
    expect(verifyToolOutput('render_chart', args, out)).toBeNull();
  });

  it('does not fire on a "0" string (finite via Number())', () => {
    const args = { series: [{ points: [{ x: 'Q1', y: '0' }] }] };
    const out = chartResult([{ points: [{ x: 'Q1', y: 0 }] }]);
    expect(verifyToolOutput('render_chart', args, out)).toBeNull();
  });

  it('fires when a non-numeric y was coerced to 0', () => {
    const args = { series: [{ points: [{ x: 'Q1', y: 'N/A' }, { x: 'Q2', y: 20 }] }] };
    const out = chartResult([{ points: [{ x: 'Q1', y: 0 }, { x: 'Q2', y: 20 }] }]);
    const v = verifyToolOutput('render_chart', args, out);
    expect(v?.level).toBe('warn');
    expect(v?.message).toMatch(/coerced 1 non-numeric/);
  });

  it('counts multiple coerced y-values', () => {
    const args = { series: [{ points: [{ x: 'a', y: null }, { x: 'b', y: 'x' }, { x: 'c', y: NaN }] }] };
    const out = chartResult([{ points: [{ x: 'a', y: 0 }, { x: 'b', y: 0 }, { x: 'c', y: 0 }] }]);
    // null is "missing" (not counted); 'x' and NaN are present-non-finite → 2.
    expect(verifyToolOutput('render_chart', args, out)?.message).toMatch(/coerced 2 non-numeric/);
  });

  it('fires when points were dropped for an empty x-label', () => {
    const args = { series: [{ points: [{ x: 'Q1', y: 1 }, { x: '', y: 2 }, { x: 'Q3', y: 3 }] }] };
    const out = chartResult([{ points: [{ x: 'Q1', y: 1 }, { x: 'Q3', y: 3 }] }]);
    const v = verifyToolOutput('render_chart', args, out);
    expect(v?.message).toMatch(/dropped 1 point/);
  });

  it('does not fire when there is no artifact (tool returned "no usable data")', () => {
    const args = { series: [{ points: [{ x: '', y: 'bad' }] }] };
    const out: ToolExecResult = { content: 'No usable chart data was provided.' };
    expect(verifyToolOutput('render_chart', args, out)).toBeNull();
  });

  it('does not fire when the tool already set a notice', () => {
    const args = { series: [{ points: [{ x: 'Q1', y: 'N/A' }] }] };
    const out = { ...chartResult([{ points: [{ x: 'Q1', y: 0 }] }]), notice: { level: 'warn' as const, message: 'tool said so' } };
    expect(verifyToolOutput('render_chart', args, out)).toBeNull();
  });
});

describe('verifyToolOutput — run_python', () => {
  const SENTINEL = 'The code ran but printed nothing and produced no /output files.';

  it('fires on the no-output sentinel (no error, no image)', () => {
    const v = verifyToolOutput('run_python', {}, { content: SENTINEL });
    expect(v?.level).toBe('warn');
    expect(v?.message).toMatch(/no stdout/);
  });

  it('does not fire when the run produced real stdout', () => {
    expect(verifyToolOutput('run_python', {}, { content: '42\n' })).toBeNull();
  });

  it('does not fire when the run printed "0"', () => {
    expect(verifyToolOutput('run_python', {}, { content: '0\n' })).toBeNull();
  });

  it('does not fire when an image was produced (no stdout but useful output)', () => {
    const out: ToolExecResult = { content: SENTINEL, images: [{ url: 'data:image/png;base64,AAAA' }] };
    expect(verifyToolOutput('run_python', {}, out)).toBeNull();
  });

  it('does not fire on a python error (already carries a notice)', () => {
    const out: ToolExecResult = { content: 'Python error:\nboom', notice: { level: 'error', message: 'Python error' } };
    expect(verifyToolOutput('run_python', {}, out)).toBeNull();
  });
});

describe('verifyToolOutput — other tools', () => {
  it('returns null for any unhandled tool', () => {
    expect(verifyToolOutput('get_weather', {}, { content: 'sunny' })).toBeNull();
  });
});
