// W1.6 licence gate: ONE policy (scripts/licence-policy.json) over
//   1. every npm lockfile the repo ships from (the app, each Worker),
//   2. the packages that are really in the browser bundle (licenceModules() in vite.config.ts writes them
//      to $LICENCE_MODULES_OUT during `npm run build`),
//   3. platform-engine/engines.lock.json (engine binaries: sha256, licence, source URL),
//   4. the data assets (fonts, ICC profiles), vendored code and CDN scripts in index.html / live.html.
//
// Rules: browser = MIT/Apache/BSD/ISC/MPL/OFL only; GPL/LGPL server-only and only from the allowlist;
// AGPL/SSPL/BUSL/PolyForm/CC-NC/source-available/no licence blocked everywhere; a named denylist.
// A known violation is never fixed here by changing a dependency: the policy records it as an owner
// decision (`exceptions`), which this gate reports as KNOWN on every run instead of failing.
//
// Usage (from the app dir):
//   node scripts/licence-check.mjs [--browser-modules <file>] [--require-browser-modules]
//                                  [--notices <dist/THIRD-PARTY-NOTICES.txt>] [--json]
// Exit 0 = pass (KNOWN entries allowed), 1 = a violation, 2 = bad input.
//
// Pure and dependency-free (node: built-ins only); the functions are exported for
// tests/config/licencePolicy.test.ts and for vite.config.ts / scripts/notices.mjs.
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const POLICY_FILE = path.join(APP_ROOT, 'scripts/licence-policy.json');

/** @typedef {'browser'|'server'|'dev'|'engine'|'qa'} Scope */
/** @typedef {{ kind: string, licence?: string, message: string }} Problem */
/**
 * @typedef {{
 *   subject: string, name: string, version?: string, scope: Scope, source: string,
 *   licence: string, effective?: string, status: 'ok'|'known'|'fail', problems: Problem[],
 *   note?: string, decision?: string
 * }} Result
 */

/** @param {string} [file] */
export function loadPolicy(file = POLICY_FILE) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------------------------
// SPDX expressions
// ---------------------------------------------------------------------------------------------

/**
 * Parses an SPDX licence expression (`A`, `A OR B`, `(A AND B) OR C`, `A WITH exc`). Returns null for
 * anything that is not one (`BSD`, `SEE LICENSE IN ./LICENSE`, `Apache 2.0`, …).
 * @param {string} text
 * @returns {null | {t:'id', id:string, with?:string} | {t:'or'|'and', items:any[]}}
 */
export function parseSpdx(text) {
  if (typeof text !== 'string') return null;
  const tokens = text.trim().match(/\(|\)|[^\s()]+/g);
  if (!tokens || tokens.length === 0) return null;
  let i = 0;
  const isId = (/** @type {string|undefined} */ t) => !!t && /^[A-Za-z0-9][A-Za-z0-9.+:-]*$/.test(t) && !/^(AND|OR|WITH)$/i.test(t);
  /** @returns {any} */
  const parseOr = () => {
    const items = [parseAnd()];
    while (tokens[i] && /^OR$/i.test(tokens[i])) { i++; items.push(parseAnd()); }
    return items.length === 1 ? items[0] : { t: 'or', items };
  };
  const parseAnd = () => {
    const items = [parseWith()];
    while (tokens[i] && /^AND$/i.test(tokens[i])) { i++; items.push(parseWith()); }
    return items.length === 1 ? items[0] : { t: 'and', items };
  };
  const parseWith = () => {
    const atom = parseAtom();
    if (tokens[i] && /^WITH$/i.test(tokens[i])) {
      i++;
      if (atom.t !== 'id' || !isId(tokens[i])) throw new Error('bad WITH');
      atom.with = tokens[i++];
    }
    return atom;
  };
  /** @returns {any} */
  const parseAtom = () => {
    const tok = tokens[i];
    if (tok === '(') {
      i++;
      const inner = parseOr();
      if (tokens[i] !== ')') throw new Error('unbalanced');
      i++;
      return inner;
    }
    if (!isId(tok)) throw new Error(`unexpected ${tok}`);
    i++;
    return { t: 'id', id: /** @type {string} */ (tok) };
  };
  try {
    const ast = parseOr();
    return i === tokens.length ? ast : null;
  } catch {
    return null;
  }
}

/** @param {any} ast @returns {string} */
export function spdxToString(ast) {
  if (ast.t === 'id') return ast.with ? `${ast.id} WITH ${ast.with}` : ast.id;
  const parts = ast.items.map((/** @type {any} */ a) => (a.t === 'id' ? spdxToString(a) : `(${spdxToString(a)})`));
  return parts.join(ast.t === 'or' ? ' OR ' : ' AND ');
}

