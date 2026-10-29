#!/usr/bin/env node
// Atlas skin — transitional accent shim generator (docs/design/atlas-skin.md, "The transitional shim").
//
// Prints the CSS block that index.css carries at its very end: for every Tailwind utility in the
// source tree that still hard-codes the terracotta literal (`bg-[#D97757]/10`, `text-[#D97757]`,
// `hover:border-[#D97757]/35`, …) one rule under `[data-ds-skin="atlas"]` that maps it to the
// accent / accent-soft / ring tokens, so those files render in the Atlas language before Phase D1
// rewrites them. tests/config/atlasSkinShim.test.ts checks that index.css covers every literal this
// scanner finds and records how many files still carry one; when that count reaches zero the shim
// block (and this script) are deleted.
//
//   node scripts/design/atlas-skin-shim.mjs            # prints the block
//   node scripts/design/atlas-skin-shim.mjs --list     # prints the literal utilities found

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Source roots Tailwind scans for utilities (tailwind.config.cjs `content`). */
export const SCAN_ROOTS = ['App.tsx', 'components', 'hooks', 'services', 'qa'];
export const LITERAL = '#D97757';
/** `[variants:]util-[#D97757][/tint]` — the utility forms Tailwind can emit for the literal. */
export const UTILITY_RE = /[A-Za-z0-9:/().-]*\[#D97757\](?:\/(?:\d{1,3}|\[0?\.\d+\]))?/g;

export function listSourceFiles(root = APP) {
  const out = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        walk(path.join(p, name));
      }
    } else if (/\.(tsx?|css|html)$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  };
  for (const r of SCAN_ROOTS) {
    const p = path.join(root, r);
    if (fs.existsSync(p)) walk(p);
  }
  return out.sort();
}

/** Every distinct literal utility in the tree, plus the files that carry the literal in any form. */
export function scanLiteral(root = APP) {
  const utilities = new Set();
  const files = [];
  for (const file of listSourceFiles(root)) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(LITERAL)) continue;
    files.push(path.relative(root, file));
    for (const m of text.matchAll(UTILITY_RE)) {
      const token = m[0];
      // A template suffix (`bg-[#D97757]/${n}`) is not a static utility; the base form is.
      utilities.add(token);
    }
  }
  return { utilities: [...utilities].sort(), files };
}

