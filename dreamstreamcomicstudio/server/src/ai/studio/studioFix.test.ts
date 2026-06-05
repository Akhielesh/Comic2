import { describe, expect, it, vi } from 'vitest';
import { buildFixPrompt, parseFixResponse, requestStudioFix } from './studioFix.js';
import { buildObservation } from './observation.js';

const missingDep = buildObservation({ stderr: 'Failed to resolve import "axios" from "src/api.ts"' });

describe('buildFixPrompt', () => {
  it('leads with the observed errors and includes the project files', () => {
    const prompt = buildFixPrompt({ '/src/api.ts': 'import axios from "axios"' }, missingDep);
    expect(prompt).toContain('OBSERVED ERRORS');
    expect(prompt).toContain('missing_dependency');
    expect(prompt).toContain('axios');
    expect(prompt).toContain('FILE: /src/api.ts');
    expect(prompt).toMatch(/Return ONLY a JSON object/);
  });
});

describe('parseFixResponse', () => {
  it('extracts changed files and a note, stripping leading slashes', () => {
    const out = parseFixResponse(
      '```json\n{"note":"added axios","files":[{"path":"/package.json","content":"{\\"deps\\":1}"}]}\n```'
    );
    expect(out.note).toBe('added axios');
    expect(out.files['package.json']).toBe('{"deps":1}');
  });

  it('returns an empty file set when the model emits no JSON', () => {
    expect(parseFixResponse('sorry, I cannot help with that').files).toEqual({});
  });

  it('ignores malformed file entries', () => {
    const out = parseFixResponse('{"files":[{"path":"/a.ts"},{"content":"x"},{"path":"/b.ts","content":"ok"}]}');
    expect(out.files).toEqual({ 'b.ts': 'ok' });
  });
});

describe('requestStudioFix', () => {
  it('feeds the prompt to the injected model call and parses the result', async () => {
    const complete = vi.fn(async (_prompt: string) => '{"note":"fix","files":[{"path":"/App.tsx","content":"fixed"}]}');
    const out = await requestStudioFix({ '/App.tsx': 'broken' }, missingDep, complete);
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0][0]).toContain('OBSERVED ERRORS');
    expect(out.files['App.tsx']).toBe('fixed');
  });
});
