// Golden-script runner for Comic Studio (v4).
//
// Renders a REAL short comic for each golden script (server/src/comic/golden/*.json)
// through the same planning + prompt + vision code the studio uses — source analysis,
// page plan, style board, character/place sheets, page renders with labeled references,
// vision QC and balloon layout — and writes everything to a folder with an index.html
// you can open to judge the result by eye. It talks to the providers directly with the
// operator's own key (no DreamStream billing), so it COSTS REAL MONEY: about $0.50 per
// script on Standard. Nothing is spent without --yes. See README.md in this folder.
//
//   npx tsx server/src/comic/golden/run.ts --script single-lead --tier standard --yes

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_FORMAT,
  createEmptyDoc,
  emptyRender,
  newId,
  type AssetRef,
  type Character,
  type ComicDoc,
  type Format,
  type QualityTier
} from '../../../../shared/comic/doc.js';
import { estimateJobs, imagePriceUsd, TIER_PRESETS } from '../../../../shared/comic/models.js';
import { getStylePreset } from '../../../../shared/comic/stylePresets.js';
import { createImageGenerator } from '../imageClient.js';
import { createLlmClient } from '../llm.js';
import { compileCharacterSheet, compilePage, compilePlaceSheet, compileStyleOption } from '../prompts.js';
import { StudioError, type CompiledImageJob, type ImageGenerator, type LlmClient, type StudioKeys } from '../types.js';
import { analyzePageRender, estimateBalloonHeight } from '../vision.js';
import { analyzeSource, rankStylePresets, writePagePlan } from '../writer.js';

export interface GoldenScript {
  title: string;
  script: string;
  format: Partial<Format>;
  quality: QualityTier;
  /** Optional style preset id (keeps runs comparable across tiers). */
  style?: string;
  /** What a reviewer should check by eye. */
  checks?: string[];
}

const GOLDEN_DIR = dirname(fileURLToPath(import.meta.url));
const MAX_SHEETS = 5;
const MAX_PLACE_SHEETS = 2;
const TIERS: QualityTier[] = ['draft', 'standard', 'pro'];

// ── CLI ──────────────────────────────────────────────────────────────────────

interface Options {
  scripts: string[];
  tier?: QualityTier;
  out: string;
  yes: boolean;
  planOnly: boolean;
  places: boolean;
}

const usage = `Usage: npx tsx server/src/comic/golden/run.ts [options]
  --script <name[,name]>   golden script(s) by file name without .json (default: all)
  --tier <draft|standard|pro>  override each script's quality tier
  --out <dir>              output folder (default: <tmp>/comic-golden/<timestamp>)
  --plan-only              analyze + plan + compile page prompts, no images (text cost only)
  --no-places              skip location sheets
  --yes                    actually call the providers (spends money)
Keys: OPENROUTER_API_KEY (preferred) and/or GEMINI_API_KEY in the environment.`;

const parseArgs = (argv: string[]): Options => {
  const opts: Options = { scripts: [], out: '', yes: false, planOnly: false, places: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return v;
    };
    if (arg === '--script') opts.scripts.push(...value().split(',').map((s) => s.trim().replace(/\.json$/, '')).filter(Boolean));
    else if (arg === '--tier') {
      const tier = value() as QualityTier;
      if (!TIERS.includes(tier)) throw new Error(`--tier must be one of ${TIERS.join(', ')}`);
      opts.tier = tier;
    } else if (arg === '--out') opts.out = resolve(value());
    else if (arg === '--yes') opts.yes = true;
    else if (arg === '--plan-only') opts.planOnly = true;
    else if (arg === '--no-places') opts.places = false;
    else if (arg === '--help' || arg === '-h') {
      console.log(usage);
      process.exit(0);
    } else throw new Error(`Unknown option ${arg}`);
  }
  if (!opts.out) opts.out = join(tmpdir(), 'comic-golden', new Date().toISOString().replace(/[:.]/g, '-'));
  return opts;
};

const keysFromEnv = (): StudioKeys => {
  const keys: StudioKeys = {};
  const openrouter = (process.env.OPENROUTER_API_KEY || '').trim();
  const gemini = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  if (openrouter) keys.openrouter = { key: openrouter, byok: true };
  if (gemini) keys.gemini = { key: gemini, byok: true };
  return keys;
};

