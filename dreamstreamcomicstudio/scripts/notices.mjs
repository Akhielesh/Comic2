// W1.6 notices: THIRD-PARTY-NOTICES.txt for the web app, and the `/licenses` text for the engine image.
//
//   web:     licenceModules() (vite.config.ts) calls webNotices() during `npm run build` and emits
//            dist/THIRD-PARTY-NOTICES.txt from the npm packages that are REALLY in the browser bundle,
//            plus the browser-scope fonts, vendored code and CDN scripts recorded in licence-policy.json.
//   engines: node scripts/notices.mjs --engines --out <file>
//            writes the notices for platform-engine/engines.lock.json, the image's own npm runtime
//            (the non-dev packages of platform-engine/package-lock.json, texts read from
//            platform-engine/node_modules, so run it after that folder's `npm ci`) and the engine-scope
//            data assets (the image copies it to /licenses; the gateway serves it at GET /v1/notices).
//   web, standalone: node scripts/notices.mjs --browser-modules <report.json> --out <file>
//
// Deterministic (sorted, no timestamps). Licence texts are read from each package's own
// LICENSE/LICENCE/COPYING/NOTICE files; identical texts are printed once.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ROOT, WEB_NOTICES_TITLE, effectiveLicence, lockfilePackages, loadPolicy } from './licence-check.mjs';

const MAX_TEXT = 64 * 1024;
const LICENCE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

