import { describe, expect, it } from 'vitest';
import { buildObservation, parseErrors, errorSignature } from './observation.js';

describe('parseErrors', () => {
  it('detects a missing npm dependency from a Vite resolve failure', () => {
    const [e] = parseErrors('Failed to resolve import "react-router-dom" from "src/App.tsx"');
    expect(e.kind).toBe('missing_dependency');
    expect(e.module).toBe('react-router-dom');
  });

  it('distinguishes a wrong relative import path from a missing package', () => {
    const [e] = parseErrors('Failed to resolve import "./componets/Header" from "src/App.tsx"');
    expect(e.kind).toBe('import_error');
    expect(e.module).toBe('./componets/Header');
  });

  it('detects Cannot find module and npm 404', () => {
    expect(parseErrors("Error: Cannot find module 'lodash'")[0]).toMatchObject({
      kind: 'missing_dependency',
      module: 'lodash'
    });
    expect(parseErrors('npm error 404 Not Found - GET https://registry.npmjs.org/reactt')[0]).toMatchObject({
      kind: 'missing_dependency',
      module: 'reactt'
    });
  });

  it('parses a TypeScript diagnostic with file/line/col', () => {
    const [e] = parseErrors("src/App.tsx(12,5): error TS2304: Cannot find name 'usState'.");
    expect(e).toMatchObject({ kind: 'type_error', file: 'src/App.tsx', line: 12, col: 5 });
    expect(e.message).toContain('usState');
  });

  it('detects syntax, runtime, and dev-crash errors', () => {
    expect(parseErrors('SyntaxError: Unexpected token <')[0].kind).toBe('syntax_error');
    expect(parseErrors("ReferenceError: foo is not defined")[0].kind).toBe('runtime_error');
    expect(parseErrors('Error: listen EADDRINUSE: address already in use :::3001')[0].kind).toBe('dev_crash');
  });

  it('dedupes repeated identical errors and caps the count', () => {
    const log = Array(20).fill("Cannot find module 'react'").join('\n');
    const errors = parseErrors(log);
    expect(errors).toHaveLength(1);
  });

  it('returns nothing for clean output', () => {
    expect(parseErrors('VITE v5.0.0  ready in 312 ms\n  ➜  Local: http://localhost:3001/')).toEqual([]);
  });
});

describe('buildObservation', () => {
  it('is ok when there are no signals', () => {
    const obs = buildObservation({ stdout: 'ready in 200ms', httpStatus: 200 });
    expect(obs.ok).toBe(true);
    expect(obs.signature).toBe('ok');
    expect(obs.phase).toBe('unknown');
  });

  it('prioritizes an install error over a later http failure', () => {
    const obs = buildObservation({
      installLog: "npm error Cannot find module 'vite-plugin-foo'",
      httpStatus: 0
    });
    expect(obs.ok).toBe(false);
    expect(obs.phase).toBe('install');
    expect(obs.errors[0].kind).toBe('missing_dependency');
    expect(obs.signature).toBe('missing_dependency:vite-plugin-foo');
  });

  it('flags an http_error when the preview does not come up cleanly', () => {
    const obs = buildObservation({ stdout: 'ready', httpStatus: 500 });
    expect(obs.ok).toBe(false);
    expect(obs.phase).toBe('http');
    expect(obs.errors[0].kind).toBe('http_error');
  });

  it('captures runtime console errors from the preview iframe', () => {
    const obs = buildObservation({
      httpStatus: 200,
      consoleErrors: ["TypeError: Cannot read properties of undefined (reading 'map')"]
    });
    expect(obs.ok).toBe(false);
    expect(obs.phase).toBe('runtime');
    expect(obs.errors[0].kind).toBe('runtime_error');
  });

  it('produces a stable signature for the same dominant error', () => {
    const a = buildObservation({ stderr: 'Failed to resolve import "axios" from "src/api.ts"' });
    const b = buildObservation({ stderr: 'Failed to resolve import "axios" from "src/other.ts"' });
    expect(a.signature).toBe(b.signature);
    expect(a.signature).toBe('missing_dependency:axios');
  });
});

describe('errorSignature', () => {
  it('is "ok" for an empty error list', () => {
    expect(errorSignature([])).toBe('ok');
  });
});