export const loadGoldenScripts = async (names: string[] = []): Promise<{ name: string; golden: GoldenScript }[]> => {
  const files = (await readdir(GOLDEN_DIR)).filter((f) => f.endsWith('.json')).sort();
  const wanted = names.length ? files.filter((f) => names.includes(basename(f, '.json'))) : files;
  const missing = names.filter((n) => !files.includes(`${n}.json`));
  if (missing.length) throw new Error(`No golden script named ${missing.join(', ')} (have: ${files.map((f) => basename(f, '.json')).join(', ')})`);
  return Promise.all(
    wanted.map(async (f) => ({ name: basename(f, '.json'), golden: JSON.parse(await readFile(join(GOLDEN_DIR, f), 'utf8')) as GoldenScript }))
  );
};

// ── Small utilities ──────────────────────────────────────────────────────────

/** Pixel size of a PNG / JPEG / WebP / GIF buffer (undefined when unknown). */
const imageSize = (buf: Buffer): { w: number; h: number } | undefined => {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (chunk === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return undefined;
};

const decodeDataUrl = (dataUrl: string): { buffer: Buffer; ext: string } => {
  const m = /^data:([^;,]+)?(;base64)?,/.exec(dataUrl);
  if (!m || !m[2]) throw new Error('Provider returned a non-base64 image');
  const mime = (m[1] || 'image/png').toLowerCase();
  const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
  return { buffer: Buffer.from(dataUrl.slice(m[0].length), 'base64'), ext };
};

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'item';

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const usd = (n: number) => `$${n.toFixed(3)}`;

interface LedgerLine {
  step: string;
  usd: number;
  model: string;
  estimated: boolean;
  ms?: number;
}

// ── One golden run ───────────────────────────────────────────────────────────

interface RunContext {
  llm: LlmClient;
  images: ImageGenerator;
  outDir: string;
  ledger: LedgerLine[];
  /** Local asset store: path → data URL (stands in for Supabase storage). */
  assets: Map<string, string>;
  prompts: string[];
}

const recordText = (ctx: RunContext, step: string, result: { costUsd?: number; model: string }) => {
  ctx.ledger.push({ step, usd: result.costUsd ?? 0, model: result.model, estimated: result.costUsd === undefined });
};

const logPrompt = (ctx: RunContext, name: string, job: CompiledImageJob) => {
  ctx.prompts.push(
    [
      `## ${name}`,
      `model: ${job.spec.id} @ ${job.resolution}, aspect ${job.aspect}, ${job.prompt.length} chars`,
      job.references.length ? `references: ${job.references.map((r, i) => `[${i + 1}] ${r.label} (${r.path})`).join('; ')}` : 'references: none',
      '',
      '```',
      job.prompt,
      '```',
      ''
    ].join('\n')
  );
};

/** Render a compiled job, save the file, register it as a local asset. */
const renderJob = async (ctx: RunContext, name: string, job: CompiledImageJob): Promise<{ asset: AssetRef; dataUrl: string }> => {
  logPrompt(ctx, name, job);
  const references = job.references.map((r) => {
    const dataUrl = ctx.assets.get(r.path);
    if (!dataUrl) throw new Error(`Reference ${r.label} (${r.path}) was never rendered`);
    return { label: r.label, dataUrl };
  });
  process.stdout.write(`  · ${name} (${job.spec.nickname} @ ${job.resolution}, ${job.aspect}, ${references.length} refs)… `);
  const started = Date.now();
  const result = await ctx.images({ spec: job.spec, resolution: job.resolution, aspect: job.aspect, prompt: job.prompt, references });
  const { buffer, ext } = decodeDataUrl(result.dataUrl);
  const file = `${slug(name)}.${ext}`;
  await writeFile(join(ctx.outDir, file), buffer);
  const size = imageSize(buffer);
  const path = `golden/${file}`;
  ctx.assets.set(path, result.dataUrl);
  const cost = result.costUsd ?? imagePriceUsd(job.spec, job.resolution);
  ctx.ledger.push({ step: name, usd: cost, model: result.model, estimated: result.costUsd === undefined, ms: Date.now() - started });
  console.log(`${((Date.now() - started) / 1000).toFixed(1)}s ${usd(cost)}${result.costUsd === undefined ? ' (est.)' : ''}`);
  return {
    asset: { path, source: 'generated', model: result.model, at: Date.now(), ...(size ? { w: size.w, h: size.h } : {}) },
    dataUrl: result.dataUrl
  };
};

const readyRender = (asset: AssetRef) => ({ ...emptyRender(), status: 'ready' as const, asset, updatedAt: Date.now() });

const buildDoc = (golden: GoldenScript, tier: QualityTier): ComicDoc => {
  const doc = createEmptyDoc(newId('golden'), golden.title);
  doc.format = { ...DEFAULT_FORMAT, ...golden.format };
  doc.settings.quality = tier;
  doc.source = { script: golden.script, updatedAt: Date.now() };
  return doc;
};

async function runGolden(ctx: RunContext, golden: GoldenScript, tier: QualityTier, opts: Options): Promise<ComicDoc> {
  const doc = buildDoc(golden, tier);

  console.log('  · analyzing the script…');
  const analysis = await analyzeSource({ doc, llm: ctx.llm, text: golden.script });
  recordText(ctx, 'analyze', analysis);
  doc.brief = { ...doc.brief, ...analysis.brief, title: golden.title, notes: analysis.brief.notes || [] };
  doc.cast = analysis.cast.map(
    (c): Character => ({
      id: newId('ch'),
      name: c.name,
      tier: c.tier,
      look: c.look,
      refs: [],
      sheet: emptyRender(),
      ...(c.role ? { role: c.role } : {}),
      ...(c.personality ? { personality: c.personality } : {}),
      ...(c.voice ? { voice: c.voice } : {})
    })
  );
  doc.places = analysis.places.map((p) => ({ id: newId('pl'), name: p.name, look: p.look, refs: [], sheet: emptyRender() }));

  const preset = getStylePreset(golden.style) || rankStylePresets(doc)[0];
  doc.style = {
    status: 'locked',
    presetId: preset.id,
    name: preset.name,
    spec: preset.spec,
    palette: preset.palette,
    linework: preset.linework,
    avoid: preset.avoid,
    refs: [],
    options: []
  };

  console.log('  · writing the page plan…');
  const plan = await writePagePlan({ doc, llm: ctx.llm });
  recordText(ctx, 'plan', plan);
  doc.cast.push(...plan.newCast);
  doc.pages = plan.pages;
  doc.planStatus = 'approved';

  if (opts.planOnly) {
    for (const page of doc.pages) logPrompt(ctx, `page ${page.n} (plan only — no sheets yet)`, compilePage(doc, page));
    return doc;
  }

  const option = { id: newId('so'), name: preset.name, spec: preset.spec, render: emptyRender() };
  doc.style.board = (await renderJob(ctx, 'style board', compileStyleOption(doc, option))).asset;

  const onPage = new Set(doc.pages.flatMap((p) => p.panels.flatMap((panel) => panel.castIds)));
  const sheeted = doc.cast.filter((c) => c.tier !== 'extra' && onPage.has(c.id)).slice(0, MAX_SHEETS);
  for (const c of sheeted) {
    const { asset } = await renderJob(ctx, `sheet ${c.name}`, compileCharacterSheet(doc, c));
    c.sheet = readyRender(asset);
  }
  if (opts.places) {
    const usage = new Map<string, number>();
    for (const p of doc.pages) for (const panel of p.panels) if (panel.placeId) usage.set(panel.placeId, (usage.get(panel.placeId) || 0) + 1);
    const places = doc.places.filter((p) => usage.has(p.id)).sort((a, b) => usage.get(b.id)! - usage.get(a.id)!).slice(0, MAX_PLACE_SHEETS);
    for (const place of places) {
      const { asset } = await renderJob(ctx, `place ${place.name}`, compilePlaceSheet(doc, place));
      place.sheet = readyRender(asset);
    }
  }

  // Page 1 first, then each page with its predecessor as the continuity reference.
  for (let i = 0; i < doc.pages.length; i += 1) {
    const page = doc.pages[i];
    const previousPage = i > 0 ? doc.pages[i - 1] : undefined;
    const { asset, dataUrl } = await renderJob(ctx, `page ${page.n}`, compilePage(doc, page, { previousPage }));
    page.render = readyRender(asset);
    process.stdout.write(`  · checking page ${page.n}… `);
    const check = await analyzePageRender({ doc, page, dataUrl, llm: ctx.llm });
    recordText(ctx, `qc page ${page.n}`, check);
    page.render = { ...page.render, qc: check.qc };
    page.balloons = check.balloons;
    console.log(`score ${check.qc.score.toFixed(2)}${check.qc.issues.length ? ` — ${check.qc.issues.length} issue(s)` : ''}`);
  }
  return doc;
}

// ── Report ───────────────────────────────────────────────────────────────────

const fileOf = (doc: ComicDoc, path?: string) => (path ? path.replace(/^golden\//, '') : '');

const pageHtml = (doc: ComicDoc, pageIndex: number): string => {
  const page = doc.pages[pageIndex];
  const src = fileOf(doc, page.render.asset?.path);
  const aspect = page.render.asset?.w && page.render.asset?.h ? page.render.asset.w / page.render.asset.h : 2 / 3;
  const lines = new Map(page.panels.flatMap((p) => p.lines.map((l) => [l.id, l] as const)));
  const balloons = page.balloons
    .map((b) => {
      const line = lines.get(b.lineId);
      if (!line) return '';
      const h = estimateBalloonHeight(line.text, b.w, aspect);
      const tail =
        typeof b.tailX === 'number' && typeof b.tailY === 'number'
          ? `<line x1="${(b.x + b.w / 2) * 100}" y1="${(b.y + h * 0.9) * 100}" x2="${b.tailX * 100}" y2="${b.tailY * 100}" />`
          : '';
      const kind = line.kind === 'caption' ? 'caption' : line.kind === 'sfx' ? 'sfx' : 'speech';
      return `${tail ? `<svg class="tail" viewBox="0 0 100 100" preserveAspectRatio="none">${tail}</svg>` : ''}<div class="b ${kind}" style="left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%">${escapeHtml(line.text)}</div>`;
    })
    .join('');
  const qc = page.render.qc;
  return `<section><h2>Page ${page.n}</h2><p class="meta">${escapeHtml(page.summary)}<br>Layout: ${escapeHtml(page.layout)}</p>
<div class="page" style="aspect-ratio:${aspect}">${src ? `<img src="${src}" alt="Page ${page.n}">` : '<p>Not rendered</p>'}${balloons}</div>
${qc ? `<p class="meta">QC score ${qc.score.toFixed(2)} (${escapeHtml(qc.model || '')})</p><ul>${qc.issues.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : ''}
<details><summary>Script</summary><ol>${page.panels
    .map(
      (p) =>
        `<li><b>${p.size}, ${p.shot}</b> — ${escapeHtml(p.action)}${p.lines
          .map((l) => `<br><i>${l.kind}${l.speakerId ? ` ${escapeHtml(doc.cast.find((c) => c.id === l.speakerId)?.name || '')}` : ''}:</i> ${escapeHtml(l.text)}`)
          .join('')}</li>`
    )
    .join('')}</ol></details></section>`;
};

const reportHtml = (name: string, golden: GoldenScript, doc: ComicDoc, ledger: LedgerLine[]): string => {
  const total = ledger.reduce((s, l) => s + l.usd, 0);
  const sheets = [
    ...(doc.style.board ? [{ label: 'Style board', path: doc.style.board.path }] : []),
    ...doc.cast.filter((c) => c.sheet.asset).map((c) => ({ label: c.name, path: c.sheet.asset!.path })),
    ...doc.places.filter((p) => p.sheet.asset).map((p) => ({ label: p.name, path: p.sheet.asset!.path }))
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(golden.title)} — golden</title><style>
body{font:15px/1.5 system-ui,sans-serif;margin:24px auto;max-width:980px;padding:0 16px;color:#1b1b1b;background:#f6f5f2}
h1{margin:0 0 4px}.meta{color:#666;font-size:13px}section{margin:32px 0}
.page{position:relative;width:min(100%,720px);container-type:inline-size;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.12)}
.page img{display:block;width:100%;height:100%;object-fit:contain}
.b{position:absolute;box-sizing:border-box;font:700 1.75cqw/1.25 "Comic Neue","Comic Sans MS",cursive;text-transform:uppercase;text-align:center;padding:1.3cqw 1.5cqw;background:#fff;color:#111;border:0.25cqw solid #111;border-radius:50%/40%}
.b.caption{border-radius:0.4cqw;background:#fff6d6;text-align:left}.b.sfx{background:none;border:none;font-size:3.2cqw;color:#c1121f;-webkit-text-stroke:0.15cqw #111}
.tail{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.tail line{stroke:#111;stroke-width:.35;vector-effect:non-scaling-stroke}
.grid{display:flex;flex-wrap:wrap;gap:12px}.grid figure{margin:0;width:300px}.grid img{width:100%;background:#fff}
table{border-collapse:collapse;font-size:13px}td,th{padding:3px 10px;border-bottom:1px solid #ddd;text-align:left}
</style></head><body>
<h1>${escapeHtml(golden.title)}</h1>
<p class="meta">${escapeHtml(name)} · ${doc.settings.quality} tier (${TIER_PRESETS[doc.settings.quality].model}) · ${doc.format.kind}, ${doc.format.pageAspect}, ${doc.format.readingDirection}, ${doc.format.lettering}, ${doc.format.colorMode} · total ${usd(total)}</p>
${golden.checks?.length ? `<h3>Check by eye</h3><ul>${golden.checks.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>` : ''}
<div class="grid">${sheets.map((s) => `<figure><img src="${fileOf(doc, s.path)}" alt=""><figcaption>${escapeHtml(s.label)}</figcaption></figure>`).join('')}</div>
${doc.pages.map((_, i) => pageHtml(doc, i)).join('\n')}
<h3>Spend</h3><table><tr><th>Step</th><th>Model</th><th>USD</th></tr>${ledger
    .map((l) => `<tr><td>${escapeHtml(l.step)}</td><td>${escapeHtml(l.model)}</td><td>${usd(l.usd)}${l.estimated ? ' (est.)' : ''}</td></tr>`)
    .join('')}</table>
<p class="meta">Prompts: <a href="prompts.md">prompts.md</a> · Document: <a href="doc.json">doc.json</a></p>
</body></html>`;
};

// ── Main ─────────────────────────────────────────────────────────────────────

/** Rough provider spend for one golden run (before the plan exists): board + sheets + places + pages. */
const estimateRun = (golden: GoldenScript, tier: QualityTier, places: boolean) => {
  const pages = golden.format.pageCount || DEFAULT_FORMAT.pageCount;
  const est = estimateJobs(
    [
      { kind: 'style_option', count: 1 },
      { kind: 'sheet', count: 3 },
      { kind: 'place', count: places ? MAX_PLACE_SHEETS : 0 },
      { kind: 'page', count: pages }
    ],
    tier,
    { byok: true }
  );
  return { usd: est.usd + 0.06, images: est.imageCount };
};

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const scripts = await loadGoldenScripts(opts.scripts);
  let planned = 0;
  console.log(`Golden scripts: ${scripts.map((s) => s.name).join(', ')}`);
  for (const { name, golden } of scripts) {
    const tier = opts.tier || golden.quality;
    const est = estimateRun(golden, tier, opts.places);
    planned += opts.planOnly ? 0.06 : est.usd;
    console.log(`  ${name}: ${tier}${opts.planOnly ? ' (plan only)' : `, ~${est.images} images`}, ≈ ${usd(opts.planOnly ? 0.06 : est.usd)}`);
  }
  console.log(`Estimated provider spend: ≈ ${usd(planned)}`);
  if (!opts.yes) {
    console.log('\nNothing was spent. Re-run with --yes to call the providers.');
    return;
  }
  const keys = keysFromEnv();
  if (!keys.openrouter && !keys.gemini) {
    console.error('Set OPENROUTER_API_KEY (preferred) or GEMINI_API_KEY to run the goldens.');
    process.exitCode = 1;
    return;
  }
  const llm = createLlmClient(keys);
  const images = createImageGenerator(keys);
  let failures = 0;
  for (const { name, golden } of scripts) {
    const tier = opts.tier || golden.quality;
    const outDir = join(opts.out, `${name}-${tier}`);
    await mkdir(outDir, { recursive: true });
    const ctx: RunContext = { llm, images, outDir, ledger: [], assets: new Map(), prompts: [] };
    console.log(`\n▶ ${golden.title} (${name}, ${tier})`);
    let doc: ComicDoc | undefined;
    try {
      doc = await runGolden(ctx, golden, tier, opts);
    } catch (err) {
      failures += 1;
      const message = err instanceof StudioError ? `${err.code}: ${err.userMessage}` : (err as Error)?.message || String(err);
      console.error(`\n  ✖ ${name} failed — ${message}`);
    }
    await writeFile(join(outDir, 'prompts.md'), `# ${golden.title} — compiled prompts\n\n${ctx.prompts.join('\n')}`);
    if (doc) {
      await writeFile(join(outDir, 'doc.json'), JSON.stringify(doc, null, 2));
      await writeFile(join(outDir, 'index.html'), reportHtml(name, golden, doc, ctx.ledger));
    }
    const total = ctx.ledger.reduce((s, l) => s + l.usd, 0);
    await writeFile(join(outDir, 'report.json'), JSON.stringify({ name, tier, totalUsd: total, ledger: ctx.ledger, failed: !doc }, null, 2));
    console.log(`  spent ${usd(total)} → ${join(outDir, doc ? 'index.html' : 'report.json')}`);
  }
  if (failures) process.exitCode = 1;
}

const invokedDirectly = (() => {
  try {
    return resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    console.error(`\n${usage}`);
    process.exitCode = 1;
  });
}
