import { describe, it, expect } from 'vitest';
import { parseRepoFullName, buildTreeEntries } from './studioGithub.js';

describe('parseRepoFullName', () => {
  it('parses plain owner/name', () => {
    expect(parseRepoFullName('octocat/hello-world')).toEqual({ owner: 'octocat', repo: 'hello-world' });
  });

  it('strips a full GitHub URL and .git suffix', () => {
    expect(parseRepoFullName('https://github.com/octocat/Hello-World.git')).toEqual({ owner: 'octocat', repo: 'Hello-World' });
  });

  it('tolerates leading/trailing slashes', () => {
    expect(parseRepoFullName('/octocat/hello/')).toEqual({ owner: 'octocat', repo: 'hello' });
  });

  it('returns null for an incomplete spec', () => {
    expect(parseRepoFullName('justaname')).toBeNull();
    expect(parseRepoFullName('')).toBeNull();
  });
});

describe('buildTreeEntries', () => {
  it('maps files to blob tree entries and strips leading slashes', () => {
    const entries = buildTreeEntries([
      { path: '/src/app.ts', content: 'export const x = 1;' },
      { path: 'README.md', content: '# hi' }
    ]);
    expect(entries).toEqual([
      { path: 'src/app.ts', mode: '100644', type: 'blob', content: 'export const x = 1;' },
      { path: 'README.md', mode: '100644', type: 'blob', content: '# hi' }
    ]);
  });

  it('drops oversized files', () => {
    const big = 'x'.repeat(600 * 1024);
    const entries = buildTreeEntries([{ path: 'big.txt', content: big }, { path: 'ok.txt', content: 'small' }]);
    expect(entries.map((e) => e.path)).toEqual(['ok.txt']);
  });
});
