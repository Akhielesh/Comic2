import { describe, it, expect } from 'vitest';
import { inferLanguage, deriveProjectName, filesToVersionMap, sanitizeFiles } from './studioFiles.js';

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
});
