// Developer & utility tools — GitHub repos, npm & PyPI packages, QR codes and
// name demographics. Free; GitHub honors an optional GITHUB_TOKEN for higher limits.
// Structured results also emit rich artifact cards (data_table / metric_board).

import type { ChatTool } from './types.js';
import type { DataTableArtifact, MetricBoardArtifact, MetricTile } from '../../../../apiTypes.js';
import { fetchJson, envKey } from './http.js';

// --- GitHub repository search ---------------------------------------------------
export interface GHRepo {
  full_name?: string;
  description?: string;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  language?: string;
  html_url?: string;
  license?: { spdx_id?: string };
  updated_at?: string;
}

// Judgment call vs. the metric_board suggestion: this tool is a SEARCH that returns
// several repos, so a sortable table (one row per repo, stars/forks/issues columns)
// fits the data better than a single-repo KPI board would.
/** Map GitHub search results to a sortable data table. Pure. */
export const reposToTable = (query: string, repos: GHRepo[]): DataTableArtifact => ({
  title: 'GitHub repositories',
  subtitle: `Top matches for "${query}"`,
  columns: [
    { label: 'Repository' },
    { label: 'Stars', kind: 'number', align: 'right' },
    { label: 'Forks', kind: 'number', align: 'right' },
    { label: 'Open issues', kind: 'number', align: 'right' },
    { label: 'Language', kind: 'badge' },
    { label: 'Updated' }
  ],
  rows: repos.map((r) => [
    { value: r.full_name || '—', href: r.html_url, sub: r.description ? r.description.slice(0, 80) : undefined },
    r.stargazers_count ?? 0,
    r.forks_count ?? 0,
    r.open_issues_count ?? 0,
    r.language || '—',
    r.updated_at ? r.updated_at.slice(0, 10) : '—'
  ]),
  sort: { column: 1, dir: 'desc' },
  caption: 'Source: GitHub search, ranked by stars'
});

