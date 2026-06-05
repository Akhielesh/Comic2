import { describe, it, expect } from 'vitest';
import {
  inferLanguage,
  deriveProjectName,
  filesToVersionMap,
  sanitizeFiles,
  isSafeStudioPath,
  sanitizeFixFiles,
  MAX_STUDIO_FILE_BYTES
} from './studioFiles.js';

describe('studioFiles', () => {
  it('infers editor language from extension', () => {
    expect(inferLanguage('/src/App.tsx')).toBe('typescript');
    expect(inferLanguage('/index.html')).toBe('html');
    expect(inferLanguage('/style.css')).toBe('css');
    expect(inferLanguage('/script.js')).toBe('javascript');
    expect(inferLanguage('/weird.xyz')).toBeUndefined();
  });

  it('derives a project name from title, else the App entry', () => {
    expect(deriveProjectName('My Todo App', [])).toBe('My Todo App');
    expect(deriveProjectName('', [{ path: '/src/App.tsx', content: '' }])).toBe('App.tsx');
    expect(deriveProjectName(undefined, [{ path: '/main.js', content: '' }])).toBe('main.js');
    expect(deriveProjectName('', [])).toBe('Untitled app');
  });

  it('flattens files into a version map', () => {
    const map = filesToVersionMap([
      { path: '/a.ts', content: '1' },
      { path: '/b.ts', content: '2' }
    ]);
    expect(map).toEqual({ '/a.ts': '1', '/b.ts': '2' });
  });

  it('sanitizes inbound files: drops bad entries, adds leading slash + language, caps count', () => {
    const files = sanitizeFiles([
      { path: 'App.tsx', content: 'x' },
      { path: '/ok.css', content: 'y', language: 'css' },
      { path: 123, content: 'bad' },
      { nope: true }
    ]);
    expect(files).toHaveLength(2);
    expect(files[0]).toEqual({ path: '/App.tsx', content: 'x', language: 'typescript' });
    expect(files[1]).toEqual({ path: '/ok.css', content: 'y', language: 'css' });

    const many = Array.from({ length: 300 }, (_, i) => ({ path: `/f${i}.ts`, content: '' }));
    expect(sanitizeFiles(many, 200)).toHaveLength(200);
  });

  it('rejects path traversal and unsafe paths', () => {
    expect(isSafeStudioPath('/src/App.tsx')).toBe(true);
    expect(isSafeStudioPath('App.tsx')).toBe(true);
    expect(isSafeStudioPath('../etc/passwd')).toBe(false);
    expect(isSafeStudioPath('/a/../../b')).toBe(false);
    expect(isSafeStudioPath('~/secrets')).toBe(false);
    expect(isSafeStudioPath('a\\b')).toBe(false);
    expect(isSafeStudioPath('with\0null')).toBe(false);
    expect(isSafeStudioPath('')).toBe(false);
  });

  it('sanitizeFiles drops traversal paths and oversized files', () => {
    const files = sanitizeFiles([
      { path: '/ok.ts', content: 'x' },
      { path: '../escape.ts', content: 'bad' },
      { path: '/huge.ts', content: 'a'.repeat(MAX_STUDIO_FILE_BYTES + 1) }
    ]);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('/ok.ts');
  });

  it('sanitizeFixFiles canonicalizes paths and reports rejections', () => {
    const res = sanitizeFixFiles({
      'package.json': '{}', // no leading slash → canonicalized
      '../evil.ts': 'x', // traversal → rejected
      '/big.ts': 'a'.repeat(MAX_STUDIO_FILE_BYTES + 1) // too large → rejected
    });
    expect(res.files).toEqual({ '/package.json': '{}' });
    expect(res.rejected.map((r) => r.reason).sort()).toEqual(['file_too_large', 'unsafe_path']);
  });

  it('sanitizeFixFiles caps the number of changed files per iteration', () => {
    const raw: Record<string, string> = {};
    for (let i = 0; i < 50; i++) raw[`/f${i}.ts`] = 'x';
    const res = sanitizeFixFiles(raw, { maxFiles: 10 });
    expect(Object.keys(res.files)).toHaveLength(10);
    expect(res.rejected.filter((r) => r.reason === 'max_files')).toHaveLength(40);
  });
});