/** Tailwind's class escaping for the characters these utilities use. */
export const escapeClass = (cls) => cls.replace(/[[\]#/:.()%,]/g, (c) => `\\${c}`);

const TINT_RE = /\/(\d{1,3}|\[(0?\.\d+)\])$/;

/** Split `hover:focus:bg-[#D97757]/10` into variants, utility, tint (0–100). */
export function parseUtility(token) {
  const parts = token.split(':');
  const util = parts.pop();
  const variants = parts;
  const m = TINT_RE.exec(util);
  const tint = m ? (m[2] !== undefined ? Math.round(Number(m[2]) * 100) : Number(m[1])) : null;
  const base = m ? util.slice(0, -m[0].length) : util;
  const kind = base.slice(0, base.indexOf('-['));
  return { variants, kind, tint };
}

const PSEUDO = {
  hover: ':hover',
  focus: ':focus',
  'focus-visible': ':focus-visible',
  'focus-within': ':focus-within',
  enabled: ':enabled',
  disabled: ':disabled',
  active: ':active',
  checked: ':checked'
};

/** The selector parts Tailwind emits for the utility: `${prefix}.${target}${suffix}`. */
export function selectorParts(token) {
  const { variants } = parseUtility(token);
  let prefix = '';
  let suffix = '';
  for (const v of variants) {
    if (PSEUDO[v]) {
      suffix += PSEUDO[v];
    } else if (v === 'peer-checked') {
      prefix += '.peer:checked ~ ';
    } else if (v === 'group-hover') {
      prefix += '.group:hover ';
    } else if (v.startsWith('group-hover/')) {
      prefix += `.${escapeClass(`group/${v.slice('group-hover/'.length)}`)}:hover `;
    } else {
      throw new Error(`atlas-skin-shim: no selector mapping for the "${v}:" variant in "${token}" — add one here and in index.css`);
    }
  }
  return { prefix, target: `.${escapeClass(token)}`, suffix };
}

/** The CSS selector Tailwind emits for the utility, scoped under the skin attribute. */
export function selectorFor(token) {
  const { prefix, target, suffix } = selectorParts(token);
  return `[data-ds-skin="atlas"] ${prefix}${target}${suffix}`;
}

const mix = (pct) => `color-mix(in srgb, var(--ds-accent) ${pct}%, transparent)`;

/** The declaration(s) the utility gets under the skin. */
export function declarationsFor(token) {
  const { variants, kind, tint } = parseUtility(token);
  const hovering = variants.includes('hover') || variants.some((v) => v.startsWith('group-hover'));
  switch (kind) {
    case 'bg': {
      if (tint === null) return { 'background-color': 'var(--ds-accent)', onAccent: true };
      if (tint <= 25) return { 'background-color': hovering ? (tint >= 20 ? 'var(--ds-active)' : 'var(--ds-hover)') : 'var(--ds-accent-soft)' };
      return { 'background-color': mix(tint), onAccent: tint >= 50 };
    }
    case 'text':
      return { color: 'var(--ds-accent)' };
    case 'border':
      return { 'border-color': tint === null ? 'var(--ds-accent)' : mix(tint) };
    case 'ring':
      return { '--tw-ring-color': 'var(--ds-ring)' };
    case 'outline':
      return { 'outline-color': 'var(--ds-ink)' };
    case 'fill':
      return { fill: 'var(--ds-accent)' };
    case 'accent':
      return { 'accent-color': 'var(--ds-accent)' };
    default:
      throw new Error(`atlas-skin-shim: no token mapping for the "${kind}-" utility in "${token}" — add one here and in index.css`);
  }
}

export const SHIM_START = '/* ==== ATLAS SKIN · TRANSITIONAL ACCENT SHIM (generated: node scripts/design/atlas-skin-shim.mjs) ==== */';
export const SHIM_END = '/* ==== END ATLAS SKIN TRANSITIONAL SHIM ==== */';

export function renderShim(utilities) {
  const lines = [
    SHIM_START,
    '/* Phase D0 of docs/design/atlas-skin.md. The files below still hard-code the terracotta literal in',
    '   Tailwind utilities; under the Atlas skin those exact classes become the accent (ink), accent-soft,',
    '   hover/active and ring tokens so nothing terracotta leaks through before Phase D1 rewrites the',
    '   files themselves. One rule per literal utility found by scripts/design/atlas-skin-shim.mjs;',
    '   tests/config/atlasSkinShim.test.ts fails when a literal utility has no rule here. Solid accent',
    '   fills that pair with `text-white` also get the on-accent text colour (dark Atlas ink is light).',
    '   DELETE this whole block (and the generator) when the literal count in that test reaches zero. */'
  ];
  for (const token of utilities) {
    const { prefix, target, suffix } = selectorParts(token);
    const { onAccent, ...decls } = declarationsFor(token);
    lines.push(`[data-ds-skin="atlas"] ${prefix}${target}${suffix} { ${Object.entries(decls).map(([k, v]) => `${k}: ${v};`).join(' ')} }`);
    if (onAccent) lines.push(`[data-ds-skin="atlas"] ${prefix}${target}.text-white${suffix} { color: var(--ds-on-accent); }`);
  }
  lines.push(
    '/* Token-driven solid accent + hard-coded white text (studioDesign PRIMARY_BTN consumers and friends). */',
    '[data-ds-skin="atlas"] .bg-\\[var\\(--ds-accent\\)\\].text-white,',
    '[data-ds-skin="atlas"] .hover\\:bg-\\[var\\(--ds-accent-hover\\)\\].text-white:hover { color: var(--ds-on-accent); }',
    SHIM_END
  );
  return lines.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { utilities, files } = scanLiteral();
  if (process.argv.includes('--list')) {
    process.stdout.write(`${utilities.length} literal utilities in ${files.length} files\n${utilities.join('\n')}\n`);
  } else {
    process.stdout.write(renderShim(utilities) + '\n');
  }
}
