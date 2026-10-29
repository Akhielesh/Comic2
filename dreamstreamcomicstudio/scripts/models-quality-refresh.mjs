#!/usr/bin/env node
// Owner-run refresh of the public leaderboard snapshot Comic Studio shows next to each image model
// (models.md §4.5 S5/S6, M1-CATALOG). It writes server/src/comic/models/qualitySnapshot.json; commit the
// result like any other change. Nothing runs at import: the network is touched only by main(), and only
// when this file is executed.
//
//   npx tsx scripts/models-quality-refresh.mjs                 refresh LMArena, write the snapshot
//   npx tsx scripts/models-quality-refresh.mjs --dry-run       show what would change, write nothing
//   OPENROUTER_API_KEY=… npx tsx scripts/models-quality-refresh.mjs --benchmarks-out /tmp/or-benchmarks.json
//                                                               also save OpenRouter's benchmarks payload
//
// Sources:
//   * LMArena — the public Hugging Face dataset lmarena-ai/leaderboard-dataset (CC BY 4.0) through the
//     documented datasets-server API: free, no key. The same merge rules as the server's on-demand refresh
//     (server/src/comic/models/quality.ts): a board is replaced only when it matches at least half of the
//     models we track, and every new publish date becomes a dated history point (trend T4). Nothing is
//     interpolated and no number is edited by hand.
//   * Artificial Analysis / Design Arena — OpenRouter's GET /api/v1/benchmarks (documented; needs the platform
//     key, reading it costs nothing). How its rows map to our models is UNVERIFIED, so this script only saves
//     the raw payload for the owner to review (--benchmarks-out); it never merges guessed mappings. AA's own
//     site is never scraped.
//
// Run with tsx (the repo's script runner) so the TypeScript merge rules are shared, not copied. Node 22.18+
// can also run it directly (type stripping).

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_PATH = resolve(HERE, '../server/src/comic/models/qualitySnapshot.json');
const QUALITY_MODULE = resolve(HERE, '../server/src/comic/models/quality.ts');
export const OPENROUTER_BENCHMARKS_URL = 'https://openrouter.ai/api/v1/benchmarks';

/** Parse argv (no defaults that reach the network). */
export const parseArgs = (argv) => {
  const out = { dryRun: false, benchmarksOut: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--benchmarks-out') out.benchmarksOut = argv[++i] ?? null;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
};

/** Human-readable rank changes between two snapshots (per OpenRouter id and LMArena board). */
export const describeChanges = (before, after) => {
  const lines = [];
  for (const board of ['lmarena_t2i', 'lmarena_edit', 'lmarena_multi_image']) {
    const a = before.boards?.[board];
    const b = after.boards?.[board];
    if (!b || a === b) continue;
    lines.push(`${board}: ${a?.asOf ?? 'none'} → ${b.asOf} (${Object.keys(b.entries ?? {}).length} tracked models found)`);
    for (const [id, e] of Object.entries(b.entries ?? {})) {
      const old = a?.entries?.[id];
      if (!old) lines.push(`  + ${id} #${e.rank} · ${e.score}`);
      else if (old.rank !== e.rank || old.score !== e.score) lines.push(`  ~ ${id} #${old.rank} · ${old.score} → #${e.rank} · ${e.score}`);
    }
    for (const id of Object.keys(a?.entries ?? {})) if (!b.entries?.[id]) lines.push(`  - ${id} (no longer matched)`);
  }
  return lines;
};

/**
 * Refresh the LMArena boards of a snapshot. Pure apart from `fetchImpl`; returns the merged snapshot and a
 * summary. `quality` is the server module (injected so tests and the CLI share it).
 */
export const refreshQualitySnapshot = async ({ snapshot, fetchImpl, quality, now = () => Date.now() }) => {
  const boards = await quality.fetchLmarenaBoards(fetchImpl, snapshot.aliases);
  const merged = quality.mergeLmarenaBoards(snapshot, boards, new Date(now()).toISOString());
  return { snapshot: merged.snapshot, replaced: merged.replaced, kept: merged.kept, changes: describeChanges(snapshot, merged.snapshot) };
};

/** Save OpenRouter's benchmarks payload as-is (owner review only; never merged automatically). */
export const saveBenchmarks = async ({ fetchImpl, key, outPath }) => {
  if (!key) throw new Error('OPENROUTER_API_KEY is not set; the benchmarks API needs the platform key.');
  const res = await fetchImpl(OPENROUTER_BENCHMARKS_URL, { headers: { authorization: `Bearer ${key}`, accept: 'application/json' } });
  if (!res.ok) throw new Error(`benchmarks API answered ${res.status}`);
  const body = await res.json();
  await writeFile(outPath, `${JSON.stringify({ fetchedAt: new Date().toISOString(), source: OPENROUTER_BENCHMARKS_URL, body }, null, 2)}\n`);
  return outPath;
};

const HELP = `Refresh Comic Studio's public leaderboard snapshot (LMArena via Hugging Face).

  --dry-run               show the changes, write nothing
  --benchmarks-out FILE   also save OpenRouter's /benchmarks payload (needs OPENROUTER_API_KEY) for review
`;

export const main = async (argv = process.argv.slice(2)) => {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  // A computed specifier keeps the client typecheck (which parses scripts/) from pulling server sources in.
  const quality = await import(pathToFileURL(QUALITY_MODULE).href);
  const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
  const fetchImpl = globalThis.fetch.bind(globalThis);
  const result = await refreshQualitySnapshot({ snapshot, fetchImpl, quality });
  console.log(`LMArena boards replaced: ${result.replaced.join(', ') || 'none'}; kept: ${result.kept.join(', ') || 'none'}`);
  for (const line of result.changes) console.log(line);
  if (!result.replaced.length) console.log('Nothing to write: the snapshot keeps its dated boards.');
  else if (args.dryRun) console.log('Dry run: nothing written.');
  else {
    await writeFile(SNAPSHOT_PATH, `${JSON.stringify(result.snapshot, null, 2)}\n`);
    console.log(`Wrote ${SNAPSHOT_PATH}. Review the diff and commit it.`);
  }
  if (args.benchmarksOut) {
    const out = await saveBenchmarks({ fetchImpl, key: process.env.OPENROUTER_API_KEY, outPath: args.benchmarksOut });
    console.log(`Saved OpenRouter benchmarks to ${out}. Map AA / Design Arena entries by hand with their source and date.`);
  }
  return 0;
};

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err?.message || err);
      process.exit(1);
    }
  );
}