export const githubRepoTool: ChatTool = {
  name: 'github_repo',
  description:
    'Search GitHub for repositories — stars, forks, primary language, license and description, ranked by popularity. Use for "best library for X", finding a project on GitHub, or comparing open-source options.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search terms, optionally with qualifiers, e.g. "react state management" or "language:rust http".' } },
    required: ['query']
  },
  execute: async (args, signal) => {
    const query = String(args?.query || '').trim();
    if (!query) return { content: 'No search query was provided.' };
    const token = envKey('GITHUB_TOKEN');
    try {
      const d = await fetchJson<{ items?: GHRepo[] }>(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=6`,
        { signal, headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } }
      );
      const repos = (d.items || []).filter((r) => r.full_name).slice(0, 6);
      if (!repos.length) return { content: `No GitHub repositories found for "${query}".` };
      const content = `GitHub repositories for "${query}":\n${repos
        .map(
          (r) =>
            `• ${r.full_name} — ⭐ ${(r.stargazers_count || 0).toLocaleString()}${r.language ? ` · ${r.language}` : ''}${
              r.license?.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? ` · ${r.license.spdx_id}` : ''
            }\n  ${(r.description || '').slice(0, 140)}\n  ${r.html_url}`
        )
        .join('\n')}\n(A sortable repo table is shown to the user — don't repeat the stats.)`;
      return {
        content,
        citations: repos.map((r) => ({ url: r.html_url!, title: r.full_name })),
        artifacts: [{ type: 'data_table', data: reposToTable(query, repos) }]
      };
    } catch (err) {
      return { content: `GitHub search failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

// --- npm package ----------------------------------------------------------------

export interface NpmMeta {
  name?: string;
  version?: string;
  description?: string;
  license?: unknown;
  homepage?: string;
  dependencies?: Record<string, string>;
}

/** Map npm registry metadata (+ optional weekly downloads) to a KPI board. Pure. */
export const npmToMetrics = (meta: NpmMeta, weeklyDownloads?: number): MetricBoardArtifact => {
  const license = typeof meta.license === 'string' ? meta.license : (meta.license as { type?: string })?.type || '—';
  const tiles: MetricTile[] = [{ label: 'Latest version', value: meta.version || '—' }];
  if (typeof weeklyDownloads === 'number') tiles.push({ label: 'Weekly downloads', value: weeklyDownloads });
  tiles.push({ label: 'License', value: license });
  tiles.push({ label: 'Dependencies', value: meta.dependencies ? Object.keys(meta.dependencies).length : 0 });
  return { title: `npm — ${meta.name || 'package'}`, columns: 2, tiles };
};

export const npmPackageTool: ChatTool = {
  name: 'npm_package',
  description:
    'Get details about an npm (JavaScript/Node) package — latest version, description, license, homepage and weekly downloads. Use for "what is npm package X", checking a JS library, or its popularity.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Exact npm package name, e.g. "react", "express", "zod".' } },
    required: ['name']
  },
  execute: async (args, signal) => {
    const name = String(args?.name || '').trim();
    if (!name) return { content: 'No package name was provided.' };
    try {
      const meta = await fetchJson<NpmMeta>(
        `https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}/latest`,
        { signal }
      );
      if (!meta.name) return { content: `No npm package found named "${name}".` };
      let weeklyDownloads: number | undefined;
      try {
        const dl = await fetchJson<{ downloads?: number }>(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`, { signal });
        if (typeof dl.downloads === 'number') weeklyDownloads = dl.downloads;
      } catch {
        /* downloads optional */
      }
      const license = typeof meta.license === 'string' ? meta.license : (meta.license as { type?: string })?.type || '—';
      const depCount = meta.dependencies ? Object.keys(meta.dependencies).length : 0;
      const content =
        `npm: ${meta.name}@${meta.version}\n` +
        `• ${meta.description || 'No description.'}\n` +
        `• License: ${license} · Dependencies: ${depCount}${
          typeof weeklyDownloads === 'number' ? `\n• Weekly downloads: ${weeklyDownloads.toLocaleString()}` : ''
        }\n` +
        `• https://www.npmjs.com/package/${meta.name}\n` +
        `(A package stat board is shown to the user — don't repeat the numbers.)`;
      return {
        content,
        citations: [{ url: `https://www.npmjs.com/package/${meta.name}`, title: meta.name }],
        artifacts: [{ type: 'metric_board', data: npmToMetrics(meta, weeklyDownloads) }]
      };
    } catch (err) {
      const msg = (err as Error)?.message || 'unknown error';
      return { content: msg.includes('404') ? `No npm package found named "${name}".` : `npm lookup failed: ${msg}.` };
    }
  }
};

// --- PyPI package ---------------------------------------------------------------

export interface PypiInfo {
  name?: string;
  version?: string;
  summary?: string;
  author?: string;
  license?: string;
  home_page?: string;
  package_url?: string;
}

/** Map PyPI JSON metadata to a KPI board (license sliced — some packages embed full license text). Pure. */
export const pypiToMetrics = (info: PypiInfo): MetricBoardArtifact => ({
  title: `PyPI — ${info.name || 'package'}`,
  columns: 3,
  tiles: [
    { label: 'Latest version', value: info.version || '—' },
    { label: 'License', value: (info.license || '—').slice(0, 40) },
    { label: 'Author', value: info.author || '—' }
  ]
});