/** Licence-ish files at the top of a directory, sorted. @param {string} dir @returns {{file:string, text:string}[]} */
export function readLicenceTexts(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => LICENCE_FILE.test(n))
    .sort()
    .flatMap((n) => {
      try {
        const text = readFileSync(path.join(dir, n), 'utf8').replace(/\r\n/g, '\n').trim();
        return text ? [{ file: n, text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[… truncated at 64 KB; see the package]` : text }] : [];
      } catch { return []; }
    });
}

/**
 * @typedef {{ title: string, version?: string, licence: string, note?: string, source?: string, texts: {file:string, text:string}[] }} NoticeEntry
 */

/**
 * Renders a notices document. Pure: give it the entries (with their texts) and it returns the text.
 * @param {{ heading: string, intro: string[], sections: { title: string, entries: NoticeEntry[] }[] }} doc
 */
export function renderNotices(doc) {
  const out = [doc.heading, '='.repeat(doc.heading.length), '', ...doc.intro, ''];
  /** @type {Map<string, string[]>} */
  const byText = new Map();
  for (const section of doc.sections) {
    if (!section.entries.length) continue;
    out.push(`${section.title} (${section.entries.length})`, '-'.repeat(section.title.length + String(section.entries.length).length + 3));
    const sorted = [...section.entries].sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
    for (const e of sorted) {
      out.push(`${e.title}${e.version ? `@${e.version}` : ''} — ${e.licence}${e.source ? ` — ${e.source}` : ''}`);
      if (e.note) out.push(`    ${e.note}`);
      const label = `${e.title}${e.version ? `@${e.version}` : ''}`;
      if (!e.texts.length) {
        const k = `(The package ships no licence file. Its licence is ${e.licence}; the standard text is at https://spdx.org/licenses/${encodeURIComponent(e.licence.replace(/[()]/g, '').split(/\s+/)[0])}.html)`;
        byText.set(k, [...(byText.get(k) ?? []), label]);
      }
      for (const t of e.texts) byText.set(t.text, [...(byText.get(t.text) ?? []), label]);
    }
    out.push('');
  }
  out.push('Licence texts', '-------------', '');
  const blocks = [...byText.entries()].map(([text, who]) => ({ who: [...new Set(who)].sort(), text })).sort((a, b) => (a.who[0] < b.who[0] ? -1 : a.who[0] > b.who[0] ? 1 : 0));
  if (!blocks.length) out.push('(none)');
  for (const b of blocks) out.push(`==== ${b.who.join(', ')} ====`, '', b.text, '');
  return `${out.join('\n').trimEnd()}\n`;
}

/** Records of one scope set, as notice entries. @param {any} policy @param {string[]} scopes @param {string} root */
function assetEntries(policy, scopes, root) {
  return (policy.dataAssets.records ?? [])
    .filter((/** @type {any} */ r) => scopes.includes(r.scope))
    .map((/** @type {any} */ r) => {
      /** @type {{file:string, text:string}[]} */
      let texts = [];
      try { texts = [{ file: r.licenceFile, text: readFileSync(path.join(root, r.licenceFile), 'utf8').trim() }]; } catch { /* the gate reports it */ }
      const copyright = Array.isArray(r.copyright) && r.copyright.length ? `\n    ${r.copyright.join('\n    ')}` : '';
      return { title: r.name, version: r.version, licence: r.licence, note: `Terms: ${r.terms}${copyright}`, source: r.source, texts };
    });
}

/**
 * The web app's THIRD-PARTY-NOTICES.txt from a licenceModules() report.
 * @param {{ packages: {key:string, name:string, version:string, licence:string|null}[], vendored?: string[] }} report
 * @param {{ root?: string, policy?: any }} [opts]
 */
export function webNotices(report, opts = {}) {
  const root = opts.root ?? APP_ROOT;
  const policy = opts.policy ?? loadPolicy(path.join(root, 'scripts/licence-policy.json'));
  const packages = report.packages.map((p) => {
    const eff = effectiveLicence(p, policy);
    return { title: p.name, version: p.version, licence: eff.licence ?? 'UNKNOWN', note: eff.note, texts: readLicenceTexts(path.join(root, p.key)) };
  });
  const vendored = (policy.vendored?.records ?? [])
    .filter((/** @type {any} */ r) => (report.vendored ?? []).includes(r.path))
    .map((/** @type {any} */ r) => ({ title: r.name, version: r.version, licence: r.licence, source: r.source, texts: readLicenceTexts(path.join(root, r.path)) }));
  const cdn = (policy.externalScripts ?? []).map((/** @type {any} */ s) => ({ title: s.name, version: s.version, licence: s.licence, source: s.src, texts: [] }));
  return renderNotices({
    heading: `DreamStream — ${WEB_NOTICES_TITLE}`,
    intro: [
      'This web app includes the open-source software below. Each item is listed with its licence and',
      'followed by the licence text it ships with. Generated at build time from the modules actually in',
      'the browser bundle (scripts/notices.mjs; policy: scripts/licence-policy.json).',
    ],
    sections: [
      { title: 'npm packages in the browser bundle', entries: packages },
      { title: 'Vendored code', entries: vendored },
      { title: 'Fonts, models and other data assets', entries: assetEntries(policy, ['browser'], root) },
      { title: 'Scripts loaded from a CDN (not bundled)', entries: cdn },
    ],
  });
}

/**
 * The engine image's /licenses text from engines.lock.json, the image's npm runtime and the
 * engine-scope data assets.
 * @param {any} lock parsed engines.lock.json, or null
 * @param {{ root?: string, policy?: any, packageLock?: any, packageDir?: string }} [opts]
 *   packageLock: the parsed platform-engine/package-lock.json (its non-dev packages are listed);
 *   packageDir: the folder whose node_modules holds them (default <root>/<dirname of engines.npmLockfile>).
 */
export function engineNotices(lock, opts = {}) {
  const root = opts.root ?? APP_ROOT;
  const policy = opts.policy ?? loadPolicy(path.join(root, 'scripts/licence-policy.json'));
  const packageDir = opts.packageDir ?? path.join(root, path.dirname(policy.engines.npmLockfile ?? 'platform-engine/package-lock.json'));
  // Every package that is not dev-only ships in the image (sharp with @img/sharp-libvips, whose LGPL
  // notice is required, mammoth, unpdf, pdfkit, ...). Platform-specific optional builds that npm skips
  // on the image's platform are listed too: over-listing a notice is harmless, missing one is not.
  const npm = opts.packageLock
    ? lockfilePackages(opts.packageLock, { lockfile: 'platform-engine/package-lock.json', root: packageDir })
      .filter((p) => !p.dev)
      .map((p) => {
        const eff = effectiveLicence(p, policy);
        return { title: p.name, version: p.version, licence: eff.licence ?? 'UNKNOWN', note: eff.note, texts: readLicenceTexts(path.join(packageDir, p.key)) };
      })
    : [];
  const engines = (Array.isArray(lock?.engines) ? lock.engines : []).map((/** @type {any} */ e) => {
    /** @type {{file:string, text:string}[]} */
    let texts = [];
    if (e.licenceFile) { try { texts = [{ file: e.licenceFile, text: readFileSync(path.join(root, e.licenceFile), 'utf8').trim() }]; } catch { /* listed by licence id */ } }
    return { title: e.id, version: e.version, licence: e.licence, source: e.source, note: `sha256 ${e.sha256}; ${e.build} build`, texts };
  });
  return renderNotices({
    heading: 'DreamStream platform engine — third-party notices',
    intro: ['The engine image runs the software below, pinned by sha256 in engines.lock.json (policy: scripts/licence-policy.json).'],
    sections: [
      { title: 'Engines', entries: engines },
      { title: 'npm packages in the engine image', entries: npm },
      { title: 'Fonts, ICC profiles and other data assets', entries: assetEntries(policy, ['engine'], root) },
    ],
  });
}

/**
 * What `notices.mjs --engines` writes: reads engines.lock.json and the image's package-lock.json
 * (both named in the policy) under root, either of which may be absent.
 * @param {{ root?: string, policy?: any }} [opts]
 */
export function engineNoticesFromDisk(opts = {}) {
  const root = opts.root ?? APP_ROOT;
  const policy = opts.policy ?? loadPolicy(path.join(root, 'scripts/licence-policy.json'));
  const read = (/** @type {string|undefined} */ rel) => (rel && existsSync(path.join(root, rel)) ? JSON.parse(readFileSync(path.join(root, rel), 'utf8')) : null);
  const engineLock = policy.engines.lockfiles.map((/** @type {string} */ f) => read(f)).find((/** @type {any} */ l) => l !== null) ?? null;
  return engineNotices(engineLock, { root, policy, packageLock: read(policy.engines.npmLockfile) });
}

/** @param {string[]} argv */
function main(argv) {
  const arg = (/** @type {string} */ flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const out = arg('--out');
  let text;
  if (argv.includes('--engines')) {
    text = engineNoticesFromDisk();
  } else {
    const modules = arg('--browser-modules');
    if (!modules || !existsSync(modules)) { console.error('notices: pass --browser-modules <report.json> (LICENCE_MODULES_OUT of a build) or --engines'); return 2; }
    text = webNotices(JSON.parse(readFileSync(modules, 'utf8')));
  }
  if (out) { mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); writeFileSync(out, text); console.log(`notices: wrote ${out} (${text.length} bytes)`); }
  else process.stdout.write(text);
  return 0;
}

const invoked = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invoked) process.exit(main(process.argv.slice(2)));
