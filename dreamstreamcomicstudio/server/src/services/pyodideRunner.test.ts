import { describe, it, expect } from 'vitest';
import { runPython } from './pyodideRunner.js';

// These use the REAL Pyodide runtime in a worker thread (lazy-loads CPython/WASM on the
// first call, ~10-30s), so the timeouts are generous.

describe('pyodideRunner — sandbox isolation', () => {
  it(
    'runs basic Python and returns stdout',
    async () => {
      const res = await runPython({ code: "print('hello sandbox')\nprint(2 ** 10)" });
      expect(res.ok).toBe(true);
      expect(res.stdout).toContain('hello sandbox');
      expect(res.stdout).toContain('1024');
    },
    90_000
  );

  it(
    'does NOT leak host process.env to Python (secrets stay out of the sandbox)',
    async () => {
      process.env.PYRUNNER_TEST_SECRET = 'sk-live-must-not-leak';
      const res = await runPython({
        code: [
          'val = None',
          'try:',
          '    import js',
          '    val = js.process.env.PYRUNNER_TEST_SECRET',
          'except Exception as e:',
          "    val = 'BLOCKED:' + type(e).__name__",
          'print(val)'
        ].join('\n')
      });
      expect(res.stdout).not.toContain('sk-live-must-not-leak');
      expect(res.stdout).toMatch(/BLOCKED:/);
    },
    30_000
  );

  it(
    'does NOT let Python reach the host filesystem via the js bridge',
    async () => {
      const res = await runPython({
        code: [
          'out = None',
          'try:',
          '    import js',
          "    out = js.require('node:fs').readFileSync('/etc/hostname', 'utf8')",
          'except Exception as e:',
          "    out = 'BLOCKED:' + type(e).__name__",
          'print(out)'
        ].join('\n')
      });
      expect(res.stdout).toMatch(/BLOCKED:/);
    },
    30_000
  );

  it(
    'gives every run a fresh namespace — no cross-run global leakage',
    async () => {
      await runPython({ code: "tenant_secret = 'tenant-A-private'" });
      const res = await runPython({
        code: ['try:', '    print(tenant_secret)', 'except NameError:', "    print('BLOCKED:NameError')"].join('\n')
      });
      expect(res.stdout).not.toContain('tenant-A-private');
      expect(res.stdout).toContain('BLOCKED:NameError');
    },
    30_000
  );

  it(
    'terminates a runaway loop within the timeout and keeps serving afterwards',
    async () => {
      const started = Date.now();
      const res = await runPython({ code: 'while True:\n    pass', timeoutMs: 2_000 });
      const elapsed = Date.now() - started;
      expect(res.ok).toBe(false);
      expect(res.error).toBeTruthy();
      // soft interrupt (≈2s) + at most the 2s hard-kill grace.
      expect(elapsed).toBeLessThan(2_000 + 2_000 + 3_000);
      // The runtime recovers for the next caller.
      const after = await runPython({ code: "print('still alive')" });
      expect(after.ok).toBe(true);
      expect(after.stdout).toContain('still alive');
    },
    30_000
  );

  it(
    'reads an input file and writes an output file',
    async () => {
      const bytes = new TextEncoder().encode('line1\nline2\nline3\n');
      const res = await runPython({
        code: [
          "data = open('/input/notes.txt').read()",
          "open('/output/count.txt','w').write(str(len(data.splitlines())))"
        ].join('\n'),
        files: [{ name: 'notes.txt', bytes }]
      });
      expect(res.ok).toBe(true);
      const out = res.outputs.find((o) => o.name === 'count.txt');
      expect(out).toBeTruthy();
      expect(new TextDecoder().decode(out!.bytes)).toBe('3');
    },
    30_000
  );

  it('rejects AGPL fitz/PyMuPDF imports outright', async () => {
    const res = await runPython({ code: 'import fitz\nprint(fitz.__doc__)' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/fitz|PyMuPDF/);
  });
});