export const pypiPackageTool: ChatTool = {
  name: 'pypi_package',
  description:
    'Get details about a PyPI (Python) package — latest version, summary, author, license and project links. Use for "what is Python package X", checking a Python library, or its homepage.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Exact PyPI package name, e.g. "requests", "numpy", "fastapi".' } },
    required: ['name']
  },
  execute: async (args, signal) => {
    const name = String(args?.name || '').trim();
    if (!name) return { content: 'No package name was provided.' };
    try {
      const d = await fetchJson<{ info?: PypiInfo }>(
        `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
        { signal }
      );
      const info = d.info;
      if (!info?.name) return { content: `No PyPI package found named "${name}".` };
      const content =
        `PyPI: ${info.name} ${info.version}\n` +
        `• ${info.summary || 'No summary.'}\n` +
        `• Author: ${info.author || '—'} · License: ${info.license || '—'}\n` +
        `• ${info.package_url || `https://pypi.org/project/${info.name}/`}\n` +
        `(A package stat board is shown to the user — don't repeat the metadata.)`;
      return {
        content,
        citations: [{ url: info.package_url || `https://pypi.org/project/${info.name}/`, title: info.name }],
        artifacts: [{ type: 'metric_board', data: pypiToMetrics(info) }]
      };
    } catch (err) {
      const msg = (err as Error)?.message || 'unknown error';
      return { content: msg.includes('404') ? `No PyPI package found named "${name}".` : `PyPI lookup failed: ${msg}.` };
    }
  }
};

// --- QR code generation (goqr.me) -----------------------------------------------
// Deliberately no extra artifact: the generated QR already renders via the images channel.
export const qrCodeTool: ChatTool = {
  name: 'qr_code',
  description:
    'Generate a QR code image encoding text, a URL, contact info or Wi-Fi credentials (via goqr.me). Use when the user asks to "make a QR code" for something.',
  parameters: {
    type: 'object',
    properties: { data: { type: 'string', description: 'The text/URL to encode in the QR code.' } },
    required: ['data']
  },
  execute: async (args) => {
    const data = String(args?.data || '').trim();
    if (!data) return { content: 'No data was provided to encode.' };
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=10&data=${encodeURIComponent(data)}`;
    return {
      content: `Generated a QR code encoding: ${data.slice(0, 120)}${data.length > 120 ? '…' : ''}. The QR image is shown to the user.`,
      images: [{ url, title: 'QR code', source: 'goqr.me' }]
    };
  }
};

// --- Name demographics (agify / genderize / nationalize) ------------------------
// Deliberately text-only: these are statistical guesses — a KPI board would lend them false authority.
export const predictNameTool: ChatTool = {
  name: 'predict_name',
  description:
    'Predict the likely age, gender and nationality associated with a first name, from large name datasets. Use for "how old/what gender is the name X", persona/character building, or name-origin curiosity. These are statistical guesses, not facts about any individual.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'A first name, e.g. "Maria", "Hiroshi", "James".' } },
    required: ['name']
  },
  execute: async (args, signal) => {
    const name = String(args?.name || '').trim().split(/\s+/)[0];
    if (!name) return { content: 'No name was provided.' };
    const q = encodeURIComponent(name);
    try {
      const [age, gender, nat] = await Promise.all([
        fetchJson<{ age?: number; count?: number }>(`https://api.agify.io?name=${q}`, { signal }).catch(() => ({} as { age?: number; count?: number })),
        fetchJson<{ gender?: string; probability?: number }>(`https://api.genderize.io?name=${q}`, { signal }).catch(() => ({} as { gender?: string; probability?: number })),
        fetchJson<{ country?: { country_id: string; probability: number }[] }>(`https://api.nationalize.io?name=${q}`, { signal }).catch(() => ({} as { country?: { country_id: string; probability: number }[] }))
      ]);
      const countries = (nat.country || []).slice(0, 3).map((c) => `${c.country_id} (${Math.round(c.probability * 100)}%)`).join(', ');
      const content =
        `Statistical prediction for the name "${name}":\n` +
        `• Likely age: ${age.age != null ? `~${age.age} years` : 'unknown'}${age.count ? ` (from ${age.count.toLocaleString()} records)` : ''}\n` +
        `• Likely gender: ${gender.gender ? `${gender.gender} (${Math.round((gender.probability || 0) * 100)}% confidence)` : 'unknown'}\n` +
        `• Likely nationality: ${countries || 'unknown'}\n` +
        `(Population-level estimates — not a statement about any specific person.)`;
      return { content };
    } catch (err) {
      return { content: `Name prediction failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

export const DEV_TOOLS: ChatTool[] = [githubRepoTool, npmPackageTool, pypiPackageTool, qrCodeTool, predictNameTool];
