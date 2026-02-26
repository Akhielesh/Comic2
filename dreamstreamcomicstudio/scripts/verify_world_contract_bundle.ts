import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DIST_ASSETS_DIR = path.resolve(process.cwd(), 'dist/assets');

const fail = (message: string): never => {
  console.error(`[verify:world-contract] ${message}`);
  process.exit(1);
};

if (!existsSync(DIST_ASSETS_DIR)) {
  fail(`Missing build output at ${DIST_ASSETS_DIR}. Run \`npm run build\` first.`);
}

const jsFiles = readdirSync(DIST_ASSETS_DIR)
  .filter((file) => file.endsWith('.js'))
  .map((file) => path.join(DIST_ASSETS_DIR, file));

if (jsFiles.length === 0) {
  fail(`No JavaScript assets found in ${DIST_ASSETS_DIR}.`);
}

const bundleText = jsFiles
  .map((filePath) => readFileSync(filePath, 'utf8'))
  .join('\n');

if (!bundleText.includes('/api/system/version')) {
  fail('Bundle does not reference /api/system/version.');
}

const extractWorldNeedle = '/api/text/extract-world';
const extractIndexes: number[] = [];
let cursor = 0;
while (cursor < bundleText.length) {
  const index = bundleText.indexOf(extractWorldNeedle, cursor);
  if (index === -1) break;
  extractIndexes.push(index);
  cursor = index + extractWorldNeedle.length;
}

if (extractIndexes.length === 0) {
  fail('Bundle does not reference /api/text/extract-world.');
}

const hasExtractWorldPayloadWithScript = extractIndexes.some((index) => {
  const window = bundleText.slice(index, index + 700);
  if (!window.includes('scenes')) return false;
  if (!window.includes('script')) return false;
  return window.indexOf('scenes') < window.lastIndexOf('script');
});

if (!hasExtractWorldPayloadWithScript) {
  fail('Could not verify extract-world payload includes both scenes and script in the compiled bundle.');
}

const hasStoryPlanningSignals =
  bundleText.includes('storyPlanning')
  && (
    bundleText.includes('Story Planning')
    || bundleText.includes('Confirm Plan & Continue')
    || bundleText.includes('STORY_PLANNING')
  );

if (!hasStoryPlanningSignals) {
  fail('Could not verify Story Planning step assets in the compiled bundle.');
}

console.log('[verify:world-contract] OK: found /api/system/version, extract-world payload with scenes+script, and Story Planning assets.');
