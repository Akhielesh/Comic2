import { describe, it, expect } from 'vitest';
import { reposToTable, npmToMetrics, pypiToMetrics } from './dev.js';

describe('reposToTable', () => {
  const repos = [
    {
      full_name: 'pmndrs/zustand',
      description: 'Bear necessities for state management in React',
      stargazers_count: 48211,
      forks_count: 1530,
      open_issues_count: 12,
      language: 'TypeScript',
      html_url: 'https://github.com/pmndrs/zustand',
      updated_at: '2026-06-11T08:14:00Z'
    },
    { full_name: 'mystery/repo', html_url: 'https://github.com/mystery/repo' } // sparse
  ];

  it('builds linked rows with star/fork/issue counts and the description as a sub-line', () => {
    const table = reposToTable('react state management', repos);
    expect(table.subtitle).toBe('Top matches for "react state management"');
    expect(table.columns.map((c) => c.label)).toEqual(['Repository', 'Stars', 'Forks', 'Open issues', 'Language', 'Updated']);
    expect(table.rows[0]).toEqual([
      {
        value: 'pmndrs/zustand',
        href: 'https://github.com/pmndrs/zustand',
        sub: 'Bear necessities for state management in React'
      },
      48211,
      1530,
      12,
      'TypeScript',
      '2026-06-11'
    ]);
  });

  it('defaults missing counts to 0 and missing text to em dashes, sorted by stars', () => {
    const table = reposToTable('x', repos);
    expect(table.rows[1]).toEqual([
      { value: 'mystery/repo', href: 'https://github.com/mystery/repo', sub: undefined },
      0,
      0,
      0,
      '—',
      '—'
    ]);
    expect(table.sort).toEqual({ column: 1, dir: 'desc' });
  });
});

describe('npmToMetrics', () => {
  it('renders version, weekly downloads, license and dependency count', () => {
    const board = npmToMetrics(
      {
        name: 'zod',
        version: '3.25.4',
        license: 'MIT',
        dependencies: { 'tslib': '^2.0.0' }
      },
      14_532_991
    );
    expect(board.title).toBe('npm — zod');
    const byLabel = Object.fromEntries(board.tiles.map((t) => [t.label, t]));
    expect(byLabel['Latest version'].value).toBe('3.25.4');
    expect(byLabel['Weekly downloads'].value).toBe(14_532_991);
    expect(byLabel['License'].value).toBe('MIT');
    expect(byLabel['Dependencies'].value).toBe(1);
  });

  it('handles object licenses, missing downloads and zero deps', () => {
    const board = npmToMetrics({ name: 'old-pkg', version: '0.1.0', license: { type: 'ISC' } });
    const labels = board.tiles.map((t) => t.label);
    expect(labels).not.toContain('Weekly downloads');
    const byLabel = Object.fromEntries(board.tiles.map((t) => [t.label, t]));
    expect(byLabel['License'].value).toBe('ISC');
    expect(byLabel['Dependencies'].value).toBe(0);
  });
});

describe('pypiToMetrics', () => {
  it('renders version, license and author tiles', () => {
    const board = pypiToMetrics({ name: 'fastapi', version: '0.115.12', license: 'MIT', author: 'Sebastián Ramírez' });
    expect(board.title).toBe('PyPI — fastapi');
    const byLabel = Object.fromEntries(board.tiles.map((t) => [t.label, t]));
    expect(byLabel['Latest version'].value).toBe('0.115.12');
    expect(byLabel['License'].value).toBe('MIT');
    expect(byLabel['Author'].value).toBe('Sebastián Ramírez');
  });

  it('truncates packages that embed the full license text in the field', () => {
    const board = pypiToMetrics({ name: 'x', version: '1.0', license: 'Permission is hereby granted, free of charge, to any person obtaining a copy…' });
    const byLabel = Object.fromEntries(board.tiles.map((t) => [t.label, t]));
    expect(String(byLabel['License'].value).length).toBeLessThanOrEqual(40);
  });
});