// ---------------------------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------------------------

/** `*` matches within one path or name segment, `**` across segments. @param {string} pattern */
export function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') { re += '.*'; i++; }
    else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** @param {string} pattern @param {string} name */
export const globMatch = (pattern, name) => globToRegExp(pattern).test(name);

/** Numeric dotted-version compare (`1.07.4` < `2.0.0`). @param {string} a @param {string} b */
export function compareVersions(a, b) {
  const pa = String(a).split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------------------------

/** Which rule set a scope uses: the browser's (browser, qa) or the server's (server, dev, engine). @param {Scope} scope */
export const rulesFor = (scope) => (scope === 'browser' || scope === 'qa' ? 'browser' : 'server');

/**
 * One licence id in one scope. `names` are the subject's names (npm name, alias, `engine:<id>`,
 * `asset:<name>`) that the copyleft allowlist may name.
 * @param {string} id @param {Scope} scope @param {string[]} names @param {any} policy
 * @returns {Problem|null}
 */
export function classifyLicence(id, scope, names, policy) {
  for (const b of policy.blocked) {
    if (new RegExp(b.pattern).test(id)) return { kind: 'blocked', licence: id, message: `${id} is blocked everywhere (${b.reason})` };
  }
  if (new RegExp(policy.copyleft.pattern).test(id)) {
    if (rulesFor(scope) === 'browser') return { kind: 'copyleft-in-browser', licence: id, message: `${id} is GPL/LGPL: never allowed in the browser bundle` };
    const allowed = policy.copyleft.serverAllowlist.some((/** @type {any} */ e) => names.some((n) => globMatch(e.match, n)));
    return allowed ? null : { kind: 'copyleft-not-allowlisted', licence: id, message: `${id} is GPL/LGPL and ${names[0]} is not on the server copyleft allowlist` };
  }
  const allow = policy.scopes[rulesFor(scope)].allow;
  if (allow.includes(id)) return null;
  return { kind: 'not-allowed', licence: id, message: `${id} is not on the ${rulesFor(scope)} allowlist` };
}

/**
 * Evaluates a parsed expression. OR passes when one alternative passes (the first that does is the
 * one we use); AND needs every part; `X WITH exception` is judged as X (an exception only adds rights).
 * @param {any} ast @param {Scope} scope @param {string[]} names @param {any} policy
 * @returns {{ ok: boolean, used: string, problems: Problem[] }}
 */
export function evaluateExpression(ast, scope, names, policy) {
  if (ast.t === 'id') {
    const p = classifyLicence(ast.id, scope, names, policy);
    return { ok: !p, used: spdxToString(ast), problems: p ? [p] : [] };
  }
  const parts = ast.items.map((/** @type {any} */ a) => evaluateExpression(a, scope, names, policy));
  if (ast.t === 'or') {
    const first = parts.find((/** @type {any} */ p) => p.ok);
    if (first) return { ok: true, used: first.used, problems: [] };
    return { ok: false, used: spdxToString(ast), problems: parts.flatMap((/** @type {any} */ p) => p.problems) };
  }
  const bad = parts.filter((/** @type {any} */ p) => !p.ok);
  return { ok: bad.length === 0, used: spdxToString(ast), problems: bad.flatMap((/** @type {any} */ p) => p.problems) };
}

/**
 * The licence we actually rely on for a package: the lockfile string, a clarification (non-SPDX string
 * read by a human), then a dual-licence election.
 * @param {{name:string, version?:string, licence?:string|null}} pkg @param {any} policy
 * @returns {{ licence: string|null, note?: string, problem?: Problem }}
 */
export function effectiveLicence(pkg, policy) {
  let licence = pkg.licence ?? null;
  /** @type {string[]} */
  const notes = [];
  const clar = policy.clarifications?.[`${pkg.name}@${pkg.version}`];
  if (clar && typeof clar === 'object') {
    notes.push(`clarified '${licence}' → ${clar.licence}: ${clar.evidence}`);
    licence = clar.licence;
  }
  const el = policy.elections?.[pkg.name];
  if (el && typeof el === 'object' && licence) {
    const ast = parseSpdx(licence);
    const options = ast?.t === 'or' ? ast.items.map(spdxToString) : [];
    if (!options.includes(el.licence)) {
      return { licence, problem: { kind: 'election-mismatch', licence, message: `elected ${el.licence} is not an option of '${licence}'` } };
    }
    notes.push(`elected ${el.licence} from '${licence}': ${el.reason}`);
    licence = el.licence;
  }
  return { licence, note: notes.join('; ') || undefined };
}

/** @param {any} policy @param {string[]} names */
const denied = (policy, names) => policy.denyPackages.find((/** @type {any} */ d) => names.some((n) => globMatch(d.match, n)));

/** @param {any} policy @param {{name:string, version?:string, scope:Scope}} subject @param {string|null} licence */
function findException(policy, subject, licence) {
  return (policy.exceptions ?? []).find((/** @type {any} */ e) =>
    e.package === subject.name &&
    (e.version === undefined || e.version === subject.version) &&
    e.licence === licence &&
    (!e.scopes || e.scopes.includes(subject.scope)));
}

/**
 * Judges one subject (npm package, engine, asset, vendored copy or CDN script).
 * @param {{ subject?: string, name: string, aliases?: string[], version?: string, licence?: string|null,
 *           scope: Scope, source: string, noDeny?: boolean, extraProblems?: Problem[], extraAllow?: string[] }} item
 * @param {any} policy
 * @returns {Result}
 */
export function evaluateItem(item, policy) {
  if (item.extraAllow?.length) {
    // A licence allowed for this one subject only (a verified custom data-asset licence).
    const rules = rulesFor(item.scope);
    policy = { ...policy, scopes: { ...policy.scopes, [rules]: { ...policy.scopes[rules], allow: [...policy.scopes[rules].allow, ...item.extraAllow] } } };
  }
  const names = [item.name, ...(item.aliases ?? [])];
  /** @type {Problem[]} */
  const problems = [...(item.extraProblems ?? [])];
  const deny = item.noDeny ? undefined : denied(policy, names);
  if (deny) problems.push({ kind: 'denied', message: `${item.name} is on the named denylist (${deny.reason})` });

  const eff = effectiveLicence({ name: item.name, version: item.version, licence: item.licence }, policy);
  let used = eff.licence ?? '';
  if (eff.problem) problems.push(eff.problem);
  else if (!eff.licence || !String(eff.licence).trim()) problems.push({ kind: 'no-licence', message: 'no licence recorded: blocked everywhere' });
  else {
    const ast = parseSpdx(eff.licence);
    if (!ast) problems.push({ kind: 'unrecognised', licence: eff.licence, message: `'${eff.licence}' is not an SPDX expression: read the licence file and add a clarification` });
    else {
      const r = evaluateExpression(ast, item.scope, names, policy);
      used = r.used;
      problems.push(...r.problems);
    }
  }

  /** @type {Result} */
  const result = {
    subject: item.subject ?? (item.version ? `${item.name}@${item.version}` : item.name),
    name: item.name, version: item.version, scope: item.scope, source: item.source,
    licence: item.licence ?? '', effective: used || undefined, status: problems.length ? 'fail' : 'ok', problems, note: eff.note,
  };
  // A denylisted package is never rescued by an exception; anything else may be an owner decision.
  if (problems.length && !problems.some((p) => p.kind === 'denied')) {
    const ex = findException(policy, item, eff.licence);
    if (ex) { result.status = 'known'; result.decision = `${ex.decision ?? 'owner'} decision${ex.status ? ` (${ex.status})` : ''}: ${ex.reason}`; }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// npm lockfiles and the browser bundle
// ---------------------------------------------------------------------------------------------

/** `node_modules/a/node_modules/@s/b` → `@s/b`. @param {string} key */
export function nameFromKey(key) {
  const tail = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const segs = tail.split('/');
  return segs[0].startsWith('@') ? `${segs[0]}/${segs[1]}` : segs[0];
}

/** A package.json `license` (string, `{type}`) or legacy `licenses` array, as one SPDX-ish string. @param {any} pj */
export function licenceOfPackageJson(pj) {
  if (!pj) return null;
  if (typeof pj.license === 'string') return pj.license;
  if (pj.license && typeof pj.license.type === 'string') return pj.license.type;
  if (Array.isArray(pj.licenses) && pj.licenses.length) {
    const ids = pj.licenses.map((/** @type {any} */ l) => (typeof l === 'string' ? l : l?.type)).filter(Boolean);
    return ids.length > 1 ? `(${ids.join(' OR ')})` : ids[0] ?? null;
  }
  return null;
}

/**
 * The installed packages of a lockfile v2/v3 (workspace folders and links are first-party and skipped).
 * @param {any} lock @param {{ lockfile?: string, root?: string }} [opts]
 * @returns {{ key: string, name: string, alias?: string, version: string, licence: string|null, dev: boolean, lockfile: string }[]}
 */
export function lockfilePackages(lock, opts = {}) {
  const out = [];
  for (const [key, v] of Object.entries(lock?.packages ?? {})) {
    if (!key || !key.includes('node_modules/') || v.link) continue;
    const keyName = nameFromKey(key);
    const name = typeof v.name === 'string' ? v.name : keyName;
    let licence = typeof v.license === 'string' ? v.license : null;
    if (licence === null && opts.root) {
      // Older lockfiles may omit `license`; fall back to the installed package.json.
      try { licence = licenceOfPackageJson(JSON.parse(readFileSync(path.join(opts.root, key, 'package.json'), 'utf8'))); } catch { /* not installed */ }
    }
    out.push({ key, name, alias: name !== keyName ? keyName : undefined, version: v.version ?? '', licence, dev: v.dev === true, lockfile: opts.lockfile ?? 'package-lock.json' });
  }
  return out;
}

/**
 * Builds the browser-bundle report from the module ids Rollup put in the output (chunk modules, asset
 * sources, worker bundles). Used by licenceModules() in vite.config.ts.
 * @param {Iterable<string>} ids @param {{ root: string, readPackageJson?: (dir: string) => any }} opts
 */
export function browserModulesReport(ids, opts) {
  const root = opts.root;
  const read = opts.readPackageJson ?? ((/** @type {string} */ dir) => {
    try { return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; }
  });
  /** @type {Map<string, {key:string, name:string, version:string, licence:string|null, modules:number}>} */
  const pkgs = new Map();
  const vendored = new Set();
  let firstParty = 0;
  const NM = '/node_modules/';
  for (const raw of ids) {
    if (!raw || raw.startsWith('\0') || raw.startsWith('virtual:')) continue;
    let id = raw.replace(/\\/g, '/').replace(/[?#].*$/, '');
    if (!path.isAbsolute(id)) id = path.resolve(root, id).replace(/\\/g, '/');
    const last = id.lastIndexOf(NM);
    if (last < 0) {
      firstParty++;
      const rel = path.relative(root, id).replace(/\\/g, '/');
      const m = /^(?:(.*?)\/)?vendor\/([^/]+)/.exec(rel);
      if (m && !rel.startsWith('..')) vendored.add(`${m[1] ? `${m[1]}/` : ''}vendor/${m[2]}`);
      continue;
    }
    const segs = id.slice(last + NM.length).split('/');
    const name = segs[0].startsWith('@') ? `${segs[0]}/${segs[1]}` : segs[0];
    const dir = id.slice(0, last + NM.length) + name;
    const key = id.slice(id.indexOf(NM) + 1, last + NM.length) + name;
    const hit = pkgs.get(key);
    if (hit) { hit.modules++; continue; }
    const pj = read(dir);
    pkgs.set(key, { key, name: pj?.name ?? name, version: pj?.version ?? '', licence: licenceOfPackageJson(pj), modules: 1 });
  }
  return {
    version: 1,
    packages: [...pkgs.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    vendored: [...vendored].sort(),
    firstPartyModules: firstParty,
  };
}

// ---------------------------------------------------------------------------------------------
// engines.lock.json (JSON Schema subset)
// ---------------------------------------------------------------------------------------------

/**
 * @param {any} schema @param {any} value @param {string} [at]
 * @returns {string[]} error messages (empty = valid)
 */
export function validateSchema(schema, value, at = '$') {
  /** @type {string[]} */
  const errs = [];
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if ('const' in schema && value !== schema.const) errs.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: must be one of ${schema.enum.join(', ')}`);
  if (schema.type) {
    const ok = schema.type === 'integer' ? Number.isInteger(value) : schema.type === type;
    if (!ok) { errs.push(`${at}: must be ${schema.type}`); return errs; }
  }
  if (type === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${at}: does not match ${schema.pattern}`);
  }
  if (type === 'array') {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((/** @type {any} */ v, /** @type {number} */ i) => errs.push(...validateSchema(schema.items, v, `${at}[${i}]`)));
  }
  if (type === 'object') {
    for (const r of schema.required ?? []) if (!(r in value)) errs.push(`${at}.${r}: required`);
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k];
      if (sub) errs.push(...validateSchema(sub, v, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}.${k}: unknown field`);
    }
  }
  return errs;
}

/**
 * @param {any} lock parsed engines.lock.json @param {any} policy @param {string} [file]
 * @returns {Result[]}
 */
export function checkEngines(lock, policy, file = 'platform-engine/engines.lock.json') {
  const schemaErrors = validateSchema(policy.engines.schema, lock);
  /** @type {Result[]} */
  const out = [];
  if (schemaErrors.length) {
    out.push({ subject: file, name: file, scope: 'engine', source: file, licence: '', status: 'fail',
      problems: schemaErrors.map((m) => ({ kind: 'schema', message: m })) });
  }
  const engines = Array.isArray(lock?.engines) ? lock.engines : [];
  const seen = new Set();
  for (const e of engines) {
    if (!e || typeof e !== 'object') continue;
    /** @type {Problem[]} */
    const extra = [];
    if (seen.has(e.id)) extra.push({ kind: 'schema', message: `duplicate engine id ${e.id}` });
    seen.add(e.id);
    if (!/^[0-9a-f]{64}$/.test(String(e.sha256 ?? ''))) extra.push({ kind: 'schema', message: 'sha256 must be 64 lowercase hex characters' });
    if (!/^https:\/\//.test(String(e.source ?? ''))) extra.push({ kind: 'schema', message: 'source must be an https:// URL' });
    out.push(evaluateItem({ name: `engine:${e.id}`, version: e.version, licence: e.licence, scope: 'engine', source: file, noDeny: true, extraProblems: extra }, policy));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Data assets, vendored code, CDN scripts
// ---------------------------------------------------------------------------------------------

/** Every data-asset file under root (relative paths, sorted). @param {string} root @param {any} policy */
export function scanDataAssets(root, policy) {
  const exts = new Set(policy.dataAssets.extensions.map((/** @type {string} */ e) => e.toLowerCase()));
  const ignore = new Set(policy.dataAssets.ignoreDirs);
  /** @type {string[]} */
  const out = [];
  /** @param {string} rel */
  const walk = (rel) => {
    let entries;
    try { entries = readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { if (!ignore.has(ent.name) && !ignore.has(r)) walk(r); }
      else if (ent.isFile() && exts.has(path.extname(ent.name).toLowerCase())) out.push(r);
    }
  };
  walk('');
  return out.sort();
}

/**
 * @param {string[]} files data-asset files (relative to root) @param {any} policy
 * @param {{ root?: string, exists?: (rel: string) => boolean }} [opts]
 * @returns {{ results: Result[], warnings: string[] }}
 */
export function checkDataAssets(files, policy, opts = {}) {
  const exists = opts.exists ?? ((/** @type {string} */ rel) => !!opts.root && existsSync(path.join(opts.root, rel)));
  const records = policy.dataAssets.records ?? [];
  /** @type {Result[]} */
  const results = [];
  /** @type {string[]} */
  const warnings = [];
  const used = new Set();
  for (const f of files) {
    const hits = records.filter((/** @type {any} */ r) => (r.files ?? []).some((/** @type {string} */ g) => globMatch(g, f)));
    if (hits.length === 1) { used.add(hits[0]); continue; }
    results.push({ subject: f, name: f, scope: 'server', source: 'data assets', licence: '', status: 'fail',
      problems: [hits.length === 0
        ? { kind: 'asset-unrecorded', message: `${f} has no data-asset record (licence and terms) in licence-policy.json` }
        : { kind: 'asset-ambiguous', message: `${f} matches ${hits.length} data-asset records` }] });
  }
  for (const r of records) {
    /** @type {Problem[]} */
    const extra = [];
    if (typeof r.terms !== 'string' || !r.terms.trim()) extra.push({ kind: 'asset-no-terms', message: `${r.name}: no recorded terms` });
    if (!['browser', 'server', 'engine', 'qa'].includes(r.scope)) extra.push({ kind: 'schema', message: `${r.name}: scope must be browser, server, engine or qa` });
    if (typeof r.licenceFile !== 'string' || !r.licenceFile) extra.push({ kind: 'asset-no-licence-file', message: `${r.name}: no licenceFile recorded` });
    else if (!exists(r.licenceFile)) extra.push({ kind: 'asset-no-licence-file', message: `${r.name}: licence file ${r.licenceFile} is missing` });
    for (const pin of policy.dataAssets.minVersions ?? []) {
      if (!new RegExp(pin.name).test(r.name ?? '')) continue;
      if (!r.version) extra.push({ kind: 'asset-version', message: `${r.name}: a version is required (${pin.reason})` });
      else if (compareVersions(r.version, pin.min) < 0) extra.push({ kind: 'asset-version', message: `${r.name} ${r.version} is below ${pin.min} (${pin.reason})` });
    }
    const scope = /** @type {Scope} */ (['browser', 'server', 'engine', 'qa'].includes(r.scope) ? r.scope : 'browser');
    // Custom terms (an ICC profile's licence, say) are a LicenseRef-* that the policy lists with the
    // terms as read from the licence text; they count only once a human marked them verified.
    /** @type {string[]} */
    const extraAllow = [];
    const custom = typeof r.licence === 'string' ? policy.dataAssets.customLicences?.[r.licence] : undefined;
    if (custom && typeof custom === 'object') {
      if (custom.verified !== true) extra.push({ kind: 'asset-terms-unverified', licence: r.licence, message: `${r.name}: the terms of ${r.licence} are not verified yet (read the licence text, then set verified: true)` });
      else if (!(custom.scopes ?? []).includes(r.scope)) extra.push({ kind: 'asset-scope', licence: r.licence, message: `${r.name}: ${r.licence} is not allowed in scope ${r.scope}` });
      else extraAllow.push(r.licence);
    }
    const res = evaluateItem({ subject: `asset:${r.name}`, name: `asset:${r.name}`, version: r.version, licence: r.licence, scope, source: 'data assets', noDeny: true, extraProblems: extra, extraAllow }, policy);
    results.push(res);
    if (!used.has(r) && opts.root) warnings.push(`data-asset record '${r.name}' matches no file (stale or not landed yet)`);
  }
  return { results, warnings };
}

/** Directories directly under a folder named `vendor` (relative to root). @param {string} root @param {any} policy */
export function scanVendored(root, policy) {
  const ignore = new Set(policy.dataAssets.ignoreDirs);
  /** @type {string[]} */
  const out = [];
  /** @param {string} rel */
  const walk = (rel) => {
    let entries;
    try { entries = readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ignore.has(ent.name) || ignore.has(r) || ent.name === 'public') continue;
      if (ent.name === 'vendor') {
        for (const sub of readdirSync(path.join(root, r), { withFileTypes: true })) out.push(`${r}/${sub.name}`);
      } else walk(r);
    }
  };
  walk('');
  return out.sort();
}

/**
 * @param {string[]} dirs vendored paths found on disk or in the bundle @param {any} policy
 * @param {{ root?: string, exists?: (rel: string) => boolean }} [opts]
 * @returns {{ results: Result[], warnings: string[] }}
 */
export function checkVendored(dirs, policy, opts = {}) {
  const exists = opts.exists ?? ((/** @type {string} */ rel) => !!opts.root && existsSync(path.join(opts.root, rel)));
  const records = policy.vendored?.records ?? [];
  /** @type {Result[]} */
  const results = [];
  /** @type {string[]} */
  const warnings = [];
  for (const dir of [...new Set(dirs)].sort()) {
    const r = records.find((/** @type {any} */ x) => x.path === dir);
    if (!r) {
      results.push({ subject: dir, name: dir, scope: 'browser', source: 'vendored', licence: '', status: 'fail',
        problems: [{ kind: 'vendored-unrecorded', message: `${dir} is vendored code with no record in licence-policy.json` }] });
      continue;
    }
    /** @type {Problem[]} */
    const extra = [];
    if (!exists(`${dir}/${r.licenceFile ?? 'LICENSE'}`)) extra.push({ kind: 'vendored-no-licence', message: `${dir}: ${r.licenceFile ?? 'LICENSE'} must stay next to the vendored code` });
    if (!exists(`${dir}/${r.patches ?? 'PATCHES.md'}`)) extra.push({ kind: 'vendored-no-patches', message: `${dir}: ${r.patches ?? 'PATCHES.md'} must list our changes` });
    results.push(evaluateItem({ name: r.name, version: r.version, licence: r.licence, scope: r.scope ?? 'browser', source: `vendored ${dir}`, extraProblems: extra }, policy));
  }
  for (const r of records) if (!dirs.includes(r.path)) warnings.push(`vendored record '${r.path}' matches no directory (not landed yet)`);
  return { results, warnings };
}

/** External `<script src="http…">` URLs of an HTML file. @param {string} html */
export const externalScriptSrcs = (html) =>
  [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]);

/** @param {{ file: string, html: string }[]} pages @param {any} policy @returns {Result[]} */
export function checkExternalScripts(pages, policy) {
  /** @type {Result[]} */
  const out = [];
  for (const { file, html } of pages) {
    for (const src of externalScriptSrcs(html)) {
      const r = (policy.externalScripts ?? []).find((/** @type {any} */ x) => x.src === src);
      if (!r) {
        out.push({ subject: src, name: src, scope: 'browser', source: file, licence: '', status: 'fail',
          problems: [{ kind: 'script-unrecorded', message: `${file} loads ${src}, which has no externalScripts record` }] });
      } else out.push(evaluateItem({ name: r.name, version: r.version, licence: r.licence, scope: 'browser', source: `${file} (CDN)` }, policy));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The whole gate
// ---------------------------------------------------------------------------------------------

/**
 * @param {{
 *   root?: string, policy?: any,
 *   lockfiles?: Record<string, any>,              // name → parsed lockfile (default: policy.lockfiles read from root)
 *   browserModules?: any,                         // the licenceModules() report, or null
 *   requireBrowserModules?: boolean,
 *   engines?: Record<string, any>,                // file → parsed engines.lock.json (default: policy.engines.lockfiles)
 *   dataAssetFiles?: string[], vendoredDirs?: string[], htmlPages?: {file:string, html:string}[],
 *   exists?: (rel: string) => boolean,
 *   noticesText?: string|null,
 * }} [opts]
 */
export function runGate(opts = {}) {
  const root = opts.root ?? APP_ROOT;
  const policy = opts.policy ?? loadPolicy(path.join(root, 'scripts/licence-policy.json'));
  const exists = opts.exists ?? ((/** @type {string} */ rel) => existsSync(path.join(root, rel)));
  /** @type {Result[]} */
  const results = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const info = [];

  // 1. Lockfiles.
  /** @type {Record<string, any>} */
  let lockfiles = opts.lockfiles ?? {};
  if (!opts.lockfiles) {
    for (const f of policy.lockfiles) if (exists(f)) lockfiles[f] = JSON.parse(readFileSync(path.join(root, f), 'utf8'));
  }
  const browser = opts.browserModules ?? null;
  if (!browser) {
    if (opts.requireBrowserModules) {
      results.push({ subject: 'browser bundle', name: 'browser bundle', scope: 'browser', source: 'licenceModules()', licence: '', status: 'fail',
        problems: [{ kind: 'no-browser-report', message: 'no browser-modules report: build with LICENCE_MODULES_OUT set and pass --browser-modules' }] });
    } else warnings.push('browser bundle not checked: build with LICENCE_MODULES_OUT=<file> and pass --browser-modules <file> (CI does)');
  }
  const browserKeys = new Map((browser?.packages ?? []).map((/** @type {any} */ p) => [p.key, p]));
  const seenBrowser = new Set();
  for (const [file, lock] of Object.entries(lockfiles)) {
    const pkgs = lockfilePackages(lock, { lockfile: file, root: file === 'package-lock.json' ? root : undefined });
    info.push(`${file}: ${pkgs.length} packages`);
    for (const p of pkgs) {
      const inBrowser = file === 'package-lock.json' && browserKeys.has(p.key);
      if (inBrowser) seenBrowser.add(p.key);
      results.push(evaluateItem({ name: p.name, aliases: p.alias ? [p.alias] : [], version: p.version, licence: p.licence,
        scope: inBrowser ? 'browser' : p.dev ? 'dev' : 'server', source: file === 'package-lock.json' ? p.key : `${file}: ${p.key}` }, policy));
    }
  }
  // Bundled packages the main lockfile does not list (e.g. a stale node_modules): judged from the report.
  for (const p of browser?.packages ?? []) {
    if (seenBrowser.has(p.key)) continue;
    results.push(evaluateItem({ name: p.name, version: p.version, licence: p.licence, scope: 'browser', source: `bundle ${p.key} (not in package-lock.json)` }, policy));
  }
  if (browser) info.push(`browser bundle: ${(browser.packages ?? []).length} npm packages, ${browser.firstPartyModules ?? 0} first-party modules`);

  // 2. Engines.
  /** @type {Record<string, any>} */
  let engines = opts.engines ?? {};
  if (!opts.engines) {
    for (const f of policy.engines.lockfiles) if (exists(f)) engines[f] = JSON.parse(readFileSync(path.join(root, f), 'utf8'));
  }
  if (Object.keys(engines).length === 0) info.push(`engines: none yet (${policy.engines.lockfiles.join(', ')} absent)`);
  for (const [file, lock] of Object.entries(engines)) {
    const r = checkEngines(lock, policy, file);
    info.push(`${file}: ${Array.isArray(lock?.engines) ? lock.engines.length : 0} engines`);
    results.push(...r);
  }

  // 3. Data assets.
  const assetFiles = opts.dataAssetFiles ?? scanDataAssets(root, policy);
  const assets = checkDataAssets(assetFiles, policy, { root, exists });
  info.push(`data assets: ${assetFiles.length} files, ${(policy.dataAssets.records ?? []).length} records`);
  results.push(...assets.results);
  warnings.push(...assets.warnings);

  // 4. Vendored code (on disk and in the bundle) and CDN scripts.
  const vendoredDirs = [...new Set([...(opts.vendoredDirs ?? scanVendored(root, policy)), ...(browser?.vendored ?? [])])];
  const vend = checkVendored(vendoredDirs, policy, { root, exists });
  results.push(...vend.results);
  warnings.push(...vend.warnings);
  const pages = opts.htmlPages ?? policy.htmlEntries.filter((/** @type {string} */ f) => exists(f)).map((/** @type {string} */ f) => ({ file: f, html: readFileSync(path.join(root, f), 'utf8') }));
  results.push(...checkExternalScripts(pages, policy));

  // 5. The built notices name every bundled package.
  if (opts.noticesText != null && browser) {
    const missing = (browser.packages ?? []).filter((/** @type {any} */ p) => !opts.noticesText?.includes(`${p.name}@${p.version}`));
    if (missing.length) {
      results.push({ subject: 'THIRD-PARTY-NOTICES.txt', name: 'THIRD-PARTY-NOTICES.txt', scope: 'browser', source: 'notices', licence: '', status: 'fail',
        problems: missing.map((/** @type {any} */ p) => ({ kind: 'notice-missing', message: `${p.name}@${p.version} is bundled but not in the notices` })) });
    }
  }

  // 6. Owner decisions that no longer match anything.
  for (const e of policy.exceptions ?? []) {
    if (!browser && e.scopes && e.scopes.every((/** @type {string} */ s) => s === 'browser')) continue; // needs the bundle report
    if (!results.some((r) => r.status === 'known' && r.name === e.package)) warnings.push(`exception for ${e.package} matched nothing (fixed? remove it from licence-policy.json)`);
  }

  const failures = results.filter((r) => r.status === 'fail');
  const known = results.filter((r) => r.status === 'known');
  return { ok: failures.length === 0, results, failures, known, warnings, info };
}

/** @param {ReturnType<typeof runGate>} gate */
export function formatGate(gate) {
  const lines = ['licence gate (scripts/licence-policy.json)'];
  for (const i of gate.info) lines.push(`  ${i}`);
  const dedupe = (/** @type {Result[]} */ rs) => {
    const m = new Map();
    for (const r of rs) {
      const k = `${r.subject}|${r.scope}|${r.status}`;
      if (!m.has(k)) m.set(k, { r, sources: [] });
      m.get(k).sources.push(r.source);
    }
    return [...m.values()];
  };
  for (const { r, sources } of dedupe(gate.known)) {
    lines.push(`KNOWN  ${r.subject} [${r.scope}] ${r.effective ?? r.licence} (${sources.join(', ')})`);
    lines.push(`       ${r.decision}`);
    for (const p of r.problems) lines.push(`       - ${p.message}`);
  }
  for (const { r, sources } of dedupe(gate.failures)) {
    lines.push(`FAIL   ${r.subject} [${r.scope}] ${r.effective ?? r.licence} (${sources.join(', ')})`);
    for (const p of r.problems) lines.push(`       - ${p.message}`);
  }
  for (const w of gate.warnings) lines.push(`WARN   ${w}`);
  lines.push(gate.ok
    ? `licence gate: PASS (${gate.results.length} checks, ${dedupe(gate.known).length} known owner decisions)`
    : `licence gate: FAIL (${dedupe(gate.failures).length} violations)`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

/** @param {string[]} argv */
function main(argv) {
  const arg = (/** @type {string} */ flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const modulesFile = arg('--browser-modules');
  const noticesFile = arg('--notices');
  let browserModules = null;
  if (modulesFile) {
    if (!existsSync(modulesFile)) {
      if (argv.includes('--require-browser-modules')) { console.error(`licence gate: ${modulesFile} not found (did the build run with LICENCE_MODULES_OUT?)`); return 2; }
    } else browserModules = JSON.parse(readFileSync(modulesFile, 'utf8'));
  }
  let noticesText = null;
  if (noticesFile) {
    if (!existsSync(noticesFile)) { console.error(`licence gate: ${noticesFile} not found`); return 2; }
    noticesText = readFileSync(noticesFile, 'utf8');
  }
  const gate = runGate({ root: APP_ROOT, browserModules, requireBrowserModules: argv.includes('--require-browser-modules'), noticesText });
  console.log(argv.includes('--json') ? JSON.stringify(gate, null, 2) : formatGate(gate));
  return gate.ok ? 0 : 1;
}

const invoked = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invoked) process.exit(main(process.argv.slice(2)));

