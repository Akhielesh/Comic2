import { describe, it, expect } from 'vitest';
import { parseGithubTarget } from './productivity.js';

// The /code-review skill's live-data path starts by parsing the user's reference
// into a concrete GitHub API target — these forms all appear in real chat input.
describe('parseGithubTarget', () => {
  it('parses a full PR URL', () => {
    expect(parseGithubTarget('https://github.com/acme/fetcher/pull/482')).toEqual({
      owner: 'acme',
      repo: 'fetcher',
      kind: 'pull',
      ref: '482'
    });
  });

  it('parses owner/repo#number shorthand', () => {
    expect(parseGithubTarget('acme/my.repo#7')).toEqual({ owner: 'acme', repo: 'my.repo', kind: 'pull', ref: '7' });
  });

  it('parses a commit URL', () => {
    expect(parseGithubTarget('https://github.com/acme/fetcher/commit/abc1234def')).toEqual({
      owner: 'acme',
      repo: 'fetcher',
      kind: 'commit',
      ref: 'abc1234def'
    });
  });

  it('tolerates surrounding text being absent and extra path noise', () => {
    expect(parseGithubTarget('see https://github.com/a-b/c_d/pull/12/files')).toMatchObject({ owner: 'a-b', repo: 'c_d', ref: '12' });
  });

  it('rejects non-GitHub input (pasted code falls through to direct review)', () => {
    expect(parseGithubTarget('const x = 1;')).toBeNull();
    expect(parseGithubTarget('https://gitlab.com/acme/repo/-/merge_requests/3')).toBeNull();
    expect(parseGithubTarget('acme/repo')).toBeNull();
  });
});
