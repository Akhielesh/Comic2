#!/usr/bin/env node
// Export the platform contract for a consumer outside this repository (plan §4.4):
//
//   node packages/platform-core/scripts/export.mjs --out <dir> [--git-sha <sha>]
//
// writes into <dir>:
//   platform-core-<ver>.tgz          the sources as they are (every relative import ends in .js: Node16 / bundlers
//                                    that map .js to .ts)
//   platform-core-bundler-<ver>.tgz  the same sources with the .js suffixes stripped, for a bundler that does not
//                                    map .js to .ts
//   MANIFEST.json                    name, version, git SHA (and whether the package folder was clean), and the
//                                    sha256 of each tgz and of every file in each
//   SHA256SUMS                       `sha256sum -c` lines for the two tgz files and MANIFEST.json
//
// Deterministic: files are sorted, every tar header is fixed (mode 0644, uid/gid 0, no names, one mtime), and the
// gzip stream uses stored (uncompressed) deflate blocks written here, so the bytes never depend on the zlib build.
// Two runs on the same tree — on any machine — give byte-identical output (src/purity.test.ts checks it).
//
// Shipped: package.json, README.md, CHANGELOG.md, src/**/*.ts except tests, fixtures/** and conformance/** (the
// conformance kit runs against each host's ports). Never scripts/, tsconfig files, dotfiles or symlinks.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** npm's fixed tarball time (1985-10-26T08:15:00Z): old enough to be obviously synthetic, new enough for every tar. */
const MTIME = 499162500;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Every relative specifier `'./x.js'` / `'../y/z.js'` after `from` or `import` (static, side-effect or dynamic). */
const RELATIVE_JS = /((?:\bfrom|\bimport)\s*\(?\s*)(['"])(\.{1,2}\/[^'"\r\n]+?)\.js\2/g;

/** The bundler flavour of one source file: relative `.js` suffixes removed, nothing else touched. */
export const stripJsSuffixes = (source) => source.replace(RELATIVE_JS, '$1$2$3$2');

const walk = (root, dir, out) => {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const abs = join(dir, name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) throw new Error(`export: refusing the symlink ${relative(root, abs)}`);
    if (st.isDirectory()) walk(root, abs, out);
    else if (st.isFile()) out.push(relative(root, abs).split(sep).join('/'));
  }
  return out;
};

/** The package-relative paths that ship, sorted. */
export const packageFiles = (pkg = PKG) => {
  const files = ['package.json', 'README.md', 'CHANGELOG.md'].filter((f) => existsSync(join(pkg, f)));
  for (const f of walk(pkg, join(pkg, 'src'), [])) if (f.endsWith('.ts') && !f.endsWith('.test.ts')) files.push(f);
  for (const dir of ['fixtures', 'conformance']) if (existsSync(join(pkg, dir))) files.push(...walk(pkg, join(pkg, dir), []));
  for (const f of files) if (!/^[\x21-\x7e]+$/.test(f)) throw new Error(`export: file names must be printable ASCII: ${f}`);
  return files.sort(byCodeUnit);
};

// ── tar (ustar) ────────────────────────────────────────────────────────────────────────────────────────────────

const octal = (n, width) => n.toString(8).padStart(width - 1, '0') + '\0';

const header = (path, size) => {
  const h = Buffer.alloc(512, 0);
  let name = path;
  let prefix = '';
  if (Buffer.byteLength(path) > 100) {
    const cut = path.lastIndexOf('/', 155);
    if (cut <= 0 || path.length - cut - 1 > 100) throw new Error(`export: path too long for ustar: ${path}`);
    prefix = path.slice(0, cut);
    name = path.slice(cut + 1);
  }
  h.write(name, 0, 100, 'ascii');
  h.write(octal(0o644, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(MTIME, 12), 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write('0', 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.write(prefix, 345, 155, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
};

/** A ustar archive of `entries` ([path, Buffer]) in the order given. */
export const tar = (entries) => {
  const parts = [];
  for (const [path, data] of entries) {
    parts.push(header(path, data.length), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
};

// ── gzip with stored deflate blocks (RFC 1951 §3.2.4, RFC 1952) ─────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

export const gzipStored = (data) => {
  const parts = [Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0xff])];
  const BLOCK = 65535;
  let at = 0;
  do {
    const chunk = data.subarray(at, at + BLOCK);
    at += chunk.length;
    const head = Buffer.alloc(5);
    head[0] = at >= data.length ? 1 : 0; // BFINAL, BTYPE 00 (stored)
    head.writeUInt16LE(chunk.length, 1);
    head.writeUInt16LE(~chunk.length & 0xffff, 3);
    parts.push(head, chunk);
  } while (at < data.length);
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(crc32(data), 0);
  tail.writeUInt32LE(data.length >>> 0, 4);
  parts.push(tail);
  return Buffer.concat(parts);
};

// ── Export ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `{gitSha, clean}` with both keys always present, so an export run with `--git-sha <HEAD>` and a plain run of the same
 * tree write the same MANIFEST.json bytes. `clean` is whether the package folder has no uncommitted change, or `null`
 * outside a git checkout (a source tarball), where `gitSha` is the override or `'unknown'`.
 */
const gitInfo = (pkg, override) => {
  const git = (args) => execFileSync('git', ['-C', pkg, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let head;
  let clean = null;
  try {
    head = git(['rev-parse', 'HEAD']);
    clean = git(['status', '--porcelain', '--', '.']) === '';
  } catch {
    head = undefined;
    clean = null;
  }
  return { gitSha: override || head || 'unknown', clean };
};

/**
 * Build both flavours in memory. Returns `{name, version, files: {[fileName]: Buffer}}`; `exportPackage` writes them.
 */
export const buildExport = ({ pkg = PKG, gitSha } = {}) => {
  const meta = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  const version = meta.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`export: bad version ${version}`);
  const paths = packageFiles(pkg);
  const flavours = {
    node16: { file: `platform-core-${version}.tgz`, transform: (_path, buf) => buf },
    bundler: {
      file: `platform-core-bundler-${version}.tgz`,
      transform: (path, buf) => (path.endsWith('.ts') ? Buffer.from(stripJsSuffixes(buf.toString('utf8')), 'utf8') : buf),
    },
  };
  const out = {};
  const manifest = { name: meta.name, version, ...gitInfo(pkg, gitSha), flavours: {} };
  for (const [flavour, { file, transform }] of Object.entries(flavours)) {
    const entries = paths.map((p) => [p, transform(p, readFileSync(join(pkg, p)))]);
    const tgz = gzipStored(tar(entries.map(([p, buf]) => [`package/${p}`, buf])));
    const files = {};
    for (const [p, buf] of entries) files[p] = sha256(buf);
    manifest.flavours[flavour] = { file, sha256: sha256(tgz), bytes: tgz.length, files };
    out[file] = tgz;
  }
  out['MANIFEST.json'] = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  out.SHA256SUMS = Buffer.from(
    Object.keys(out)
      .sort(byCodeUnit)
      .map((name) => `${sha256(out[name])}  ${name}\n`)
      .join(''),
    'utf8',
  );
  return { name: meta.name, version, files: out };
};

export const exportPackage = ({ out, pkg = PKG, gitSha } = {}) => {
  if (!out) throw new Error('export: --out <dir> is required');
  const dir = resolve(out);
  if (dir === pkg || dir.startsWith(join(pkg, 'src'))) throw new Error('export: refusing to write into the package sources');
  mkdirSync(dir, { recursive: true });
  const result = buildExport({ pkg, gitSha });
  for (const [name, buf] of Object.entries(result.files)) writeFileSync(join(dir, name), buf);
  return { dir, ...result };
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  try {
    const { dir, version, files } = exportPackage({ out: opt('--out'), gitSha: opt('--git-sha') });
    for (const name of Object.keys(files).sort(byCodeUnit)) console.log(`${name}  ${files[name].length} bytes`);
    console.log(`platform-core ${version} exported to ${dir}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
