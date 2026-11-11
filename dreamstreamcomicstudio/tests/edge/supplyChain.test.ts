// @vitest-environment node
/**
 * ADR 0006 WS-1 — supply chain, kept that way: SHA-pinned workflow actions with least-privilege
 * tokens, no install scripts or @latest tools next to deploy secrets, Dependabot with a cooldown,
 * code owners on the risky paths, SRI on third-party scripts, a lockfile that only names the
 * npm registry, the dependency floors this phase set, and a security.txt that hasn't expired.
 *
 * PF-1 (PROGRAM3, perf lens F1): the classic wizard's jsPDF + html2canvas no longer load with every
 * page. services/legacyPdfLoader.ts injects the same SRI-pinned cdnjs files when someone exports;
 * "the classic wizard's PDF tools" below keeps index.html free of them, the pins identical to the
 * licence records, the CSP open to them, and every caller on the loader.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { mainCsp } from '../../functions/_middleware';
import { buildCsp } from '../../functions/_shared/csp';
import { LEGACY_PDF_SCRIPTS } from '../../services/legacyPdfLoader';
import { allowsUrl, parsePolicy } from './cspEval';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO = path.join(ROOT, '..');
const GITHUB = path.join(REPO, '.github');
const read = (abs: string) => readFileSync(abs, 'utf8');
const app = (rel: string) => read(path.join(ROOT, rel));

/** Lines that aren't comments (a trailing `# vX.Y.Z` stays on its line). */
const codeLines = (text: string) => text.split('\n').filter((l) => !/^\s*#/.test(l));

const HAS_GITHUB = existsSync(path.join(GITHUB, 'workflows'));

describe.skipIf(!HAS_GITHUB)('GitHub workflows (repo root .github/)', () => {
  const workflows = HAS_GITHUB
    ? readdirSync(path.join(GITHUB, 'workflows')).filter((f) => /\.ya?ml$/.test(f)).map((f) => ({ name: f, text: read(path.join(GITHUB, 'workflows', f)) }))
    : [];

  it('pins every action by commit SHA, with the version it stands for', () => {
    const loose: string[] = [];
    for (const { name, text } of workflows) {
      for (const line of codeLines(text)) {
        const m = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line);
        if (!m || m[1].startsWith('./')) continue;
        if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(m[1]) || !/#\s*v\d+(\.\d+)*/.test(m[2])) loose.push(`${name}: ${line.trim()}`);
      }
    }
    expect(loose).toEqual([]);
  });

  it('defaults every workflow token to read-only; writes are granted per job', () => {
    for (const { name, text } of workflows) {
      const lines = text.split('\n');
      const start = lines.findIndex((l) => /^permissions:/.test(l));
      expect(start, `${name} has top-level permissions`).toBeGreaterThanOrEqual(0);
      const block: string[] = [];
      for (const l of lines.slice(start + 1)) {
        if (/^\S/.test(l)) break;
        block.push(l);
      }
      expect(block.join('\n'), name).toMatch(/contents:\s*read/);
      expect(block.join('\n'), `${name}: no top-level write`).not.toMatch(/:\s*write/);
      expect(lines[start], name).not.toMatch(/write-all/);
    }
  });

  it('checks out without persisting the token, installs without scripts, never runs @latest tools', () => {
    for (const { name, text } of workflows) {
      const lines = codeLines(text);
      lines.forEach((line, i) => {
        if (/uses:\s*actions\/checkout@/.test(line)) {
          expect(lines.slice(i + 1, i + 4).join('\n'), `${name}: checkout persist-credentials`).toMatch(/persist-credentials:\s*false/);
        }
        if (/\bnpm ci\b/.test(line)) expect(line, `${name}: ${line.trim()}`).toMatch(/--ignore-scripts/);
        expect(line, `${name}: ${line.trim()}`).not.toMatch(/@latest\b/);
      });
    }
  });

  it('runs every job that holds the Cloudflare deploy token in the production-deploy Environment', () => {
    for (const { name, text } of workflows) {
      if (!/secrets\.CLOUDFLARE_API_TOKEN/.test(text)) continue;
      expect(text, name).toMatch(/^\s+environment:\s*production-deploy\s*$/m);
    }
  });

  it('has Dependabot (npm + actions) with a cooldown of at least 7 days', () => {
    const cfg = read(path.join(GITHUB, 'dependabot.yml'));
    for (const eco of ['npm', 'github-actions']) {
      const section = cfg.split(/\n\s*- package-ecosystem:/).find((s) => s.trimStart().startsWith(eco) || s.includes(`package-ecosystem: ${eco}`));
      expect(section, eco).toBeTruthy();
      const days = Number(/cooldown:\s*\n\s*default-days:\s*(\d+)/.exec(section!)?.[1]);
      expect(days, `${eco} cooldown`).toBeGreaterThanOrEqual(7);
    }
    expect(cfg).toContain('/dreamstreamcomicstudio');
  });

  it('puts the workflows and the edge security files behind code owners, and publishes a policy', () => {
    const owners = read(path.join(GITHUB, 'CODEOWNERS'));
    for (const p of ['/.github/', '/dreamstreamcomicstudio/functions/', '/dreamstreamcomicstudio/public/_headers', '/dreamstreamcomicstudio/package-lock.json']) {
      expect(owners).toMatch(new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s+@\\w`, 'm'));
    }
    expect(existsSync(path.join(GITHUB, 'SECURITY.md'))).toBe(true);
    expect(workflows.some((w) => /ossf\/scorecard-action@/.test(w.text))).toBe(true);
  });
});

describe('dependencies', () => {
  const pkg = JSON.parse(app('package.json')) as {
    dependencies: Record<string, string>; devDependencies: Record<string, string>; overrides?: Record<string, unknown>;
  };
  const lock = JSON.parse(app('package-lock.json')) as { lockfileVersion: number; packages: Record<string, { version?: string; resolved?: string; integrity?: string; link?: boolean }> };
  const semver = (v: string) => v.replace(/^[\^~]/, '').split('.').map((n) => parseInt(n, 10));
  const atLeast = (v: string, min: string) => {
    const [a, b] = [semver(v), semver(min)];
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    return true;
  };

  it('runs the sound model on a stable ONNX Runtime and the auth client new enough for MFA', () => {
    expect(pkg.dependencies['onnxruntime-web']).toMatch(/^\d+\.\d+\.\d+$/); // exact, and no -dev build
    expect(atLeast(pkg.dependencies['onnxruntime-web'], '1.30.0')).toBe(true);
    expect(lock.packages['node_modules/onnxruntime-web'].version).toBe(pkg.dependencies['onnxruntime-web']);
    expect(atLeast(pkg.dependencies['@supabase/supabase-js'], '2.118.0')).toBe(true);
    expect(atLeast(lock.packages['node_modules/@supabase/supabase-js'].version!, '2.118.0')).toBe(true);
  });

  it('keeps the dictation model runtime under Pages’ 25 MiB file limit (transformers held, native deps patched)', () => {
    // @huggingface/transformers 4.3.x bundles an ONNX Runtime whose asyncify .wasm is 25.6 MiB —
    // over the Pages per-file limit, so the site would not deploy. It stays on 4.2.0 until that
    // changes (liveCsp.built.test.ts checks every built file); its Node-only native deps, which
    // the browser never loads, are lifted past their advisories by overrides.
    expect(pkg.dependencies['@huggingface/transformers']).toBe('4.2.0');
    expect(pkg.overrides).toEqual({ '@huggingface/transformers': { sharp: '$sharp', 'onnxruntime-node': expect.stringMatching(/^\d+\.\d+\.\d+$/) } });
  });

  it('never asks for "latest" or "*"', () => {
    for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(spec, name).not.toMatch(/^(latest|\*|x)$/i);
    }
  });

  it('resolves every package from the npm registry, with an integrity hash', () => {
    expect(lock.lockfileVersion).toBe(3);
    const odd = Object.entries(lock.packages)
      .filter(([k, v]) => k && !v.link && (!v.resolved?.startsWith('https://registry.npmjs.org/') || !/^sha512-/.test(v.integrity ?? '')))
      .map(([k]) => k);
    expect(odd).toEqual([]);
  });
});

describe('third-party code in the pages', () => {
  it('index.html pins every external script with Subresource Integrity', () => {
    const doc = new JSDOM(app('index.html')).window.document;
    const external = [...doc.querySelectorAll('script[src]')].filter((s) => /^https?:/i.test(s.getAttribute('src') ?? ''));
    // Since PF-1 the page may carry none (the PDF tools load on demand); any that come back are pinned.
    for (const s of external) {
      expect(s.getAttribute('integrity'), s.getAttribute('src')!).toMatch(/^sha(384|512)-[A-Za-z0-9+/]+=*$/);
      expect(s.getAttribute('crossorigin'), s.getAttribute('src')!).toBe('anonymous');
    }
    expect(new JSDOM(app('live.html')).window.document.querySelectorAll('script[src^="http"]').length).toBe(0);
  });

  it('the YAMNet worker fetches nothing but our own hash-checked model', () => {
    const src = app('live/monitor/yamnet.worker.ts');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/https?:\/\//);
    expect(code).toMatch(/const MODEL_URL = '\/models\/yamnet\/yamnet-v1\.onnx'/);
    expect(code).toMatch(/MODEL_SHA256 = '[0-9a-f]{64}'/);
  });
});

describe("the classic wizard's PDF tools (PF-1: loaded on demand, not with every page)", () => {
  const PINS = Object.values(LEGACY_PDF_SCRIPTS);
  const IS_LEGACY_PDF = /\/(jspdf|html2canvas)\//i;
  const LOADER = 'services/legacyPdfLoader.ts';

  /** The jsPDF / html2canvas `<script src>` tags a page carries (index.html: none once DS-2 applies PF-1's note). */
  const legacyTagsIn = (html: string) =>
    [...new JSDOM(html).window.document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src')!).filter((src) => IS_LEGACY_PDF.test(src));

  /**
   * A direct read of the UMD globals, which works only while index.html carries the tags (after PF-1 it
   * throws on export): `declare const jspdf`, `declare global { interface Window { jspdf … } }`, and
   * `window.jspdf` / `(window as any).jspdf` / `globalThis.html2canvas` / `self['jspdf']`.
   */
  const GLOBAL_READ =
    /\bdeclare\s+(?:const|let|var)\s+(?:jspdf|html2canvas)\b|\binterface\s+Window\b[^}]*\b(?:jspdf|html2canvas)\b|\b(?:window|globalThis|self)\b[^;\n]*?(?:\.|\[\s*['"`])(?:jspdf|html2canvas)\b/;

  /** Call sites another package moves onto the loader (wave notes). An entry that no longer matches must go. */
  const PENDING: Readonly<Record<string, string>> = {
    'components/modals/ProjectInfoModal.tsx': 'DS-3 wave note (PF-1): buildPdfBlob awaits loadJsPdf()',
  };

  /** Everything the client bundle can import: the source dirs, the root modules and the ambient .d.ts files. */
  const CLIENT_ROOTS = ['components', 'services', 'hooks', 'lib', 'contexts', 'live', 'shared', 'qa', 'App.tsx', 'index.tsx', 'types.ts', 'apiTypes.ts', 'vite-env.d.ts'];
  const clientFiles = (() => {
    let cached: string[] | null = null;
    return () => {
      if (cached) return cached;
      const files: string[] = [];
      const walk = (rel: string) => {
        const abs = path.join(ROOT, rel);
        if (!existsSync(abs)) return;
        if (statSync(abs).isDirectory()) {
          for (const name of readdirSync(abs)) if (name !== 'node_modules') walk(path.join(rel, name));
        } else if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(rel) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)) files.push(rel.split(path.sep).join('/'));
      };
      CLIENT_ROOTS.forEach(walk);
      return (cached = files);
    };
  })();
  const directReaders = () => clientFiles().filter((f) => f !== LOADER && GLOBAL_READ.test(app(f)));

  /**
   * The window-globals rule for one index.html. While the page still carries the tags, a PENDING caller may
   * read the globals until its wave note lands. Once the tags are gone nothing defines the globals, so every
   * direct reader would throw on export: PENDING no longer excuses it (index.html's note without the
   * ProjectInfoModal note goes red here, not in a user's hands). A PENDING entry whose note landed must go.
   */
  function globalsRule(indexHtml: string, readers: readonly string[], pending: Readonly<Record<string, string>> = PENDING) {
    const tagsLeft = legacyTagsIn(indexHtml).length > 0;
    return {
      tagsLeft,
      offenders: tagsLeft ? readers.filter((f) => !pending[f]) : [...readers],
      stalePending: Object.keys(pending).filter((f) => !readers.includes(f)),
    };
  }

  // Reads the SOURCE index.html: Vite copies external <script src> and <link> tags into dist/index.html
  // untouched (its only HTML transform, vite.config.ts dsSkinEverywherePlugin, strips one attribute), so
  // what holds here holds for the built page. Green once DS-2 applies PF-1's index.html wave note.
  it('index.html loads neither script, and warms no connection to cdnjs for them', () => {
    const html = app('index.html');
    expect(legacyTagsIn(html), 'move these to services/legacyPdfLoader.ts (deferred classic scripts hold the module entry back)').toEqual([]);
    const warmed = [...new JSDOM(html).window.document.querySelectorAll('link[rel~="preconnect"], link[rel~="dns-prefetch"]')]
      .map((l) => l.getAttribute('href') ?? '')
      .filter((href) => /cdnjs\.cloudflare\.com/i.test(href));
    expect(warmed).toEqual([]);
  });

  it('the loader pins exactly the cdnjs files the licence policy records, each SHA-512 SRI-pinned', () => {
    const policy = JSON.parse(app('scripts/licence-policy.json')) as { externalScripts: { src: string; name: string; version: string }[] };
    expect(PINS.map((p) => p.name).sort()).toEqual(['html2canvas', 'jspdf']);
    for (const pin of PINS) {
      expect(pin.src).toBe(`https://cdnjs.cloudflare.com/ajax/libs/${pin.name}/${pin.version}/${pin.src.split('/').pop()}`);
      expect(pin.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(pin.integrity, pin.src).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
      expect(policy.externalScripts, `${pin.src} needs its licence record (THIRD-PARTY-NOTICES)`).toContainEqual(expect.objectContaining({ src: pin.src, name: pin.name, version: pin.version }));
    }
    // Every CDN licence record is something a page or the loader still loads (no stale notices).
    const loaded = new Set([
      ...PINS.map((p) => p.src),
      ...['index.html', 'live.html'].flatMap((f) => [...new JSDOM(app(f)).window.document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src')!))
    ]);
    for (const record of policy.externalScripts) expect(loaded.has(record.src), record.src).toBe(true);
  });

  it('the CSP still lets the loader inject them: script-src(-elem) allows each pinned URL', () => {
    const mainPage = 'https://dreamstreamstudio.ai/';
    const sharePage = 'https://comics.dreamstreamstudio.ai/c/Ab3dEf6hIj9kLm2nP';
    const policies = [
      { name: 'main app (functions/_middleware.ts mainCsp)', policy: parsePolicy(mainCsp({ origin: 'https://dreamstreamstudio.ai' })), self: mainPage },
      // A shared-comic page is the same SPA shell, and in-app navigation keeps its (enforced) policy.
      { name: 'shared comic (functions/_shared/csp.ts buildCsp)', policy: parsePolicy(buildCsp({ hashes: { scripts: [], handlers: [] }, supabaseOrigin: 'https://bdjfmxfmhqhzvgrhbbzm.supabase.co', embed: false })), self: sharePage },
    ];
    for (const { name, policy, self } of policies) {
      for (const pin of PINS) expect(allowsUrl(policy, 'script-src-elem', pin.src, self), `${name}: ${pin.src}`).toBe(true);
    }
  });

  it('the direct-read pattern catches every way of reaching the globals, and none of the loader calls', () => {
    const reads = [
      'declare const jspdf: any;',
      'declare let html2canvas: any',
      'declare global {\n  interface Window {\n    jspdf: any;\n  }\n}',
      'interface Window { html2canvas?: (el: HTMLElement) => Promise<HTMLCanvasElement> }',
      'const jspdf = (window as any).jspdf;',
      'const pdf = new window.jspdf.jsPDF();',
      'globalThis.html2canvas(el);',
      'const { jsPDF } = self.jspdf;',
      "const h = window['html2canvas'];",
    ];
    for (const code of reads) expect(GLOBAL_READ.test(code), code).toBe(true);
    const calls = [
      "import { legacyPdfErrorMessage, loadJsPdf } from '../../services/legacyPdfLoader';",
      'const { jsPDF, html2canvas } = await loadLegacyPdf();',
      'const canvas = await html2canvas(element, { scale: 2 });',
      'const [html2canvas, jsPDF] = await Promise.all([loadHtml2Canvas(), loadJsPdf()]);',
      "window.addEventListener('resize', onResize); const canvas = await html2canvas(el);",
      '// jsPDF + html2canvas load on demand (services/legacyPdfLoader.ts).',
      "if (isLegacyPdfReady('jspdf')) sizePdf();",
    ];
    for (const code of calls) expect(GLOBAL_READ.test(code), code).toBe(false);
  });

  it('nothing reads the window globals directly: every caller awaits services/legacyPdfLoader.ts', () => {
    const files = clientFiles();
    expect(files).toContain(LOADER);
    // The ambient declarations and every client root are walked (a `declare global` hides in a .d.ts).
    expect(files).toContain('vite-env.d.ts');
    for (const dir of CLIENT_ROOTS.filter((r) => !/\.[jt]sx?$/.test(r) && existsSync(path.join(ROOT, r)))) {
      expect(files.some((f) => f.startsWith(`${dir}/`)), `${dir}/ is walked`).toBe(true);
    }
    const { tagsLeft, offenders, stalePending } = globalsRule(app('index.html'), directReaders());
    if (tagsLeft) {
      expect(offenders, 'await loadJsPdf() / loadHtml2Canvas() / loadLegacyPdf() instead').toEqual([]);
    } else {
      expect(offenders, 'index.html no longer provides window.jspdf/html2canvas, so these exports would throw: apply the DS-3 wave note in the same integration').toEqual([]);
    }
    expect(stalePending, 'these are on the loader now: remove them from PENDING').toEqual([]);
  });

  it("the rule goes red when index.html loses the tags but a PENDING caller still reads the globals (one wave note without the other)", () => {
    const legacy = 'components/legacy/Exporter.tsx';
    const pending = { [legacy]: 'wave note' };
    const withTags = `<!doctype html><html><head>${PINS.map((p) => `<script defer src="${p.src}" integrity="${p.integrity}" crossorigin="anonymous"></script>`).join('')}</head><body></body></html>`;
    const noted = '<!doctype html><html><head><script type="module" src="/index.tsx"></script></head><body></body></html>';
    expect(legacyTagsIn(withTags)).toHaveLength(2);
    expect(legacyTagsIn(noted)).toEqual([]);

    // Tags still on the page: the PENDING caller is excused until its note lands.
    expect(globalsRule(withTags, [legacy], pending)).toEqual({ tagsLeft: true, offenders: [], stalePending: [] });
    // The index.html note alone: the caller's export would throw, and PENDING no longer covers it.
    expect(globalsRule(noted, [legacy], pending)).toEqual({ tagsLeft: false, offenders: [legacy], stalePending: [] });
    // Both notes: the caller is on the loader, and its PENDING entry must go.
    expect(globalsRule(noted, [], pending)).toEqual({ tagsLeft: false, offenders: [], stalePending: [legacy] });
    expect(globalsRule(noted, [], {})).toEqual({ tagsLeft: false, offenders: [], stalePending: [] });
  });

  it('every loader caller shows the calm copy, and the modal\'s automatic size refresh never fetches the tools', () => {
    const users = clientFiles().filter((f) => f !== LOADER && /from\s+['"][^'"]*\/legacyPdfLoader['"]/.test(app(f)));
    expect(users).toEqual(expect.arrayContaining(['components/steps/ReferenceBuilder.tsx', 'components/steps/ReviewExport.tsx']));
    for (const f of users) expect(app(f), `${f}: show legacyPdfErrorMessage(e) when an export fails`).toMatch(/\blegacyPdfErrorMessage\(/);
    // ProjectInfoModal refreshes its file sizes on a 1.2 s timer when it opens with stale sizes. Once it is on
    // the loader (DS-3 wave note), that refresh sizes the PDF only when the tools are already loaded.
    const modal = 'components/modals/ProjectInfoModal.tsx';
    if (users.includes(modal)) {
      expect(app(modal), `${modal}: gate the automatic size refresh on isLegacyPdfReady('jspdf')`).toMatch(/\bisLegacyPdfReady\(\s*['"]jspdf['"]\s*\)/);
    }
  });
});

describe('security.txt (RFC 9116)', () => {
  const txt = app('public/.well-known/security.txt');
  const field = (name: string) => [...txt.matchAll(new RegExp(`^${name}:\\s*(.+)$`, 'gmi'))].map((m) => m[1].trim());

  it('has a contact, a policy and both canonical addresses', () => {
    expect(field('Contact').length).toBeGreaterThan(0);
    for (const c of field('Contact')) expect(c).toMatch(/^(mailto:|https:\/\/)/);
    expect(field('Policy')[0]).toMatch(/^https:\/\//);
    expect(field('Canonical')).toEqual(expect.arrayContaining([
      'https://dreamstreamstudio.ai/.well-known/security.txt',
      'https://stream.dreamstreamstudio.ai/.well-known/security.txt',
    ]));
  });

  it('has not expired, and expires within about a year (refresh it before then)', () => {
    const [expires] = field('Expires');
    const t = Date.parse(expires);
    expect(Number.isFinite(t)).toBe(true);
    expect(t, 'security.txt has expired — set a new Expires (≤ 1 year ahead)').toBeGreaterThan(Date.now());
    expect(t - Date.now()).toBeLessThan(400 * 24 * 3600 * 1000);
  });
});
