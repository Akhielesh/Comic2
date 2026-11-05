// Re-creates the vendored PptxGenJS from an upstream release (PATCHES.md, "Updating").
//
//   npm pack pptxgenjs@<ver>            # in an empty folder; check the tarball's sha512 against the registry
//   tar -xzf pptxgenjs-<ver>.tgz
//   node packages/platform-render/scripts/vendor-pptxgenjs.mjs package/dist/pptxgen.es.js [out]
//
// Applies scripts/pptxgenjs-patches.json in order. Every `old` must occur exactly once at its turn, so an upstream
// change near a patched function stops the run instead of producing a half-patched file. The default output is
// src/vendor/pptxgenjs/pptxgen.es.js. Then copy LICENSE, update PATCHES.md and the licence policy record, and run
// `npx vitest run packages/platform-render` (the vendor guards and the goldens).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [, , input, output = path.join(here, '../src/vendor/pptxgenjs/pptxgen.es.js')] = process.argv;
if (!input) {
  console.error('usage: node vendor-pptxgenjs.mjs <upstream dist/pptxgen.es.js> [out]');
  process.exit(2);
}
const { edits } = JSON.parse(readFileSync(path.join(here, 'pptxgenjs-patches.json'), 'utf8'));
let code = readFileSync(input, 'utf8');
for (const [i, e] of edits.entries()) {
  const first = code.indexOf(e.old);
  if (first === -1 || code.indexOf(e.old, first + 1) !== -1) {
    console.error(`edit ${i + 1} (${e.patch}): expected exactly one match, found ${first === -1 ? 0 : 'several'}; re-check the upstream change by hand`);
    process.exit(1);
  }
  code = code.slice(0, first) + e.new + code.slice(first + e.old.length);
}
writeFileSync(output, code);
console.log(`wrote ${output} (${edits.length} edits)`);
